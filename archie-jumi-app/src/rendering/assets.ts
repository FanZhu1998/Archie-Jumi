import { ACTIONS, type AnimationPack, type AtlasFrame, type Facing, type Action, type PetId } from '../shared/types';
export interface LoadedPage { action: Action; image: ImageBitmap; offsetX: number; offsetY: number; masks: Map<string, Uint8Array> }
export interface LoadedPack { manifest: AnimationPack; cache: Map<Action, LoadedPage>; pending: Map<Action, Promise<void>>; base: string; failed: Set<Action> }
const MASK_SIZE = 64;
export function validatePack(pack: AnimationPack, id: PetId): void {
  if (!pack || pack.formatVersion !== 1 || pack.id !== id || !Number.isFinite(pack.frameWidth) || pack.frameWidth < 16 || pack.frameWidth > 1024 || !Number.isFinite(pack.frameHeight) || pack.frameHeight < 16 || pack.frameHeight > 1024) throw new Error(`Unsupported character pack: ${id}`);
  if (!/^[\w.-]+\.png$/.test(pack.atlas)) throw new Error('Character atlas must be a local PNG filename');
  for (const action of ACTIONS) {
    const page = pack.pages?.[action];
    if (page && (!/^actions\/[a-z_]+\.png$/.test(page.file) || ![page.offsetX, page.offsetY].every(v => Number.isFinite(v) && v >= 0))) throw new Error('Invalid local animation page');
    for (const facing of ['left', 'right'] as Facing[]) {
      const clip = pack.animations?.[action]?.[facing];
      if (!clip?.frames?.length || clip.frames.length > 120) throw new Error(`Missing animation: ${id}/${action}/${facing}`);
      for (const frame of clip.frames) if (![frame.x, frame.y, frame.w, frame.h, frame.duration].every(Number.isFinite) || frame.x < 0 || frame.y < 0 || frame.w <= 0 || frame.h <= 0 || frame.duration <= 0) throw new Error(`Invalid frame in ${id}/${action}`);
    }
  }
}
export const frameKey = (frame: AtlasFrame) => `${frame.x}:${frame.y}:${frame.w}:${frame.h}`;
export async function loadPack(id: PetId): Promise<LoadedPack> {
  const base = `./pets/${id}/`, response = await fetch(`${base}manifest.json`);
  if (!response.ok) throw new Error(`Could not load ${id}'s animation pack`);
  const manifest = await response.json() as AnimationPack; validatePack(manifest, id);
  const pack: LoadedPack = { manifest, cache: new Map(), pending: new Map(), failed: new Set(), base };
  await requestPage(pack, 'idle'); return pack;
}
export async function requestPage(pack: LoadedPack, action: Action): Promise<void> {
  const key = pack.manifest.pages?.[action] ? action : 'idle';
  if (pack.cache.has(key) || pack.failed.has(key)) return;
  if (pack.pending.has(key)) return pack.pending.get(key);
  if (pack.pending.size >= 2) return;
  const promise = (async () => {
    const spec = pack.manifest.pages?.[action], response = await fetch(pack.base + (spec?.file ?? pack.manifest.atlas));
    if (!response.ok) throw new Error('Could not load character animation');
    const image = await createImageBitmap(await response.blob());
    let retained = false;
    try {
    if (image.width * image.height > 30_000_000) throw new Error('Character atlas exceeds decoded image budget');
    const page: LoadedPage = { action: key, image, offsetX: spec?.offsetX ?? 0, offsetY: spec?.offsetY ?? 0, masks: new Map() };
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = MASK_SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    for (const a of spec ? [action] : ACTIONS) for (const facing of ['left', 'right'] as Facing[]) for (const frame of pack.manifest.animations[a][facing].frames) {
      const x = frame.x - page.offsetX, y = frame.y - page.offsetY;
      if (x < 0 || y < 0 || x + frame.w > image.width || y + frame.h > image.height) throw new Error('Atlas frame lies outside its image page');
      if (page.masks.has(frameKey(frame))) continue;
      ctx.clearRect(0, 0, MASK_SIZE, MASK_SIZE); ctx.drawImage(image, x, y, frame.w, frame.h, 0, 0, MASK_SIZE, MASK_SIZE);
      const rgba = ctx.getImageData(0, 0, MASK_SIZE, MASK_SIZE).data, mask = new Uint8Array(MASK_SIZE * MASK_SIZE);
      for (let i = 0; i < mask.length; i++) mask[i] = rgba[i * 4 + 3] > 100 ? 1 : 0;
      page.masks.set(frameKey(frame), mask);
    }
    pack.cache.set(key, page);
    retained = true;
    for (const [oldKey, old] of pack.cache) if (pack.cache.size > 2 && oldKey !== 'idle' && oldKey !== key) { old.image.close(); pack.cache.delete(oldKey); }
    } finally { if (!retained) image.close(); }
  })();
  pack.pending.set(key, promise);
  try { await promise; } catch (error) { pack.failed.add(key); throw error; } finally { pack.pending.delete(key); }
}
export function pageFor(pack: LoadedPack, action: Action): LoadedPage {
  if (!pack.manifest.pages?.[action]) return pack.cache.get('idle')!;
  return pack.cache.get(action) ?? pack.cache.get('idle')!;
}
export function animationFrame(pack: AnimationPack, action: Action, facing: Facing, seconds: number): AtlasFrame {
  const clip = pack.animations[action]?.[facing] ?? pack.animations.idle[facing];
  const duration = clip.frames.reduce((sum, f) => sum + f.duration, 0);
  let elapsed = clip.loop ? (seconds * 1000) % duration : Math.min(seconds * 1000, duration - 0.001);
  for (const frame of clip.frames) { if (elapsed < frame.duration) return frame; elapsed -= frame.duration; }
  return clip.frames[0];
}
export function alphaHit(page: { masks: Map<string, Uint8Array> }, frame: AtlasFrame, u: number, v: number) {
  if (u < 0 || v < 0 || u >= 1 || v >= 1) return false;
  return page.masks.get(frameKey(frame))?.[Math.floor(v * MASK_SIZE) * MASK_SIZE + Math.floor(u * MASK_SIZE)] === 1;
}
