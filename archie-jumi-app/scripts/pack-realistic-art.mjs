/** Mechanical extraction/packing only: no drawing, retouching or remote calls.
 * Input: artwork/realistic/{archie,jumi}-{a,b,c,d}.png (four semantic poses each).
 * Existing portrait PNGs and application icons are never modified. */
import { createRequire } from 'node:module';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
let sharp;
try { sharp = require('sharp'); }
catch { sharp = require(resolve(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp')); }
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(root, 'artwork/realistic'), outputRoot = resolve(root, 'public/pets'), workRoot = resolve(root, 'work');
const frameSize = Number(process.argv.find(v => v.startsWith('--frame-size='))?.split('=')[1] ?? 512);
if (!Number.isInteger(frameSize) || frameSize < 128 || frameSize > 512) throw new Error('--frame-size must be an integer between 128 and 512.');
const unit = frameSize / 512, ground = Math.round(464 * unit), margin = Math.max(4, Math.round(12 * unit));
const names = { archie: 'Archie', jumi: 'Jumi' };
const actions = ['idle', 'walk', 'trot', 'sit', 'groom', 'sleep', 'wake', 'pet', 'carried', 'land', 'pounce', 'eat', 'nose_touch'];
const sheets = { a: ['idle', 'blink', 'walk_a', 'walk_b'], b: ['groom', 'sleep', 'wake', 'pet'], c: ['carried', 'land', 'pounce', 'eat'], d: ['nose_touch', 'trot_a', 'trot_b', 'sit'] };
const clips = {
  idle: { poses: ['idle', 'blink'], durations: [2800, 140], loop: true },
  walk: { poses: ['walk_a', 'walk_b'], durations: [160, 160], loop: true },
  trot: { poses: ['trot_a', 'trot_b'], durations: [105, 105], loop: true },
  sit: { poses: ['sit'], durations: [1600], loop: true },
  groom: { poses: ['groom'], durations: [1300], loop: true },
  sleep: { poses: ['sleep'], durations: [2000], loop: true },
  wake: { poses: ['wake'], durations: [1100], loop: false },
  pet: { poses: ['pet'], durations: [1700], loop: true },
  carried: { poses: ['carried'], durations: [1000], loop: true },
  land: { poses: ['land'], durations: [500], loop: false },
  pounce: { poses: ['pounce'], durations: [650], loop: false },
  eat: { poses: ['eat'], durations: [1500], loop: true },
  nose_touch: { poses: ['nose_touch'], durations: [1100], loop: false },
};
const round = v => Number(v.toFixed(3));

function bounds(data, width, height, threshold) {
  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0, edgeCount = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] < threshold) continue;
    count++; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    if (x < 2 || y < 2 || x >= width - 2 || y >= height - 2) edgeCount++;
  }
  return { minX, minY, maxX, maxY, width: Math.max(0, maxX - minX + 1), height: Math.max(0, maxY - minY + 1), count, edgeCount };
}

