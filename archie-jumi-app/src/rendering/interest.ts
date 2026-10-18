/**
 * Interest region published by the overlay renderer (plan F1): where the main process should
 * tell it about the cursor. Pure; no DOM. Phase 2 adds attention rects here, so every rect is
 * built in `buildInterestRects`.
 */
import type { Point, Rect } from '../shared/types';

/** Inflation around each drawn sprite and the toy, in DIP. */
export const INTEREST_MARGIN = 24;
/** Rects are rounded outward to this grid so tiny moves do not cause IPC. */
export const INTEREST_GRID = 4;
/** Hit radius of the yarn toy, in DIP. */
export const TOY_RADIUS = 18;

export function inflateRect(rect: Rect, margin: number): Rect {
  return { x: rect.x - margin, y: rect.y - margin, width: rect.width + margin * 2, height: rect.height + margin * 2 };
}

export function roundOutward(rect: Rect, grid = INTEREST_GRID): Rect {
  const left = Math.floor(rect.x / grid) * grid, top = Math.floor(rect.y / grid) * grid;
  const right = Math.ceil((rect.x + rect.width) / grid) * grid, bottom = Math.ceil((rect.y + rect.height) / grid) * grid;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** `sprites` are the drawn sprite rectangles of presented kittens; `toy` is the toy centre, if any. */
export function buildInterestRects(sprites: readonly Rect[], toy: Point | null): Rect[] {
  const rects = sprites.map(sprite => inflateRect(sprite, INTEREST_MARGIN));
  if (toy) rects.push(inflateRect({ x: toy.x - TOY_RADIUS, y: toy.y - TOY_RADIUS, width: TOY_RADIUS * 2, height: TOY_RADIUS * 2 }, INTEREST_MARGIN));
  return rects
    .filter(rect => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite))
    .map(rect => roundOutward(rect));
}

/** Stable comparison key; never the empty string, so '' can mean "not yet published". */
export function rectsKey(rects: readonly Rect[]): string {
  return JSON.stringify(rects.map(rect => [rect.x, rect.y, rect.width, rect.height]));
}
