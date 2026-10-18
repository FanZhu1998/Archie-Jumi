import { app, BrowserWindow, Tray, Menu, screen, ipcMain, globalShortcut, powerMonitor, nativeImage, clipboard, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type Rectangle } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import { join } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { release } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { StateStore } from './storage';
import { windowsLoginTarget } from './login-item';
import { CursorFeed } from './cursor-feed';
import { HOVER_GUARD_MS, decideInput, ignoreOptionsFor, needsFreshSample, parseInputRouting, type InputDecision, type InputRouting } from './input-routing';
import { HeartbeatWatchdog, RecoveryBudget, RECOVERY_LIMIT } from './watchdog';
import { DiagnosticsLog, copyVerified, type DiagnosticsDetails } from './diagnostics';
import { displayRecreateReason, snapshotDisplay, type DisplaySnapshot } from './display-policy';
import { defaultPreferences } from '../shared/defaults';
import { normalizePreferences, validCommand } from '../shared/validation';
import { validHeartbeat, validInputModePayload, validInterest, validSceneState } from '../shared/ipc';
import { PET_IDS, type Bootstrap, type PetId, type Preferences, type PetCommand, type Lifecycle, type Point, type SceneCarryOver, type DiagnosticsResult } from '../shared/types';

const smoke = process.argv.includes('--smoke-test');
const hookLossCheck = smoke && process.argv.includes('--hook-loss-check');
const smokeOutput = process.argv.find(v => v.startsWith('--smoke-output='))?.slice('--smoke-output='.length) ?? join(process.cwd(), 'test-results');
if (smoke) app.setPath('userData', join(smokeOutput, 'profile'));
// Chromium's native occlusion tracking can treat a covered transparent overlay as hidden and
// starve requestAnimationFrame. It stays off unless --native-occlusion asks for it (plan F6).
const nativeOcclusion = process.argv.includes('--native-occlusion');
if (!nativeOcclusion) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const APP_ID = 'com.squirrel.archie_jumi.archie-jumi';
app.setAppUserModelId(APP_ID);
let overlay: BrowserWindow | null = null, settings: BrowserWindow | null = null, tray: Tray | null = null;
let preferences = defaultPreferences(), generation = 0, hidden = false, paused = false, sceneReady = false;
let quitting = false, flushed = false, saveTimer: NodeJS.Timeout | undefined;
let runtimeNotices: string[] = [], inputMode = { target: null as PetId | 'toy' | null, capture: false };
let store: StateStore;
const rendererFile = join(__dirname, 'renderer', 'index.html');
const getDisplay = () => screen.getAllDisplays().find(d => String(d.id) === preferences.selectedDisplay) ?? screen.getPrimaryDisplay();
const getScene = () => ({ width: getDisplay().workArea.width, height: getDisplay().workArea.height });

// Input routing, cursor feed, watchdog, recovery and diagnostics (1.0.2).
/** Watchdog grace after creation, scene-ready, show, power resume/unlock and display handling. */
const GRACE_MS = 10_000;
/** How long a healthy overlay may take to report its scene before it is replaced anyway. */
const HANDOFF_MS = 250;
const REARM_INTERVAL_MS = 60_000;
/** Smoke tests script the cursor (screen DIP) so the real pointer never influences their results. */
const FAR_AWAY: Point = { x: -1e6, y: -1e6 };
/**
 * The notice shown when the recovery budget is used up, one per trigger (the smoke test checks each
 * trigger's own). Each starts with 'The pet scene', which the next one and Show All replace.
 */
const SCENE_NOTICE = {
  renderGone: 'The pet scene stopped. Use Show All to bring your kittens back.',
  unresponsive: 'The pet scene paused unexpectedly. Use Show All to restore it.',
  stoppedResponding: 'The pet scene stopped responding. Use Show All to restore it.',
  gpuGone: 'The pet scene lost its graphics connection. Use Show All to restore it.',
  startupTimeout: 'The pet scene could not start. Reopen the app or restore its bundled animation files.',
} as const;
/** Copy diagnostics replies to the settings window. */
const COPY_DONE = 'Diagnostics copied to the clipboard.', COPY_BUSY = 'The clipboard is busy. Please try again.';
let inputRouting: InputRouting = hookLossCheck ? 'hybrid' : parseInputRouting(process.argv);
let interactive = false, lastDecision: InputDecision = { interactive: false, reason: 'not-ready' }, interactiveChangedAt = 0;
let recovering = false, recoveryGeneration = -1, recoveryTimer: NodeJS.Timeout | undefined, recoveries = 0;
let handoff: { generation: number; trigger: string; timer: NodeJS.Timeout } | null = null;
let carryOver: SceneCarryOver | null = null;
let overlayDisplay: DisplaySnapshot | null = null;
let overlayOrigin: Point | null = null;
let scriptedCursor: Point | null = smoke ? { ...FAR_AWAY } : null;
/** Smoke tests never touch the real clipboard: this stand-in drops writes while `busy`, as a clipboard held by another program does. */
const smokeClipboard = {
  busy: false,
  text: '',
  async writeText(text: string) { if (!smokeClipboard.busy) smokeClipboard.text = text; },
  async readText() { return smokeClipboard.text; },
};
let lastRearmAt = 0, hoverGuardTrips = 0, heartbeatResyncs = 0, displayEventsIgnored = 0;
let lastHandoff: { generation: number; outcome: 'reported' | 'timeout' } | null = null;
interface NativeIgnore { ignore: boolean; forward: boolean }
/** What main last applied with setIgnoreMouseEvents (null without an overlay), plus the newest calls for smoke checks. */
let nativeIgnore: NativeIgnore | null = null, nativeWrites = 0;
const nativeLog: NativeIgnore[] = [];
const invalidIpc: Record<string, number> = {};
const diagnostics = new DiagnosticsLog(app.getPath('userData'), { context: diagnosticsContext });
const watchdog = new HeartbeatWatchdog(() => performance.now());
const budget = new RecoveryBudget();
const cursorSource = (): Point | null => scriptedCursor ? { ...scriptedCursor } : screen.getCursorScreenPoint();
const feed = new CursorFeed({
  source: cursorSource,
  origin: () => overlayOrigin,
  send: message => { sendTo(overlay, 'cursor', { generation, ...message }); },
  now: () => performance.now(),
  // Feed samples matter to the decision only for a stored hover report (the hover guard), so the
  // steady state costs one cursor read per tick. The heartbeat still re-decides every second.
  onSample: () => { if (inputMode.target !== null && !inputMode.capture) applyInputMode('feed'); },
});

function bootstrap(): Bootstrap {
  const cursor = cursorScene();
  // A renderer being recovered or handed off stays paused (no drawing or IPC while hidden); the
  // replacement is resumed by scene-ready, which clears `recovering` first.
  const rendererPaused = paused || recovering || handoff !== null;
  return { preferences: structuredClone(preferences), scene: getScene(), generation, hidden, paused: rendererPaused, cursor, version: app.getVersion(), notices: [...store.notices, ...runtimeNotices], displays: screen.getAllDisplays().map(d => ({ id: String(d.id), label: d.label || `Display ${d.id}`, width: d.workArea.width, height: d.workArea.height, scaleFactor: d.scaleFactor, primary: d.id === screen.getPrimaryDisplay().id })), carryOver: carryOver ? structuredClone(carryOver) : null, scriptedCursor: scriptedCursor !== null };
}
function sendBootstrap() {
  for (const w of [overlay, settings]) sendTo(w, 'bootstrap-update', bootstrap());
  updateTray();
}
function lifecycle(event: Lifecycle) { sendTo(overlay, 'lifecycle', event); }
/** Clears the stored renderer report, then forces the authoritative decision onto the window. */
function safeInput(reason = 'safe-input') {
  inputMode = { target: null, capture: false };
  applyInputMode(reason, true);
}
/** Sends only while the renderer can receive: never to a destroyed or crashed window. */
function sendTo(win: BrowserWindow | null, channel: string, payload: unknown): boolean {
  if (!win || win.isDestroyed()) return false;
  const contents = win.webContents;
  if (!contents || contents.isDestroyed() || contents.isCrashed()) return false;
  try {
    contents.send(channel, payload);
    return true;
  } catch {
    return false;
  }
}
const overlayAlive = (): boolean => overlay !== null && !overlay.isDestroyed();
const overlayVisible = (): boolean => overlayAlive() && overlay!.isVisible();
const overlayScene = () => overlayDisplay ? { width: overlayDisplay.workArea.width, height: overlayDisplay.workArea.height } : getScene();
/** The scene should be animating and observed: ready, shown, not hidden, paused or recovering. */
const sceneRunning = (): boolean => sceneReady && overlayVisible() && !hidden && !paused && !recovering;
/** The cursor in scene DIP, from the same source the feed uses (scripted in smoke tests). */
function cursorScene(): Point | null {
  try {
    const point = cursorSource(), origin = overlayOrigin ?? getDisplay().workArea;
    return point ? { x: point.x - origin.x, y: point.y - origin.y } : null;
  } catch {
    return null;
  }
}
function stopFeed(reason: string) {
  if (!feed.active()) return;
  feed.stop();
  // The renderer may still believe the cursor is inside; resynchronize it with the stopped feed.
  sendTo(overlay, 'cursor', { generation, inside: false });
  diagnostics.log('feed-stop', { generation, reason });
}
/** Runs the cursor feed and arms the watchdog exactly while the scene is running. */
function syncRuntime(reason: string) {
  const running = sceneRunning();
  if (running && !preferences.quiet) {
    if (!feed.active()) {
      feed.start();
      diagnostics.log('feed-start', { generation, reason });
    }
  } else {
    stopFeed(reason);
  }
  watchdog.arm(running);
}
/**
 * The single authoritative input decision (plan F3). Every transition calls it; the native
 * click-through state changes only when the decision changes, or when forced.
 */
