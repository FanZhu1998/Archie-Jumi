/**
 * README screenshots. Run after `npm run build`:
 *   node scripts/screenshots.mjs [--output=docs/screenshots]
 *
 * Launches the built app with a fresh temporary profile (never your own settings), poses the kittens
 * through the app's own command channel and captures only the app's own windows: the overlay (drawn on
 * a neutral backdrop here, so nothing from the real desktop appears) and the Settings window. Output
 * images carry no metadata. The kittens appear on screen for about a minute while it runs.
 */
import { _electron as electron } from 'playwright-core';
import sharp from 'sharp';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputArgument = process.argv.find(argument => argument.startsWith('--output='))?.slice('--output='.length);
const output = resolve(root, outputArgument ?? 'docs/screenshots');
await readFile(join(root, 'dist', 'main.cjs')); // Fail early without a build.
await mkdir(output, { recursive: true });

// Editor hosts may export ELECTRON_RUN_AS_NODE=1, which turns Electron into plain Node.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const fixture = await mkdtemp(join(tmpdir(), 'archie-jumi-screenshots-'));
const profile = join(fixture, 'profile');
await mkdir(profile, { recursive: true });
const wrapper = join(fixture, 'main.cjs');
await writeFile(wrapper, [
  "const { app } = require('electron');",
  `app.setPath('userData', ${JSON.stringify(profile)});`,
  `require(${JSON.stringify(join(root, 'dist', 'main.cjs'))});`,
].join('\n'), 'utf8');
// Launched as an app folder with the real name and version, so Settings shows "v1.1.0", not Electron's version.
const appPackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: appPackage.name, productName: appPackage.productName, version: appPackage.version, main: 'main.cjs' }), 'utf8');

const wait = ms => new Promise(done => setTimeout(done, ms));
async function until(probe, timeoutMs, stepMs = 25) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= end) return null;
    await wait(stepMs);
  }
}

