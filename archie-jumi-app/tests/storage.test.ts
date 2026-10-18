import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StateStore } from '../src/main/storage';
import { defaultState } from '../src/shared/defaults';

let directory: string;
beforeEach(async () => {
  const testRoot = join(process.cwd(), 'node_modules', '.cache', 'storage-tests');
  await mkdir(testRoot, { recursive: true });
  directory = await mkdtemp(join(testRoot, 'case-'));
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('StateStore durable writes and recovery', () => {
  it('uses defaults for a missing state and saves complete JSON without a leftover temporary file', async () => {
    const store = new StateStore(directory);
    expect(await store.load()).toEqual(defaultState());
    expect(store.notices).toEqual([]);
    const state = defaultState();
    state.preferences.pets.archie.name = 'Archie 🐈';
    await store.save(state);
    expect(JSON.parse(await readFile(store.file, 'utf8'))).toEqual(state);
    expect(await readdir(directory)).toEqual(['state.json']);
    expect(await new StateStore(directory).load()).toEqual(state);
  });

  it('serializes overlapping writes and retains the last complete previous version as its backup', async () => {
    const store = new StateStore(directory);
    const first = defaultState();
    const second = defaultState();
    const third = defaultState();
    first.preferences.volume = 0.1;
    second.preferences.volume = 0.2;
    third.preferences.volume = 0.3;
    await Promise.all([store.save(first), store.save(second), store.save(third)]);
    expect(JSON.parse(await readFile(store.file, 'utf8'))).toEqual(third);
    expect(JSON.parse(await readFile(store.backup, 'utf8'))).toEqual(second);
    expect((await readdir(directory)).some(name => name.endsWith('.tmp'))).toBe(false);
  });

  it('captures a save at invocation rather than reading later mutations from the caller', async () => {
    const store = new StateStore(directory);
    const state = defaultState();
    const saved = store.save(state);
    state.preferences.sound = true;
    await saved;
    expect(JSON.parse(await readFile(store.file, 'utf8')).preferences.sound).toBe(false);
  });

  it('recovers a truncated primary from the last good backup without replacing that backup with corruption', async () => {
    const store = new StateStore(directory);
    const good = defaultState();
    good.preferences.pets.jumi.position = { x: 0.6, y: 0.8 };
    await store.save(good);
    await store.save(defaultState());
    await writeFile(store.file, '{ "schemaVersion": 1, "preferences": ', 'utf8');
    const recovered = new StateStore(directory);
    expect(await recovered.load()).toEqual(good);
    expect(recovered.notices.some(notice => notice.includes('backup'))).toBe(true);
    await recovered.save(good);
    expect(JSON.parse(await readFile(store.file, 'utf8'))).toEqual(good);
    expect(JSON.parse(await readFile(store.backup, 'utf8'))).toEqual(good);
  });

  it('falls back safely when both state files are damaged, and does not overwrite files merely by loading', async () => {
    const store = new StateStore(directory);
    await writeFile(store.file, 'null', 'utf8');
    await writeFile(store.backup, 'not json', 'utf8');
    expect(await store.load()).toEqual(defaultState());
    expect(store.notices).toHaveLength(2);
    expect(await readFile(store.file, 'utf8')).toBe('null');
    expect(await readFile(store.backup, 'utf8')).toBe('not json');
  });

  it('normalizes saved values while retaining supported choices', async () => {
    const store = new StateStore(directory);
    await writeFile(store.file, JSON.stringify({ schemaVersion: 1, preferences: {
      quiet: true, volume: 99, pets: { archie: { name: '  Archie  ', size: -50, position: { x: 99, y: -99 } } },
    } }), 'utf8');
    const state = await store.load();
    expect(state.preferences).toMatchObject({ quiet: true, volume: 1 });
    expect(state.preferences.pets.archie).toMatchObject({ name: 'Archie', size: 96, position: { x: 1, y: 0 } });
    expect(state.preferences.pets.jumi).toEqual(defaultState().preferences.pets.jumi);
  });
});

describe('StateStore format compatibility', () => {
  it('backs up version zero bytes before migration and writes the upgraded version on save', async () => {
    const store = new StateStore(directory);
    const legacy = JSON.stringify({ schemaVersion: 0, settings: { sound: true, volume: 0.65, pets: { jumi: { name: 'Jum Jum' } } } }, null, 2);
    await writeFile(store.file, legacy, 'utf8');
    const state = await store.load();
    expect(state.schemaVersion).toBe(1);
    expect(state.preferences).toMatchObject({ sound: true, volume: 0.65, pets: { jumi: { name: 'Jum Jum' } } });
    const migrationBackup = join(directory, 'state.pre-migration-v0.json');
    expect(await readFile(migrationBackup, 'utf8')).toBe(legacy);
    await store.save(state);
    expect(JSON.parse(await readFile(store.file, 'utf8')).schemaVersion).toBe(1);
    expect(await readFile(migrationBackup, 'utf8')).toBe(legacy);
  });

  it('preserves future-schema state byte-for-byte and refuses later writes for the session', async () => {
    const store = new StateStore(directory);
    const future = JSON.stringify({ schemaVersion: 12, preferences: { unknownFutureSetting: 'must survive' } }, null, 2);
    await writeFile(store.file, future, 'utf8');
    expect(await store.load()).toEqual(defaultState());
    expect(store.readOnly).toBe(true);
    await store.save(defaultState());
    expect(await readFile(store.file, 'utf8')).toBe(future);
    expect(store.notices.some(notice => notice.includes('newer app version'))).toBe(true);
  });

  it('also preserves a future-format backup discovered during recovery', async () => {
    const store = new StateStore(directory);
    const future = JSON.stringify({ schemaVersion: 8, important: ['not', 'discarded'] });
    await writeFile(store.file, '{', 'utf8');
    await writeFile(store.backup, future, 'utf8');
    expect(await store.load()).toEqual(defaultState());
    expect(store.readOnly).toBe(true);
    await store.save(defaultState());
    expect(await readFile(store.backup, 'utf8')).toBe(future);
    expect(await readFile(store.file, 'utf8')).toBe('{');
  });

  it('does not overwrite a newer save that appears after startup or before load', async () => {
    const store = new StateStore(directory);
    await store.load();
    const future = JSON.stringify({ schemaVersion: 2, preferences: { featureAddedLater: true } });
    await writeFile(store.file, future, 'utf8');
    await Promise.all([store.save(defaultState()), store.save(defaultState())]);
    expect(await readFile(store.file, 'utf8')).toBe(future);
    expect(store.readOnly).toBe(true);
    await new StateStore(directory).save(defaultState());
    expect(await readFile(store.file, 'utf8')).toBe(future);
  });

  it('preserves a newer backup even if an older supported primary was manually restored', async () => {
    const store = new StateStore(directory);
    const supported = JSON.stringify(defaultState());
    const future = JSON.stringify({ schemaVersion: 3, preferences: { futureSetting: 'preserve' } });
    await writeFile(store.file, supported, 'utf8');
    await writeFile(store.backup, future, 'utf8');
    await store.load();
    await store.save(defaultState());
    expect(store.readOnly).toBe(true);
    expect(await readFile(store.file, 'utf8')).toBe(supported);
    expect(await readFile(store.backup, 'utf8')).toBe(future);
  });
});