function applyInputMode(reason: string, force = false) {
  syncRuntime(reason);
  const decision = decideInput({
    sceneReady, overlayVisible: overlayVisible(), hidden, paused, quiet: preferences.quiet, recovering, report: inputMode,
    feedActive: feed.active(), cursorInsideInterest: feed.insideInterest(), outsideSinceMs: feed.outsideSince(), nowMs: performance.now(),
  });
  if (decision.reason === 'hover-guard' && lastDecision.reason !== 'hover-guard') {
    hoverGuardTrips++;
    diagnostics.log('hover-guard', { generation, target: inputMode.target, trigger: reason });
  }
  lastDecision = decision;
  const changed = decision.interactive !== interactive;
  if (!changed && !force) return;
  interactive = decision.interactive;
  writeIgnore(!interactive, ignoreOptionsFor(inputRouting));
  if (changed) {
    interactiveChangedAt = performance.now();
    diagnostics.log(interactive ? 'interactive-on' : 'interactive-off', { generation, reason: decision.reason, trigger: reason });
  }
}
/**
 * The only caller of setIgnoreMouseEvents, so the recorded native state always matches the calls
 * actually made. Returns false without an overlay or when Electron throws.
 */
function writeIgnore(ignore: boolean, options?: { forward: true }): boolean {
  if (!overlayAlive()) return false;
  try {
    if (options) overlay!.setIgnoreMouseEvents(ignore, options);
    else overlay!.setIgnoreMouseEvents(ignore);
  } catch {
    diagnostics.log('input-mode-error', { generation });
    return false;
  }
  nativeIgnore = { ignore, forward: options?.forward === true };
  nativeWrites++;
  nativeLog.push(nativeIgnore);
  if (nativeLog.length > 16) nativeLog.shift();
  return true;
}
/** Main's interactive flag and the native click-through call agree (forwarding exactly in hybrid mode). */
const nativeInSync = (): boolean => nativeIgnore !== null && nativeIgnore.ignore === !interactive && nativeIgnore.forward === (inputRouting === 'hybrid');
/**
 * Hybrid mode only (plan F2): reinstall Electron's mouse-forwarding hook, which Windows silently
 * removes when a callback misses its timeout. Turning forwarding off unhooks the stale handle; the
 * forced decision right after applies click-through with forwarding again from main's own state,
 * which installs a fresh hook. Both run in the same tick with no await, so no message pump runs in
 * between and no click can leak through.
 */
