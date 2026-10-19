/**
 * Interest region published by the overlay renderer (plan F1): where the main process should
 * tell it about the cursor. Pure; no DOM. Every rect is built here: the hover rects in
 * `buildInterestRects`, the attention squares in `buildAttentionRects`, both in `buildInterest`.
 */
import { CURIOUS_RADIUS } from '../core/engine';
import type { InterestPayload, Point, Rect, Size } from '../shared/types';

/** Inflation around each drawn sprite and the toy, in DIP. */
export const INTEREST_MARGIN = 24;
/** Rects are rounded outward to this grid so tiny moves do not cause IPC. */
export const INTEREST_GRID = 4;
/** Hit radius of the yarn toy, in DIP. */
export const TOY_RADIUS = 18;
/**
 * Half-size of a kitten's attention square, as a multiple of its size: the cursor-curiosity radius
 * (1.6), so the cursor feed keeps reporting a cursor that rests near an attentive kitten.
 */
export const ATTENTION_HALF_SIZE = CURIOUS_RADIUS;

export function inflateRect(rect: Rect, margin: number): Rect {
  return { x: rect.x - margin, y: rect.y - margin, width: rect.width + margin * 2, height: rect.height + margin * 2 };
}

export function roundOutward(rect: Rect, grid = INTEREST_GRID): Rect {
  const left = Math.floor(rect.x / grid) * grid, top = Math.floor(rect.y / grid) * grid;
  const right = Math.ceil((rect.x + rect.width) / grid) * grid, bottom = Math.ceil((rect.y + rect.height) / grid) * grid;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * The attention square around an attentive kitten: centred on the kitten centre, half-size 1.6 × size,
 * clipped to the scene when given (nothing outside it can be noticed, and main rejects payloads with
 * rects larger than twice the scene).
 */
export function attentionRect(pet: { x: number; y: number; size: number }, scene?: Size): Rect {
  const half = ATTENTION_HALF_SIZE * pet.size;
  let left = pet.x - half, top = pet.y - half, right = pet.x + half, bottom = pet.y + half;
  if (scene) {
    left = Math.max(0, left); top = Math.max(0, top);
    right = Math.min(scene.width, right); bottom = Math.min(scene.height, bottom);
  }
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

const finiteRects = (rects: readonly Rect[]) => rects.filter(rect => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)).map(rect => roundOutward(rect));

/**
 * The hover rects: `sprites` are the bounds of everything `hit()` can return for each drawn kitten
 * (see spriteHitBounds), `toy` is the drawn toy centre, if any; each inflated by INTEREST_MARGIN.
 * Only these count as hover for main's guard. Non-finite rects are dropped.
 */
export function buildInterestRects(sprites: readonly Rect[], toy: Point | null): Rect[] {
  const rects = sprites.map(sprite => inflateRect(sprite, INTEREST_MARGIN));
  if (toy) rects.push(inflateRect({ x: toy.x - TOY_RADIUS, y: toy.y - TOY_RADIUS, width: TOY_RADIUS * 2, height: TOY_RADIUS * 2 }, INTEREST_MARGIN));
  return finiteRects(rects);
}

/**
 * The attention squares, used as they are (they already cover the cursor-curiosity radius): main
 * reports the cursor inside them, but they never count as hover. Non-finite rects are dropped.
 */
export function buildAttentionRects(attention: readonly Rect[]): Rect[] {
  return finiteRects(attention);
}

/** The whole interest region: hover `rects` (sprites and toy) and `attention` squares, kept apart. */
export function buildInterest(sprites: readonly Rect[], toy: Point | null, attention: readonly Rect[] = []): Pick<InterestPayload, 'rects' | 'attention'> {
  return { rects: buildInterestRects(sprites, toy), attention: buildAttentionRects(attention) };
}

/** Stable comparison key; never the empty string, so '' can mean "not yet published". */
export function rectsKey(rects: readonly Rect[]): string {
  return JSON.stringify(rects.map(rect => [rect.x, rect.y, rect.width, rect.height]));
}

/** Stable comparison key of a whole region (both lists); never the empty string. */
export function interestKey(region: Pick<InterestPayload, 'rects' | 'attention'>): string {
  return `${rectsKey(region.rects)}|${rectsKey(region.attention)}`;
}
