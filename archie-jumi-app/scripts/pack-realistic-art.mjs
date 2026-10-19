/** Mechanical extraction/packing only: no drawing, retouching or remote calls.
 * Input: artwork/realistic/{archie,jumi}-{a,b,c,d}.png (four semantic poses each), plus the optional
 * {archie,jumi}-{e,f,g,h}.png sheets (in-between and true-left poses), used per kitten only when present.
 * Options: --source-dir=, --output-dir=, --work-dir= (defaults unchanged), --frame-size=, --check, --help.
 * Existing portrait PNGs and application icons are never modified. */
import { createRequire } from 'node:module';
import { access, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
const require = createRequire(import.meta.url);
let sharp;
try { sharp = require('sharp'); }
catch { sharp = require(resolve(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp')); }
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundledSourceRoot = resolve(root, 'artwork/realistic');
const options = readOptions(process.argv.slice(2));
const sourceRoot = options.sourceDir, outputRoot = options.outputDir, workRoot = options.workDir;
const frameSize = options.frameSize;
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

// Optional sheets: same 2×2 row-major layout, checks and crops.json overrides as A–D.
// Sheets E–G face right like A–D; sheet H is drawn facing LEFT.
const optionalSheets = {
  e: ['walk_c', 'walk_d', 'sleep_b', 'eat_b'],
  f: ['pounce_crouch', 'pounce_air', 'pounce_land', 'groom_b'],
  g: ['trot_c', 'trot_d', 'pet_b', 'wake_b'],
  h: ['idle_left', 'blink_left', 'sit_left', 'sleep_left'],
};
const leftFacingSheets = new Set(['h']);

// Clip changes when a sheet is present; loop flags stay as above. Walk and trot keep their
// authored cycle (320 ms, 210 ms): one cycle is still one stride of two steps (A, C, B, D) and the
// renderer speed-matches it. Pounce and wake keep the engine's 0.2 s crouch + 0.45 s leap and 1.1 s
// stretch. The two-pose loops follow the motion layer's rhythms (src/core/motion.ts): sleep breathes
// every 3.4 s, groom matches the 1.2 s head tilt, pet the 1 Hz nuzzle and eat the 2 Hz bob.
const optionalClips = {
  e: {
    walk: { poses: ['walk_a', 'walk_c', 'walk_b', 'walk_d'], durations: [80, 80, 80, 80] },
    sleep: { poses: ['sleep', 'sleep_b'], durations: [1700, 1700] },
    eat: { poses: ['eat', 'eat_b'], durations: [250, 250] },
  },
  f: {
    pounce: { poses: ['pounce', 'pounce_crouch', 'pounce_air', 'pounce_land'], durations: [100, 100, 300, 150] },
    groom: { poses: ['groom', 'groom_b'], durations: [600, 600] },
  },
  g: {
    trot: { poses: ['trot_a', 'trot_c', 'trot_b', 'trot_d'], durations: [52.5, 52.5, 52.5, 52.5] },
    pet: { poses: ['pet', 'pet_b'], durations: [500, 500] },
    wake: { poses: ['wake', 'wake_b'], durations: [550, 550] },
  },
};

// True-left variants replace a clip's mirrored left-facing frames only when every pose of
// the clip has one; a clip never mixes true-left and mirrored frames.
const trueLeft = { idle: 'idle_left', blink: 'blink_left', sit: 'sit_left', sleep: 'sleep_left' };

// Budgets: 4 frames per clip and direction keep every atlas row within 8 frames
// (4096 px at 512 px frames); 4096 × 6656 stays under the renderer's decoded-image budget.
const maxFramesPerDirection = 4, decodedPixelBudget = 30_000_000;
const round = v => Number(v.toFixed(3));

function readOptions(args) {
  const usage = [
    'Usage: npm run art -- [options]   or   node scripts/pack-realistic-art.mjs [options]',
    '  --source-dir=DIR   pose sheets and optional crops.json (default artwork/realistic)',
    '  --output-dir=DIR   pet packs, one folder per kitten (default public/pets)',
    '  --work-dir=DIR     review previews and packing report (default work)',
    '  --frame-size=N     frame size in pixels, 128 to 512 (default 512)',
    '  --check            validate every sheet and print the report; write nothing',
    '  --help             show this help',
  ].join('\n');
  let values;
  try {
    ({ values } = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        'source-dir': { type: 'string' },
        'output-dir': { type: 'string' },
        'work-dir': { type: 'string' },
        'frame-size': { type: 'string' },
        check: { type: 'boolean' },
        help: { type: 'boolean' },
      },
    }));
  } catch (error) {
    stop(`${error.message}\n${usage}`);
  }
  if (values.help) {
    console.log(usage);
    process.exit(0);
  }
  const folder = (name, fallback) => {
    const value = values[name];
    if (value === undefined) return resolve(root, fallback);
    if (!value.trim()) stop(`--${name} needs a folder path.`);
    return resolve(value);
  };
  const size = Number(values['frame-size'] ?? 512);
  if (!Number.isInteger(size) || size < 128 || size > 512) stop('--frame-size must be an integer between 128 and 512.');
  return {
    sourceDir: folder('source-dir', 'artwork/realistic'),
    outputDir: folder('output-dir', 'public/pets'),
    workDir: folder('work-dir', 'work'),
    frameSize: size,
    check: values.check === true,
  };
}

function stop(message) {
  console.error(`Art packing stopped: ${message}`);
  process.exit(1);
}

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

async function loadCropOverrides(folder = sourceRoot, label = 'crops.json') {
  let text;
  try {
    text = await readFile(resolve(folder, 'crops.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  let overrides;
  try {
    overrides = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON (${error.message}).`);
  }
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isObject(overrides)) throw new Error(`${label} must be an object keyed by sheet file name.`);
  // A misspelled sheet or pose name would silently fall back to the nominal grid cell.
  const allSheets = { ...sheets, ...optionalSheets };
  for (const [file, entries] of Object.entries(overrides)) {
    const sheetId = Object.keys(allSheets).find(id => Object.keys(names).some(pet => file === `${pet}-${id}.png`));
    if (!sheetId) throw new Error(`${label}: "${file}" is not a sheet file name (expected archie-a.png … jumi-h.png).`);
    if (!isObject(entries)) throw new Error(`${label}: "${file}" must map pose names to { left, top, width, height } rectangles.`);
    for (const pose of Object.keys(entries)) {
      if (!allSheets[sheetId].includes(pose)) throw new Error(`${label}: ${file} has no pose "${pose}"; its poses are ${allSheets[sheetId].join(', ')}.`);
    }
  }
  return overrides;
}

/**
 * Another source folder (a staging folder) keeps the bundled crops.json rectangles for its unchanged
 * copies of the bundled sheets, unless its own crops.json lists that sheet: the bundled B–D poses
 * cross their grid lines and need them. Returns the sheet files that borrowed rectangles.
 */
async function borrowBundledCrops() {
  if (sourceRoot === bundledSourceRoot) return [];
  const bundled = await loadCropOverrides(bundledSourceRoot, 'artwork/realistic/crops.json');
  const borrowed = [];
  for (const [file, rectangles] of Object.entries(bundled)) {
    if (cropOverrides[file]) continue;
    const read = folder => readFile(resolve(folder, file)).catch(() => null);
    const [copy, original] = await Promise.all([read(sourceRoot), read(bundledSourceRoot)]);
    if (copy && original && copy.equals(original)) { cropOverrides[file] = rectangles; borrowed.push(file); }
  }
  return borrowed;
}

/** Review notes about files that look like sheets but are not used as named. */
async function sourceNotices() {
  const known = Object.keys(names).flatMap(id => [...Object.keys(sheets), ...Object.keys(optionalSheets)].map(sheet => `${id}-${sheet}.png`));
  const notices = [];
  for (const file of await readdir(sourceRoot)) {
    if (!/^(archie|jumi)[^/\\]*\.png$/i.test(file) || known.includes(file)) continue;
    if (known.includes(file.toLowerCase())) notices.push(`${file}: rename to ${file.toLowerCase()}; sheet names are lowercase, and case-sensitive systems and tools miss other spellings.`);
    else notices.push(`${file}: not a sheet name, so it is ignored (sheets are archie-a.png … archie-h.png and jumi-a.png … jumi-h.png).`);
  }
  return notices;
}

async function inspectPose(buffer, cell, pose, id, referenceCellHeight, edgeFix) {
  const extracted = await sharp(buffer).extract(cell).ensureAlpha().png().toBuffer();
  const { data, info } = await sharp(extracted).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const visible = bounds(data, info.width, info.height, 8), opaque = bounds(data, info.width, info.height, 128);
  if (opaque.count < 200 || opaque.height < 30 || opaque.width < 20) throw new Error(`${id}/${pose}: empty or unusably small source sprite.`);
  if (visible.count > info.width * info.height * .98) throw new Error(`${id}/${pose}: no useful transparent background.`);
  if (opaque.edgeCount) throw new Error(`${id}/${pose}: ${opaque.edgeCount} opaque pixels touch a crop edge; ${edgeFix}.`);
  const warnings = visible.edgeCount ? [`${visible.edgeCount} fine/low-alpha pixels touch a crop edge; inspect fur/whiskers.`] : [];
  const left = Math.max(0, visible.minX - 2), top = Math.max(0, visible.minY - 2);
  const crop = { left, top, width: Math.min(info.width - 1, visible.maxX + 2) - left + 1, height: Math.min(info.height - 1, visible.maxY + 2) - top + 1 };
  const cropped = await sharp(extracted).extract(crop).png().toBuffer();
  return { pose, referenceCellHeight, sourceRect: cell, opaque, visible, crop, cropped, warnings };
}

/** Largest common scale this pose allows inside the frame (width, above and below the ground line). */
function scaleLimit(pose) {
  const aboveGround = (pose.opaque.maxY - pose.crop.top + 1) * pose.normalization;
  const belowGround = (pose.crop.height - (pose.opaque.maxY - pose.crop.top + 1)) * pose.normalization;
  const limits = [(frameSize - 2 * margin) / (pose.crop.width * pose.normalization), (ground - margin) / aboveGround];
  if (belowGround > 0) limits.push((frameSize - ground - margin) / belowGround);
  return Math.min(...limits);
}

async function inspectKitten(id, optional) {
  const poses = {};
  const kittenSheets = { ...sheets, ...Object.fromEntries(optional.map(sheetId => [sheetId, optionalSheets[sheetId]])) };
  for (const [sheetId, poseNames] of Object.entries(kittenSheets)) {
    const file = `${id}-${sheetId}.png`, source = resolve(sourceRoot, file);
    // Image decoders do not name the file, so say which sheet could not be read.
    const unreadable = error => { throw new Error(`${file}: the image could not be read (${error.message.split('\n')[0]}); export it again as an RGBA PNG.`); };
    const metadata = await sharp(source).metadata().catch(unreadable);
    if (!metadata.hasAlpha) throw new Error(`${file}: alpha channel is required.`);
    if (!metadata.width || !metadata.height || metadata.width % 2 || metadata.height % 2) throw new Error(`${file}: dimensions must divide into a 2×2 grid.`);
    const buffer = await sharp(source).ensureAlpha().png().toBuffer().catch(unreadable), cw = metadata.width / 2, ch = metadata.height / 2;
    for (const [slot, pose] of poseNames.entries()) {
      const override = cropOverrides[file]?.[pose];
      const cell = override ?? { left: (slot % 2) * cw, top: Math.floor(slot / 2) * ch, width: cw, height: ch };
      if (![cell.left, cell.top, cell.width, cell.height].every(Number.isInteger) || cell.left < 0 || cell.top < 0 || cell.width < 1 || cell.height < 1 || cell.left + cell.width > metadata.width || cell.top + cell.height > metadata.height) throw new Error(`${file}/${pose}: invalid mechanical crop rectangle ${JSON.stringify(cell)}; use whole-pixel left, top, width and height inside the ${metadata.width}×${metadata.height} sheet.`);
      const edgeFix = override
        ? `adjust its crops.json rectangle for ${file} or regenerate clipped anatomy`
        : `if the pose only crosses its grid cell in ${file}, add a crops.json rectangle in ${sourceRoot} that follows the transparent gap; otherwise regenerate clipped anatomy`;
      poses[pose] = await inspectPose(buffer, cell, pose, id, ch, edgeFix);
      poses[pose].source = file; poses[pose].slot = slot;
      poses[pose].facing = leftFacingSheets.has(sheetId) ? 'left' : 'right';
      poses[pose].optional = sheetId in optionalSheets;
    }
  }
  const referenceHeight = poses.idle.referenceCellHeight;
  for (const pose of Object.values(poses)) pose.normalization = referenceHeight / pose.referenceCellHeight;
  const wantedScale = 430 * unit / poses.idle.opaque.height;
  // Every present pose shares the scale; baseScale is what sheets A–D alone would allow.
  const scale = Math.min(wantedScale, ...Object.values(poses).map(scaleLimit));
  const baseScale = Math.min(wantedScale, ...Object.values(poses).filter(pose => !pose.optional).map(scaleLimit));
  const warnings = Object.values(poses).flatMap(pose => pose.warnings.map(w => `${pose.pose}: ${w}`));
  if (scale < wantedScale * .99) warnings.push(`A wide/tall pose limits the common scale; idle height about ${Math.round(poses.idle.opaque.height * scale)}px instead of ${Math.round(430 * unit)}px.`);
  if (scale < baseScale) {
    const limiting = Object.values(poses).filter(pose => pose.optional && scaleLimit(pose) < baseScale).map(pose => pose.pose);
    warnings.push(`Optional pose${limiting.length > 1 ? 's' : ''} ${limiting.join(', ')} lower${limiting.length > 1 ? '' : 's'} the common scale from ${round(baseScale)} (sheets A–D alone) to ${round(scale)}, shrinking every frame: idle about ${Math.round(poses.idle.opaque.height * scale)}px instead of ${Math.round(poses.idle.opaque.height * baseScale)}px. Regenerate ${limiting.length > 1 ? 'them' : 'it'} with the A–D camera distance to keep the current size.`);
  }
  if (poses.idle.opaque.height * scale < 384 * unit) warnings.push('Actual idle source resolution is below the 384px/200% target; maximum-size rendering may soften.');
  const clipPlan = planClips(id, poses);
  warnings.push(...clipPlan.warnings);
  return { id, poses, scale, baseScale, optional, plan: clipPlan.plan, trueLeftActions: clipPlan.trueLeftActions, warnings };
}

/** Per action: pose names for the right- and left-facing frames, durations and loop flag. */
function planClips(id, poses) {
  const plan = {}, trueLeftActions = [], warnings = [];
  for (const action of actions) {
    let clip = clips[action];
    for (const changes of Object.values(optionalClips)) {
      const change = changes[action];
      if (change && change.poses.every(pose => poses[pose])) clip = { ...clip, ...change };
    }
    const right = [...clip.poses];
    const variants = right.map(pose => (trueLeft[pose] && poses[trueLeft[pose]] ? trueLeft[pose] : null));
    let left = right;
    if (variants.every(Boolean)) {
      left = variants;
      trueLeftActions.push(action);
    } else if (variants.some(Boolean)) {
      const lacking = right.filter((_, index) => !variants[index]), unused = variants.filter(Boolean);
      warnings.push(`${action}: the whole left-facing clip stays mirrored because ${lacking.join(', ')} ${lacking.length > 1 ? 'have' : 'has'} no true-left pose; ${unused.join(', ')} ${unused.length > 1 ? 'are' : 'is'} not used (true-left and mirrored frames are never mixed in one clip).`);
    }
    if (right.length > maxFramesPerDirection) {
      throw new Error(`${id}/${action}: ${right.length} frames per direction exceed the budget of ${maxFramesPerDirection} (an atlas row holds ${2 * maxFramesPerDirection} frames, ${2 * maxFramesPerDirection * frameSize}px at ${frameSize}px frames).`);
    }
    if (clip.durations.length !== right.length || !clip.durations.every(ms => Number.isFinite(ms) && ms > 0)) {
      throw new Error(`${id}/${action}: every frame needs a positive duration in milliseconds.`);
    }
    plan[action] = { right, left, durations: [...clip.durations], loop: clip.loop };
  }
  const atlasWidth = Math.max(...Object.values(plan).map(c => c.right.length * 2)) * frameSize, atlasHeight = actions.length * frameSize;
  if (atlasWidth * atlasHeight > decodedPixelBudget) {
    throw new Error(`${id}: compatibility atlas ${atlasWidth}×${atlasHeight} (${(atlasWidth * atlasHeight).toLocaleString('en-US')} px) exceeds the renderer's ${decodedPixelBudget.toLocaleString('en-US')} px decoded-image budget.`);
  }
  return { plan, trueLeftActions, warnings };
}

/** One line per clip that differs from the A–D packs, for the console report. */
function clipNotes(kitten) {
  const notes = [];
  for (const action of actions) {
    const clip = kitten.plan[action], extended = clip.right.join() !== clips[action].poses.join();
    const leftArt = kitten.trueLeftActions.includes(action);
    if (extended) notes.push(`${action} ${clip.right.length} frames (${clip.right.join(', ')}; ${clip.durations.join('/')} ms)${leftArt ? ' with true-left frames' : ''}`);
    else if (leftArt) notes.push(`${action} left-facing frames use true-left art (${clip.left.join(', ')})`);
  }
  return notes;
}

async function placePose(pose, scale) {
  const factor = scale * pose.normalization;
  const resized = await sharp(pose.cropped).resize({ width: Math.max(1, Math.round(pose.crop.width * factor)), kernel: 'lanczos3' }).png().toBuffer();
  const size = await sharp(resized).metadata();
  const x = Math.round((frameSize - size.width) / 2), y = ground - Math.round((pose.opaque.maxY - pose.crop.top + 1) * size.height / pose.crop.height);
  if (x < 0 || y < 0 || x + size.width > frameSize || y + size.height > frameSize) throw new Error(`Packing would clip ${pose.pose}.`);
  // `placed` is the art as supplied (right-facing, or left-facing for sheet H); `flipped` mirrors it.
  const placed = await sharp({ create: { width: frameSize, height: frameSize, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: resized, left: x, top: y }]).png().toBuffer();
  const flipped = await sharp(placed).flop().png().toBuffer();
  const { data, info } = await sharp(placed).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const opaque = bounds(data, info.width, info.height, 128), soft = bounds(data, info.width, info.height, 8);
  if (!opaque.count || soft.minX < 2 || soft.minY < 2 || soft.maxX >= frameSize - 2 || soft.maxY >= frameSize - 2) throw new Error(`Empty/clipped output sprite: ${pose.pose}.`);
  const [right, left] = pose.facing === 'left' ? [flipped, placed] : [placed, flipped];
  return { right, left, facing: pose.facing, bounds: opaque, source: pose.source, slot: pose.slot, scale: round(factor), placedAt: { x, y }, sourceRect: pose.sourceRect, sourceCrop: pose.crop, sourceOpaqueBounds: pose.opaque };
}

const attribution = 'Reference-derived realistic kitten artwork generated for Archie & Jumi, mechanically alpha-trimmed, uniformly scaled and packed locally. Original photographs are not bundled. Left-facing frames are mirrored fallbacks, including asymmetric markings. Personality presets are fictional and editable.';

function attributionFor(trueLeftActions) {
  if (!trueLeftActions.length) return attribution;
  const list = trueLeftActions.length > 1 ? `${trueLeftActions.slice(0, -1).join(', ')} and ${trueLeftActions.at(-1)}` : trueLeftActions[0];
  return attribution.replace('Left-facing frames are mirrored fallbacks', `Left-facing ${list} frames use separately generated left-facing art; other left-facing frames are mirrored fallbacks`);
}

async function buildKitten(inspected) {
  const { id, poses, scale, plan } = inspected, sprites = {};
  for (const [pose, source] of Object.entries(poses)) sprites[pose] = await placePose(source, scale);
  const animations = {}, pages = {}, pageFiles = [], atlasRows = [];
  const maxColumns = Math.max(...Object.values(plan).map(c => c.right.length * 2));
  for (const [row, action] of actions.entries()) {
    const clip = plan[action], composites = []; animations[action] = {}; let column = 0;
    for (const facing of ['right', 'left']) {
      const frames = [];
      for (const [index, pose] of clip[facing].entries()) {
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
  const atlasWidth = maxColumns * frameSize, atlasHeight = actions.length * frameSize; // budget checked in planClips
  const atlas = await sharp({ create: { width: atlasWidth, height: atlasHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(atlasRows).png({ compressionLevel: 9 }).toBuffer();
  const idle = sprites.idle.bounds;
  const manifest = { formatVersion: 1, id, name: names[id], atlas: 'atlas.png', frameWidth: frameSize, frameHeight: frameSize, anchor: { x: frameSize / 2, y: ground }, hitShapes: [{ x: round((idle.minX + idle.maxX) / 2), y: round((idle.minY + idle.maxY) / 2), rx: round(idle.width / 2), ry: round(idle.height / 2) }], pages, animations,
    attribution: attributionFor(inspected.trueLeftActions) };
  const report = { id, frameSize, anchor: manifest.anchor, commonScale: round(scale), idleVisibleHeight: idle.height, atlas: { width: atlasWidth, height: atlasHeight, decodedMiB: round(atlasWidth * atlasHeight * 4 / 1024 / 1024) }, pages: pageFiles.map(({ file, width, height }) => ({ file, width, height, decodedMiB: round(width * height * 4 / 1024 / 1024) })), warnings: inspected.warnings,
    poses: Object.fromEntries(Object.entries(sprites).map(([pose, s]) => [pose, { source: s.source, slot: s.slot, scale: s.scale, placedAt: s.placedAt, outputOpaqueBounds: s.bounds, sourceRect: s.sourceRect, sourceCrop: s.sourceCrop, sourceOpaqueBounds: s.sourceOpaqueBounds, ...(s.facing === 'left' ? { artFacing: 'left' } : {}) }])) };
  // Extra report fields appear only with optional sheets, so A–D-only reports stay as before.
  if (inspected.optional.length) {
    Object.assign(report, {
      optionalSheets: inspected.optional.map(sheetId => `${id}-${sheetId}.png`),
      scaleFromSheetsAtoD: round(inspected.baseScale),
      clips: Object.fromEntries(actions.map(action => [action, { ...plan[action], leftArt: inspected.trueLeftActions.includes(action) ? 'true-left' : 'mirrored' }])),
    });
  }
  return { id, sprites, plan, trueLeftActions: inspected.trueLeftActions, manifest, atlas, pageFiles, report };
}

async function contactSheet(results, dark = false) {
  const cell = 144, rowHeight = 180, width = actions.length * cell, height = 70 + results.length * rowHeight;
  const leftNote = results.some(r => r.trueLeftActions.length) ? 'true-left art where supplied, otherwise mirrored left-facing fallback' : 'mirrored left-facing fallback';
  const labels = results.map((r, row) => actions.map((a, col) => `<text x="${col * cell + 72}" y="${row * rowHeight + 226}" text-anchor="middle" fill="${dark ? '#cbdcd6' : '#4f6360'}" font-size="11">${names[r.id]} · ${a.replaceAll('_', ' ')}</text>`).join('')).join('');
  const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${dark ? '#273b39' : '#f7f1e7'}"/><g font-family="Segoe UI, sans-serif"><text x="20" y="28" font-size="20" font-weight="600" fill="${dark ? '#f7f1e7' : '#3e5654'}">Archie &amp; Jumi · realistic supplied sprite poses</text><text x="20" y="49" font-size="12" fill="${dark ? '#afc5be' : '#657571'}">Mechanical packing · common scale per kitten · original alpha · ${leftNote}</text>${labels}</g></svg>`);
  const overlays = [];
  for (const [row, r] of results.entries()) for (const [col, a] of actions.entries()) overlays.push({ input: await sharp(r.sprites[r.plan[a].right[0]].right).resize(cell, cell).png().toBuffer(), left: col * cell, top: row * rowHeight + 70 });
  return sharp(bg).composite(overlays).png().toBuffer();
}

/** Every packed frame in clip order, right- then left-facing, on light and dark backgrounds. */
async function clipPreviews(results) {
  const cell = 112, labelWidth = 160, gap = 28, top = 84, rowHeight = cell + 30;
  const columns = Math.max(...results.flatMap(r => actions.map(a => r.plan[a].right.length)));
  const blockWidth = columns * cell, width = Math.max(820, labelWidth + 2 * blockWidth + gap + 16);
  const height = top + results.length * actions.length * rowHeight + 8, groundY = Math.round(ground / frameSize * cell);
  const overlays = [], rows = [];
  for (const r of results) for (const action of actions) {
    const clip = r.plan[action], y = top + rows.length * rowHeight, total = clip.durations.reduce((sum, ms) => sum + ms, 0);
    const cells = [];
    for (const [block, facing] of ['right', 'left'].entries()) {
      for (const [index, pose] of clip[facing].entries()) {
        const x = labelWidth + block * (blockWidth + gap) + index * cell;
        const art = facing === 'left' ? (r.trueLeftActions.includes(action) ? 'true left' : 'mirror') : 'right';
        cells.push({ x, pose, ms: clip.durations[index], art });
        overlays.push({ input: await sharp(r.sprites[pose][facing]).resize(cell, cell).png().toBuffer(), left: x, top: y });
      }
    }
    rows.push({ y, title: `${names[r.id]} · ${action.replaceAll('_', ' ')}`, detail: `${clip.right.length} frame${clip.right.length > 1 ? 's' : ''} · ${total} ms ${clip.loop ? 'loop' : 'once'}`, cells });
  }
  const svg = dark => {
    const ink = dark ? '#f7f1e7' : '#3e5654', soft = dark ? '#afc5be' : '#657571', tile = dark ? '#2f4744' : '#efe6d8', line = dark ? '#5d7a75' : '#cdbfa9';
    const body = rows.map(row => [
      `<text x="16" y="${row.y + 48}" font-size="13" font-weight="600" fill="${ink}">${row.title}</text>`,
      `<text x="16" y="${row.y + 66}" font-size="11" fill="${soft}">${row.detail}</text>`,
      ...row.cells.map(c => [
        `<rect x="${c.x + 2}" y="${row.y + 2}" width="${cell - 4}" height="${cell - 4}" rx="6" fill="${tile}"/>`,
        `<line x1="${c.x + 4}" x2="${c.x + cell - 4}" y1="${row.y + groundY}" y2="${row.y + groundY}" stroke="${line}"/>`,
        `<text x="${c.x + cell / 2}" y="${row.y + cell + 12}" text-anchor="middle" font-size="10" fill="${ink}">${c.pose}</text>`,
        `<text x="${c.x + cell / 2}" y="${row.y + cell + 24}" text-anchor="middle" font-size="10" fill="${soft}">${c.ms} ms${c.art === 'right' ? '' : ` · ${c.art}`}</text>`,
      ].join('')),
    ].join('')).join('');
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${dark ? '#273b39' : '#f7f1e7'}"/><g font-family="Segoe UI, sans-serif"><text x="16" y="28" font-size="20" font-weight="600" fill="${ink}">Archie &amp; Jumi · every packed frame in clip order</text><text x="16" y="48" font-size="12" fill="${soft}">Right-facing frames, then left-facing frames · “mirror” = flipped right-facing art, “true left” = sheet H · line = ground anchor</text><text x="${labelWidth}" y="74" font-size="12" font-weight="600" fill="${soft}">right-facing</text><text x="${labelWidth + blockWidth + gap}" y="74" font-size="12" font-weight="600" fill="${soft}">left-facing</text>${body}</g></svg>`);
  };
  return {
    light: await sharp(svg(false)).composite(overlays).png().toBuffer(),
    dark: await sharp(svg(true)).composite(overlays).png().toBuffer(),
  };
}

async function pairPreview(results) {
  const panels = [{ x: 0, bg: '#f7f1e7', fg: '#405a59' }, { x: 480, bg: '#273b39', fg: '#f7f1e7' }];
  const backing = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="330">${panels.map(p => `<rect x="${p.x}" width="480" height="330" fill="${p.bg}"/><g font-family="Segoe UI, sans-serif" fill="${p.fg}"><text x="${p.x + 20}" y="28" font-size="17" font-weight="600">Realistic nose-touch poses · spacing check</text><text x="${p.x + 20}" y="49" font-size="11">Existing engine spacing; generated muzzle alignment needs visual review</text></g>`).join('')}</svg>`);
  const a = await sharp(results.find(r => r.id === 'archie').sprites.nose_touch.right).resize(256, 256).png().toBuffer();
  const j = await sharp(results.find(r => r.id === 'jumi').sprites.nose_touch.left).resize(256, 256).png().toBuffer();
  return sharp(backing).composite(panels.flatMap(p => [{ input: a, left: p.x + 18, top: 65 }, { input: j, left: p.x + 205, top: 65 }])).png().toBuffer();
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// Pack files are replaced together. Every new file is first staged beside its target, then swapped in.
const stagedSuffix = '.pack-new', backupSuffix = '.pack-old';
// What a failure leaves in the output folder: null (nothing written), 'kept', 'unsettled' or 'replaced'.
let packState = null;

/** One kitten's pack files in swap order: the atlas and action pages, then manifest.json last. */
function packFiles(r) {
  const directory = resolve(outputRoot, r.id);
  return [
    { path: resolve(directory, 'atlas.png'), data: r.atlas },
    ...r.pageFiles.map(page => ({ path: resolve(directory, page.file), data: page.buffer })),
    { path: resolve(directory, 'manifest.json'), data: `${JSON.stringify(r.manifest, null, 2)}\n` },
  ];
}

/** Renames, retrying for under a second while a scanner, indexer or Explorer thumbnail briefly holds the file. */
async function move(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(from, to);
    } catch (error) {
      if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      await new Promise(done => setTimeout(done, 50 * 2 ** attempt));
    }
  }
}

/** A run stopped mid-swap leaves a kitten without manifest.json but with backups: put its previous pack back. */
async function restoreInterruptedSwap(name, files) {
  const manifest = files.at(-1).path;
  if (await exists(manifest)) {
    // The swap finished; only the backup cleanup was cut short.
    for (const { path } of files) await rm(path + backupSuffix, { force: true }).catch(() => {});
    return;
  }
  if (!await exists(manifest + backupSuffix)) return;
  packState = 'unsettled';
  for (const { path } of files) if (await exists(path + backupSuffix)) await move(path + backupSuffix, path);
  packState = null;
  console.warn(`${name}: restored the previous pack that an interrupted run had partly replaced.`);
}

/** Opening for writing (without truncating) stops on read-only or locked files before any pack file changes. */
async function assertReplaceable(path) {
  const handle = await open(path, 'r+').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  await handle?.close();
}

/**
 * Replaces both kittens' packs all or nothing: stage every new file, check every target, then swap.
 * Each manifest.json moves aside first and its replacement moves in last, so even an interrupted swap
 * never pairs a manifest with pages of another layout. A failure undoes the swap step by step.
 */
async function replacePacks(results) {
  const kittens = results.map(r => ({ id: r.id, files: packFiles(r) }));
  const all = kittens.flatMap(kitten => kitten.files), undo = [];
  for (const { id, files } of kittens) await restoreInterruptedSwap(names[id], files);
  try {
    packState = 'kept';
    for (const { id, files } of kittens) {
      await mkdir(resolve(outputRoot, id, 'actions'), { recursive: true });
      for (const { path, data } of files) await writeFile(path + stagedSuffix, data);
    }
    for (const { path } of all) await assertReplaceable(path);
    for (const { files } of kittens) {
      const manifest = files.at(-1).path;
      if (await exists(manifest)) { await move(manifest, manifest + backupSuffix); undo.push(() => move(manifest + backupSuffix, manifest)); }
      for (const { path } of files) {
        if (path !== manifest && await exists(path)) { await move(path, path + backupSuffix); undo.push(() => move(path + backupSuffix, path)); }
        await move(path + stagedSuffix, path); undo.push(() => rm(path));
      }
    }
  } catch (error) {
    // Every step's undo returns to the state before it, and each of those states is safe to stop in.
    for (const step of undo.reverse()) {
      try { await step(); } catch (undoError) { packState = 'unsettled'; error.message += ` Undoing the swap also failed: ${undoError.message}`; break; }
    }
    for (const { path } of all) await rm(path + stagedSuffix, { force: true }).catch(() => {});
    throw error;
  }
  packState = 'replaced';
  for (const { path } of all) {
    await rm(path + backupSuffix, { force: true }).catch(error => console.warn(`Could not delete ${path + backupSuffix} (${error.code ?? error.message}); delete it by hand.`));
  }
}

async function main() {
  // Check every source first: a missing/clipped sheet never partly replaces packs.
  const missing = [];
  for (const id of Object.keys(names)) for (const sheet of Object.keys(sheets)) { const p = resolve(sourceRoot, `${id}-${sheet}.png`); try { await access(p); } catch { missing.push(p); } }
  if (missing.length) throw new Error(`Realistic source sheets are not ready:\n${missing.join('\n')}`);
  cropOverrides = await loadCropOverrides();
  const borrowed = await borrowBundledCrops();
  if (borrowed.length) console.log(`Using the artwork/realistic/crops.json rectangles for ${borrowed.join(', ')}: they are unchanged copies of the bundled sheets, and ${resolve(sourceRoot, 'crops.json')} has no rectangles for them.`);
  const notices = await sourceNotices();
  for (const notice of notices) console.warn(notice);
  const inspected = [];
  for (const id of Object.keys(names)) {
    const optional = [];
    for (const sheet of Object.keys(optionalSheets)) if (await exists(resolve(sourceRoot, `${id}-${sheet}.png`))) optional.push(sheet);
    inspected.push(await inspectKitten(id, optional));
  }
  const results = [];
  for (const kitten of inspected) {
    results.push(await buildKitten(kitten));
    console.log(`${names[kitten.id]}: ${Object.keys(kitten.poses).length} supplied poses ${options.check ? 'checked' : 'packed'} with common scale ${round(kitten.scale)}.`);
    if (kitten.optional.length) console.log(`${names[kitten.id]}: optional sheets ${kitten.optional.map(s => s.toUpperCase()).join(', ')}: ${clipNotes(kitten).join('; ') || 'no clip changes'}.`);
    else if (options.check) console.log(`${names[kitten.id]}: no optional sheets (E–H); clips as packed from A–D.`);
  }
  const report = `${JSON.stringify({ generatedAt: new Date().toISOString(), frameSize, ...(notices.length ? { warnings: notices } : {}), results: results.map(r => r.report) }, null, 2)}\n`;
  // Previews are built before any file is written, so a failure up to here leaves every file untouched.
  const previews = options.check ? null : {
    light: await contactSheet(results),
    dark: await contactSheet(results, true),
    pair: await pairPreview(results),
    clips: await clipPreviews(results),
  };
  for (const r of results) {
    console.log(`${names[r.id]}: idle ${r.report.idleVisibleHeight}px; compatibility atlas ${r.report.atlas.width}×${r.report.atlas.height}; action pages ${Math.min(...r.report.pages.map(p => p.decodedMiB))}–${Math.max(...r.report.pages.map(p => p.decodedMiB))} MiB.`);
    for (const warning of r.report.warnings) console.warn(`${names[r.id]}: ${warning}`);
  }
  if (options.check) {
    console.log(`Check passed: every sheet is usable and every clip fits the budgets. Nothing was written (packing would write ${outputRoot} and ${workRoot}).`);
    return;
  }
  await mkdir(workRoot, { recursive: true });
  await replacePacks(results);
  await writeFile(resolve(workRoot, 'realistic-animation-preview.png'), previews.light);
  await writeFile(resolve(workRoot, 'realistic-animation-preview-dark.png'), previews.dark);
  await writeFile(resolve(workRoot, 'realistic-pair-preview.png'), previews.pair);
  await writeFile(resolve(workRoot, 'realistic-clip-preview.png'), previews.clips.light);
  await writeFile(resolve(workRoot, 'realistic-clip-preview-dark.png'), previews.clips.dark);
  await writeFile(resolve(workRoot, 'realistic-packing-report.json'), report);
  console.log('Realistic sprite packs ready. Portraits/icons untouched. No application build or packaging performed.');
  console.log(`Packs: ${outputRoot} · review files: ${workRoot}`);
}

try {
  await main();
} catch (error) {
  console.error(`Art packing stopped: ${error?.message ?? error}`);
  // Validation, file and image errors are plain Errors; anything else is a script bug worth a stack.
  if (error?.constructor !== Error && error?.stack) console.error(error.stack);
  const outcome = {
    kept: `No pack file was replaced; the packs in ${outputRoot} are as they were.`,
    unsettled: `A kitten's pack in ${outputRoot} may be left without manifest.json: fix the problem and pack again, which first restores the previous pack from its ${backupSuffix} backups.`,
    replaced: `The new packs are in place, but the review files in ${workRoot} are incomplete; fix the problem and pack again.`,
  };
  console.error(options.check ? 'Check failed; nothing was written.' : outcome[packState] ?? 'Nothing was written.');
  process.exitCode = 1;
}
