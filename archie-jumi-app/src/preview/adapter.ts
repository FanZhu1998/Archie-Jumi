import { defaultPreferences } from '../shared/defaults';
import { normalizePreferences, validCommand } from '../shared/validation';
import type { Bootstrap, DesktopAdapter, Lifecycle, PetCommand, PetId, Point, Preferences, Size } from '../shared/types';

const STATE_KEY = 'archie-jumi.preview.state.v1';
const RUNTIME_KEY = 'archie-jumi.preview.runtime.v1';
const CHANNEL_NAME = 'archie-jumi.preview.v1';
type Message =
  | { type: 'preferences'; preferences: Preferences }
  | { type: 'command'; command: PetCommand }
  | { type: 'runtime'; scene: Size; hidden: boolean; revision: number }
  | { type: 'request-state' };

const clamp = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};

/** Browser-only implementation of the same narrow bridge used by Electron. */
export function createPreviewAdapter(options: { scene?: Size; version?: string } = {}): DesktopAdapter {
  const settingsView = new URLSearchParams(window.location.search).get('view') !== 'overlay';
  let preferences = defaultPreferences();
  let scene: Size = options.scene ?? (settingsView ? { width: 1280, height: 800 } : { width: window.innerWidth, height: window.innerHeight });
  let hidden = false;
  let visibilityRevision = 0;
  let generation = 1;
  let canPersist = true;
  const notices = new Set<string>();
  const bootstrapListeners = new Set<(state: Bootstrap) => void>();
  const commandListeners = new Set<(command: PetCommand) => void>();
  const lifecycleListeners = new Set<(event: Lifecycle) => void>();
  let channel: BroadcastChannel | null = null;

  try {
    const raw = window.localStorage.getItem(STATE_KEY);
    if (raw) {
      const saved = record(JSON.parse(raw));
      if (saved.schemaVersion === 1) preferences = normalizePreferences(saved.preferences);
      else { canPersist = false; notices.add('This preview save uses a different version. Your saved data has been left untouched; changes apply to this session only.'); }
    }
    const runtime = record(JSON.parse(window.localStorage.getItem(RUNTIME_KEY) ?? '{}'));
    hidden = runtime.hidden === true;
    visibilityRevision = clamp(runtime.revision, 0, 0, Number.MAX_SAFE_INTEGER);
    if (settingsView) {
      const storedScene = record(runtime.scene);
      scene = { width: clamp(storedScene.width, scene.width, 240, 16384), height: clamp(storedScene.height, scene.height, 200, 16384) };
    }
  } catch {
    notices.add('Browser storage is unavailable or unreadable. This session can still be used.');
  }

  const bootstrap = (): Bootstrap => ({
    preferences: structuredClone(preferences),
    displays: [{ id: 'preview', label: 'Browser playground', width: scene.width, height: scene.height, scaleFactor: window.devicePixelRatio || 1, primary: true }],
    scene: { ...scene }, generation, hidden, paused: hidden, cursor: null,
    notices: [...notices], version: options.version ?? '1.0.0-preview', carryOver: null, scriptedCursor: false,
  });
  const notify = () => { const state = bootstrap(); bootstrapListeners.forEach(callback => callback(state)); };
  const post = (message: Message) => { try { channel?.postMessage(message); } catch { /* A closed preview tab must not stop the companion. */ } };
  const postRuntime = () => post({ type: 'runtime', scene, hidden, revision: visibilityRevision });
  const persist = () => {
    if (!canPersist) return;
    try { window.localStorage.setItem(STATE_KEY, JSON.stringify({ schemaVersion: 1, preferences })); }
    catch { notices.add('Your browser could not save these settings. They will last for this session.'); }
  };
  const persistRuntime = () => {
    try { window.localStorage.setItem(RUNTIME_KEY, JSON.stringify({ scene, hidden, revision: visibilityRevision })); } catch { /* The settings tab can use its fallback scene size. */ }
  };
  const setHidden = (next: boolean) => {
    if (next === hidden) return;
    hidden = next;
    lifecycleListeners.forEach(callback => callback({ type: next ? 'pause' : 'resume', cursor: null }));
    if (next) lifecycleListeners.forEach(callback => callback({ type: 'cancel-input' }));
    notify();
  };
  const receiveCommand = (input: PetCommand) => {
    const command = validCommand(input, scene);
    if (!command) return;
    if (command.type === 'hide' || command.type === 'show') {
      preferences.pets[command.petId].visible = command.type === 'show';
      persist();
      notify();
    }
    commandListeners.forEach(callback => callback(command));
  };
  const openSettings = (petId?: PetId) => {
    const url = new URL(window.location.href);
    url.searchParams.set('view', 'settings');
    if (petId) url.searchParams.set('pet', petId);
    window.open(url.toString(), 'archie-jumi-settings');
  };

  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent<Message>) => {
      const message = event.data;
      if (!message || typeof message !== 'object') return;
      if (message.type === 'preferences') {
        preferences = normalizePreferences(message.preferences, preferences);
        notify();
      } else if (message.type === 'command') receiveCommand(message.command);
      else if (message.type === 'runtime') {
        if (settingsView && message.scene?.width > 0 && message.scene?.height > 0) scene = message.scene;
        if (Number.isFinite(message.revision) && message.revision >= visibilityRevision) {
          visibilityRevision = message.revision;
          setHidden(message.hidden === true);
        }
        notify();
      } else if (message.type === 'request-state') {
        post({ type: 'preferences', preferences });
        if (!settingsView) postRuntime();
      }
    };
    post({ type: 'request-state' });
  } catch { notices.add('This browser cannot connect multiple preview tabs. Use one playground tab.'); }

  window.addEventListener('storage', event => {
    if (event.key === STATE_KEY && event.newValue) {
      try {
        const saved = record(JSON.parse(event.newValue));
        if (saved.schemaVersion === 1) { preferences = normalizePreferences(saved.preferences); notify(); }
      } catch { /* Do not replace current settings with a malformed storage event. */ }
    }
  });
  if (!settingsView) {
    persistRuntime();
    window.addEventListener('resize', () => {
      if (options.scene) return;
      scene = { width: window.innerWidth, height: window.innerHeight };
      generation += 1;
      lifecycleListeners.forEach(callback => callback({ type: 'cancel-input' }));
      persistRuntime();
      notify();
      postRuntime();
    });
  }
  window.addEventListener('pagehide', () => channel?.close(), { once: true });

  return {
    // No main process: the overlay trusts real pointer events and there is no cursor feed.
    cursorFeed: false,
    getBootstrap: async () => bootstrap(),
    savePreferences: async patch => {
      preferences = normalizePreferences(patch, preferences);
      persist();
      notify();
      post({ type: 'preferences', preferences });
      return bootstrap();
    },
    sendCommand: command => { receiveCommand(command); post({ type: 'command', command }); },
    setInputMode: () => {},
    ready: () => { notify(); if (!settingsView) postRuntime(); },
    heartbeat: () => {},
    setInterest: () => {},
    reportScene: () => {},
    savePositions: (positions: Record<PetId, Point>) => {
      for (const id of ['archie', 'jumi'] as const) {
        preferences.pets[id].position = { x: clamp(positions[id]?.x, preferences.pets[id].position.x, 0, 1), y: clamp(positions[id]?.y, preferences.pets[id].position.y, 0, 1) };
      }
      persist();
      notify();
      post({ type: 'preferences', preferences });
    },
    showPetMenu: openSettings,
    action: action => {
      if (action === 'settings') { openSettings(); return; }
      if (action === 'quit') { visibilityRevision += 1; setHidden(true); persistRuntime(); postRuntime(); return; }
      const next = action === 'toggle-hidden' ? !hidden : action === 'hide';
      visibilityRevision += 1;
      setHidden(next);
      persistRuntime();
      postRuntime();
    },
    copyDiagnostics: async () => ({ ok: false, message: 'Diagnostics are available in the desktop app.' }),
    onBootstrap: callback => { bootstrapListeners.add(callback); return () => bootstrapListeners.delete(callback); },
    onCommand: callback => { commandListeners.add(callback); return () => commandListeners.delete(callback); },
    onLifecycle: callback => { lifecycleListeners.add(callback); return () => lifecycleListeners.delete(callback); },
    onCursor: () => () => {},
  };
}
