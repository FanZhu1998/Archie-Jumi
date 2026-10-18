import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPreviewAdapter } from '../src/preview/adapter';
import type { PetCommand } from '../src/shared/types';

const stateKey = 'archie-jumi.preview.state.v1';
class MemoryStorage {
  data = new Map<string, string>();
  fail = false;
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.fail) throw new Error('Quota exceeded'); this.data.set(key, value); }
}
class TestChannel {
  static channels = new Set<TestChannel>();
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(public name: string) { TestChannel.channels.add(this); }
  postMessage(data: unknown) {
    for (const other of TestChannel.channels) {
      if (other !== this && other.name === this.name) queueMicrotask(() => other.onmessage?.({ data: structuredClone(data) }));
    }
  }
  close() { TestChannel.channels.delete(this); }
}
class TestWindow extends EventTarget {
  location: { search: string; href: string };
  innerWidth = 1200;
  innerHeight = 800;
  devicePixelRatio = 1.5;
  open = vi.fn();
  constructor(public localStorage: MemoryStorage, view: string) {
    super();
    this.location = { search: `?view=${view}`, href: `http://localhost:5173/?view=${view}` };
  }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
let storage: MemoryStorage;
const setWindow = (view = 'overlay') => { const win = new TestWindow(storage, view); vi.stubGlobal('window', win); return win; };

beforeEach(() => { storage = new MemoryStorage(); TestChannel.channels.clear(); vi.stubGlobal('BroadcastChannel', TestChannel); setWindow(); });
afterEach(() => { TestChannel.channels.clear(); vi.unstubAllGlobals(); });

describe('browser preview adapter', () => {
  it('restores settings after a reload without losing the other kitten', async () => {
    const adapter = createPreviewAdapter();
    const initial = await adapter.getBootstrap();
    await adapter.savePreferences({ sound: true, pets: { ...initial.preferences.pets, archie: { ...initial.preferences.pets.archie, name: 'Archibald', size: 176 } } });
    const restored = await createPreviewAdapter().getBootstrap();
    expect(restored.preferences.sound).toBe(true);
    expect(restored.preferences.pets.archie.name).toBe('Archibald');
    expect(restored.preferences.pets.archie.size).toBe(176);
    expect(restored.preferences.pets.jumi.name).toBe('Jumi');
  });

  it('sends settings, commands and visibility between settings and playground tabs', async () => {
    const playground = createPreviewAdapter();
    setWindow('settings');
    const settings = createPreviewAdapter();
    const commands: PetCommand[] = [];
    const events: string[] = [];
    playground.onCommand(command => commands.push(command));
    playground.onLifecycle(event => events.push(event.type));
    await settle();
    await settings.savePreferences({ quiet: true });
    settings.sendCommand({ type: 'play', petId: 'jumi', automatic: true });
    settings.action('hide');
    await settle();
    expect((await playground.getBootstrap()).preferences.quiet).toBe(true);
    expect(commands).toEqual([{ type: 'play', petId: 'jumi', automatic: true }]);
    expect((await playground.getBootstrap()).hidden).toBe(true);
    expect(events).toContain('pause');
    settings.action('show');
    await settle();
    expect(events).toContain('resume');
    expect((await playground.getBootstrap()).hidden).toBe(false);
  });

  it('tracks playground geometry rather than the settings-tab viewport', async () => {
    const win = setWindow();
    const playground = createPreviewAdapter();
    setWindow('settings');
    const settings = createPreviewAdapter();
    await settle();
    vi.stubGlobal('window', win);
    win.innerWidth = 1600;
    win.innerHeight = 900;
    win.dispatchEvent(new Event('resize'));
    await settle();
    expect((await playground.getBootstrap()).generation).toBe(2);
    expect((await settings.getBootstrap()).scene).toEqual({ width: 1600, height: 900 });
  });

  it('leaves an unknown newer save intact while allowing temporary preferences', async () => {
    const future = JSON.stringify({ schemaVersion: 90, specialData: 'keep me' });
    storage.setItem(stateKey, future);
    const adapter = createPreviewAdapter();
    const result = await adapter.savePreferences({ sound: true });
    expect(result.preferences.sound).toBe(true);
    expect(result.notices.join(' ')).toContain('this session only');
    expect(storage.getItem(stateKey)).toBe(future);
  });

  it('does not let a stale playground startup reverse a visibility action', async () => {
    setWindow('settings');
    const settings = createPreviewAdapter();
    settings.action('hide');
    const oldPlayground = new TestChannel('archie-jumi.preview.v1');
    oldPlayground.postMessage({ type: 'runtime', scene: { width: 1200, height: 800 }, hidden: false, revision: 0 });
    await settle();
    expect((await settings.getBootstrap()).hidden).toBe(true);
    settings.action('show');
    expect((await settings.getBootstrap()).hidden).toBe(false);
  });

  it('refreshes the renderer after a hidden-state change during asset loading', async () => {
    const adapter = createPreviewAdapter();
    const captured = await adapter.getBootstrap();
    expect(captured.hidden).toBe(false);
    adapter.action('hide');
    const listener = vi.fn();
    adapter.onBootstrap(listener);
    adapter.ready(captured.generation);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ hidden: true }));
  });

  it('keeps working and reports a failed local save', async () => {
    const adapter = createPreviewAdapter();
    storage.fail = true;
    const result = await adapter.savePreferences({ reducedMotion: true });
    expect(result.preferences.reducedMotion).toBe(true);
    expect(result.notices.join(' ')).toContain('could not save');
  });

  it('ignores malformed commands and clips pointer commands to the scene', async () => {
    const adapter = createPreviewAdapter();
    const commands: PetCommand[] = [];
    adapter.onCommand(command => commands.push(command));
    adapter.sendCommand({ type: 'hide', petId: 'unknown' } as unknown as PetCommand);
    adapter.sendCommand({ type: 'move', petId: 'archie', point: { x: -100, y: 10000 } });
    expect(commands).toEqual([{ type: 'move', petId: 'archie', point: { x: 0, y: 800 } }]);
  });

  it('saves normalized positions and supports listener cleanup', async () => {
    const adapter = createPreviewAdapter();
    const listener = vi.fn();
    const unsubscribe = adapter.onBootstrap(listener);
    adapter.savePositions({ archie: { x: -0.1, y: 1.2 }, jumi: { x: 0.7, y: 0.3 } });
    expect(listener).toHaveBeenCalledOnce();
    expect((await adapter.getBootstrap()).preferences.pets.archie.position).toEqual({ x: 0, y: 1 });
    unsubscribe();
    await adapter.savePreferences({ sound: true });
    expect(listener).toHaveBeenCalledOnce();
  });
});
