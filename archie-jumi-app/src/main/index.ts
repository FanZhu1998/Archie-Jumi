import { app, BrowserWindow, Tray, Menu, screen, ipcMain, globalShortcut, powerMonitor, nativeImage, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { StateStore } from './storage';
import { windowsLoginTarget } from './login-item';
import { defaultPreferences } from '../shared/defaults';
import { normalizePreferences, validCommand } from '../shared/validation';
import { PET_IDS, type Bootstrap, type PetId, type Preferences, type PetCommand, type Lifecycle } from '../shared/types';

const smoke = process.argv.includes('--smoke-test');
const smokeOutput = process.argv.find(v => v.startsWith('--smoke-output='))?.slice('--smoke-output='.length) ?? join(process.cwd(), 'test-results');
if (smoke) app.setPath('userData', join(smokeOutput, 'profile'));
const APP_ID = 'com.squirrel.archie_jumi.archie-jumi';
app.setAppUserModelId(APP_ID);
let overlay: BrowserWindow | null = null, settings: BrowserWindow | null = null, tray: Tray | null = null;
let preferences = defaultPreferences(), generation = 0, hidden = false, paused = false, sceneReady = false;
let heartbeatAt = Date.now(), quitting = false, flushed = false, saveTimer: NodeJS.Timeout | undefined;
let runtimeNotices: string[] = [], inputMode = { target: null as PetId | 'toy' | null, capture: false };
let store: StateStore;
const rendererFile = join(__dirname, 'renderer', 'index.html');
const getDisplay = () => screen.getAllDisplays().find(d => String(d.id) === preferences.selectedDisplay) ?? screen.getPrimaryDisplay();
const getScene = () => ({ width: getDisplay().workArea.width, height: getDisplay().workArea.height });
function bootstrap(): Bootstrap {
  const display = getDisplay(), cursor = screen.getCursorScreenPoint();
  return { preferences: structuredClone(preferences), scene: getScene(), generation, hidden, paused, cursor: { x: cursor.x - display.workArea.x, y: cursor.y - display.workArea.y }, version: app.getVersion(), notices: [...store.notices, ...runtimeNotices], displays: screen.getAllDisplays().map(d => ({ id: String(d.id), label: d.label || `Display ${d.id}`, width: d.workArea.width, height: d.workArea.height, scaleFactor: d.scaleFactor, primary: d.id === screen.getPrimaryDisplay().id })) };
}
function sendBootstrap() {
  for (const w of [overlay, settings]) if (w && !w.isDestroyed()) w.webContents.send('bootstrap-update', bootstrap());
  updateTray();
}
function lifecycle(event: Lifecycle) { if (overlay && !overlay.isDestroyed()) overlay.webContents.send('lifecycle', event); }
function safeInput() {
  inputMode = { target: null, capture: false };
  if (overlay && !overlay.isDestroyed()) overlay.setIgnoreMouseEvents(true, { forward: true });
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { store.save({ schemaVersion: 1, preferences }).catch(() => { runtimeNotices = [...runtimeNotices.filter(n => !n.startsWith('Could not save')), 'Could not save your preferences. This session still works; check disk space and folder access.']; sendBootstrap(); }); }, 400);
}
function secureWindow(window: BrowserWindow) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
  window.webContents.session.setSpellCheckerEnabled(false);
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !['file:', 'data:', 'blob:', 'devtools:'].some(protocol => details.url.startsWith(protocol)) }));
}
function createOverlay() {
  sceneReady = false;
  lifecycle({ type: 'cancel-input' });
  if (overlay && !overlay.isDestroyed()) { overlay.hide(); overlay.destroy(); }
  generation++;
  const bounds = getDisplay().workArea;
  const win = new BrowserWindow({ ...bounds, show: false, transparent: true, backgroundColor: '#00000000', frame: false, resizable: false, movable: false, focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  overlay = win;
  secureWindow(win);
  safeInput();
  win.webContents.on('render-process-gone', () => { if (overlay === win) recover('The pet scene stopped. Use Show All to bring your kittens back.'); });
  win.on('unresponsive', () => { if (overlay === win) recover('The pet scene paused unexpectedly. Use Show All to restore it.'); });
  win.on('closed', () => { if (overlay === win) overlay = null; });
  void win.loadFile(rendererFile, { query: { view: 'overlay' } });
  heartbeatAt = Date.now();
  setTimeout(() => { if (overlay === win && !sceneReady && !hidden) { recover('The pet scene could not start. Reopen the app or restore its bundled animation files.'); openSettings(); } }, 15000).unref();
}
function openSettings() {
  if (settings && !settings.isDestroyed()) { settings.show(); settings.focus(); settings.webContents.send('bootstrap-update', bootstrap()); return; }
  settings = new BrowserWindow({ width: 1080, height: 850, minWidth: 720, minHeight: 600, title: 'Archie & Jumi', backgroundColor: '#f7f4ee', icon: join(__dirname, 'icon.png'), show: false, autoHideMenuBar: true, webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  secureWindow(settings);
  settings.on('ready-to-show', () => settings?.show());
  settings.on('closed', () => { settings = null; });
  void settings.loadFile(rendererFile, { query: { view: 'settings' } });
}
function setHidden(value: boolean) {
  hidden = value; safeInput();
  if (value) { lifecycle({ type: 'pause' }); overlay?.hide(); }
  else {
    if (!overlay || overlay.isDestroyed() || !sceneReady) createOverlay();
    else if (!paused) { heartbeatAt = Date.now(); lifecycle({ type: 'resume', cursor: bootstrap().cursor }); overlay.showInactive(); }
    runtimeNotices = runtimeNotices.filter(n => !n.startsWith('The pet scene'));
  }
  sendBootstrap();
}
function recover(message: string) {
  safeInput(); hidden = true; sceneReady = false; overlay?.hide(); lifecycle({ type: 'pause' });
  runtimeNotices = [...runtimeNotices.filter(n => !n.startsWith('The pet scene')), message]; sendBootstrap();
}
function applyCommand(command: PetCommand) {
  if ('petId' in command && (command.type === 'show' || command.type === 'hide')) {
    preferences.pets[command.petId].visible = command.type === 'show'; scheduleSave(); sendBootstrap();
  }
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('pet-command', command);
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
  if (preferences.selectedDisplay !== old.selectedDisplay) createOverlay();
  if (preferences.quiet) safeInput();
  scheduleSave(); sendBootstrap(); return bootstrap();
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
    if (!isSender(event, 'overlay') || !payload || payload.generation !== generation || typeof payload.capture !== 'boolean' || ![null, 'archie', 'jumi', 'toy'].includes(payload.target)) return;
    if (preferences.quiet || hidden || paused) { safeInput(); return; }
    inputMode = { target: payload.target, capture: payload.capture };
    overlay?.setIgnoreMouseEvents(!inputMode.target && !inputMode.capture, { forward: true });
  });
  ipcMain.on('scene-ready', (event, value) => {
    if (!isSender(event, 'overlay') || value !== generation) return;
    sceneReady = true; heartbeatAt = Date.now();
    // Preferences/visibility can change while sprite atlases are loading.
    overlay?.webContents.send('bootstrap-update', bootstrap());
    if (!hidden && !paused) { overlay?.showInactive(); lifecycle({ type: 'resume', cursor: bootstrap().cursor }); }
  });
  ipcMain.on('heartbeat', (event, value) => { if (isSender(event, 'overlay') && value === generation) heartbeatAt = Date.now(); });
  ipcMain.on('positions', (event, positions) => {
    if (!isSender(event, 'overlay') || !positions || typeof positions !== 'object') return;
    const pets = Object.fromEntries(PET_IDS.map(id => [id, { position: positions[id] }]));
    preferences = normalizePreferences({ pets }, preferences); scheduleSave();
    if (settings && !settings.isDestroyed()) settings.webContents.send('bootstrap-update', bootstrap());
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
async function runSmoke() {
  await mkdir(smokeOutput, { recursive: true });
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const report: Record<string, unknown> = { version: app.getVersion(), checks: {}, errors: [] };
  const checks = report.checks as Record<string, unknown>;
  for (let i = 0; i < 100 && !sceneReady; i++) await wait(100);
  checks.rendererReady = sceneReady;
  checks.noNodeIntegration = await overlay?.webContents.executeJavaScript('typeof require === "undefined" && typeof process === "undefined"');
  checks.nonFocusable = !overlay?.isFocusable();
  checks.scene = getScene();
  await wait(800);
  if (overlay) {
    await writeFile(join(smokeOutput, 'desktop-pets.png'), (await overlay.webContents.capturePage()).toPNG());
    checks.overlay = await overlay.webContents.executeJavaScript('({ canvases: document.querySelectorAll("canvas").length, error: document.querySelector("[data-error]")?.textContent ?? null })');
    applyCommand({ type: 'pet', petId: 'archie' }); await wait(200);
    applyCommand({ type: 'play', petId: 'jumi', automatic: true }); await wait(800);
    await writeFile(join(smokeOutput, 'play.png'), (await overlay.webContents.capturePage()).toPNG());
    applyCommand({ type: 'end-play' });
    const center = { x: Math.round(getScene().width / 3), y: Math.round(getScene().height / 2) };
    applyCommand({ type: 'move', petId: 'archie', point: center });
    applyCommand({ type: 'pet', petId: 'archie' }); await wait(150);
    overlay.webContents.sendInputEvent({ type: 'mouseMove', ...center }); await wait(150);
    checks.petPixelInteractive = inputMode.target === 'archie';
    overlay.webContents.sendInputEvent({ type: 'mouseDown', ...center, button: 'left', clickCount: 1 }); await wait(100);
    checks.pointerCaptured = inputMode.capture;
    overlay.webContents.sendInputEvent({ type: 'mouseMove', x: center.x + 25, y: center.y + 15 });
    overlay.webContents.sendInputEvent({ type: 'mouseUp', x: center.x + 25, y: center.y + 15, button: 'left', clickCount: 1 }); await wait(150);
    checks.captureReleased = !inputMode.capture;
    overlay.webContents.sendInputEvent({ type: 'mouseMove', x: 4, y: 4 }); await wait(100);
    checks.emptySpaceInputMode = inputMode.target === null && !inputMode.capture;
    overlay.webContents.sendInputEvent({ type: 'mouseMove', ...center });
    applyCommand({ type: 'move', petId: 'archie', point: center }); await wait(150);
    checks.stationaryCursorEntry = inputMode.target === 'archie';
    applyCommand({ type: 'move', petId: 'archie', point: { x: center.x + 200, y: center.y } }); await wait(150);
    checks.stationaryCursorExit = inputMode.target === null;
  }
  updatePreferences({ quiet: true }); await wait(300); checks.quietInputSafe = inputMode.target === null && !inputMode.capture;
  updatePreferences({ quiet: false });
  setHidden(true); checks.hidden = !overlay?.isVisible(); setHidden(false); await wait(300); checks.restored = overlay?.isVisible();
  openSettings(); await wait(1800);
  if (settings) {
    await writeFile(join(smokeOutput, 'control-panel.png'), (await settings.webContents.capturePage()).toPNG());
    checks.settings = await settings.webContents.executeJavaScript('({ title: document.title, text: document.body.innerText.slice(0, 4000), buttons: document.querySelectorAll("button").length })');
  }
  checks.metrics = app.getAppMetrics().map(m => ({ type: m.type, memory: m.memory, cpu: m.cpu }));
  const displayChecks = [];
  for (const display of screen.getAllDisplays()) {
    updatePreferences({ selectedDisplay: String(display.id) });
    for (let i = 0; i < 80 && !sceneReady; i++) await wait(50);
    displayChecks.push({ id: display.id, scaleFactor: display.scaleFactor, ready: sceneReady, actual: overlay?.getBounds(), expected: display.workArea });
  }
  checks.displaySelection = displayChecks;
  updatePreferences({ selectedDisplay: null });
  for (let i = 0; i < 80 && !sceneReady; i++) await wait(50);
  overlay?.webContents.forcefullyCrashRenderer(); await wait(500);
  checks.crashHidden = hidden && !overlay?.isVisible();
  setHidden(false);
  for (let i = 0; i < 80 && !sceneReady; i++) await wait(50);
  checks.crashRestored = sceneReady && overlay?.isVisible();
  await store.save({ schemaVersion: 1, preferences });
  checks.saved = true;
  const required = ['rendererReady', 'noNodeIntegration', 'nonFocusable', 'petPixelInteractive', 'pointerCaptured', 'captureReleased', 'emptySpaceInputMode', 'stationaryCursorEntry', 'stationaryCursorExit', 'quietInputSafe', 'hidden', 'restored', 'crashHidden', 'crashRestored', 'saved'];
  report.errors = required.filter(key => checks[key] !== true).map(key => `Failed native check: ${key}`);
  await writeFile(join(smokeOutput, 'smoke-report.json'), JSON.stringify(report, null, 2));
  if ((report.errors as string[]).length) app.exit(1); else app.quit();
}
if (squirrelStartup || !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', openSettings);
  void app.whenReady().then(async () => {
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
    const displaysChanged = () => { clearTimeout(displayTimer); displayTimer = setTimeout(() => { if (!screen.getAllDisplays().some(d => String(d.id) === preferences.selectedDisplay)) preferences.selectedDisplay = null; createOverlay(); sendBootstrap(); scheduleSave(); }, 200); };
    screen.on('display-added', displaysChanged); screen.on('display-removed', displaysChanged); screen.on('display-metrics-changed', displaysChanged);
    const pause = () => { paused = true; safeInput(); lifecycle({ type: 'pause' }); overlay?.hide(); };
    const resume = () => { paused = false; heartbeatAt = Date.now(); if (!hidden && sceneReady) { lifecycle({ type: 'resume', cursor: bootstrap().cursor }); overlay?.showInactive(); } sendBootstrap(); };
    powerMonitor.on('suspend', pause); powerMonitor.on('lock-screen', pause); powerMonitor.on('resume', resume); powerMonitor.on('unlock-screen', resume);
    setInterval(() => { if (sceneReady && !hidden && !paused && Date.now() - heartbeatAt > 3500) recover('The pet scene stopped responding. Use Show All to restore it.'); }, 1000).unref();
    if (smoke) void runSmoke().catch(async error => { await mkdir(smokeOutput, { recursive: true }); await writeFile(join(smokeOutput, 'smoke-error.txt'), String(error.stack ?? error)); app.quit(); });
  });
}
app.on('window-all-closed', () => {});
app.on('before-quit', event => {
  quitting = true;
  if (flushed || !store) return;
  event.preventDefault(); clearTimeout(saveTimer); globalShortcut.unregisterAll();
  void store.save({ schemaVersion: 1, preferences }).catch(() => {}).finally(() => { flushed = true; app.quit(); });
});
app.on('will-quit', () => { globalShortcut.unregisterAll(); tray?.destroy(); });