// Optional manual crop rectangles follow existing transparent gaps when a pose
// extends across a nominal grid line. They do not resize, erase or repaint art.
let cropOverrides = {};
try { cropOverrides = JSON.parse(await readFile(resolve(sourceRoot, 'crops.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

async function inspectPose(buffer, cell, pose, id, referenceCellHeight) {
  const extracted = await sharp(buffer).extract(cell).ensureAlpha().png().toBuffer();
  const { data, info } = await sharp(extracted).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const visible = bounds(data, info.width, info.height, 8), opaque = bounds(data, info.width, info.height, 128);
  if (opaque.count < 200 || opaque.height < 30 || opaque.width < 20) throw new Error(`${id}/${pose}: empty or unusably small source sprite.`);
  if (visible.count > info.width * info.height * .98) throw new Error(`${id}/${pose}: no useful transparent background.`);
  if (opaque.edgeCount) throw new Error(`${id}/${pose}: ${opaque.edgeCount} opaque pixels touch a crop edge; adjust source crop or regenerate clipped anatomy.`);
  const warnings = visible.edgeCount ? [`${visible.edgeCount} fine/low-alpha pixels touch a crop edge; inspect fur/whiskers.`] : [];
  const left = Math.max(0, visible.minX - 2), top = Math.max(0, visible.minY - 2);
  const crop = { left, top, width: Math.min(info.width - 1, visible.maxX + 2) - left + 1, height: Math.min(info.height - 1, visible.maxY + 2) - top + 1 };
  const cropped = await sharp(extracted).extract(crop).png().toBuffer();
  return { pose, referenceCellHeight, sourceRect: cell, opaque, visible, crop, cropped, warnings };
}

async function inspectKitten(id) {
  const poses = {};
  for (const [sheetId, poseNames] of Object.entries(sheets)) {
    const file = `${id}-${sheetId}.png`, source = resolve(sourceRoot, file), metadata = await sharp(source).metadata();
    if (!metadata.hasAlpha) throw new Error(`${file}: alpha channel is required.`);
    if (!metadata.width || !metadata.height || metadata.width % 2 || metadata.height % 2) throw new Error(`${file}: dimensions must divide into a 2×2 grid.`);
    const buffer = await sharp(source).ensureAlpha().png().toBuffer(), cw = metadata.width / 2, ch = metadata.height / 2;
    for (const [slot, pose] of poseNames.entries()) {
      const cell = cropOverrides[file]?.[pose] ?? { left: (slot % 2) * cw, top: Math.floor(slot / 2) * ch, width: cw, height: ch };
      if (![cell.left, cell.top, cell.width, cell.height].every(Number.isInteger) || cell.left < 0 || cell.top < 0 || cell.width < 1 || cell.height < 1 || cell.left + cell.width > metadata.width || cell.top + cell.height > metadata.height) throw new Error(`${file}/${pose}: invalid mechanical crop rectangle.`);
      poses[pose] = await inspectPose(buffer, cell, pose, id, ch);
      poses[pose].source = file; poses[pose].slot = slot;
    }
  }
  const referenceHeight = poses.idle.referenceCellHeight;
  for (const pose of Object.values(poses)) pose.normalization = referenceHeight / pose.referenceCellHeight;
  const wantedScale = 430 * unit / poses.idle.opaque.height;
  let scale = wantedScale;
  for (const pose of Object.values(poses)) {
    const aboveGround = (pose.opaque.maxY - pose.crop.top + 1) * pose.normalization;
    const belowGround = (pose.crop.height - (pose.opaque.maxY - pose.crop.top + 1)) * pose.normalization;
    scale = Math.min(scale, (frameSize - 2 * margin) / (pose.crop.width * pose.normalization), (ground - margin) / aboveGround);
    if (belowGround > 0) scale = Math.min(scale, (frameSize - ground - margin) / belowGround);
  }
  const warnings = Object.values(poses).flatMap(pose => pose.warnings.map(w => `${pose.pose}: ${w}`));
  if (scale < wantedScale * .99) warnings.push(`A wide/tall pose limits the common scale; idle height about ${Math.round(poses.idle.opaque.height * scale)}px instead of ${Math.round(430 * unit)}px.`);
  if (poses.idle.opaque.height * scale < 384 * unit) warnings.push('Actual idle source resolution is below the 384px/200% target; maximum-size rendering may soften.');
  return { id, poses, scale, warnings };
}

async function placePose(pose, scale) {
  const factor = scale * pose.normalization;
  const resized = await sharp(pose.cropped).resize({ width: Math.max(1, Math.round(pose.crop.width * factor)), kernel: 'lanczos3' }).png().toBuffer();
  const size = await sharp(resized).metadata();
  const x = Math.round((frameSize - size.width) / 2), y = ground - Math.round((pose.opaque.maxY - pose.crop.top + 1) * size.height / pose.crop.height);
  if (x < 0 || y < 0 || x + size.width > frameSize || y + size.height > frameSize) throw new Error(`Packing would clip ${pose.pose}.`);
  const right = await sharp({ create: { width: frameSize, height: frameSize, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: resized, left: x, top: y }]).png().toBuffer();
  const left = await sharp(right).flop().png().toBuffer();
  const { data, info } = await sharp(right).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const opaque = bounds(data, info.width, info.height, 128), soft = bounds(data, info.width, info.height, 8);
  if (!opaque.count || soft.minX < 2 || soft.minY < 2 || soft.maxX >= frameSize - 2 || soft.maxY >= frameSize - 2) throw new Error(`Empty/clipped output sprite: ${pose.pose}.`);
  return { right, left, bounds: opaque, source: pose.source, slot: pose.slot, scale: round(factor), placedAt: { x, y }, sourceRect: pose.sourceRect, sourceCrop: pose.crop, sourceOpaqueBounds: pose.opaque };
}

async function buildKitten(inspected) {
  const { id, poses, scale } = inspected, sprites = {};
  for (const [pose, source] of Object.entries(poses)) sprites[pose] = await placePose(source, scale);
  const animations = {}, pages = {}, pageFiles = [], atlasRows = [];
  const maxColumns = Math.max(...Object.values(clips).map(c => c.poses.length * 2));
  for (const [row, action] of actions.entries()) {
    const clip = clips[action], composites = []; animations[action] = {}; let column = 0;
    for (const facing of ['right', 'left']) {
      const frames = [];
      for (const [index, pose] of clip.poses.entries()) {
        composites.push({ input: sprites[pose][facing], left: column * frameSize, top: 0 });
        frames.push({ x: column * frameSize, y: row * frameSize, w: frameSize, h: frameSize, duration: clip.durations[index] }); column++;
      }
      animations[action][facing] = { frames, loop: clip.loop };
    }
    const width = column * frameSize;
    const buffer = await sharp({ create: { width, height: frameSize, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(composites).png({ compressionLevel: 9 }).toBuffer();
    const spec = { file: `actions/${action}.png`, offsetX: 0, offsetY: row * frameSize }; pages[action] = spec;
    for (const facing of ['right', 'left']) for (const f of animations[action][facing].frames) if (f.x - spec.offsetX < 0 || f.y - spec.offsetY < 0 || f.x - spec.offsetX + f.w > width || f.y - spec.offsetY + f.h > frameSize) throw new Error(`Page frame out of bounds: ${id}/${action}.`);
    pageFiles.push({ file: spec.file, buffer, width, height: frameSize }); atlasRows.push({ input: buffer, left: 0, top: row * frameSize });
  }
  const atlasWidth = maxColumns * frameSize, atlasHeight = actions.length * frameSize;
  if (atlasWidth * atlasHeight > 30_000_000) throw new Error('Compatibility atlas exceeds renderer image budget.');
  const atlas = await sharp({ create: { width: atlasWidth, height: atlasHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(atlasRows).png({ compressionLevel: 9 }).toBuffer();
  const idle = sprites.idle.bounds;
  const manifest = { formatVersion: 1, id, name: names[id], atlas: 'atlas.png', frameWidth: frameSize, frameHeight: frameSize, anchor: { x: frameSize / 2, y: ground }, hitShapes: [{ x: round((idle.minX + idle.maxX) / 2), y: round((idle.minY + idle.maxY) / 2), rx: round(idle.width / 2), ry: round(idle.height / 2) }], pages, animations,
    attribution: 'Reference-derived realistic kitten artwork generated for Archie & Jumi, mechanically alpha-trimmed, uniformly scaled and packed locally. Original photographs are not bundled. Left-facing frames are mirrored fallbacks, including asymmetric markings. Personality presets are fictional and editable.' };
  const report = { id, frameSize, anchor: manifest.anchor, commonScale: round(scale), idleVisibleHeight: idle.height, atlas: { width: atlasWidth, height: atlasHeight, decodedMiB: round(atlasWidth * atlasHeight * 4 / 1024 / 1024) }, pages: pageFiles.map(({ file, width, height }) => ({ file, width, height, decodedMiB: round(width * height * 4 / 1024 / 1024) })), warnings: inspected.warnings,
    poses: Object.fromEntries(Object.entries(sprites).map(([pose, s]) => [pose, { source: s.source, slot: s.slot, scale: s.scale, placedAt: s.placedAt, outputOpaqueBounds: s.bounds, sourceRect: s.sourceRect, sourceCrop: s.sourceCrop, sourceOpaqueBounds: s.sourceOpaqueBounds }])) };
  return { id, sprites, manifest, atlas, pageFiles, report };
}

async function contactSheet(results, dark = false) {
  const cell = 144, rowHeight = 180, width = actions.length * cell, height = 70 + results.length * rowHeight;
  const labels = results.map((r, row) => actions.map((a, col) => `<text x="${col * cell + 72}" y="${row * rowHeight + 226}" text-anchor="middle" fill="${dark ? '#cbdcd6' : '#4f6360'}" font-size="11">${names[r.id]} · ${a.replaceAll('_', ' ')}</text>`).join('')).join('');
  const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${dark ? '#273b39' : '#f7f1e7'}"/><g font-family="Segoe UI, sans-serif"><text x="20" y="28" font-size="20" font-weight="600" fill="${dark ? '#f7f1e7' : '#3e5654'}">Archie &amp; Jumi · realistic supplied sprite poses</text><text x="20" y="49" font-size="12" fill="${dark ? '#afc5be' : '#657571'}">Mechanical packing · common scale per kitten · original alpha · mirrored left-facing fallback</text>${labels}</g></svg>`);
  const overlays = [];
  for (const [row, r] of results.entries()) for (const [col, a] of actions.entries()) overlays.push({ input: await sharp(r.sprites[clips[a].poses[0]].right).resize(cell, cell).png().toBuffer(), left: col * cell, top: row * rowHeight + 70 });
  return sharp(bg).composite(overlays).png().toBuffer();
}

async function pairPreview(results) {
  const panels = [{ x: 0, bg: '#f7f1e7', fg: '#405a59' }, { x: 480, bg: '#273b39', fg: '#f7f1e7' }];
  const backing = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="330">${panels.map(p => `<rect x="${p.x}" width="480" height="330" fill="${p.bg}"/><g font-family="Segoe UI, sans-serif" fill="${p.fg}"><text x="${p.x + 20}" y="28" font-size="17" font-weight="600">Realistic nose-touch poses · spacing check</text><text x="${p.x + 20}" y="49" font-size="11">Existing engine spacing; generated muzzle alignment needs visual review</text></g>`).join('')}</svg>`);
  const a = await sharp(results.find(r => r.id === 'archie').sprites.nose_touch.right).resize(256, 256).png().toBuffer();
  const j = await sharp(results.find(r => r.id === 'jumi').sprites.nose_touch.left).resize(256, 256).png().toBuffer();
  return sharp(backing).composite(panels.flatMap(p => [{ input: a, left: p.x + 18, top: 65 }, { input: j, left: p.x + 205, top: 65 }])).png().toBuffer();
}

// Check every source first: a missing/clipped sheet never partly replaces packs.
const missing = [];
for (const id of Object.keys(names)) for (const sheet of Object.keys(sheets)) { const p = resolve(sourceRoot, `${id}-${sheet}.png`); try { await access(p); } catch { missing.push(p); } }
if (missing.length) throw new Error(`Realistic source sheets are not ready:\n${missing.join('\n')}`);
const inspected = [];
for (const id of Object.keys(names)) inspected.push(await inspectKitten(id));
const results = [];
for (const kitten of inspected) { results.push(await buildKitten(kitten)); console.log(`${names[kitten.id]}: 16 supplied poses packed with common scale ${round(kitten.scale)}.`); }
await mkdir(workRoot, { recursive: true });
for (const r of results) {
  const directory = resolve(outputRoot, r.id); await mkdir(resolve(directory, 'actions'), { recursive: true });
  await writeFile(resolve(directory, 'atlas.png'), r.atlas);
  for (const page of r.pageFiles) await writeFile(resolve(directory, page.file), page.buffer);
  await writeFile(resolve(directory, 'manifest.json'), `${JSON.stringify(r.manifest, null, 2)}\n`);
  console.log(`${names[r.id]}: idle ${r.report.idleVisibleHeight}px; compatibility atlas ${r.report.atlas.width}×${r.report.atlas.height}; action pages ${Math.min(...r.report.pages.map(p => p.decodedMiB))}–${Math.max(...r.report.pages.map(p => p.decodedMiB))} MiB.`);
  for (const warning of r.report.warnings) console.warn(`${names[r.id]}: ${warning}`);
}
await writeFile(resolve(workRoot, 'realistic-animation-preview.png'), await contactSheet(results));
await writeFile(resolve(workRoot, 'realistic-animation-preview-dark.png'), await contactSheet(results, true));
await writeFile(resolve(workRoot, 'realistic-pair-preview.png'), await pairPreview(results));
await writeFile(resolve(workRoot, 'realistic-packing-report.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), frameSize, results: results.map(r => r.report) }, null, 2)}\n`);
console.log('Realistic sprite packs ready. Portraits/icons untouched. No application build or packaging performed.');