function rearmForwarding(reason: string): boolean {
  if (inputRouting !== 'hybrid' || !overlayVisible()) return false;
  applyInputMode(`rearm:${reason}`);
  if (interactive) return false;
  const off = writeIgnore(false);
  applyInputMode(`rearm:${reason}`, true);
  // A half-done re-arm must never leave the window interactive.
  if (!nativeInSync()) applyInputMode('rearm-error', true);
  const ok = off && nativeInSync();
  lastRearmAt = performance.now();
  diagnostics.log(ok ? 'rearm' : 'rearm-error', { generation, reason });
  return ok;
}
/** Smoke and opt-in checks only; not exposed over IPC or in the UI. */
function setInputRouting(mode: InputRouting) {
  if (mode === inputRouting) return;
  inputRouting = mode;
  diagnostics.log('input-routing', { mode });
  applyInputMode('input-routing', true);
}
const rectText = (r: Rectangle) => `${r.x},${r.y} ${r.width}x${r.height}`;
/** R7: overlay bounds versus its work area, logged on every creation and scene-ready. */
function geometry(win: BrowserWindow | null): DiagnosticsDetails {
  if (!win || win.isDestroyed()) return {};
  return { bounds: rectText(win.getBounds()), contentBounds: rectText(win.getContentBounds()), workArea: overlayDisplay ? rectText(overlayDisplay.workArea) : null, scaleFactor: overlayDisplay?.scaleFactor ?? null };
}
/** Invalid payloads are dropped; only a per-channel count is kept (logged at 1, 10, 100, then every 1000). */
function invalidPayload(channel: string) {
  const count = (invalidIpc[channel] ?? 0) + 1;
  invalidIpc[channel] = count;
  if (count === 1 || count === 10 || count === 100 || count % 1000 === 0) diagnostics.log('invalid-ipc', { channel, count });
}
function diagnosticsContext() {
  const displays = app.isReady() ? screen.getAllDisplays() : [];
  return {
    appVersion: app.getVersion(), electron: process.versions.electron ?? 'unknown', chrome: process.versions.chrome ?? 'unknown', os: `${process.platform} ${release()}`,
    inputRouting, occlusion: nativeOcclusion ? 'enabled (--native-occlusion)' : 'disabled',
    displays: { count: displays.length, scaleFactors: displays.map(d => d.scaleFactor) },
  };
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { store.save({ schemaVersion: 1, preferences }).catch(error => { diagnostics.log('save-failed', { code: String((error as NodeJS.ErrnoException)?.code ?? 'unknown') }); runtimeNotices = [...runtimeNotices.filter(n => !n.startsWith('Could not save')), 'Could not save your preferences. This session still works; check disk space and folder access.']; sendBootstrap(); }); }, 400);
}
function secureWindow(window: BrowserWindow) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
  window.webContents.session.setSpellCheckerEnabled(false);
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !['file:', 'data:', 'blob:', 'devtools:'].some(protocol => details.url.startsWith(protocol)) }));
}
/** Detaches, then destroys the overlay; its renderer process goes with it, even a hung one. */
function discardOverlay() {
  // Detach first: a synchronous 'closed' or 'render-process-gone' from destroy() must not look like the live overlay.
  const previous = overlay; overlay = null; nativeIgnore = null;
  if (previous && !previous.isDestroyed()) { previous.hide(); previous.destroy(); }
}
function createOverlay(trigger = 'startup') {
  cancelHandoff();
  clearTimeout(recoveryTimer); recoveryTimer = undefined;
  sceneReady = false;
  lifecycle({ type: 'cancel-input' });
  stopFeed('overlay-replace');
  discardOverlay();
  generation++;
  inputMode = { target: null, capture: false };
  feed.setRegion([]);
  const display = getDisplay(), bounds = display.workArea;
  overlayDisplay = snapshotDisplay(display);
  const win = new BrowserWindow({ ...bounds, show: false, transparent: true, backgroundColor: '#00000000', frame: false, resizable: false, movable: false, focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  overlay = win;
  // Feed origin: cached at creation and refreshed when the window moves or resizes.
  const updateOrigin = () => { if (overlay === win && !win.isDestroyed()) { const { x, y } = win.getContentBounds(); overlayOrigin = { x, y }; } };
  updateOrigin();
  win.on('move', updateOrigin); win.on('resize', updateOrigin);
  secureWindow(win);
  safeInput('overlay-create');
  win.webContents.on('render-process-gone', (_event, details) => {
    if (overlay !== win) return;
    diagnostics.log('render-gone', { generation, reason: details.reason, exitCode: details.exitCode });
    if (details.reason !== 'clean-exit') recover('render-gone', SCENE_NOTICE.renderGone);
  });
  win.on('unresponsive', () => {
    if (overlay !== win) return;
    diagnostics.log('unresponsive', { generation });
    recover('unresponsive', SCENE_NOTICE.unresponsive);
  });
  win.on('closed', () => { if (overlay === win) { overlay = null; applyInputMode('overlay-closed'); } });
  void win.loadFile(rendererFile, { query: { view: 'overlay' } });
  watchdog.grace(GRACE_MS);
  diagnostics.log('overlay-create', { generation, trigger, routing: inputRouting, ...geometry(win) });
  // A recovery attempt that never starts must also count, even if the user hid the kittens meanwhile.
  setTimeout(() => { if (overlay === win && !sceneReady && (!hidden || recovering)) recover('startup-timeout', SCENE_NOTICE.startupTimeout); }, 15000).unref();
}
/**
 * Replaces a healthy overlay after a short handoff: the renderer is paused first, so it reports
 * current positions and scene state (bounded wait). A dead or missing overlay is replaced at once.
 */
function recreateOverlay(trigger: string) {
  // Hidden with no overlay (the recovery budget ran out): Show All builds it on the current display.
  // A hidden overlay is not watched, so building one now could leak a hung renderer again.
  if (hidden && !recovering && !overlayAlive()) { diagnostics.log('recreate-deferred', { generation, trigger }); return; }
  if (!overlayAlive() || !sceneReady || recovering || overlay!.webContents.isCrashed()) { createOverlay(trigger); return; }
  cancelHandoff();
  const forGeneration = generation;
  sceneReady = false;
  safeInput(`handoff:${trigger}`);
  lifecycle({ type: 'pause' });
  handoff = { generation: forGeneration, trigger, timer: setTimeout(() => finishHandoff('timeout'), HANDOFF_MS) };
}
function finishHandoff(outcome: 'reported' | 'timeout') {
  if (!handoff) return;
  const { trigger, generation: forGeneration } = handoff;
  cancelHandoff();
  lastHandoff = { generation: forGeneration, outcome };
  diagnostics.log('handoff', { generation: forGeneration, outcome });
  createOverlay(trigger);
}
function cancelHandoff() {
  if (!handoff) return;
  clearTimeout(handoff.timer);
  handoff = null;
}
function openSettings() {
  if (settings && !settings.isDestroyed()) { settings.show(); settings.focus(); sendTo(settings, 'bootstrap-update', bootstrap()); return; }
  settings = new BrowserWindow({ width: 1080, height: 850, minWidth: 720, minHeight: 600, title: 'Archie & Jumi', backgroundColor: '#f7f4ee', icon: join(__dirname, 'icon.png'), show: false, autoHideMenuBar: true, webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  secureWindow(settings);
  settings.on('ready-to-show', () => settings?.show());
  settings.on('closed', () => { settings = null; });
  void settings.loadFile(rendererFile, { query: { view: 'settings' } });
}
function setHidden(value: boolean) {
  hidden = value; safeInput(value ? 'hide' : 'show');
  diagnostics.log(value ? 'hide' : 'show', { generation, recovering });
  if (value) { lifecycle({ type: 'pause' }); if (overlayAlive()) overlay!.hide(); }
  else {
    // A manual Show All starts a fresh recovery budget and gets the same re-asserts as a power resume.
    budget.reset();
    watchdog.grace(GRACE_MS);
    if (recovering) { if (recoveryTimer) createOverlay('show'); }
    else if (!overlay || overlay.isDestroyed() || !sceneReady) createOverlay('show');
    else if (!paused) { lifecycle({ type: 'resume', cursor: cursorScene() }); overlay.showInactive(); overlay.setAlwaysOnTop(true); }
    runtimeNotices = runtimeNotices.filter(n => !n.startsWith('The pet scene'));
    applyInputMode('show', true);
    rearmForwarding('show');
  }
  sendBootstrap();
}
/**
 * Automatic recovery (plan F4): hide the broken scene at once, then recreate it after a short,
 * growing delay. The user's `hidden` choice is never flipped while that works; only when the
 * budget is used up do the kittens stay hidden with a notice until Show All.
 */
function recover(trigger: string, notice: string) {
  if (recovering && recoveryGeneration === generation) return; // this overlay's recovery is already under way
  recovering = true; recoveryGeneration = generation; sceneReady = false; recoveries++;
  cancelHandoff();
  safeInput(`recover:${trigger}`);
  if (overlayAlive()) overlay!.hide();
  lifecycle({ type: 'pause' });
  const attempt = budget.next(performance.now());
  diagnostics.log('recover', { trigger, generation, allowed: attempt.allowed, delayMs: attempt.allowed ? attempt.delayMs : null });
  if (attempt.allowed) {
    clearTimeout(recoveryTimer);
    recoveryTimer = setTimeout(() => { recoveryTimer = undefined; if (recovering && !quitting) createOverlay(`recover:${trigger}`); }, attempt.delayMs);
  } else {
    recovering = false; hidden = true;
    // Tear the failed overlay down: a hung renderer would otherwise keep spinning while hidden,
    // unwatched, until Show All. Show All creates a fresh overlay.
    discardOverlay();
    runtimeNotices = [...runtimeNotices.filter(n => !n.startsWith('The pet scene')), notice];
    diagnostics.log('budget-exhausted', { trigger, generation });
    applyInputMode('budget-exhausted', true);
    if (trigger === 'startup-timeout') openSettings();
  }
  sendBootstrap();
}
function applyCommand(command: PetCommand) {
  if ('petId' in command && (command.type === 'show' || command.type === 'hide')) {
    preferences.pets[command.petId].visible = command.type === 'show'; scheduleSave(); sendBootstrap();
  }
  sendTo(overlay, 'pet-command', command);
}
function petItems(id: PetId): MenuItemConstructorOptions[] {
  return [
    { label: 'Pet', click: () => applyCommand({ type: 'pet', petId: id }) },
    { label: 'Give a treat', click: () => applyCommand({ type: 'treat', petId: id }) },
    { label: 'Play with yarn', click: () => applyCommand({ type: 'play', petId: id, automatic: false }) },
    { label: 'Automatic yarn play', click: () => applyCommand({ type: 'play', petId: id, automatic: true }) },
    { label: 'Nap', click: () => applyCommand({ type: 'nap', petId: id }) },
    { label: 'Wake', click: () => applyCommand({ type: 'wake', petId: id }) },
    { label: 'Reposition…', click: openSettings },
    { type: 'separator' },
    { label: preferences.pets[id].visible ? 'Hide kitten' : 'Show kitten', click: () => applyCommand({ type: preferences.pets[id].visible ? 'hide' : 'show', petId: id }) }
  ];
}
function updateTray() {
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: hidden ? 'Show All' : 'Hide All', click: () => setHidden(!hidden) },
    { label: 'Quiet Mode', type: 'checkbox', checked: preferences.quiet, click: () => updatePreferences({ quiet: !preferences.quiet }) },
    { type: 'separator' },
    ...PET_IDS.map(id => ({ label: preferences.pets[id].name, submenu: petItems(id) })),
    { label: 'End Play', click: () => applyCommand({ type: 'end-play' }) },
    { label: 'Monitor', submenu: screen.getAllDisplays().map(d => ({ label: `${d.label || 'Display'} · ${d.workArea.width} × ${d.workArea.height}`, type: 'radio' as const, checked: getDisplay().id === d.id, click: () => updatePreferences({ selectedDisplay: String(d.id) }) })) },
    { type: 'separator' }, { label: 'Settings', click: openSettings }, { label: 'Quit', click: () => app.quit() }
  ]));
}
function registerShortcut() {
  globalShortcut.unregisterAll();
  runtimeNotices = runtimeNotices.filter(n => !n.startsWith('Shortcut'));
  try { if (!globalShortcut.register(preferences.shortcut, () => setHidden(!hidden))) throw new Error('Unavailable'); }
  catch { runtimeNotices.push('Shortcut unavailable. Choose another combination in Settings; the tray menu still works.'); }
}
function configureLoginItem(openAtLogin: boolean, preserveApproval = false) {
  const target = windowsLoginTarget(process.execPath);
  // Electron returns approval only for matching executable paths. Never guess
  // that an unknown older registration is enabled and override an OS disable.
  const candidates = preserveApproval ? [
    ...app.getLoginItemSettings(target).launchItems,
    ...app.getLoginItemSettings({ path: process.execPath, args: target.args }).launchItems,
  ] : [];
  const existing = candidates.find(item => item.name === APP_ID && item.scope === 'user');
  if (preserveApproval && !existing) return;
  app.setLoginItemSettings({ openAtLogin, name: APP_ID, ...target, enabled: existing?.enabled ?? true });
}
function updatePreferences(patch: unknown) {
  const old = preferences; preferences = normalizePreferences(patch, preferences);
  if (preferences.shortcut !== old.shortcut) registerShortcut();
  if (preferences.launchAtLogin !== old.launchAtLogin) {
    if (app.isPackaged && !smoke && process.platform === 'win32') {
      try { configureLoginItem(preferences.launchAtLogin); runtimeNotices = runtimeNotices.filter(n => !n.startsWith('Launch at login')); }
      catch { preferences.launchAtLogin = old.launchAtLogin; runtimeNotices = [...runtimeNotices.filter(n => !n.startsWith('Launch at login')), 'Launch at login could not be changed. Check Windows startup settings and try again.']; }
    }
    else { preferences.launchAtLogin = false; runtimeNotices = [...runtimeNotices.filter(n => !n.startsWith('Launch at login')), 'Launch at login is available in the installed app.']; }
  }
  if (preferences.selectedDisplay !== old.selectedDisplay) recreateOverlay('display-selected');
  if (preferences.quiet) safeInput('quiet'); else applyInputMode(old.quiet ? 'quiet-off' : 'preferences', old.quiet);
  scheduleSave(); sendBootstrap(); return bootstrap();
}
/**
 * Stores the renderer's latest report, even while hidden, paused or quiet: the decision, not the
 * IPC handler, decides whether it applies. A hover report is judged against a cursor sample taken
 * after it arrived, never an older one, so a fast entry does not trip the hover guard.
 */
