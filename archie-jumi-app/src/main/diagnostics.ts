/**
 * Local troubleshooting log (plan F7): an in-memory ring buffer plus `diagnostics.log` in the
 * app-data folder, rotated to `diagnostics.1.log`. Offline only. Callers log events and small
 * flat details; never window titles, outside file paths, user names or continuous cursor
 * coordinates. Uses node:fs only (testable with a temporary folder) and never throws to callers.
 */
import { appendFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type DiagnosticsValue = string | number | boolean | null;
export type DiagnosticsDetails = Record<string, DiagnosticsValue>;

export interface DiagnosticsContext {
  appVersion: string;
  electron: string;
  chrome: string;
  os: string;
  inputRouting: string;
  occlusion: string;
  /** Display summary only: how many and their scale factors. */
  displays: { count: number; scaleFactors: number[] };
}

export interface DiagnosticsOptions {
  maxBytes?: number;
  memoryEntries?: number;
  /** Wall clock (ms since the epoch) for the ISO timestamp. */
  now?: () => number;
  /** Monotonic clock in ms. */
  monotonic?: () => number;
  /** Header information for `text()`. */
  context?: () => Partial<DiagnosticsContext>;
}

const MAX_DETAILS_CHARS = 600;

/** The parts of Electron's Promise-based clipboard that copying diagnostics uses. */
export interface TextClipboard {
  writeText(text: string): Promise<void>;
  readText(): Promise<string>;
}

export interface CopyOptions {
  attempts?: number;
  retryMs?: number;
  wait?: (ms: number) => Promise<void>;
}

const comparable = (text: string) => text.replace(/\r\n/g, '\n').trimEnd();

/**
 * Writes `text` and reports success only when reading it back matches. On Windows a write is
 * dropped silently while another process (rdpclip, a clipboard manager) holds the clipboard, and
 * the user would then paste whatever they copied before. Retries once by default. The read-back is
 * only compared, never logged or returned: it may be the user's previous clipboard content.
 */
export async function copyVerified(clipboard: TextClipboard, text: string, options: CopyOptions = {}): Promise<boolean> {
  const attempts = Math.max(1, options.attempts ?? 2), retryMs = options.retryMs ?? 75;
  const wait = options.wait ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await wait(retryMs);
    try {
      await clipboard.writeText(text);
      if (comparable(await clipboard.readText()) === comparable(text)) return true;
    } catch { /* A busy or failing clipboard: retry, then report failure. */ }
  }
  return false;
}

export class DiagnosticsLog {
  readonly file: string;
  readonly rotatedFile: string;
  private readonly maxBytes: number;
  private readonly memoryEntries: number;
  private readonly now: () => number;
  private readonly monotonic: () => number;
  private readonly context: () => Partial<DiagnosticsContext>;
  private readonly lines: string[] = [];
  private pending: string[] = [];
  private chain: Promise<void> = Promise.resolve();
  private size: number | null = null;
  private failures = 0;

  constructor(readonly directory: string, options: DiagnosticsOptions = {}) {
    this.file = join(directory, 'diagnostics.log');
    this.rotatedFile = join(directory, 'diagnostics.1.log');
    this.maxBytes = options.maxBytes && options.maxBytes > 0 ? options.maxBytes : 256 * 1024;
    this.memoryEntries = options.memoryEntries && options.memoryEntries > 0 ? Math.floor(options.memoryEntries) : 500;
    this.now = options.now ?? Date.now;
    this.monotonic = options.monotonic ?? (() => performance.now());
    this.context = options.context ?? (() => ({}));
  }

  /** Records an event in memory and queues an append to the log file. Never throws. */
  log(event: string, details?: DiagnosticsDetails): void {
    try {
      const line = this.format(event, details);
      this.lines.push(line);
      if (this.lines.length > this.memoryEntries) this.lines.splice(0, this.lines.length - this.memoryEntries);
      this.pending.push(line);
      if (this.pending.length === 1) this.chain = this.chain.then(() => this.drain());
    } catch { /* Diagnostics must never disturb the app. */ }
  }

  /** A header (versions, routing, occlusion, display summary) followed by the newest entries. */
  text(limit = this.memoryEntries): string {
    let context: Partial<DiagnosticsContext> = {};
    try { context = this.context(); } catch { /* Keep the header partial. */ }
    const wanted = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : this.lines.length;
    const shown = wanted === 0 ? [] : this.lines.slice(-wanted);
    const scales = context.displays?.scaleFactors?.join(', ') || 'unknown';
    const header = [
      'Archie & Jumi diagnostics',
      `app ${context.appVersion ?? 'unknown'} | electron ${context.electron ?? 'unknown'} | chrome ${context.chrome ?? 'unknown'} | os ${context.os ?? 'unknown'}`,
      `input routing ${context.inputRouting ?? 'unknown'} | native occlusion ${context.occlusion ?? 'unknown'}`,
      `displays ${context.displays?.count ?? 'unknown'} | scale factors ${scales}`,
      `entries ${shown.length} of ${this.lines.length} in memory, newest last | file write failures ${this.failures}`,
    ];
    return [...header, '', ...shown].join('\n') + '\n';
  }

  /** Entries currently held in memory. */
  get count(): number { return this.lines.length; }
  get writeFailures(): number { return this.failures; }

  /** Resolves once every queued append has been attempted. */
  async flush(): Promise<void> {
    let current: Promise<void>;
    do {
      current = this.chain;
      await current;
    } while (current !== this.chain);
  }

  private format(event: string, details?: DiagnosticsDetails): string {
    const name = String(event).replace(/[^\w.:-]/g, '_').slice(0, 64) || 'event';
    let json = details && Object.keys(details).length ? JSON.stringify(details) : '';
    if (json.length > MAX_DETAILS_CHARS) json = JSON.stringify({ truncated: json.slice(0, MAX_DETAILS_CHARS) });
    const mono = Math.round(this.monotonic());
    return `${new Date(this.now()).toISOString()} ${mono} ${name}${json ? ` ${json}` : ''}`;
  }

  private async drain(): Promise<void> {
    const batch = this.pending;
    this.pending = [];
    try {
      if (this.size === null) {
        await mkdir(this.directory, { recursive: true });
        this.size = await stat(this.file).then(info => info.size, () => 0);
      }
      let chunk = '', chunkBytes = 0;
      for (const line of batch) {
        const text = `${line}\n`, bytes = Buffer.byteLength(text);
        if (this.size + chunkBytes + bytes > this.maxBytes && this.size + chunkBytes > 0) {
          if (chunk) await this.append(chunk, chunkBytes);
          chunk = '';
          chunkBytes = 0;
          await this.rotate();
        }
        chunk += text;
        chunkBytes += bytes;
      }
      if (chunk) await this.append(chunk, chunkBytes);
    } catch {
      this.failures++;
      this.size = null;
    }
  }

  private async append(chunk: string, bytes: number): Promise<void> {
    await appendFile(this.file, chunk, 'utf8');
    this.size = (this.size ?? 0) + bytes;
  }

  /** Keeps exactly one older file: diagnostics.1.log is replaced. */
  private async rotate(): Promise<void> {
    try {
      await rename(this.file, this.rotatedFile);
    } catch {
      try {
        await rm(this.rotatedFile, { force: true });
        await rename(this.file, this.rotatedFile);
      } catch {
        await writeFile(this.file, '', 'utf8');
      }
    }
    this.size = 0;
  }
}
