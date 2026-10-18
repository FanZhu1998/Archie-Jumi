import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DiagnosticsLog, copyVerified, type TextClipboard } from '../src/main/diagnostics';

let directory: string;
beforeEach(async () => {
  const testRoot = join(process.cwd(), 'node_modules', '.cache', 'diagnostics-tests');
  await mkdir(testRoot, { recursive: true });
  directory = await mkdtemp(join(testRoot, 'case-'));
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

const clocks = () => { let wall = Date.UTC(2026, 9, 17, 12, 0, 0), mono = 1000; return { now: () => wall, monotonic: () => mono, step: () => { wall += 1000; mono += 1000; } }; };

describe('DiagnosticsLog', () => {
  it('writes ISO time, monotonic ms, event and compact JSON details per line', async () => {
    const log = new DiagnosticsLog(directory, clocks());
    log.log('overlay-create', { generation: 2, trigger: 'startup', visible: false, workArea: null });
    log.log('feed-start');
    await log.flush();
    expect(await readFile(log.file, 'utf8')).toBe(
      '2026-10-17T12:00:00.000Z 1000 overlay-create {"generation":2,"trigger":"startup","visible":false,"workArea":null}\n'
      + '2026-10-17T12:00:00.000Z 1000 feed-start\n');
  });

  it('keeps a bounded in-memory ring of the newest entries', () => {
    const log = new DiagnosticsLog(directory, { memoryEntries: 5 });
    for (let i = 1; i <= 12; i++) log.log('event', { i });
    expect(log.count).toBe(5);
    const text = log.text();
    expect(text).not.toContain('{"i":7}');
    for (let i = 8; i <= 12; i++) expect(text).toContain(`{"i":${i}}`);
    expect(log.text(2)).not.toContain('{"i":10}');
    expect(log.text(2)).toContain('{"i":12}');
    expect(log.text(0)).not.toContain('event');
  });

  it('keeps file appends in order under rapid logging', async () => {
    const log = new DiagnosticsLog(directory);
    for (let i = 0; i < 200; i++) {
      log.log('tick', { i });
      if (i % 37 === 0) await Promise.resolve();
    }
    await log.flush();
    const order = (await readFile(log.file, 'utf8')).trim().split('\n').map(line => JSON.parse(line.slice(line.indexOf('{'))).i);
    expect(order).toEqual(Array.from({ length: 200 }, (_, i) => i));
  });

  it('rotates to diagnostics.1.log at maxBytes, replacing the older copy', async () => {
    const log = new DiagnosticsLog(directory, { maxBytes: 400 });
    for (let i = 0; i < 40; i++) log.log('rotation-check', { index: i, padding: 'x'.repeat(20) });
    await log.flush();
    expect((await stat(log.file)).size).toBeLessThanOrEqual(400);
    expect((await stat(log.rotatedFile)).size).toBeLessThanOrEqual(400);
    const current = await readFile(log.file, 'utf8'), rotated = await readFile(log.rotatedFile, 'utf8');
    expect(current).toContain('"index":39');
    expect(rotated).not.toContain('"index":0,');
    const indices = (rotated + current).trim().split('\n').map(line => JSON.parse(line.slice(line.indexOf('{'))).index);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(indices.at(-1)).toBe(39);
  });

  it('appends to an existing log and counts its size before rotating', async () => {
    await writeFile(join(directory, 'diagnostics.log'), 'y'.repeat(390) + '\n', 'utf8');
    const log = new DiagnosticsLog(directory, { maxBytes: 400 });
    log.log('after-restart');
    await log.flush();
    expect(await readFile(log.rotatedFile, 'utf8')).toBe('y'.repeat(390) + '\n');
    expect(await readFile(log.file, 'utf8')).toContain('after-restart');
  });
});

describe('DiagnosticsLog header and failure handling', () => {
  it('starts text() with versions, OS, routing, occlusion and a display summary only', () => {
    const log = new DiagnosticsLog(directory, { context: () => ({
      appVersion: '1.0.2', electron: '44.8.0', chrome: '152.0.1', os: 'win32 10.0.26200',
      inputRouting: 'polling', occlusion: 'disabled', displays: { count: 3, scaleFactors: [1.25, 1.5, 1.5] },
    }) });
    log.log('app-start');
    const [title, versions, routing, displays, entries, blank, first] = log.text().split('\n');
    expect(title).toBe('Archie & Jumi diagnostics');
    expect(versions).toBe('app 1.0.2 | electron 44.8.0 | chrome 152.0.1 | os win32 10.0.26200');
    expect(routing).toBe('input routing polling | native occlusion disabled');
    expect(displays).toBe('displays 3 | scale factors 1.25, 1.5, 1.5');
    expect(entries).toContain('entries 1 of 1');
    expect(blank).toBe('');
    expect(first).toMatch(/ app-start$/);
  });

  it('keeps a usable header when the context throws', () => {
    const log = new DiagnosticsLog(directory, { context: () => { throw new Error('screen not ready'); } });
    expect(log.text()).toContain('app unknown');
  });

  it('never throws to callers when the folder cannot be written', async () => {
    const blocker = join(directory, 'not-a-folder');
    await writeFile(blocker, 'file', 'utf8');
    const log = new DiagnosticsLog(join(blocker, 'logs'));
    expect(() => log.log('first', { ok: true })).not.toThrow();
    await expect(log.flush()).resolves.toBeUndefined();
    expect(() => log.log('second')).not.toThrow();
    await log.flush();
    expect(log.writeFailures).toBe(2);
    expect(log.count).toBe(2);
    expect(log.text()).toContain('second');
  });

  it('sanitizes event names and bounds large details', () => {
    const log = new DiagnosticsLog(directory);
    log.log('bad name\nwith newline', { text: 'z'.repeat(5000) });
    const line = log.text().trimEnd().split('\n').at(-1)!;
    expect(line).toContain(' bad_name_with_newline ');
    expect(line.length).toBeLessThan(800);
  });
});

describe('copyVerified', () => {
  /** A fake clipboard: `drops` silently discards that many writes, as a busy Windows clipboard does. */
  function fakeClipboard(options: { drops?: number; rejectWrites?: boolean; rewrite?: (text: string) => string } = {}) {
    let content = 'previous private text', drops = options.drops ?? 0, writes = 0;
    const clipboard: TextClipboard = {
      writeText: async text => {
        writes++;
        if (options.rejectWrites) throw new Error('clipboard unavailable');
        if (drops > 0) { drops--; return; }
        content = options.rewrite ? options.rewrite(text) : text;
      },
      readText: async () => content,
    };
    return { clipboard, get content() { return content; }, get writes() { return writes; } };
  }
  const waits: number[] = [];
  const wait = async (ms: number) => { waits.push(ms); };

  it('succeeds when the read-back matches the written text', async () => {
    const fake = fakeClipboard();
    await expect(copyVerified(fake.clipboard, 'log\nlines\n', { wait })).resolves.toBe(true);
    expect(fake.content).toBe('log\nlines\n');
    expect(fake.writes).toBe(1);
  });

  it('retries once after a dropped write and then succeeds', async () => {
    waits.length = 0;
    const fake = fakeClipboard({ drops: 1 });
    await expect(copyVerified(fake.clipboard, 'log', { wait, retryMs: 75 })).resolves.toBe(true);
    expect(fake.writes).toBe(2);
    expect(waits).toEqual([75]);
  });

  it('reports failure when every write is dropped, leaving the old content in place', async () => {
    const fake = fakeClipboard({ drops: 5 });
    await expect(copyVerified(fake.clipboard, 'log', { wait })).resolves.toBe(false);
    expect(fake.content).toBe('previous private text');
    expect(fake.writes).toBe(2);
  });

  it('reports failure, without throwing, when writes reject', async () => {
    const fake = fakeClipboard({ rejectWrites: true });
    await expect(copyVerified(fake.clipboard, 'log', { wait })).resolves.toBe(false);
  });

  it('accepts a read-back that differs only in line endings or trailing whitespace', async () => {
    const fake = fakeClipboard({ rewrite: text => text.replace(/\n/g, '\r\n') });
    await expect(copyVerified(fake.clipboard, 'a\nb\n', { wait })).resolves.toBe(true);
  });
});