/** A soft wallpaper-like backdrop so the transparent overlay captures read as "on the desktop". */
function backdrop(width, height) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#c9d7e6"/><stop offset="0.55" stop-color="#ddd8e8"/><stop offset="1" stop-color="#efe3d6"/>
      </linearGradient>
      <radialGradient id="glow" cx="0.3" cy="0.2" r="0.9"><stop offset="0" stop-color="#ffffff" stop-opacity="0.35"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#sky)"/><rect width="100%" height="100%" fill="url(#glow)"/>
  </svg>`);
}

/** Crops an overlay capture to what is drawn (plus padding, at a fixed aspect ratio) and puts it on the backdrop. */
async function compose(png, name, { width = 960, aspect = 2, pad = 0.22 } = {}) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    if (data[(y * info.width + x) * 4 + 3] <= 8) continue;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (maxX < 0) throw new Error(`${name}: the overlay capture is empty`);
  const padding = Math.round(Math.max(maxX - minX, maxY - minY) * pad);
  let left = minX - padding, top = minY - padding, right = maxX + padding, bottom = maxY + padding;
  const grow = (extra, low, high) => [low - Math.floor(extra / 2), high + Math.ceil(extra / 2)];
  if ((right - left) / (bottom - top) < aspect) [left, right] = grow(Math.round((bottom - top) * aspect - (right - left)), left, right);
  else [top, bottom] = grow(Math.round((right - left) / aspect - (bottom - top)), top, bottom);
  // Keep the frame inside the capture, shifting it rather than cropping the kittens.
  const shift = (low, high, size) => (low < 0 ? [0, Math.min(size, high - low)] : high > size ? [Math.max(0, low - (high - size)), size] : [low, high]);
  [left, right] = shift(left, right, info.width);
  [top, bottom] = shift(top, bottom, info.height);
  const crop = { left, top, width: right - left, height: bottom - top };
  const kittens = await sharp(png).extract(crop).png().toBuffer();
  const file = join(output, `${name}.jpg`);
  await sharp(backdrop(crop.width, crop.height)).composite([{ input: kittens }])
    .resize({ width, withoutEnlargement: true }).jpeg({ quality: 88, mozjpeg: true }).toFile(file);
  console.log(`${name}.jpg  ${crop.width}x${crop.height} capture px`);
}

let application;
const results = [];
try {
  application = await electron.launch({
    args: [fixture],
    executablePath: join(root, 'node_modules', 'electron', 'dist', platform() === 'win32' ? 'electron.exe' : 'electron'),
    cwd: root,
    env,
    timeout: 30_000,
  });
  const pageFor = view => until(() => application.windows().find(page => !page.isClosed() && page.url().includes(`view=${view}`)), 30_000, 100);
  const overlay = await pageFor('overlay'), settings = await pageFor('settings');
  if (!overlay || !settings) throw new Error('The overlay or the Settings window did not open.');
  await overlay.waitForFunction(() => window.__archieJumi?.scene?.pets?.length === 2, null, { timeout: 30_000 });
  const visible = await until(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.webContents.getURL().includes('view=overlay') && window.isVisible())), 15_000, 100);
  if (!visible) throw new Error('The overlay never became visible.');

  const send = command => overlay.evaluate(value => window.desktop.sendCommand(value), command);
  const scene = () => overlay.evaluate(() => window.__archieJumi.scene);
  const pet = async id => (await scene()).pets.find(item => item.id === id);
  const save = patch => settings.evaluate(value => window.desktop.savePreferences(value), patch);
  const capture = async () => Buffer.from(await application.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('view=overlay'));
    return (await window.webContents.capturePage()).toPNG().toString('base64');
  }), 'base64');
  const size = await overlay.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const center = { x: Math.round(size.width * 0.5), y: Math.round(size.height * 0.6) };
  const show = async (archie, jumi) => {
    await send({ type: archie ? 'show' : 'hide', petId: 'archie' });
    await send({ type: jumi ? 'show' : 'hide', petId: 'jumi' });
  };
  // Larger kittens show more detail; the Settings capture goes back to the default size.
  const sized = async value => save({ pets: { archie: { size: value }, jumi: { size: value } } });
  await sized(176);
  await wait(1500);

  // 1. Both kittens side by side.
  await send({ type: 'move', petId: 'archie', point: { x: center.x - 130, y: center.y } });
  await send({ type: 'move', petId: 'jumi', point: { x: center.x + 130, y: center.y } });
  await wait(1400);
  await compose(await capture(), 'together');
  results.push('together');

  // 2. A nose boop (first, before any pair cooldown can start).
  await send({ type: 'pair', kind: 'nose_touch' });
  const touching = await until(async () => (await scene()).pair === 'nose_touch:together', 10_000);
  if (touching) { await wait(300); await compose(await capture(), 'nose-boop'); results.push('nose-boop'); }
  else console.warn('nose-boop: the pair activity did not start; skipped');
  await wait(2500);

  // 3. Yarn play: Jumi alone, captured in mid-pounce.
  await show(false, true);
  await send({ type: 'move', petId: 'jumi', point: center });
  await wait(900);
  await send({ type: 'play', petId: 'jumi', automatic: false });
  const leaping = await until(async () => { const jumi = await pet('jumi'); return jumi?.leap !== null && jumi.leap >= 0.3 && jumi.leap <= 0.6; }, 10_000, 10);
  if (leaping) { await compose(await capture(), 'yarn-pounce'); results.push('yarn-pounce'); }
  else console.warn('yarn-pounce: no leap within 10 s; skipped');
  await send({ type: 'end-play' });

  // 4. A treat: Archie alone, captured while eating.
  await show(true, false);
  await send({ type: 'move', petId: 'archie', point: center });
  await wait(900);
  await send({ type: 'treat', petId: 'archie' });
  const eating = await until(async () => { const archie = await pet('archie'); return archie?.action === 'eat' && archie.actionTime >= 0.6; }, 10_000);
  if (eating) { await compose(await capture(), 'treat'); results.push('treat'); }
  else console.warn('treat: Archie never started eating; skipped');
  await wait(3500);

  // 5. Petting: a heart rises.
  await send({ type: 'move', petId: 'archie', point: center });
  await wait(900);
  await send({ type: 'pet', petId: 'archie' });
  await wait(650);
  await compose(await capture(), 'petting');
  results.push('petting');

  // 6. A nap side by side, with drifting z's.
  await show(true, true);
  await send({ type: 'move', petId: 'archie', point: { x: center.x - 85, y: center.y } });
  await send({ type: 'move', petId: 'jumi', point: { x: center.x + 85, y: center.y } });
  await wait(900);
  await send({ type: 'nap', petId: 'archie' });
  await send({ type: 'nap', petId: 'jumi' });
  await wait(2200);
  await compose(await capture(), 'napping');
  results.push('napping');

  // 7. The Settings window at the default size, with Archie's personality panel open.
  await sized(128);
  await send({ type: 'wake', petId: 'archie' });
  await send({ type: 'wake', petId: 'jumi' });
  await settings.bringToFront();
  await settings.evaluate(() => scrollTo(0, 0));
  await settings.locator('#pet-archie summary').click();
  // Monitor names identify hardware: show generic labels in the capture only (the app is unchanged).
  await settings.evaluate(() => {
    for (const select of document.querySelectorAll('select')) [...select.options].forEach((option, index) => {
      option.textContent = `Display ${index + 1}${/Primary/.test(option.textContent ?? '') ? ' · Primary' : ''}`;
    });
  });
  await wait(600);
  const page = await settings.screenshot({ fullPage: true, type: 'png' });
  await sharp(page).resize({ width: 1100, withoutEnlargement: true }).png({ palette: true, quality: 92, compressionLevel: 9 }).toFile(join(output, 'settings.png'));
  console.log('settings.png');
  results.push('settings');
} finally {
  if (application) await application.close().catch(() => {});
  await rm(fixture, { recursive: true, force: true }).catch(() => {});
}
console.log(`Saved ${results.length} screenshots to ${output}`);