function storeReport(report: { target: PetId | 'toy' | null; capture: boolean }, trigger: string) {
  inputMode = { target: report.target, capture: report.capture };
  if (needsFreshSample(inputMode, feed.active(), feed.insideInterest())) feed.sampleNow();
  applyInputMode(trigger);
}
/** A heartbeat changed main's copy of the report: the two sides had diverged (logged at 1, 10, 100, then every 1000). */
function countResync() {
  heartbeatResyncs++;
  if (heartbeatResyncs === 1 || heartbeatResyncs === 10 || heartbeatResyncs === 100 || heartbeatResyncs % 1000 === 0) diagnostics.log('input-resync', { generation, count: heartbeatResyncs });
}
type SenderEvent = IpcMainEvent | IpcMainInvokeEvent;
function isSender(event: SenderEvent, role?: 'overlay' | 'settings'): boolean {
  const windows = role ? [role === 'overlay' ? overlay : settings] : [overlay, settings];
  return windows.some(w => w && !w.isDestroyed() && event.sender === w.webContents && event.senderFrame === w.webContents.mainFrame);
}
function installIpc() {
  ipcMain.handle('bootstrap', event => { if (!isSender(event)) throw new Error('Unknown sender'); return bootstrap(); });
  ipcMain.handle('preferences', (event, patch) => { if (!isSender(event, 'settings')) throw new Error('Unknown sender'); return updatePreferences(patch); });
  ipcMain.on('command', (event, payload) => { if (!isSender(event)) return; const command = validCommand(payload, getScene()); if (command) applyCommand(command); });
  ipcMain.on('input-mode', (event, payload) => {
    if (!isSender(event, 'overlay')) return;
    const report = validInputModePayload(payload);
    if (!report) { invalidPayload('input-mode'); return; }
    if (report.generation !== generation) return;
    storeReport(report, 'input-mode');
  });
  ipcMain.on('scene-ready', (event, value) => {
    if (!isSender(event, 'overlay') || value !== generation) return;
    sceneReady = true;
    watchdog.grace(GRACE_MS);
    if (recovering) { recovering = false; diagnostics.log('recovery-success', { generation }); }
    // Preferences/visibility can change while sprite atlases are loading.
    sendTo(overlay, 'bootstrap-update', bootstrap());
    if (!hidden && !paused && overlayAlive()) { overlay!.showInactive(); lifecycle({ type: 'resume', cursor: cursorScene() }); }
    applyInputMode('scene-ready', true);
    diagnostics.log('scene-ready', { generation, ...geometry(overlay) });
  });
  ipcMain.on('heartbeat', (event, payload) => {
    if (!isSender(event, 'overlay')) return;
    const beat = validHeartbeat(payload);
    if (!beat) { invalidPayload('heartbeat'); return; }
    if (beat.generation !== generation) return;
    const streak = watchdog.misses;
    watchdog.beat(beat.frames);
    if (streak >= 2) diagnostics.log('heartbeat-resumed', { generation, misses: streak });
    // Resync (plan F3): every beat carries the renderer's current input report.
    if (beat.target !== inputMode.target || beat.capture !== inputMode.capture) countResync();
    storeReport(beat, 'heartbeat');
  });
  ipcMain.on('interest', (event, payload) => {
    if (!isSender(event, 'overlay')) return;
    const interest = validInterest(payload, overlayScene());
    if (!interest) { invalidPayload('interest'); return; }
    if (interest.generation === generation) feed.setRegion(interest.rects);
  });
  ipcMain.on('scene-state', (event, payload) => {
    if (!isSender(event, 'overlay')) return;
    const scene = validSceneState(payload);
    if (!scene) { invalidPayload('scene-state'); return; }
    if (scene.generation !== generation) return;
    carryOver = scene;
    if (handoff?.generation === scene.generation) finishHandoff('reported');
  });
  ipcMain.handle('diagnostics', async (event): Promise<DiagnosticsResult> => {
    if (!isSender(event, 'settings')) throw new Error('Unknown sender');
    const entries = diagnostics.count;
    let copied = false;
    try { copied = await copyVerified(smoke ? smokeClipboard : clipboard, diagnostics.text()); } catch { /* Reported below. */ }
    // Never report success for a write that a busy clipboard dropped: the user would paste old content.
    if (!copied) {
      diagnostics.log('diagnostics-copy-failed', { entries });
      return { ok: false, message: COPY_BUSY };
    }
    diagnostics.log('diagnostics-copied', { entries });
    return { ok: true, message: COPY_DONE, entries };
  });
  ipcMain.on('positions', (event, positions) => {
    if (!isSender(event, 'overlay') || !positions || typeof positions !== 'object') return;
    const pets = Object.fromEntries(PET_IDS.map(id => [id, { position: positions[id] }]));
    preferences = normalizePreferences({ pets }, preferences); scheduleSave();
    sendTo(settings, 'bootstrap-update', bootstrap());
  });
  ipcMain.on('pet-menu', (event, id) => { if (isSender(event, 'overlay') && PET_IDS.includes(id)) Menu.buildFromTemplate(petItems(id)).popup({ window: overlay! }); });
  ipcMain.on('app-action', (event, action) => {
    if (!isSender(event)) return;
    if (action === 'toggle-hidden') setHidden(!hidden);
    if (action === 'show') setHidden(false);
    if (action === 'hide') setHidden(true);
    if (action === 'settings') openSettings();
    if (action === 'quit') app.quit();
  });
}
/** Plan F5: recreate the overlay only when its display's identity, work area or scale really changed. */
function handleDisplayChange() {
  if (!screen.getAllDisplays().some(d => String(d.id) === preferences.selectedDisplay)) preferences.selectedDisplay = null;
  const target = getDisplay();
  const reason = displayRecreateReason(overlayDisplay, snapshotDisplay(target), overlayAlive());
  watchdog.grace(GRACE_MS);
  if (!reason) {
    displayEventsIgnored++;
    diagnostics.log('display-event-ignored', { generation, displays: screen.getAllDisplays().length });
  } else {
    diagnostics.log('display-handled', { generation, displays: screen.getAllDisplays().length, scaleFactor: target.scaleFactor, reason });
    recreateOverlay('display');
  }
  sendBootstrap(); scheduleSave();
  rearmForwarding('display');
}
function pauseForPower(kind: string) {
  paused = true;
  diagnostics.log('power', { event: kind });
  safeInput(kind); lifecycle({ type: 'pause' }); if (overlayAlive()) overlay!.hide();
}
/** Power resume or unlock (plan R2): grace, z-order and input re-asserts, re-arm, feed restart. */
function resumeFromPower(kind: string) {
  paused = false;
  diagnostics.log('power', { event: kind });
  watchdog.grace(GRACE_MS);
  if (!hidden && sceneReady && overlayAlive()) { lifecycle({ type: 'resume', cursor: cursorScene() }); overlay!.showInactive(); overlay!.setAlwaysOnTop(true); }
  applyInputMode(kind, true);
  rearmForwarding(kind);
  sendBootstrap();
}
/** Every second: watchdog verdicts and, in hybrid mode, the periodic hook re-arm. */
function watchdogTick() {
  watchdog.arm(sceneRunning());
  const misses = watchdog.misses, verdict = watchdog.tick();
  if (watchdog.misses >= 2 && misses < 2) diagnostics.log('heartbeat-miss', { generation, misses: watchdog.misses });
  if (verdict === 'kick') {
    let occluded: boolean | null = null;
    try {
      const value = (overlay as unknown as { isOccluded?: () => unknown } | null)?.isOccluded?.();
      if (typeof value === 'boolean') occluded = value;
    } catch { /* Not available in this Electron version. */ }
    diagnostics.log('kick', { generation, zeroFrameBeats: watchdog.zeroFrameBeats, occluded });
    lifecycle({ type: 'resume', cursor: cursorScene() });
  } else if (verdict === 'recover') {
    recover(watchdog.lastCause === 'frame-stall' ? 'frame-stall' : 'heartbeat', SCENE_NOTICE.stoppedResponding);
  }
  if (inputRouting === 'hybrid' && feed.active() && !interactive && performance.now() - lastRearmAt >= REARM_INTERVAL_MS) rearmForwarding('periodic');
}
/** Smoke tests only: places the scripted cursor at a scene point (converted with the cached origin), or far away. */
function setSmokeCursor(scenePoint: Point | null) {
  const origin = overlayOrigin ?? { x: 0, y: 0 };
  scriptedCursor = scenePoint ? { x: scenePoint.x + origin.x, y: scenePoint.y + origin.y } : { ...FAR_AWAY };
}
const smokeWait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Polls `predicate` until it holds or `timeoutMs` passes; returns the final result. */
async function smokeUntil(predicate: () => boolean, timeoutMs: number, stepMs = 5): Promise<boolean> {
  const end = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= end) return false;
    await smokeWait(stepMs);
  }
  return true;
}
interface OverlayCounters { pointerEvents: number; cursorMessages: number; frames: number; fallbackFrames: number; drags: number; lostReleases: number; lastMode: string }
async function overlayCounters(): Promise<OverlayCounters | null> {
  try { return await overlay?.webContents.executeJavaScript('window.__archieJumi ? { ...window.__archieJumi } : null') ?? null; } catch { return null; }
}
/** Required native checks; a key that never ran (an exception or an early end) counts as failed. */
const SMOKE_REQUIRED = [
  'rendererReady', 'noNodeIntegration', 'nonFocusable', 'petPixelInteractive', 'pointerCaptured', 'captureReleased', 'emptySpaceInputMode', 'stationaryCursorEntry', 'stationaryCursorExit', 'quietInputSafe', 'hidden', 'restored', 'crashHidden', 'crashRestored', 'saved',
  'pollingRouting', 'hoverLatencyOk', 'hoverExit', 'hoverGuard', 'powerCycle', 'displayNoop', 'frameStallSelfHeal', 'heartbeatAutoRecover', 'crashAutoRecovered', 'recoveryBudgetExhausts', 'budgetManualRestore', 'hybridRearmSafe',
  'dragHeld', 'dragMoved', 'lostPointerUpGuard', 'heartbeatResync', 'displayRecreate', 'frameStallRafRestored', 'recoveryHiddenFrozen', 'budgetTeardown',
  'realPointerIgnored', 'diagnosticsCopyFeedback',
];
/**
 * `npm run smoke`: clears the previous run's outputs, leaves a failing placeholder report until
 * the final write, and exits non-zero for any failed or missing check, exception or unwritable report.
 */
