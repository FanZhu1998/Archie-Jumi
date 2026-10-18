/**
 * Screenshot-free native Electron benchmark. Run after `npm run build`:
 *   node scripts/benchmark.mjs [--seconds=5] [--output=test-results/performance.json]
 *
 * Uses an isolated temporary app profile, never your real preferences. Does not
 * install, register launch-at-login, or alter the app source. A visible transparent
 * pet overlay is necessary to measure its real compositor cost.
 */
import { _electron as electron } from 'playwright-core';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const seconds = Number(process.argv.find(argument => argument.startsWith('--seconds='))?.split('=')[1] ?? 5);
if (!Number.isFinite(seconds) || seconds < 3 || seconds > 30) throw new Error('--seconds must be between 3 and 30.');
const outputArgument = process.argv.find(argument => argument.startsWith('--output='))?.slice('--output='.length);
const output = resolve(root, outputArgument ?? 'test-results/performance.json');
const results = join(root, 'test-results');
await mkdir(results, { recursive: true });
await mkdir(dirname(output), { recursive: true });
await readFile(join(root, 'dist', 'main.cjs')); // Fail before launching if a build is missing.
const fixture = await mkdtemp(join(results, 'benchmark-'));
const profile = join(fixture, 'profile');
await mkdir(profile, { recursive: true });
const wrapper = join(fixture, 'benchmark-main.cjs');
await writeFile(wrapper, [
  "const { app } = require('electron');",
  `app.setPath('userData', ${JSON.stringify(profile)});`,
  "process.argv.push('--start-hidden-panel');",
  `require(${JSON.stringify(join(root, 'dist', 'main.cjs'))});`,
].join('\n'), 'utf8');

const wait = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));
const round = (value, digits = 3) => Number(value.toFixed(digits));
const processors = cpus().length;
const report = {
  generatedAt: new Date().toISOString(),
  appVersion: JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version,
  environment: { platform: platform(), release: release(), logicalProcessors: processors, cpu: cpus()[0]?.model },
  method: {
    sampleDurationSeconds: seconds,
    sampleIntervalSeconds: 1,
    screenshotsTaken: false,
    settingsOpened: false,
    isolatedProfile: profile,
    cpu: 'Sum of per-process cumulativeCPUUsage deltas / wall seconds / logical processors × 100. This is percent of total system CPU capacity, not percent of one core.',
    memory: 'Electron workingSetSize/privateBytes are KiB; reported totals are MiB. Summed working sets can double-count memory shared across processes; private bytes are committed memory, not resident memory. GPU process data is not GPU utilization or dedicated VRAM.',
    drawing: 'Only drawImage calls on attached HTMLCanvasElement surfaces inside the pet-overlay document are counted. Detached atlas-mask work, including lazy page loads, is excluded. With two visible kittens, two sprite draws equal one scene render. Instrumentation and Playwright add small overhead.',
    canvasMemory: 'Sum of width × height ×4 bytes for all attached canvas backing stores. This estimates one RGBA surface per canvas, not additional compositor buffers or atlas textures.',
    targets: { restingTotalCpuPercentBelow: 1, summedWorkingSetMiBBelow: 500, hiddenSpriteDraws: 0 },
  },
  phases: [],
  errors: [],
  diagnostics: { stderr: '', console: [], windows: [], mainEvents: [] },
};

