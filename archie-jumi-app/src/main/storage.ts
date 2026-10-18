import { mkdir, readFile, writeFile, copyFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizePreferences } from '../shared/validation';
import { defaultState } from '../shared/defaults';
import type { SavedState } from '../shared/types';
export class StateStore {
  readonly file: string;
  readonly backup: string;
  readOnly = false;
  notices: string[] = [];
  private queue = Promise.resolve();
  constructor(readonly directory: string) { this.file = join(directory, 'state.json'); this.backup = join(directory, 'state.backup.json'); }
  async load(): Promise<SavedState> {
    await mkdir(this.directory, { recursive: true });
    for (const path of [this.file, this.backup]) {
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8'));
        if (this.protectFutureFormat(parsed.schemaVersion)) return defaultState();
        if (parsed.schemaVersion !== 0 && parsed.schemaVersion !== 1) throw new Error('Unknown save format');
        if (parsed.schemaVersion === 0) await copyFile(path, join(this.directory, 'state.pre-migration-v0.json'));
        if (path === this.backup) this.notices.push('Recovered your preferences from the last good backup.');
        return { schemaVersion: 1, preferences: normalizePreferences(parsed.preferences ?? parsed.settings) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.notices.push(`Could not read ${path === this.file ? 'the saved preferences' : 'the backup'}. A safe recovery was used.`);
      }
    }
    return defaultState();
  }
  save(state: SavedState): Promise<void> {
    if (this.readOnly) return Promise.resolve();
    const contents = JSON.stringify(state, null, 2);
    this.queue = this.queue.catch(() => {}).then(async () => {
      // A queued write may have discovered a newer file after this save was requested.
      if (this.readOnly) return;
      await mkdir(this.directory, { recursive: true });
      try {
        const oldBackup = JSON.parse(await readFile(this.backup, 'utf8'));
        // Manual restoration of an older primary must not destroy a newer backup.
        if (this.protectFutureFormat(oldBackup?.schemaVersion)) return;
      } catch { /* A missing or damaged backup does not prevent a primary save. */ }
      try {
        const old = JSON.parse(await readFile(this.file, 'utf8'));
        // Recheck at write time: the file may have been upgraded since startup.
        if (this.protectFutureFormat(old.schemaVersion)) return;
        if (old.schemaVersion === 1) await copyFile(this.file, this.backup);
      } catch { /* Preserve a good backup if the current file is absent or damaged. */ }
      const temporary = this.file + '.tmp';
      await writeFile(temporary, contents, 'utf8');
      await rename(temporary, this.file);
    });
    return this.queue;
  }
  private protectFutureFormat(version: unknown): boolean {
    if (typeof version !== 'number' || version <= 1) return false;
    if (!this.readOnly) this.notices.push('This save belongs to a newer app version. Your file is preserved; this session will not overwrite it.');
    this.readOnly = true;
    return true;
  }
}