async function runSmoke() {
  const startedAt = new Date().toISOString(), reportFile = join(smokeOutput, 'smoke-report.json');
  const checks: Record<string, unknown> = {}, errors: string[] = [];
  try {
    await mkdir(smokeOutput, { recursive: true });
    for (const name of ['smoke-report.json', 'smoke-error.txt', 'desktop-pets.png', 'play.png', 'control-panel.png']) await rm(join(smokeOutput, name), { force: true });
    // Replaced only by the final write below: a killed, hung or crashed run leaves a failing report.
    await writeFile(reportFile, JSON.stringify({ version: app.getVersion(), startedAt, errors: ['Smoke run did not finish'] }, null, 2));
    await smokeSteps(checks);
  } catch (error) {
    console.error(error);
    errors.push(`Smoke run threw: ${String((error as Error)?.stack ?? error)}`);
  }
  checks.diagnosticsTail = diagnostics.text(80).trimEnd().split('\n');
  const report = { version: app.getVersion(), startedAt, finishedAt: new Date().toISOString(), checks, errors: [...errors, ...SMOKE_REQUIRED.filter(key => checks[key] !== true).map(key => `Failed native check: ${key}`)] };
  let written = false;
  try { await writeFile(reportFile, JSON.stringify(report, null, 2)); written = true; } catch (error) { console.error('The smoke report could not be written:', error); }
  if (report.errors.length) console.error(report.errors.join('\n'));
  await diagnostics.flush();
  if (!written || report.errors.length) app.exit(1); else app.quit();
}
async function smokeSteps(checks: Record<string, unknown>) {
  const wait = smokeWait, until = smokeUntil;
  const timings: Record<string, number> = {};
  checks.timings = timings;
  let stepStarted = performance.now();
  const step = (name: string) => { const now = performance.now(); timings[name] = Math.round(now - stepStarted); stepStarted = now; };
  const hovering = (id: PetId) => inputMode.target === id && interactive;
  const leave = async () => { setSmokeCursor(null); return until(() => !interactive && inputMode.target === null, 1000); };
  /** Moves Archie to `at` and keeps him still with a pet, then places the scripted cursor over him. */
  const hoverArchie = async (at: Point, timeoutMs = 1000) => {
    applyCommand({ type: 'move', petId: 'archie', point: at }); applyCommand({ type: 'pet', petId: 'archie' });
    await wait(150);
    setSmokeCursor(at);
    return until(() => hovering('archie'), timeoutMs);
  };
  for (let i = 0; i < 100 && !sceneReady; i++) await wait(100);
  checks.rendererReady = sceneReady;
  checks.noNodeIntegration = await overlay?.webContents.executeJavaScript('typeof require === "undefined" && typeof process === "undefined"');
  checks.nonFocusable = !overlay?.isFocusable();
  checks.scene = getScene();
  checks.pollingRouting = inputRouting === 'polling';
  checks.nativeOcclusion = nativeOcclusion;
  const center = { x: Math.round(getScene().width / 3), y: Math.round(getScene().height / 2) };
  await wait(800);
  step('startup');
  if (overlay) {
    await writeFile(join(smokeOutput, 'desktop-pets.png'), (await overlay.webContents.capturePage()).toPNG());
    checks.overlay = await overlay.webContents.executeJavaScript('({ canvases: document.querySelectorAll("canvas").length, error: document.querySelector("[data-error]")?.textContent ?? null })');
    applyCommand({ type: 'pet', petId: 'archie' }); await wait(200);
    applyCommand({ type: 'play', petId: 'jumi', automatic: true }); await wait(800);
    await writeFile(join(smokeOutput, 'play.png'), (await overlay.webContents.capturePage()).toPNG());
    applyCommand({ type: 'end-play' });
    step('screenshots');
    // Hover through the cursor feed only: the window is click-through with no forwarding hook.
    applyCommand({ type: 'move', petId: 'archie', point: center });
    applyCommand({ type: 'pet', petId: 'archie' }); await wait(150);
    const latencies: number[] = [];
    for (const delay of [0, 41, 67, 89, 113]) {
      await leave(); await wait(delay);
      applyCommand({ type: 'pet', petId: 'archie' });
      setSmokeCursor(center);
      const placedAt = performance.now();
      if (await until(() => hovering('archie'), 1000, 1)) latencies.push(Math.max(0, Math.round(interactiveChangedAt - placedAt)));
    }
    const worst = latencies.length === 5 ? Math.max(...latencies) : null;
    checks.petPixelInteractive = await until(() => hovering('archie'), 250);
    // A real mouse moved during the run (synthesized moves, well away from Archie) never overrides the
    // scripted cursor's hover (spec 2.3): the window stays interactive over Archie throughout.
    const realBefore = await overlayCounters();
    let realHoverKept = hovering('archie');
    for (let i = 0; i < 8; i++) {
      overlay.webContents.sendInputEvent({ type: 'mouseMove', x: 4 + i, y: 4 });
      const next = performance.now() + 40;
      while (performance.now() < next) { realHoverKept &&= hovering('archie'); await wait(5); }
    }
    const realAfter = await overlayCounters();
    const realEvents = realBefore && realAfter ? realAfter.pointerEvents - realBefore.pointerEvents : 0;
    checks.realPointerIgnored = realHoverKept && hovering('archie') && realEvents > 0;
    checks.realPointerDetails = { hoverKept: realHoverKept, pointerEvents: realEvents };
    checks.hoverLatencySamples = latencies;
    checks.hoverLatencyMs = worst;
    checks.hoverLatencyOk = worst !== null && worst <= 100;
    checks.hoverLatencyUnder50 = worst !== null && worst <= 50;
    setSmokeCursor(null);
    const leftAt = performance.now();
    checks.hoverExit = await until(() => !interactive, 200, 1) && nativeInSync();
    checks.hoverExitMs = checks.hoverExit ? Math.round(interactiveChangedAt - leftAt) : null;
    step('hover');
    // Capture still uses real (synthesized) pointer events. Archie stands still at `center`, so
    // the drag must leave him exactly where the button is released.
    await hoverArchie(center);
    const scene = getScene(), dropAt = { x: center.x + 25, y: center.y + 15 }, dragBefore = await overlayCounters();
    overlay.webContents.sendInputEvent({ type: 'mouseMove', ...center }); await wait(50);
    overlay.webContents.sendInputEvent({ type: 'mouseDown', ...center, button: 'left', clickCount: 1 }); await wait(100);
    checks.pointerCaptured = inputMode.capture;
    setSmokeCursor(dropAt);
    overlay.webContents.sendInputEvent({ type: 'mouseMove', ...dropAt, modifiers: ['leftbuttondown'] });
    // A held-button move keeps the capture: the drag starts and the lost-pointerup guard stays quiet.
    let held = true;
    const heldFrom = performance.now();
    while (performance.now() - heldFrom < 100) { held &&= inputMode.capture; await wait(5); }
    const dragHeldCounters = await overlayCounters();
    checks.dragHeld = held && inputMode.capture && !!dragBefore && !!dragHeldCounters
      && dragHeldCounters.drags === dragBefore.drags + 1 && dragHeldCounters.lostReleases === dragBefore.lostReleases;
    overlay.webContents.sendInputEvent({ type: 'mouseUp', ...dropAt, button: 'left', clickCount: 1 }); await wait(150);
    checks.captureReleased = !inputMode.capture;
    const near = (normalized: number, size: number, expected: number) => Math.abs(normalized * size - expected) <= 2;
    checks.dragMoved = await until(() => near(preferences.pets.archie.position.x, scene.width, dropAt.x) && near(preferences.pets.archie.position.y, scene.height, dropAt.y), 500);
    checks.dragDetails = { before: dragBefore, held: dragHeldCounters, after: await overlayCounters(), saved: { x: Math.round(preferences.pets.archie.position.x * scene.width), y: Math.round(preferences.pets.archie.position.y * scene.height) }, expected: dropAt };
    setSmokeCursor({ x: 4, y: 4 });
    checks.emptySpaceInputMode = await until(() => inputMode.target === null && !inputMode.capture && !interactive, 1000) && nativeInSync();
    step('capture');
    // A release we never saw: a buttonless move of the captured pointer ends the capture through the
    // lost-pointerup guard itself (not through Blink releasing the capture on its own).
    await hoverArchie(center);
    const guardBefore = await overlayCounters();
    overlay.webContents.sendInputEvent({ type: 'mouseMove', ...center }); await wait(30);
    overlay.webContents.sendInputEvent({ type: 'mouseDown', ...center, button: 'left', clickCount: 1 });
    const guardCaptured = await until(() => inputMode.capture, 300);
    overlay.webContents.sendInputEvent({ type: 'mouseMove', x: center.x + 10, y: center.y });
    const guardReleased = await until(() => !inputMode.capture, 200);
    const guardAfter = await overlayCounters();
    // Reset Chromium's pressed-button state; onUp ignores it because nothing is captured any more.
    overlay.webContents.sendInputEvent({ type: 'mouseUp', x: center.x + 10, y: center.y, button: 'left', clickCount: 1 }); await wait(50);
    checks.lostPointerUpGuard = guardCaptured && guardReleased && !!guardBefore && !!guardAfter
      && guardAfter.lostReleases === guardBefore.lostReleases + 1 && guardAfter.drags === guardBefore.drags;
    checks.lostPointerUpDetails = { guardCaptured, guardReleased, before: guardBefore, after: guardAfter };
    await leave();
    step('lostPointerUp');
    // A kitten walking under a stationary cursor, then away from it.
    applyCommand({ type: 'move', petId: 'archie', point: { x: center.x + 200, y: center.y } }); await wait(150);
    setSmokeCursor(center); await wait(100);
    const clearBefore = !interactive && inputMode.target === null;
    applyCommand({ type: 'move', petId: 'archie', point: center });
    checks.stationaryCursorEntry = clearBefore && await until(() => hovering('archie'), 500);
    applyCommand({ type: 'move', petId: 'archie', point: { x: center.x + 200, y: center.y } });
    checks.stationaryCursorExit = await until(() => inputMode.target === null && !interactive, 500);
    step('stationary');
    // A stale hover report while main's own samples place the cursor far away.
    await leave(); await wait(HOVER_GUARD_MS + 50);
    const tripsBefore = hoverGuardTrips, resyncsBefore = heartbeatResyncs, fakedAt = performance.now();
    let becameInteractive = false;
    await overlay.webContents.executeJavaScript(`window.desktop.setInputMode({ generation: ${generation}, target: 'archie', capture: false }), true`);
    const guarded = await until(() => { becameInteractive ||= interactive; return hoverGuardTrips > tripsBefore && !interactive; }, 600);
    while (performance.now() - fakedAt < 600) { becameInteractive ||= interactive; await wait(5); }
    checks.hoverGuard = guarded && !interactive;
    // The renderer's own report never changed, so only a heartbeat resync (plan F3) can clear the forged one.
    checks.heartbeatResync = await until(() => inputMode.target === null && !inputMode.capture && !interactive, 1500) && heartbeatResyncs > resyncsBefore;
    checks.hoverGuardDetails = { trips: hoverGuardTrips - tripsBefore, becameInteractive, resyncs: heartbeatResyncs - resyncsBefore };
    step('hoverGuard');
  }
  updatePreferences({ quiet: true }); await wait(300); checks.quietInputSafe = inputMode.target === null && !inputMode.capture && !interactive && nativeInSync();
  updatePreferences({ quiet: false });
  setHidden(true); checks.hidden = !overlay?.isVisible(); setHidden(false); await wait(300); checks.restored = overlay?.isVisible();
  step('quietHidden');
  // Lock and unlock: no notice, visible again, and hover works again with the scripted cursor.
  const noticesBefore = runtimeNotices.join('|'), powerGeneration = generation;
  powerMonitor.emit('lock-screen'); await wait(150);
  const lockedSafe = paused && !overlayVisible() && !interactive && !feed.active() && nativeInSync();
  powerMonitor.emit('unlock-screen');
  const visibleAgain = await until(() => overlayVisible() && !paused, 1000);
  const hoverAgain = await hoverArchie(center);
  checks.powerCycle = lockedSafe && visibleAgain && hoverAgain && runtimeNotices.join('|') === noticesBefore && generation === powerGeneration;
  checks.powerCycleDetails = { lockedSafe, visibleAgain, hoverAgain };
  await leave();
  step('powerCycle');
  // Hybrid routing: forwarding plus the feed; a re-arm while idle must leave the window click-through.
  setInputRouting('hybrid');
  const hybridHover = await hoverArchie(center);
  const hybridLeft = await leave();
  const writesBefore = nativeWrites;
  const rearmed = rearmForwarding('smoke');
  // Checked synchronously: exactly the off-toggle, then click-through with forwarding again.
  const rearmWrites = nativeWrites - writesBefore, rearmCalls = rearmWrites <= nativeLog.length ? nativeLog.slice(nativeLog.length - rearmWrites) : null;
  const rearmSequence = JSON.stringify(rearmCalls) === JSON.stringify([{ ignore: false, forward: false }, { ignore: true, forward: true }]);
  const rearmNative = nativeInSync() && nativeIgnore?.ignore === true && nativeIgnore.forward === true;
  await wait(100);
  checks.hybridRearmSafe = hybridHover && hybridLeft && rearmed && rearmSequence && rearmNative && !interactive && nativeInSync() && inputRouting === 'hybrid';
  checks.hybridDetails = { hybridHover, hybridLeft, rearmed, rearmCalls, native: nativeIgnore };
  setInputRouting('polling');
  await leave();
  step('hybrid');
  // A metrics event that does not change the selected display must not recreate the overlay.
  const displayGeneration = generation, ignoredBefore = displayEventsIgnored;
  screen.emit('display-metrics-changed', {}, getDisplay(), ['workArea']);
  await wait(500);
  checks.displayNoop = generation === displayGeneration && displayEventsIgnored > ignoredBefore && sceneReady && overlayVisible();
  step('displayNoop');
  // A real work-area change (the recorded one is made 1 DIP shorter) recreates through a reported handoff.
  const recreateGeneration = generation;
  if (overlayDisplay) overlayDisplay = { ...overlayDisplay, workArea: { ...overlayDisplay.workArea, height: overlayDisplay.workArea.height - 1 } };
  screen.emit('display-metrics-changed', {}, getDisplay(), ['workArea']);
  const recreated = await until(() => generation === recreateGeneration + 1 && sceneReady && overlayVisible() && !recovering, 3000, 10);
  checks.displayRecreate = recreated && generation === recreateGeneration + 1 && !hidden
    && lastHandoff?.generation === recreateGeneration && lastHandoff.outcome === 'reported' && carryOver?.generation === recreateGeneration
    && displayRecreateReason(overlayDisplay, snapshotDisplay(getDisplay()), overlayAlive()) === null;
  checks.displayRecreateDetails = { recreated, handoff: lastHandoff, carryOverGeneration: carryOver?.generation ?? null };
  step('displayRecreate');
  openSettings(); await wait(1800);
  if (settings) {
    await writeFile(join(smokeOutput, 'control-panel.png'), (await settings.webContents.capturePage()).toPNG());
    checks.settings = await settings.webContents.executeJavaScript('({ title: document.title, text: document.body.innerText.slice(0, 4000), buttons: document.querySelectorAll("button").length })');
  }
  // Only the settings window may copy diagnostics (smoke runs never touch the real clipboard).
  checks.diagnosticsSenderGuard = await overlay?.webContents.executeJavaScript('window.desktop.copyDiagnostics().then(() => false, () => true)');
  // The settings window's own Copy diagnostics button, with the stand-in clipboard: a busy clipboard
  // shows its error, and the next copy shows the toast and clears that error.
  interface CopyUi { error: string | null; toast: string | null; ready: boolean }
  const settingsPage = settings && !settings.isDestroyed() ? settings.webContents : null;
  const copyUi = async (): Promise<CopyUi | null> => {
    try {
      return await settingsPage?.executeJavaScript('(() => { const button = document.querySelector(".diagnostics-row button"); return { error: document.querySelector(".error-notice")?.textContent ?? null, toast: document.querySelector(".toast.visible")?.textContent ?? null, ready: !!button && !button.disabled }; })()') ?? null;
    } catch { return null; }
  };
  const copyUiUntil = async (predicate: (ui: CopyUi) => boolean, timeoutMs: number): Promise<CopyUi | null> => {
    const end = performance.now() + timeoutMs;
    for (;;) {
      const ui = await copyUi();
      if (ui && predicate(ui)) return ui;
      if (performance.now() >= end) return null;
      await wait(25);
    }
  };
  const clickCopy = async () => { try { await settingsPage?.executeJavaScript('(document.querySelector(".diagnostics-row button")?.click(), true)'); } catch { /* Checked through the page state. */ } };
  smokeClipboard.busy = true;
  const copyReady = await copyUiUntil(ui => ui.ready && ui.error === null, 2000);
  if (copyReady) await clickCopy();
  const copyBusy = copyReady ? await copyUiUntil(ui => ui.ready && ui.error === COPY_BUSY && ui.toast !== COPY_DONE, 3000) : null;
  smokeClipboard.busy = false;
  if (copyBusy) await clickCopy();
  const copyDone = copyBusy ? await copyUiUntil(ui => ui.ready && ui.error === null && ui.toast === COPY_DONE, 3000) : null;
  checks.diagnosticsCopyFeedback = copyDone !== null && smokeClipboard.text.startsWith('Archie & Jumi diagnostics');
  checks.diagnosticsCopyDetails = { ready: copyReady, busy: copyBusy, done: copyDone, copiedChars: smokeClipboard.text.length };
  checks.metrics = app.getAppMetrics().map(m => ({ type: m.type, memory: m.memory, cpu: m.cpu }));
  step('settings');
  const displayChecks = [];
  for (const display of screen.getAllDisplays()) {
    updatePreferences({ selectedDisplay: String(display.id) });
    for (let i = 0; i < 80 && !sceneReady; i++) await wait(50);
    displayChecks.push({ id: display.id, scaleFactor: display.scaleFactor, ready: sceneReady, actual: overlay?.getBounds(), expected: display.workArea });
  }
  checks.displaySelection = displayChecks;
  updatePreferences({ selectedDisplay: null });
  for (let i = 0; i < 80 && !sceneReady; i++) await wait(50);
  step('displaySelection');
  // The watchdog must be live (no creation or scene-ready grace) for the next two checks to mean anything.
  await until(() => watchdog.graceRemaining() === 0 && sceneRunning(), 15000, 50);
  step('graceWait');
  // A starved requestAnimationFrame: timers keep the frames advancing and nothing is recovered.
  const stallGeneration = generation, stallRecoveries = recoveries, stallBefore = await overlayCounters();
  await overlay?.webContents.executeJavaScript('(() => { let id = 1e6; window.__smokeRaf = window.requestAnimationFrame; window.requestAnimationFrame = () => ++id; return true; })()');
  await wait(1500);
  const stallMid = await overlayCounters();
  await wait(1000);
  const stallAfter = await overlayCounters(), stallZeroBeats = watchdog.zeroFrameBeats;
  await overlay?.webContents.executeJavaScript('(() => { if (window.__smokeRaf) window.requestAnimationFrame = window.__smokeRaf; delete window.__smokeRaf; return true; })()');
  // Over the final second the timers still drive at least 10 frames (about 21 at Windows' default
  // timer resolution), every one a fallback frame (rAF really starved), and each beat carries them.
  const lateFallback = stallMid && stallAfter ? stallAfter.fallbackFrames - stallMid.fallbackFrames : 0;
  const lateRaf = stallMid && stallAfter ? stallAfter.frames - stallMid.frames - lateFallback : Number.POSITIVE_INFINITY;
  checks.frameStallSelfHeal = !!stallBefore && !!stallAfter && stallAfter.frames > stallBefore.frames && stallAfter.fallbackFrames > stallBefore.fallbackFrames
    && lateFallback >= 10 && lateRaf <= 1 && stallZeroBeats === 0
    && generation === stallGeneration && recoveries === stallRecoveries && !recovering;
  // Once rAF is back, the fallback stops and rAF keeps the frames coming.
  await wait(300); const restoredA = await overlayCounters(); await wait(300); const restoredB = await overlayCounters();
  checks.frameStallRafRestored = !!restoredA && !!restoredB && restoredB.fallbackFrames === restoredA.fallbackFrames && restoredB.frames > restoredA.frames;
  checks.frameStall = { before: stallBefore, mid: stallMid, after: stallAfter, lateFallbackFrames: lateFallback, lateRafFrames: lateRaf, zeroFrameBeats: stallZeroBeats, restoredA, restoredB };
  step('frameStall');
  // A renderer whose JavaScript is blocked misses its beats and is recreated automatically.
  await until(() => watchdog.graceRemaining() === 0 && sceneRunning(), 12000, 50);
  const heartbeatGeneration = generation, blockedAt = performance.now();
  void overlay?.webContents.executeJavaScript('(() => { const end = performance.now() + 4500; while (performance.now() < end) { /* blocked */ } return true; })()').catch(() => {});
  const heartbeatRecovered = await until(() => generation > heartbeatGeneration && sceneReady && overlayVisible() && !recovering, 12000, 50);
  checks.heartbeatAutoRecover = heartbeatRecovered && !hidden;
  checks.heartbeatAutoRecoverMs = heartbeatRecovered ? Math.round(performance.now() - blockedAt) : null;
  step('heartbeatAutoRecover');
  // A crashed renderer is hidden and click-through at once, then restored without Show All.
  const crashGeneration = generation;
  overlay?.webContents.forcefullyCrashRenderer();
  await until(() => recovering, 3000, 2);
  checks.crashHidden = recovering && !overlayVisible() && !interactive && nativeInSync();
  const crashRecovered = await until(() => generation > crashGeneration && sceneReady && overlayVisible() && !recovering, 10000, 50);
  checks.crashRestored = crashRecovered;
  checks.crashAutoRecovered = crashRecovered && !hidden;
  step('crash');
  // A lost GPU process recovers the same way; meanwhile the hidden old renderer stays paused, so
  // bootstrap updates sent during the backoff never restart its drawing.
  const gpuGeneration = generation, runningA = await overlayCounters();
  await wait(300); const runningB = await overlayCounters();
  const wasRunning = !!runningA && !!runningB && runningB.frames > runningA.frames;
  app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 1, name: 'GPU', serviceName: 'GPU' });
  const gpuRecovering = recovering && !overlayVisible() && !interactive && generation === gpuGeneration;
  await wait(300); const frozenA = await overlayCounters();
  await wait(700); const frozenB = await overlayCounters();
  const gpuRecovered = await until(() => generation > gpuGeneration && sceneReady && overlayVisible() && !recovering, 12000, 50);
  checks.recoveryHiddenFrozen = wasRunning && gpuRecovering && !!frozenA && !!frozenB && frozenB.frames === frozenA.frames && gpuRecovered && !hidden;
  checks.recoveryFrozenDetails = { wasRunning, gpuRecovering, runningA, runningB, frozenA, frozenB, gpuRecovered };
  step('gpuRecover');
  // Further forced crashes use up whatever recovery budget is left (normally none: the heartbeat,
  // crash and GPU steps took all three).
  let budgetCrashes = 0;
  while (budget.remaining(performance.now()) > 0 && budgetCrashes < RECOVERY_LIMIT) {
    const before = generation;
    overlay?.webContents.forcefullyCrashRenderer(); budgetCrashes++;
    await until(() => generation > before && sceneReady && overlayVisible() && !recovering, 12000, 50);
  }
  const sceneNotices = () => runtimeNotices.filter(n => n.startsWith('The pet scene'));
  // With the budget used up, the next real crash is final: the render-process-gone handler hides the
  // kittens with its own notice and destroys the window inside that very event; the app keeps running.
  const exhaustGeneration = generation, crashedWindow = overlay;
  crashedWindow?.webContents.forcefullyCrashRenderer();
  const exhausted = await until(() => hidden && !recovering && overlay === null, 5000, 10);
  const exhaustNotices = sceneNotices(), crashedDestroyed = crashedWindow?.isDestroyed() ?? false;
  checks.recoveryBudgetExhausts = exhausted && crashedDestroyed && generation === exhaustGeneration
    && exhaustNotices.length === 1 && exhaustNotices[0] === SCENE_NOTICE.renderGone;
  checks.recoveryBudgetCrashes = budgetCrashes;
  checks.recoveryBudgetDetails = { exhausted, notices: exhaustNotices, windowDestroyed: crashedDestroyed, generationKept: generation === exhaustGeneration };
  // Show All builds a fresh overlay: the failed one is gone.
  setHidden(false);
  checks.budgetManualRestore = await until(() => generation > exhaustGeneration && sceneReady && overlayVisible() && !hidden && !recovering, 10000, 50) && sceneNotices().length === 0;
  step('budget');
  // A renderer that hangs for good once the budget is used up again (spent here through the budget
  // itself, since Show All started a fresh one): its window's 'unresponsive' event (emitted here, as
  // Electron does for a hung page) is final too, and the hung renderer is torn down instead of
  // spinning while hidden.
  const spentAt = performance.now();
  while (budget.remaining(spentAt) > 0) budget.next(spentAt);
  const hangGeneration = generation, hungWindow = overlay, hungPid = overlay?.webContents.getOSProcessId() ?? -1;
  void hungWindow?.webContents.executeJavaScript('(() => { for (;;) { /* hung for good */ } })()').catch(() => {});
  await wait(300);
  hungWindow?.emit('unresponsive');
  const hangExhausted = await until(() => hidden && !recovering && overlay === null, 3000, 10);
  const hangNotices = sceneNotices(), hungDestroyed = hungWindow?.isDestroyed() ?? false;
  const hungGone = hungPid > 0 && await until(() => !app.getAppMetrics().some(metric => metric.pid === hungPid), 3000, 50);
  // No display event may build a new, unwatched hidden overlay before Show All.
  screen.emit('display-metrics-changed', {}, getDisplay(), ['workArea']);
  await wait(500);
  const deferred = overlay === null && generation === hangGeneration && hidden;
  setHidden(false);
  const hangRestored = await until(() => generation > hangGeneration && sceneReady && overlayVisible() && !hidden && !recovering, 10000, 50) && sceneNotices().length === 0;
  checks.budgetTeardown = hangExhausted && hungDestroyed && hungGone && deferred && hangRestored
    && hangNotices.length === 1 && hangNotices[0] === SCENE_NOTICE.unresponsive;
  checks.budgetTeardownDetails = { hungPid, hungGone, notices: hangNotices, windowDestroyed: hungDestroyed, deferred, restored: hangRestored };
  step('budgetTeardown');
  // Malformed payloads are dropped and counted, never applied.
  await overlay?.webContents.executeJavaScript('(window.desktop.heartbeat({ generation: "x", frames: -1 }), true)');
  await wait(100);
  checks.invalidIpc = { ...invalidIpc };
  await store.save({ schemaVersion: 1, preferences });
  checks.saved = true;
}
/**
 * Opt-in native confirmation of the root cause: `--smoke-test --hook-loss-check` after a build.
 * Runs instead of the smoke steps and writes test-results/hook-loss-report.json. It sends real
 * but tiny mouse moves through scripts/jiggle-mouse.ps1 (1 pixel, self-restoring; no clicks,
 * no keys), so it is never part of `npm run smoke`.
 */