let application;
let applicationClosed = false;
try {
  application = await electron.launch({
    args: [wrapper, '--start-hidden-panel'],
    executablePath: join(root, 'node_modules', 'electron', 'dist', platform() === 'win32' ? 'electron.exe' : 'electron'),
    cwd: root,
    timeout: 30_000,
  });
  application.on('close', () => { applicationClosed = true; });
  application.process().stderr?.on('data', chunk => {
    report.diagnostics.stderr = (report.diagnostics.stderr + chunk.toString()).slice(-24_000);
  });
  const watchedPages = new WeakSet();
  function watchPage(candidate) {
    if (watchedPages.has(candidate)) return;
    watchedPages.add(candidate);
    const record = event => report.diagnostics.windows.push({ at: new Date().toISOString(), event, url: candidate.url() });
    record('opened');
    candidate.on('close', () => record('closed'));
    candidate.on('crash', () => { record('crashed'); report.errors.push(`Renderer crashed: ${candidate.url()}`); });
    candidate.on('pageerror', error => report.errors.push(`${candidate.url()}: ${String(error)}`));
    candidate.on('console', message => {
      if (message.type() === 'error' || message.type() === 'warning') report.diagnostics.console.push({ type: message.type(), text: message.text().slice(0, 2000), url: candidate.url() });
    });
  }
  application.on('window', watchPage);
  for (const candidate of application.windows()) watchPage(candidate);
  await application.evaluate(({ app, BrowserWindow, screen }) => {
    globalThis.__benchmarkWindowEvents = [];
    const record = (event, details = {}) => globalThis.__benchmarkWindowEvents.push({ at: Date.now(), event, ...details });
    const observe = window => {
      const id = window.id;
      record('browser-window-created', { id });
      window.on('closed', () => record('browser-window-closed', { id }));
      window.webContents.on('render-process-gone', (_event, details) => record('render-process-gone', { id, details }));
      window.webContents.on('did-fail-load', (_event, code, description, url) => record('did-fail-load', { id, code, description, url }));
    };
    for (const window of BrowserWindow.getAllWindows()) observe(window);
    app.on('browser-window-created', (_event, window) => observe(window));
    screen.on('display-added', (_event, display) => record('display-added', { display: display.id }));
    screen.on('display-removed', (_event, display) => record('display-removed', { display: display.id }));
    screen.on('display-metrics-changed', (_event, display, metrics) => record('display-metrics-changed', { display: display.id, metrics }));
    for (const window of BrowserWindow.getAllWindows()) if (window.webContents.getURL().includes('view=settings')) window.close();
  });
  // Display startup can destroy the first overlay and replace it. Select a live,
  // visibly ready scene instead of retaining a possibly ephemeral firstWindow().
  let page;
  let lastCandidate = null;
  let stableSince = 0;
  const readyDeadline = performance.now() + 30_000;
  while (!page && performance.now() < readyDeadline) {
    if (applicationClosed) throw new Error('Electron exited before a stable overlay was ready. See diagnostics.stderr and window events.');
    let candidate = application.windows().find(value => !value.isClosed() && value.url().includes('view=overlay'));
    let ready = false;
    if (candidate) {
      watchPage(candidate);
      try {
        const renderer = await candidate.evaluate(async () => {
          const canvas = document.querySelector('canvas');
          const error = document.querySelector('[data-error]')?.textContent;
          if (error) throw new Error(error);
          if (!window.desktop || !canvas) return false;
          await window.desktop.getBootstrap();
          return canvas.width > 0 && canvas.height > 0;
        });
        const nativeWindow = await application.browserWindow(candidate);
        ready = renderer && await nativeWindow.evaluate(window => !window.isDestroyed() && window.isVisible());
        await nativeWindow.dispose();
      } catch (error) {
        if (!candidate.isClosed()) report.diagnostics.windows.push({ at: new Date().toISOString(), event: 'readiness-error', message: String(error).slice(0, 1000), url: candidate.url() });
        candidate = null;
      }
    }
    if (candidate !== lastCandidate || !ready) { lastCandidate = candidate; stableSince = performance.now(); }
    else if (performance.now() - stableSince >= 600) page = candidate;
    if (!page) await wait(100);
  }
  if (!page) throw new Error('No live overlay reached visible, nonempty-canvas, stable readiness within 30 seconds. See diagnostic events; no performance result is valid.');
  await page.evaluate(() => {
    window.__benchmarkSpriteDraws = 0;
    const original = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      if (this.canvas instanceof HTMLCanvasElement && this.canvas.isConnected && document.body.classList.contains('pet-overlay')) {
        window.__benchmarkSpriteDraws++;
      }
      return Reflect.apply(original, this, args);
    };
  });
  const environment = await application.evaluate(({ app, BrowserWindow, screen }) => ({
    versions: process.versions,
    gpuFeatureStatus: app.getGPUFeatureStatus(),
    displays: screen.getAllDisplays().map(display => ({ id: display.id, workArea: display.workArea, scaleFactor: display.scaleFactor, primary: display.id === screen.getPrimaryDisplay().id })),
    windows: BrowserWindow.getAllWindows().map(window => ({ url: window.webContents.getURL(), bounds: window.getBounds(), visible: window.isVisible(), focusable: window.isFocusable() })),
  }));
  Object.assign(report.environment, environment);

  async function sample() {
    const started = performance.now();
    const processes = await application.evaluate(({ app, BrowserWindow }) => {
      const roles = new Map(BrowserWindow.getAllWindows().map(window => [window.webContents.getOSProcessId(), window.webContents.getURL().includes('view=overlay') ? 'overlay' : 'settings']));
      return app.getAppMetrics().map(metric => ({
        pid: metric.pid,
        creationTime: metric.creationTime,
        type: metric.type,
        role: roles.get(metric.pid) ?? metric.name ?? metric.serviceName ?? metric.type,
        cpuSeconds: metric.cpu.cumulativeCPUUsage ?? null,
        workingSetKiB: metric.memory.workingSetSize,
        privateBytesKiB: metric.memory.privateBytes ?? null,
      }));
    });
    const renderer = await page.evaluate(() => {
      const canvases = [...document.querySelectorAll('canvas')].map((canvas, index) => ({
        index, width: canvas.width, height: canvas.height, visible: getComputedStyle(canvas).display !== 'none',
        backingBytes: canvas.width * canvas.height * 4,
      }));
      return { spriteDraws: window.__benchmarkSpriteDraws, dpr: devicePixelRatio, canvases,
        canvasBackingBytes: canvases.reduce((sum, canvas) => sum + canvas.backingBytes, 0) };
    });
    return { atMilliseconds: (started + performance.now()) / 2, processes, renderer };
  }

  async function phase(name, setup) {
    await setup();
    await wait(1500); // Exclude transition and image-upload work from each steady-state sample.
    const samples = [await sample()];
    const deadline = performance.now() + seconds * 1000;
    while (performance.now() < deadline) {
      await wait(Math.min(1000, Math.max(1, deadline - performance.now())));
      samples.push(await sample());
    }
    const first = samples[0];
    const last = samples.at(-1);
    const elapsed = (last.atMilliseconds - first.atMilliseconds) / 1000;
    const baseline = new Map(first.processes.map(metric => [`${metric.pid}:${metric.creationTime}`, metric]));
    const perProcess = last.processes.map(metric => {
      const old = baseline.get(`${metric.pid}:${metric.creationTime}`);
      const delta = old && metric.cpuSeconds !== null && old.cpuSeconds !== null ? Math.max(0, metric.cpuSeconds - old.cpuSeconds) : null;
      return { ...metric, workingSetMiB: round(metric.workingSetKiB / 1024), privateMiB: metric.privateBytesKiB === null ? null : round(metric.privateBytesKiB / 1024),
        cpuSecondsDelta: delta === null ? null : round(delta, 6), totalSystemCpuPercent: delta === null ? null : round(delta / elapsed / processors * 100, 4) };
    });
    const totalAt = entry => entry.processes.reduce((sum, metric) => sum + metric.workingSetKiB / 1024, 0);
    const completeCpu = perProcess.every(metric => metric.cpuSecondsDelta !== null);
    const totalCpu = completeCpu ? perProcess.reduce((sum, metric) => sum + metric.totalSystemCpuPercent, 0) : null;
    const spriteDraws = last.renderer.spriteDraws - first.renderer.spriteDraws;
    const result = {
      name, elapsedSeconds: round(elapsed),
      totalSystemCpuPercent: totalCpu === null ? null : round(totalCpu, 4),
      summedWorkingSetMiB: { mean: round(samples.reduce((sum, entry) => sum + totalAt(entry), 0) / samples.length), min: round(Math.min(...samples.map(totalAt))), max: round(Math.max(...samples.map(totalAt))), end: round(totalAt(last)) },
      summedPrivateMiB: round(last.processes.reduce((sum, metric) => sum + (metric.privateBytesKiB ?? 0) / 1024, 0)),
      spriteDraws, approximateSceneRendersPerSecond: round(spriteDraws / 2 / elapsed),
      surfaces: last.renderer.canvases,
      devicePixelRatio: last.renderer.dpr,
      canvasBackingBytes: last.renderer.canvasBackingBytes,
      canvasBackingMiB: round(last.renderer.canvasBackingBytes / 1024 / 1024),
      perProcess,
      samples,
    };
    report.phases.push(result);
    await writeFile(output, JSON.stringify(report, null, 2), 'utf8');
    console.log(`${name}: ${result.totalSystemCpuPercent ?? 'unavailable'}% total CPU; ${result.summedWorkingSetMiB.mean} MiB summed working set; ${result.approximateSceneRendersPerSecond} scene renders/s`);
  }

  await wait(3500); // Let first asset decoding finish, with no screenshots or settings.
  await phase('resting', () => page.evaluate(() => {
    window.desktop.sendCommand({ type: 'end-play' });
    window.desktop.sendCommand({ type: 'nap', petId: 'archie' });
    window.desktop.sendCommand({ type: 'nap', petId: 'jumi' });
  }));
  await phase('active-play', () => page.evaluate(() => {
    window.desktop.sendCommand({ type: 'wake', petId: 'archie' });
    window.desktop.sendCommand({ type: 'wake', petId: 'jumi' });
    window.desktop.sendCommand({ type: 'play', petId: 'jumi', automatic: true });
  }));
  await phase('hidden', () => page.evaluate(() => window.desktop.action('hide')));
  report.acceptance = {
    restingCpuBelowOnePercent: report.phases[0].totalSystemCpuPercent === null ? null : report.phases[0].totalSystemCpuPercent < 1,
    restingWorkingSetBelow500MiB: report.phases[0].summedWorkingSetMiB.mean < 500,
    hiddenDrawingStopped: report.phases[2].spriteDraws === 0,
    note: 'This short instrumented run is a targeted engineering measurement, not a hardware-independent performance guarantee.',
  };
} catch (error) {
  report.errors.push(error?.stack ?? String(error));
  process.exitCode = 1;
} finally {
  if (application && !applicationClosed) {
    report.diagnostics.mainEvents = await application.evaluate(() => globalThis.__benchmarkWindowEvents ?? []).catch(error => [{ event: 'diagnostics-unavailable', message: String(error) }]);
    await application.close().catch(error => report.errors.push(`Close: ${String(error)}`));
  }
  await writeFile(output, JSON.stringify(report, null, 2), 'utf8');
  console.log(`Performance report: ${output}`);
  if (report.errors.length) { process.exitCode = 1; console.error(report.errors.join('\n')); }
}
