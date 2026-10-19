/**
 * Device-pixel boxes for the overlay's canvas layers. A layer sits on whole device pixels (its canvas
 * is drawn 1:1, never resampled by the compositor), and its backing store only grows: it keeps its
 * size while the content fits and grows each side to fit when it does not, so a moving kitten, a
 * spreading dust puff or a swinging toy thread does not reallocate its canvas every few frames. It
 * shrinks only when a large box would waste too much. Pure; no DOM.
 */
import type { Rect } from '../shared/types';

/** The smallest rect containing every given rect with finite fields; null when there is none. */
export function unionRects(...rects: readonly (Rect | null | undefined)[]): Rect | null {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const rect of rects) {
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) continue;
    left = Math.min(left, rect.x); top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width); bottom = Math.max(bottom, rect.y + rect.height);
  }
  return left <= right && top <= bottom ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

/** A layer's position and backing-store size in device pixels. */
export interface DeviceBox { left: number; top: number; width: number; height: number }

/** New allocations are rounded up to this many device pixels. */
export const BOX_STEP_PX = 16;
/** A kept or grown backing store larger than BOX_KEEP_PX may hold at most this many times the pixels its content needs. */
export const BOX_MAX_WASTE = 4;
/** A backing store of at most this many pixels (256 × 256) is kept whatever it wastes: that costs less than reallocating it. */
export const BOX_KEEP_PX = 256 * 256;
/** Upper bound for either side of a layer, device pixels (a safety net; layers are far smaller). */
export const BOX_MAX_PX = 4096;

/**
 * The box for content covering `rect` (scene DIP) at `dpr` device pixels per DIP: its top-left corner
 * on the device pixel at or above-left of the content, and a backing size that only grows: each side
 * of `previous` that fits is kept, a side that does not grows to the needed size rounded up to
 * BOX_STEP_PX. The result is used while it holds at most BOX_KEEP_PX pixels or wastes at most
 * BOX_MAX_WASTE × the needed pixels; otherwise the box refits to the needed size, rounded up.
 * Null for non-finite input or a non-positive `dpr`.
 */
export function fitDeviceBox(rect: Rect, dpr: number, previous: { width: number; height: number } | null): DeviceBox | null {
  if (![rect.x, rect.y, rect.width, rect.height, dpr].every(Number.isFinite) || !(dpr > 0)) return null;
  const left = Math.floor(rect.x * dpr), top = Math.floor(rect.y * dpr);
  const neededWidth = Math.min(BOX_MAX_PX, Math.max(1, Math.ceil((rect.x + Math.max(0, rect.width)) * dpr) - left));
  const neededHeight = Math.min(BOX_MAX_PX, Math.max(1, Math.ceil((rect.y + Math.max(0, rect.height)) * dpr) - top));
  const round = (value: number) => Math.min(BOX_MAX_PX, Math.ceil(value / BOX_STEP_PX) * BOX_STEP_PX);
  if (previous && previous.width > 0 && previous.height > 0) {
    // Grow-only per side: a side that fits keeps its size even when the other one grows.
    const width = previous.width >= neededWidth ? previous.width : round(neededWidth);
    const height = previous.height >= neededHeight ? previous.height : round(neededHeight);
    const pixels = width * height;
    if (pixels <= BOX_KEEP_PX || pixels <= BOX_MAX_WASTE * neededWidth * neededHeight) return { left, top, width, height };
  }
  return { left, top, width: round(neededWidth), height: round(neededHeight) };
}
