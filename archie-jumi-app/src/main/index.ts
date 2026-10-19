import { app, BrowserWindow, Tray, Menu, screen, ipcMain, globalShortcut, powerMonitor, nativeImage, clipboard, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type Rectangle } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import { join } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { release } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { StateStore } from './storage';
import { windowsLoginTarget } from './login-item';
import { CursorFeed, CursorRest, PointChoice } from './cursor-feed';
import { HOVER_GUARD_MS, decideInput, ignoreOptionsFor, needsFreshSample, parseInputRouting, type InputDecision, type InputRouting } from './input-routing';
import { HeartbeatWatchdog, RecoveryBudget, RECOVERY_LIMIT } from './watchdog';
import { DiagnosticsLog, copyVerified, type DiagnosticsDetails } from './diagnostics';
import { displayRecreateReason, snapshotDisplay, type DisplaySnapshot } from './display-policy';
import { defaultPreferences } from '../shared/defaults';
import { normalizePreferences, samePositions, validCommand } from '../shared/validation';
import { LEAP_HEIGHT } from '../core/engine';
import { validHeartbeat, validInputModePayload, validInterest, validSceneState } from '../shared/ipc';
import { PET_IDS, type Bootstrap, type PetId, type Preferences, type PetCommand, type Lifecycle, type Point, type SceneCarryOver, type DiagnosticsResult, type InterestPayload, type Rect } from '../shared/types';
import type { PetSummary, SceneSummary } from '../rendering/scene-summary';

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
/** The interest region the current overlay sent last (the smoke test checks its attention squares). */
let interestRegion: InterestPayload | null = null;
/** Smoke runs only: console errors the overlay pages logged (newest 50; messages truncated). */
const overlayConsoleErrors: { generation: number; message: string }[] = [];
interface NativeIgnore { ignore: boolean; forward: boolean }
/** What main last applied with setIgnoreMouseEvents (null without an overlay), plus the newest calls for smoke checks. */
let nativeIgnore: NativeIgnore | null = null, nativeWrites = 0;
const nativeLog: NativeIgnore[] = [];
const invalidIpc: Record<string, number> = {};
const diagnostics = new DiagnosticsLog(app.getPath('userData'), { context: diagnosticsContext });
const watchdog = new HeartbeatWatchdog(() => performance.now());
const budget = new RecoveryBudget();
const cursorSource = (): Point | null => scriptedCursor ? { ...scriptedCursor } : screen.getCursorScreenPoint();
/** Come here (I9) from the tray uses the last spot where the cursor rested this long inside the scene. */
const TRAY_REST_MS = 500;
/** Where the cursor rests, from the feed's own samples (in memory only). */
const cursorRest = new CursorRest(TRAY_REST_MS);
/** The rest point frozen when the tray menu opened, so pausing on the menu itself never counts. */
let trayRestPoint: Point | null = null;
let trayMenu: Menu | null = null;
type ComeSource = 'tray' | 'menu';
/** A Come here chosen in a kitten's menu, waiting for the user to point (at most one at a time). */
let pendingCome: { petId: PetId; generation: number; source: ComeSource; choice: PointChoice } | null = null;
/** Smoke runs only: the come commands main sent, newest last. */
const comeLog: { petId: PetId; point: Point; source: ComeSource }[] = [];
const feed = new CursorFeed({
  source: cursorSource,
  origin: () => overlayOrigin,
  send: message => { sendTo(overlay, 'cursor', { generation, ...message }); },
  now: () => performance.now(),
  // Feed samples matter to the decision only for a stored hover report (the hover guard), so the
  // steady state costs one cursor read per tick. The heartbeat still re-decides every second. The same
  // samples tell Come here where the cursor rests.
  onSample: sample => {
    const now = performance.now();
    cursorRest.observe(sample, now, overlayScene());
    if (pendingCome) resolvePendingCome(sample, now);
    if (inputMode.target !== null && !inputMode.capture) applyInputMode('feed');
  },
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
  // Nothing samples the cursor any more (hidden, paused, Quiet Mode, recovery, a new overlay): a Come
  // here still waiting for the user to point gives up.
  cancelPendingCome();
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
  interestRegion = null;
  // The new scene may lie on another display: forget where the cursor rested.
  cursorRest.reset();
  trayRestPoint = null;
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
  if (smoke) {
    // The smoke test requires motion steps without page errors; the renderer counts uncaught ones too.
    const forGeneration = generation;
    win.webContents.on('console-message', details => {
      if (details.level !== 'error') return;
      overlayConsoleErrors.push({ generation: forGeneration, message: String(details.message).slice(0, 300) });
      if (overlayConsoleErrors.length > 50) overlayConsoleErrors.shift();
    });
  }
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
  // Any other command for a kitten replaces a Come here that is still waiting for the user to point.
  if ('petId' in command && command.type !== 'come' && pendingCome?.petId === command.petId) cancelPendingCome();
  sendTo(overlay, 'pet-command', command);
}
/**
 * Come here (I9). From the tray, the kitten walks to where the cursor last rested inside the scene before
 * the tray was used (frozen when the pointer reached the tray icon or its menu opened, so pausing on the
 * menu itself never counts). From a kitten's own menu, which always opens on the kitten, main waits up to
 * POINT_WAIT_MS for the user to point: the cursor must leave the menu row and rest inside the scene.
 */
function comeHere(id: PetId, source: ComeSource) {
  cancelPendingCome();
  if (source === 'tray') {
    const point = trayRestPoint ?? cursorRest.lastRest();
    if (point) sendCome(id, point, 'tray');
    else diagnostics.log('come-no-point', { generation, petId: id });
    return;
  }
  pendingCome = { petId: id, generation, source, choice: new PointChoice(cursorScene(), performance.now()) };
  diagnostics.log('come-armed', { generation, petId: id });
}
function sendCome(id: PetId, point: Point, source: ComeSource) {
  const command = validCommand({ type: 'come', petId: id, point }, overlayScene());
  if (!command || command.type !== 'come') return;
  if (smoke) { comeLog.push({ petId: id, point: { ...command.point }, source }); if (comeLog.length > 20) comeLog.shift(); }
  diagnostics.log('come', { generation, petId: id, source });
  applyCommand(command);
}
/** Feed samples for a Come here that waits for the user to point (see PointChoice). */
function resolvePendingCome(sample: Point | null, now: number) {
  const pending = pendingCome;
  if (!pending) return;
  if (pending.generation !== generation) { cancelPendingCome(); return; }
  const result = pending.choice.update(sample, cursorRest.resting(), now);
  if (result === null) return;
  pendingCome = null;
  if (result === 'expired') { diagnostics.log('come-expired', { generation, petId: pending.petId }); return; }
  sendCome(pending.petId, result, pending.source);
}
function cancelPendingCome() {
  if (!pendingCome) return;
  diagnostics.log('come-cancelled', { generation, petId: pendingCome.petId });
  pendingCome = null;
}
/** The tray's Come here target: the last cursor rest inside the scene, taken before the tray menu is used. */
function freezeTrayRest() { trayRestPoint = cursorRest.lastRest(); }
function petItems(id: PetId, source: ComeSource): MenuItemConstructorOptions[] {
  return [
    { label: 'Pet', click: () => applyCommand({ type: 'pet', petId: id }) },
    { label: 'Come here', click: () => comeHere(id, source) },
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
  if (!tray) return;
  trayMenu = Menu.buildFromTemplate([
    { label: hidden ? 'Show All' : 'Hide All', click: () => setHidden(!hidden) },
    { label: 'Quiet Mode', type: 'checkbox', checked: preferences.quiet, click: () => updatePreferences({ quiet: !preferences.quiet }) },
    { type: 'separator' },
    ...PET_IDS.map(id => ({ label: preferences.pets[id].name, submenu: petItems(id, 'tray') })),
    { label: 'End Play', click: () => applyCommand({ type: 'end-play' }) },
    { label: 'Monitor', submenu: screen.getAllDisplays().map(d => ({ label: `${d.label || 'Display'} · ${d.workArea.width} × ${d.workArea.height}`, type: 'radio' as const, checked: getDisplay().id === d.id, click: () => updatePreferences({ selectedDisplay: String(d.id) }) })) },
    { type: 'separator' }, { label: 'Settings', click: openSettings }, { label: 'Quit', click: () => app.quit() }
  ]);
  trayMenu.on('menu-will-show', freezeTrayRest);
  tray.setContextMenu(trayMenu);
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
    if (interest.generation !== generation) return;
    // Attention squares are reported by the feed but never count for the hover guard (P2-14).
    feed.setRegion(interest.rects, interest.attention);
    interestRegion = interest;
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
    const next = normalizePreferences({ pets }, preferences);
    // The renderer reports every 5 s; only a real move rewrites state.json (P2-28).
    const moved = !samePositions(next, preferences);
    preferences = next;
    if (!moved) return;
    scheduleSave();
    sendTo(settings, 'bootstrap-update', bootstrap());
  });
  ipcMain.on('pet-menu', (event, id) => { if (isSender(event, 'overlay') && PET_IDS.includes(id)) Menu.buildFromTemplate(petItems(id, 'menu')).popup({ window: overlay! }); });
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
interface OverlayCounters { pointerEvents: number; cursorMessages: number; frames: number; fallbackFrames: number; drags: number; lostReleases: number; lastMode: string; pageErrors: number; purring: boolean; scene: SceneSummary }
async function overlayCounters(): Promise<OverlayCounters | null> {
  try { return await overlay?.webContents.executeJavaScript('window.__archieJumi ? { ...window.__archieJumi } : null') ?? null; } catch { return null; }
}
/** Required native checks; a key that never ran (an exception or an early end) counts as failed. */
const SMOKE_REQUIRED = [
  'rendererReady', 'noNodeIntegration', 'nonFocusable', 'petPixelInteractive', 'pointerCaptured', 'captureReleased', 'emptySpaceInputMode', 'stationaryCursorEntry', 'stationaryCursorExit', 'quietInputSafe', 'hidden', 'restored', 'crashHidden', 'crashRestored', 'saved',
  'pollingRouting', 'hoverLatencyOk', 'hoverExit', 'hoverGuard', 'powerCycle', 'displayNoop', 'frameStallSelfHeal', 'heartbeatAutoRecover', 'crashAutoRecovered', 'recoveryBudgetExhausts', 'budgetManualRestore', 'hybridRearmSafe',
  'dragHeld', 'dragMoved', 'lostPointerUpGuard', 'heartbeatResync', 'displayRecreate', 'frameStallRafRestored', 'recoveryHiddenFrozen', 'budgetTeardown',
  'realPointerIgnored', 'diagnosticsCopyFeedback',
  'motionRenders', 'treatFlow', 'heldPet', 'clickPet', 'hoverWithTransforms', 'comeHere', 'curiosityToggle', 'curiosityNotices',
];
/** Visual-review captures of the Phase 2 motion steps, written to test-results/. */
const MOTION_CAPTURES = ['motion-play.png', 'motion-pounce.png', 'motion-treat.png', 'motion-held-pet.png'];
/**
 * `npm run smoke`: clears the previous run's outputs, leaves a failing placeholder report until
 * the final write, and exits non-zero for any failed or missing check, exception or unwritable report.
 */
async function runSmoke() {
  const startedAt = new Date().toISOString(), reportFile = join(smokeOutput, 'smoke-report.json');
  const checks: Record<string, unknown> = {}, errors: string[] = [];
  try {
    await mkdir(smokeOutput, { recursive: true });
    for (const name of ['smoke-report.json', 'smoke-error.txt', 'desktop-pets.png', 'play.png', 'control-panel.png', ...MOTION_CAPTURES]) await rm(join(smokeOutput, name), { force: true });
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
    await interactionSmoke(checks, { step, hovering, leave, hoverArchie, center });
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
/** A motion capture: the PNG written, the captured scene rect, its pixels, and how much of it is drawn (DIP² with alpha ≥ 128). */
interface MotionCapture { file: string; rect: Rect; pixels: number; opaqueDip: number; ok: boolean }
/** A drawn kitten covers about half of size² in the bundled art; a capture counts as showing it above this fraction of size². */
const KITTEN_COVER_MIN = 0.12;
/**
 * The torso on the kitten's centre line, as a fraction of its size below the centre (frame v ≈ 0.585):
 * opaque in every walk, trot, idle, sit, pet and land frame of both bundled kittens, for either facing.
 */
const TORSO_OFFSET = 0.1;
/** Below the kitten centre, as a multiple of size: opaque in the unlifted pounce frame, empty mid-leap (both packs). */
const GROUND_PROBE = 0.25;
/**
 * Captures the overlay page around a kitten (scene DIP, clipped to the scene) into test-results/<name>.png:
 * the kitten with room for its leap, and a toy or treat in front of it. `ok` when the drawn pixels cover
 * at least KITTEN_COVER_MIN × size², which the toy, a treat or effects alone never reach.
 */
async function captureMotion(name: string, pet: PetSummary): Promise<MotionCapture | null> {
  if (!overlayAlive()) return null;
  const scene = overlayScene();
  const left = Math.max(0, Math.floor(pet.x - 1.5 * pet.size)), top = Math.max(0, Math.floor(pet.y - 1.15 * pet.size));
  const right = Math.min(scene.width, Math.ceil(pet.x + 1.5 * pet.size)), bottom = Math.min(scene.height, Math.ceil(pet.y + 0.8 * pet.size));
  if (right - left < 1 || bottom - top < 1) return null;
  const rect = { x: left, y: top, width: right - left, height: bottom - top };
  try {
    const image = await overlay!.webContents.capturePage(rect);
    await writeFile(join(smokeOutput, `${name}.png`), image.toPNG());
    // Whatever scale the bitmap has, its share of mostly opaque pixels converts to DIP² of the rect.
    const bitmap = image.toBitmap(), pixels = bitmap.length / 4;
    let opaque = 0;
    for (let i = 3; i < bitmap.length; i += 4) if (bitmap[i] >= 128) opaque++;
    const opaqueDip = pixels > 0 ? Math.round(opaque * rect.width * rect.height / pixels) : 0;
    return { file: `${name}.png`, rect, pixels, opaqueDip, ok: opaqueDip >= KITTEN_COVER_MIN * pet.size * pet.size };
  } catch {
    return null;
  }
}
interface SmokeHelpers {
  step: (name: string) => void;
  hovering: (id: PetId) => boolean;
  leave: () => Promise<boolean>;
  hoverArchie: (at: Point, timeoutMs?: number) => Promise<boolean>;
  center: Point;
}
/**
 * Phase 2 interactions (spec 6.5), all with the scripted cursor: the curious toggle and attention
 * squares, curiosity end to end, Come here, the treat flow, motion captures during play and a pounce,
 * hold-to-pet and a quick click, and hover on a kitten that turns around and walks. Saves the
 * motion-*.png captures for visual review and leaves the cursor far away.
 */
async function interactionSmoke(checks: Record<string, unknown>, { step, hovering, leave, hoverArchie, center }: SmokeHelpers) {
  const wait = smokeWait, until = smokeUntil, scene = getScene();
  const summary = async (): Promise<SceneSummary | null> => (await overlayCounters())?.scene ?? null;
  const petNow = async (id: PetId): Promise<PetSummary | null> => (await summary())?.pets.find(pet => pet.id === id) ?? null;
  /** Polls an async probe every `stepMs` until it holds or `timeoutMs` passes. */
  const untilAsync = async (probe: () => Promise<boolean>, timeoutMs: number, stepMs = 20): Promise<boolean> => {
    const end = performance.now() + timeoutMs;
    for (;;) {
      if (await probe()) return true;
      if (performance.now() >= end) return false;
      await wait(stepMs);
    }
  };
  const sendInput = (event: Parameters<BrowserWindow['webContents']['sendInputEvent']>[0]) => { overlay?.webContents.sendInputEvent(event); };
  const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  // Two clear spots, well apart and away from the edges: attention squares stay whole and each capture shows one kitten.
  const spots: Record<PetId, Point> = {
    archie: { x: Math.round(scene.width * 0.3), y: Math.round(scene.height * 0.45) },
    jumi: { x: Math.round(scene.width * 0.65), y: Math.round(scene.height * 0.45) },
  };
  /** Ends play and moves both kittens to their spots; after the 0.5 s landing both sit (moving also ends a pair activity). */
  const settle = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      applyCommand({ type: 'end-play' });
      for (const id of PET_IDS) applyCommand({ type: 'move', petId: id, point: spots[id] });
      await wait(700);
      const now = await summary();
      if (now && now.pair === null && now.toy === null && now.pets.every(pet => pet.visible && pet.action === 'sit')) return true;
    }
    return false;
  };

  /** Moves one kitten back to its spot; after the landing it sits for 4 to 8 s, long enough for a 2.5 s dwell. */
  const resettle = async (id: PetId): Promise<boolean> => {
    applyCommand({ type: 'move', petId: id, point: spots[id] });
    await wait(700);
    return (await petNow(id))?.action === 'sit';
  };

  // Attention squares (spec 5.2, 6.4): with `curious` on, a sitting kitten adds a square of 3.2 × size
  // around itself to the interest region, far larger than any sprite rect; with it off, none is sent.
  // The watcher is a kitten that may notice the cursor (Jumi unless she cannot); the other one naps
  // through the curiosity checks, so no pair activity can start and move the watcher meanwhile.
  await leave();
  const settled = await settle();
  const settledScene = await summary();
  const watcherId: PetId | null = settledScene?.attentive.includes('jumi') ? 'jumi' : settledScene?.attentive[0] ?? null;
  const sleeperId = PET_IDS.find(id => id !== (watcherId ?? 'jumi'))!;
  applyCommand({ type: 'nap', petId: sleeperId });
  const largest = Math.max(...PET_IDS.map(id => preferences.pets[id].size));
  const isSquare = (rect: Rect) => rect.width >= 2.5 * largest && rect.height >= 2.5 * largest;
  const squares = () => interestRegion?.generation === generation ? interestRegion.attention.filter(isSquare).length : 0;
  const squaresOn = await until(() => squares() > 0, 3000, 20);
  // P2-14: the squares travel separately and never enter the hover guard's sprite and toy rects.
  const squaresKeptApart = interestRegion?.generation === generation && !interestRegion.rects.some(isSquare);
  const curiousOn = await summary();
  updatePreferences({ curious: false });
  const squaresCleared = await until(() => squares() === 0, 1000, 10);
  await wait(500);
  const curiousOff = await summary();
  const stayedClear = squares() === 0 && curiousOff?.attention === 0 && curiousOff.attentive.length === 0;
  updatePreferences({ curious: true });
  const squaresBack = await until(() => squares() > 0, 1500, 20);
  checks.curiosityToggle = settled && watcherId !== null && squaresOn && squaresKeptApart && (curiousOn?.attention ?? 0) > 0 && squaresCleared && stayedClear && squaresBack;
  checks.curiosityToggleDetails = { settled, attentive: settledScene?.attentive ?? null, watcher: watcherId, sleeper: sleeperId, squaresOn, squaresKeptApart, attentionOn: curiousOn?.attention ?? null, squaresCleared, stayedClear, squaresBack };
  step('curiosityToggle');

  // Curiosity end to end (spec 6.2): the cursor feed reaches engine.observeCursor. A cursor resting
  // behind the sitting watcher, inside its attention square but off its sprite, makes it turn to face
  // the cursor after 2.5 s, and the window stays click-through meanwhile.
  const watchReady = watcherId !== null && await resettle(watcherId);
  const watcher = watcherId ? await petNow(watcherId) : null;
  let noticed = false, clickThrough = true, noticeMs: number | null = null, pairDuring: string | null = null;
  if (watchReady && watcher) {
    const cursor = { x: watcher.x + (watcher.facing === 'left' ? 1.1 : -1.1) * watcher.size, y: watcher.y };
    const placedAt = performance.now();
    setSmokeCursor(cursor);
    noticed = await untilAsync(async () => {
      clickThrough &&= !interactive;
      const now = await summary();
      const pet = now?.pets.find(item => item.id === watcher.id);
      pairDuring ??= now?.pair ?? null;
      return !!pet && pet.facing !== watcher.facing && (pet.facing === 'right') === (cursor.x > pet.x);
    }, 4500, 25);
    if (noticed) noticeMs = Math.round(performance.now() - placedAt);
  }
  await leave();
  // P2-32: the turn must come from the 2.5 s dwell (plus feed and frame latency), not from any turn at all.
  checks.curiosityNotices = watchReady && noticed && clickThrough && pairDuring === null && noticeMs !== null && noticeMs >= 2400 && noticeMs <= 3200;
  checks.curiosityNoticesDetails = { watcher: watcherId, watchReady, noticed, noticeMs, clickThrough, pairDuring };
  step('curiosityNotices');

  // Come here (I9, P2-05). From the tray, the kitten walks to where the cursor last rested inside the
  // scene before it reached the tray. From the kitten's own menu, main waits for the user to point: a
  // cursor that stays on the menu row chooses nothing, a cursor that moves away and rests is the target.
  const menusOffer = PET_IDS.every(id => (['tray', 'menu'] as const).every(source => petItems(id, source).some(item => item.label === 'Come here')));
  const comeTrial = async (source: ComeSource, offset: Point) => {
    applyCommand({ type: 'move', petId: 'jumi', point: spots.jumi });
    await wait(700);
    const from = await petNow('jumi');
    if (!from) return { source, ok: false };
    const goal = { x: Math.round(from.x + offset.x), y: Math.round(from.y + offset.y) };
    const sentBefore = comeLog.length;
    let earlySend = false;
    if (source === 'tray') {
      setSmokeCursor(goal);
      await wait(TRAY_REST_MS + 250);
      freezeTrayRest(); // the pointer reaches the tray icon...
      setSmokeCursor(null); // ...which lies outside the scene
      comeHere('jumi', 'tray');
    } else {
      setSmokeCursor({ x: from.x, y: from.y }); // the menu opens on the kitten
      comeHere('jumi', 'menu');
      setSmokeCursor({ x: from.x + 20, y: from.y + 30 }); // resting on the menu row
      await wait(700);
      earlySend = comeLog.length !== sentBefore;
      setSmokeCursor(goal);
    }
    const startDistance = distance(from, goal);
    const walking = await untilAsync(async () => { const now = await petNow('jumi'); return !!now && now.action === 'walk' && now.speed > 0; }, 1500, 10);
    let closer = false;
    const arrived = await untilAsync(async () => {
      const now = await petNow('jumi');
      if (!now) return false;
      closer ||= distance(now, goal) < startDistance - 40;
      return now.action === 'sit' && distance(now, goal) <= 2;
    }, 8000, 25);
    const sent = comeLog.length > sentBefore ? comeLog[comeLog.length - 1] : null;
    // Away well before the 2.5 s a resting cursor needs to be noticed.
    await leave();
    const aimed = !!sent && sent.source === source && distance(sent.point, goal) <= 2;
    return { source, goal, sent: sent ? sent.point : null, earlySend, walking, closer, arrived, ok: !earlySend && aimed && walking && closer && arrived };
  };
  const trayTrial = await comeTrial('tray', { x: -220, y: 60 });
  const menuTrial = await comeTrial('menu', { x: 210, y: -50 });
  checks.comeHere = menusOffer && trayTrial.ok && menuTrial.ok;
  checks.comeHereDetails = { menusOffer, tray: trayTrial, menu: menuTrial };
  step('comeHere');

  // Treat (I4): it drops in front of her and bounces, she walks over and eats, it turns to crumbs and
  // disappears, and she sits.
  applyCommand({ type: 'move', petId: 'jumi', point: spots.jumi });
  await wait(700);
  const phases = new Set<string>();
  let walkedToTreat = false, ate = false, treatGone = false, satAfter = false, treatCapture: MotionCapture | null = null;
  const treatStarted = performance.now();
  applyCommand({ type: 'treat', petId: 'jumi' });
  while (performance.now() - treatStarted < 9000) {
    const now = await summary();
    const jumi = now?.pets.find(pet => pet.id === 'jumi'), treat = now?.treats.find(item => item.petId === 'jumi');
    if (!now || !jumi) break;
    if (treat) phases.add(treat.phase);
    if (treat?.phase === 'resting' && jumi.action === 'walk') walkedToTreat = true;
    if (jumi.action === 'eat') {
      ate = true;
      if (!treatCapture && jumi.actionTime >= 0.6) treatCapture = await captureMotion('motion-treat', jumi);
    }
    if (ate && !treat) treatGone = true;
    if (treatGone && jumi.action === 'sit') { satAfter = true; break; }
    await wait(20);
  }
  checks.treatFlow = phases.has('falling') && phases.has('resting') && phases.has('eaten') && walkedToTreat && ate && treatGone && satAfter;
  checks.treatFlowDetails = { phases: [...phases], walkedToTreat, ate, treatGone, satAfter, ms: Math.round(performance.now() - treatStarted), capture: treatCapture };
  step('treatFlow');

  // The motion layer draws real kittens (spec 6.5): captures during automatic play and in mid-leap,
  // and no page errors in this overlay at all.
  const motionGeneration = generation;
  applyCommand({ type: 'move', petId: 'jumi', point: spots.jumi });
  await wait(700);
  applyCommand({ type: 'play', petId: 'jumi', automatic: true });
  await wait(1500);
  const player = await petNow('jumi');
  const playCapture = player ? await captureMotion('motion-play', player) : null;
  const playToy = (await summary())?.toy ?? null;
  applyCommand({ type: 'end-play' });
  // Manual play leaves the toy still and just in reach: she eyes it, crouches and leaps onto it.
  applyCommand({ type: 'move', petId: 'jumi', point: spots.jumi });
  await wait(700);
  applyCommand({ type: 'play', petId: 'jumi', automatic: false });
  let leap: number | null = null, pounceCapture: MotionCapture | null = null;
  const pounceStarted = performance.now();
  while (performance.now() - pounceStarted < 8000) {
    const jumi = await petNow('jumi');
    // Captured after the take-off, so the capture lands near the apex.
    if (jumi && jumi.leap !== null && jumi.leap >= 0.25 && jumi.leap <= 0.75) {
      leap = jumi.leap;
      pounceCapture = await captureMotion('motion-pounce', jumi);
      break;
    }
    await wait(5);
  }
  const landed = leap !== null && await untilAsync(async () => (await petNow('jumi'))?.action === 'land', 1000, 10);
  applyCommand({ type: 'end-play' });
  await wait(150);
  const motionCounters = await overlayCounters();
  const consoleErrors = overlayConsoleErrors.filter(entry => entry.generation === motionGeneration);
  checks.motionRenders = !!playCapture?.ok && !!pounceCapture?.ok && leap !== null && landed
    && motionCounters?.pageErrors === 0 && consoleErrors.length === 0 && generation === motionGeneration;
  checks.motionRendersDetails = { play: playCapture, playToy, pounce: pounceCapture, leapProgress: leap, landed, pageErrors: motionCounters?.pageErrors ?? null, consoleErrors };
  step('motionRenders');

  // Hold-to-pet (I2): a press that stays put for 350 ms becomes a held pet (hearts and the looping
  // purr); its release ends it and the kitten sits. Sound is on at volume 0, so the run stays silent.
  const soundBefore = { sound: preferences.sound, volume: preferences.volume };
  updatePreferences({ sound: true, volume: 0 });
  const holdHover = await hoverArchie(center);
  sendInput({ type: 'mouseMove', ...center });
  await wait(30);
  sendInput({ type: 'mouseDown', ...center, button: 'left', clickCount: 1 });
  await wait(450);
  const holding = await overlayCounters();
  const heldArchie = holding?.scene.pets.find(pet => pet.id === 'archie') ?? null;
  const heldCapture = heldArchie ? await captureMotion('motion-held-pet', heldArchie) : null;
  sendInput({ type: 'mouseUp', ...center, button: 'left', clickCount: 1 });
  // A hold shorter than a click's pet ends like a click (P2-01): no longer held at once, still petting
  // until its 2 s are up, then the kitten sits.
  const releasedNotHeld = await untilAsync(async () => { const now = await petNow('archie'); return !!now && !now.held; }, 300, 10);
  const petAfterRelease = (await petNow('archie'))?.action ?? null;
  const releasedToSit = releasedNotHeld && petAfterRelease === 'pet'
    && await untilAsync(async () => { const now = await petNow('archie'); return !!now && now.action === 'sit' && !now.held; }, 2500, 20);
  const captureFreed = await until(() => !inputMode.capture, 300);
  const purrStopped = await untilAsync(async () => (await overlayCounters())?.purring === false, 1000, 20);
  // A quick click is still the 2 s pet, and no hold starts after its release.
  sendInput({ type: 'mouseDown', ...center, button: 'left', clickCount: 1 });
  await wait(80);
  sendInput({ type: 'mouseUp', ...center, button: 'left', clickCount: 1 });
  const clicked = await untilAsync(async () => { const now = await petNow('archie'); return !!now && now.action === 'pet' && !now.held; }, 400, 10);
  await wait(400);
  const afterClick = await petNow('archie');
  updatePreferences(soundBefore);
  checks.heldPet = holdHover && !!heldArchie && heldArchie.held && heldArchie.action === 'pet' && releasedToSit && captureFreed && !!heldCapture?.ok;
  checks.clickPet = clicked && !!afterClick && afterClick.action === 'pet' && !afterClick.held;
  checks.purrLoop = holding?.purring === true && purrStopped;
  checks.heldPetDetails = { holdHover, held: heldArchie, releasedNotHeld, petAfterRelease, releasedToSit, captureFreed, capture: heldCapture, purring: holding?.purring ?? null, purrStopped, clicked, afterClick };
  step('heldPet');

  // Hover through transforms (spec 5.2): the scripted cursor follows the torso of a kitten that turns
  // around and walks (bob and lean), and the hover holds; the turn's mid-squeeze may drop a sample.
  const hoverStart = await hoverArchie(center);
  const start = await petNow('archie');
  let samples = 0, hits = 0, walkSamples = 0, turned = false, sat = false, longestMissMs = 0;
  let missFrom: number | null = null;
  if (start) {
    applyCommand({ type: 'come', petId: 'archie', point: { x: center.x + (start.facing === 'right' ? -160 : 160), y: center.y } });
    const end = performance.now() + 6000;
    while (performance.now() < end) {
      const archie = await petNow('archie');
      if (!archie) break;
      setSmokeCursor({ x: archie.x, y: archie.y + TORSO_OFFSET * archie.size });
      await wait(12);
      samples++;
      const sampledAt = performance.now();
      if (hovering('archie')) {
        hits++;
        if (missFrom !== null) longestMissMs = Math.max(longestMissMs, sampledAt - missFrom);
        missFrom = null;
      } else {
        missFrom ??= sampledAt;
      }
      if (archie.facing !== start.facing) turned = true;
      if (archie.action === 'walk' && archie.speed > 0) walkSamples++;
      if (walkSamples > 0 && archie.action === 'sit') { sat = true; break; }
    }
    if (missFrom !== null) longestMissMs = Math.max(longestMissMs, performance.now() - missFrom);
  }
  const hoverEnd = hovering('archie');
  await leave();

  // ...and through pounce leaps, where only a hit test that follows the pose passes (P2-12). Mid-leap
  // the lifted torso must hover. A ground point GROUND_PROBE × size below the centre is opaque only
  // in the unlifted frame: placed once the kitten is airborne, it must never hover. Each probe gets a
  // fresh manual-play session: the kitten eyes the toy and leaps onto it once, and later pounces on a
  // toy that lies under its paws happen in place, without a leap.
  let liftedSamples = 0, liftedHits = 0, groundSamples = 0, groundHits = 0, leaps = 0;
  for (let session = 0; session < 6 && (liftedSamples < 2 || groundSamples < 2); session++) {
    const probe: 'lifted' | 'ground' = liftedSamples < 2 && (session % 2 === 0 || groundSamples >= 2) ? 'lifted' : 'ground';
    applyCommand({ type: 'end-play' });
    applyCommand({ type: 'move', petId: 'jumi', point: spots.jumi });
    await wait(700);
    applyCommand({ type: 'play', petId: 'jumi', automatic: false });
    let inLeap = false;
    const sessionUntil = performance.now() + 6000;
    while (performance.now() < sessionUntil) {
      const jumi = await petNow('jumi');
      if (!jumi) break;
      const progress = jumi.leap;
      if (progress !== null && progress <= 0.7) {
        if (!inLeap) { inLeap = true; leaps++; }
        const lift = LEAP_HEIGHT * jumi.size * Math.sin(Math.PI * progress);
        if (probe === 'lifted') {
          setSmokeCursor({ x: jumi.x, y: jumi.y + TORSO_OFFSET * jumi.size - lift });
          if (progress >= 0.4 && progress <= 0.65) { liftedSamples++; if (hovering('jumi')) liftedHits++; }
        } else if (progress >= 0.3) {
          setSmokeCursor({ x: jumi.x, y: jumi.y + GROUND_PROBE * jumi.size });
          if (progress >= 0.4 && progress <= 0.65) { groundSamples++; if (hovering('jumi')) groundHits++; }
        }
      } else if (inLeap) {
        break;
      }
      await wait(5);
    }
    setSmokeCursor(null);
  }
  applyCommand({ type: 'end-play' });
  await leave();
  const leapHover = liftedSamples >= 2 && liftedHits >= 2 && liftedHits / liftedSamples >= 0.5 && groundSamples >= 2 && groundHits === 0;
  checks.hoverWithTransforms = hoverStart && turned && walkSamples >= 20 && sat && samples >= 50 && hits / samples >= 0.9 && longestMissMs <= 100 && hoverEnd && leapHover;
  checks.hoverWithTransformsDetails = { hoverStart, samples, hits, walkSamples, turned, sat, longestMissMs: Math.round(longestMissMs), hoverEnd, leaps, liftedSamples, liftedHits, groundSamples, groundHits };
  step('hoverWithTransforms');
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
    // Come here from the tray: remember where the cursor rested before it reached the tray.
    tray.on('mouse-enter', freezeTrayRest); tray.on('click', freezeTrayRest); tray.on('right-click', freezeTrayRest);
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
