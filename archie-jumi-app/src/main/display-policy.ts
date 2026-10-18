/**
 * Display-change policy (plan F5): the overlay is recreated only when the display it should cover
 * really changed. Pure; no runtime electron import, so Vitest can load it.
 */
import type { Rect } from '../shared/types';

/** What the overlay was built for: the display's identity, work area and scale factor. */
export interface DisplaySnapshot { id: number; workArea: Rect; scaleFactor: number }
export type DisplayRecreateReason = 'no-overlay' | 'display-id' | 'work-area' | 'scale-factor';

/** A copy, so later changes to the live display object never alter what was recorded. */
export function snapshotDisplay(display: { id: number; workArea: Rect; scaleFactor: number }): DisplaySnapshot {
  const { x, y, width, height } = display.workArea;
  return { id: display.id, workArea: { x, y, width, height }, scaleFactor: display.scaleFactor };
}

const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * Why the overlay must be recreated for `target`, or null when the live overlay already covers it.
 * `recorded` is the snapshot taken when the current overlay was created.
 */
export function displayRecreateReason(recorded: DisplaySnapshot | null, target: DisplaySnapshot, overlayAlive: boolean): DisplayRecreateReason | null {
  if (!recorded || !overlayAlive) return 'no-overlay';
  if (recorded.id !== target.id) return 'display-id';
  if (recorded.scaleFactor !== target.scaleFactor) return 'scale-factor';
  if (!sameRect(recorded.workArea, target.workArea)) return 'work-area';
  return null;
}