/** PowerShell start-up plus Add-Type compilation can take seconds; a jiggler not ready by then makes its step inconclusive. */
const JIGGLER_READY_TIMEOUT_MS = 15_000;
/** The jiggler's final JSON line (see scripts/jiggle-mouse.ps1). */
interface JigglerSummary { sent?: number; moved?: number; restored?: boolean; mode?: string; [key: string]: unknown }
async function runHookLossCheck() {
  const startedAt = new Date().toISOString(), reportFile = join(smokeOutput, 'hook-loss-report.json');
  const report: Record<string, unknown> = { version: app.getVersion(), mode: 'hook-loss-check', startedAt, startRouting: inputRouting, steps: {}, errors: [] };
  const steps = report.steps as Record<string, unknown>, errors = report.errors as string[], inconclusiveSteps: string[] = [];
  const wait = smokeWait, until = smokeUntil;
  const script = join(app.getAppPath(), 'scripts', 'jiggle-mouse.ps1');
  const jigglers = new Set<ChildProcess>();
  const parseLast = (output: string): unknown => { const line = output.trim().split(/\r?\n/).pop() ?? ''; try { return JSON.parse(line); } catch { return line.slice(0, 400); } };
  /**
   * Starts the jiggler. `ready` resolves true once it prints READY (compiled, first move sent) and
   * false if that takes longer than JIGGLER_READY_TIMEOUT_MS; `done` resolves with its summary.
   */
  const startJiggler = (seconds: number) => {
    const spawnedAt = performance.now();
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Seconds', String(seconds), '-IntervalMs', '20'], { windowsHide: true });
    jigglers.add(child);
    let output = '', readyAt: number | null = null, settle: (ready: boolean) => void = () => {};
    const ready = new Promise<boolean>(resolve => { settle = resolve; });
    const readyTimer = setTimeout(() => settle(false), JIGGLER_READY_TIMEOUT_MS);
    child.stdout?.on('data', chunk => {
      output += String(chunk);
      if (readyAt === null && /^READY\b/m.test(output)) { readyAt = performance.now(); clearTimeout(readyTimer); settle(true); }
    });
    child.stderr?.on('data', chunk => { output += String(chunk); });
    const done = new Promise<JigglerSummary>((resolve, reject) => {
      // The jiggler restores the cursor itself when it ends; a kill is only a last resort.
      const killTimer = setTimeout(() => child.kill(), (seconds + 30) * 1000);
      const finish = () => { clearTimeout(killTimer); clearTimeout(readyTimer); settle(false); jigglers.delete(child); };
      child.on('error', error => { finish(); reject(error); });
      child.on('exit', code => {
        finish();
        const summary = parseLast(output);
        if (code === 0 && summary && typeof summary === 'object') resolve(summary as JigglerSummary);
        else reject(new Error(`jiggle-mouse.ps1 exited with ${code}: ${output.trim().slice(-400)}`));
      });
    });
    return { ready, done, readyMs: () => readyAt === null ? null : Math.round(readyAt - spawnedAt) };
  };
  /** A step means something only if the jiggler became ready and the cursor really moved. */
  const delivered = (summary: JigglerSummary) => typeof summary.moved === 'number' && summary.moved > 0;
  const pointerEvents = async () => (await overlayCounters())?.pointerEvents ?? 0;
  /** Pointer events the overlay received while the jiggler ran; null when the step is inconclusive. */
  const measure = async (name: string, seconds: number): Promise<number | null> => {
    const before = await pointerEvents(), jiggler = startJiggler(seconds), from = performance.now();
    const ready = await jiggler.ready, summary = await jiggler.done;
    const delta = (await pointerEvents()) - before, conclusive = ready && delivered(summary);
    steps[name] = { pointerEvents: delta, conclusive, readyMs: jiggler.readyMs(), durationMs: Math.round(performance.now() - from), jiggler: summary };
    if (!conclusive) inconclusiveSteps.push(name);
    return conclusive ? delta : null;
  };
  try {
    await mkdir(smokeOutput, { recursive: true });
    for (const name of ['hook-loss-report.json', 'smoke-error.txt']) await rm(join(smokeOutput, name), { force: true });
    // Replaced only by the final write: a killed or crashed check leaves a failing report.
    await writeFile(reportFile, JSON.stringify({ version: app.getVersion(), mode: 'hook-loss-check', startedAt, errors: ['Hook-loss check did not finish'] }, null, 2));
    for (let i = 0; i < 100 && !sceneReady; i++) await wait(100);
    if (!sceneReady) throw new Error('The overlay did not become ready.');
    // The whole check takes well under a minute: keep the periodic re-arm from repairing the hook between B and C.
    lastRearmAt = performance.now();
    // Cover the display that holds the real cursor.
    const real = screen.getCursorScreenPoint(), display = screen.getDisplayNearestPoint(real);
    if (getDisplay().id !== display.id) { updatePreferences({ selectedDisplay: String(display.id) }); await until(() => sceneReady && overlayVisible(), 10000, 50); }
    const area = display.workArea;
    report.display = { scaleFactor: display.scaleFactor, workArea: rectText(area) };
    if (real.x < area.x || real.y < area.y || real.x >= area.x + area.width || real.y >= area.y + area.height) { report.inconclusive = 'cursor outside overlay work area'; return; }
    // Measure forwarding, not hover: keep both kittens (and their interest rects) away from the real cursor.
    const awayX = real.x - area.x < area.width / 2 ? area.width * 0.8 : area.width * 0.2;
    applyCommand({ type: 'move', petId: 'archie', point: { x: awayX, y: area.height * 0.35 } }); applyCommand({ type: 'nap', petId: 'archie' });
    applyCommand({ type: 'move', petId: 'jumi', point: { x: awayX, y: area.height * 0.7 } }); applyCommand({ type: 'nap', petId: 'jumi' });
    await wait(600);
    if (interactive) { report.inconclusive = 'overlay interactive before the check'; return; }
    const forwardedBefore = await measure('A-forwardingBefore', 2);
    // B: once the jiggler is really moving the cursor, the main thread stalls 2.5 s while it keeps
    // moving (5 s in all); Windows removes the timed-out hook. The stall never starts before READY,
    // however long PowerShell takes to start.
    const stallBefore = await pointerEvents(), stallJiggler = startJiggler(5), stallFrom = performance.now();
    const stallReady = await stallJiggler.ready;
    let stallStartMs: number | null = null;
    if (stallReady) {
      await wait(600);
      stallStartMs = Math.round(performance.now() - stallFrom);
      const end = performance.now() + 2500;
      while (performance.now() < end) { /* deliberate main-thread stall: the hook callback cannot run */ }
    }
    const stallSummary = await stallJiggler.done, stallConclusive = stallReady && delivered(stallSummary);
    steps['B-mainThreadStall'] = { pointerEvents: (await pointerEvents()) - stallBefore, stallMs: stallReady ? 2500 : 0, conclusive: stallConclusive, readyMs: stallJiggler.readyMs(), stallStartMs, durationMs: Math.round(performance.now() - stallFrom), jiggler: stallSummary };
    if (!stallConclusive) inconclusiveSteps.push('B-mainThreadStall');
    const forwardedAfter = await measure('C-forwardingAfterStall', 2);
    const rearmed = rearmForwarding('hook-loss-check');
    // The re-arm must end click-through with forwarding (never interactive), whatever forwarding then delivers.
    const rearmNative = rearmed && nativeInSync() && nativeIgnore?.ignore === true && nativeIgnore.forward === true;
    report.rearmNative = { rearmed, state: nativeIgnore, inSync: nativeInSync() };
    const forwardedRearmed = await measure('D-afterRearm', 2);
    report.forwardingBefore = forwardedBefore === null ? null : forwardedBefore > 0;
    report.forwardingAfterStall = forwardedAfter === null ? null : forwardedAfter === 0;
    report.rootCauseConfirmed = forwardedBefore === null || forwardedAfter === null || !stallConclusive ? null : forwardedBefore > 0 && forwardedAfter === 0;
    report.rearmRestores = forwardedRearmed === null ? null : rearmNative && forwardedRearmed > 0;
    // E: polling only, with the real cursor source for this step.
    setInputRouting('polling');
    scriptedCursor = null;
    const now = screen.getCursorScreenPoint(), origin = overlayOrigin ?? area;
    const under = { x: now.x - origin.x, y: now.y - origin.y };
    const size = preferences.pets.archie.size, marginX = size * 0.62 + 8, marginY = size * 0.55 + 8;
    if (under.x < marginX || under.x > area.width - marginX || under.y < marginY || under.y > area.height - marginY) {
      steps['E-polling'] = { inconclusive: 'cursor too close to the work-area edge to centre Archie under it' };
    } else {
      applyCommand({ type: 'move', petId: 'archie', point: under }); applyCommand({ type: 'pet', petId: 'archie' });
      await wait(400);
      report.pollingSeesRealCursor = inputMode.target === 'archie' && interactive;
      applyCommand({ type: 'move', petId: 'archie', point: { x: awayX, y: area.height * 0.35 } });
      report.pollingReleases = await until(() => !interactive && inputMode.target === null, 1000);
    }
  } catch (error) {
    errors.push(String((error as Error)?.stack ?? error));
  } finally {
    for (const child of jigglers) child.kill();
    scriptedCursor = { ...FAR_AWAY };
    report.endRouting = inputRouting;
    if (inconclusiveSteps.length) report.inconclusiveSteps = inconclusiveSteps;
    report.finishedAt = new Date().toISOString();
    report.diagnosticsTail = diagnostics.text(60).trimEnd().split('\n');
    let written = false;
    try { await writeFile(reportFile, JSON.stringify(report, null, 2)); written = true; } catch (error) { console.error('The hook-loss report could not be written:', error); }
    if (errors.length) console.error(errors.join('\n'));
    await diagnostics.flush();
    if (!written || errors.length) app.exit(1); else app.quit();
  }
}
/** Last resort for a smoke mode that threw outside its own handling: always exits non-zero. */
async function smokeAborted(error: unknown) {
  try {
    console.error(error);
    await mkdir(smokeOutput, { recursive: true });
    await writeFile(join(smokeOutput, 'smoke-error.txt'), String((error as Error)?.stack ?? error));
    await diagnostics.flush();
  } catch { /* Still fail below. */ } finally {
    app.exit(1);
  }
}
if (squirrelStartup || !app.requestSingleInstanceLock()) {
  // A second smoke run must fail rather than pass on the first run's report.
  if (smoke && !squirrelStartup) { console.error('Another smoke run is using the test profile.'); app.exit(1); } else app.quit();
} else {
  app.on('second-instance', openSettings);
  void app.whenReady().then(async () => {
    diagnostics.log('app-start', { version: app.getVersion(), routing: inputRouting, nativeOcclusion, smoke, hookLossCheck });
    store = new StateStore(app.getPath('userData'));
    preferences = (await store.load()).preferences;
    if (preferences.launchAtLogin && app.isPackaged && !smoke && process.platform === 'win32') {
      try { configureLoginItem(true, true); }
      catch { runtimeNotices.push('Launch at login could not be refreshed after startup. Toggle it off and on in Settings to retry.'); }
    }
    installIpc();
    tray = new Tray(nativeImage.createFromPath(join(__dirname, 'icon.png')).resize({ width: 32, height: 32 }));
    tray.setToolTip('Archie & Jumi'); tray.on('double-click', openSettings);
    registerShortcut(); createOverlay(); updateTray();
    if (!process.argv.includes('--start-hidden-panel')) openSettings();
    let displayTimer: NodeJS.Timeout | undefined;
    const displaysChanged = () => { clearTimeout(displayTimer); displayTimer = setTimeout(handleDisplayChange, 200); };
    screen.on('display-added', displaysChanged); screen.on('display-removed', displaysChanged); screen.on('display-metrics-changed', displaysChanged);
    powerMonitor.on('suspend', () => pauseForPower('suspend')); powerMonitor.on('lock-screen', () => pauseForPower('lock-screen'));
    powerMonitor.on('resume', () => resumeFromPower('resume')); powerMonitor.on('unlock-screen', () => resumeFromPower('unlock-screen'));
    setInterval(watchdogTick, 1000).unref();
    app.on('child-process-gone', (_event, details) => {
      if (details.type !== 'GPU' || details.reason === 'clean-exit') return;
      diagnostics.log('gpu-gone', { reason: details.reason, exitCode: details.exitCode });
      // Transparent windows can turn opaque or black after a GPU restart: recreate the overlay.
      if (overlayAlive()) recover('gpu-gone', SCENE_NOTICE.gpuGone);
    });
    if (smoke) void (hookLossCheck ? runHookLossCheck() : runSmoke()).catch(smokeAborted);
  });
}
app.on('window-all-closed', () => {});
app.on('before-quit', event => {
  quitting = true;
  if (flushed || !store) return;
  event.preventDefault(); clearTimeout(saveTimer); globalShortcut.unregisterAll();
  diagnostics.log('app-quit', { generation });
  void store.save({ schemaVersion: 1, preferences }).catch(() => {}).then(() => diagnostics.flush()).finally(() => { flushed = true; app.quit(); });
});
app.on('will-quit', () => { globalShortcut.unregisterAll(); tray?.destroy(); });
