import type { Point } from '../shared/types';

/** Distances are in device-independent pixels, including on scaled monitors. */
export const DRAG_THRESHOLD = 6;
/** A press that stays within the drag threshold for this many milliseconds is a hold (hold-to-pet). */
export const HOLD_THRESHOLD_MS = 350;

export function exceedsDragThreshold(start: Point, current: Point): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) > DRAG_THRESHOLD;
}

/**
 * Lost-pointerup guard: a move of the captured pointer with no button pressed means its release
 * was never delivered. `buttons` is the DOM PointerEvent bitmask; any pressed button (including
 * a chord or a pen/touch contact, which report 1) keeps the capture.
 */
export function missedRelease(captured: boolean, buttons: number): boolean {
  return captured && buttons === 0;
}

/** What a pressed pointer is doing right now. */
export type GesturePhase = 'inactive' | 'pressed' | 'holding' | 'dragging';
/** How a press ended. */
export type GestureResult = 'inactive' | 'click' | 'drag' | 'hold';

/**
 * Click, hold and drag recognition for one press. A drag remains a drag even when the pointer
 * returns to its starting point, and a hold that later moves past the drag threshold becomes a
 * drag. Times are milliseconds on one monotonic clock (for example `performance.now()`).
 */
export class PointerGesture {
  private origin: Point | null = null;
  private startedAt = Number.NaN;
  private dragging = false;
  private holding = false;

  /** Starts a press at `now`. Without `now` the press can only become a click or a drag. */
  begin(point: Point, now: number = Number.NaN): void {
    this.origin = { ...point };
    this.startedAt = now;
    this.dragging = false;
    this.holding = false;
  }

  move(point: Point): GesturePhase {
    if (!this.origin) return 'inactive';
    this.dragging ||= exceedsDragThreshold(this.origin, point);
    return this.phase();
  }

  /**
   * Call while pressed (every frame). The first poll at or after HOLD_THRESHOLD_MS without a drag
   * recognizes the hold; later polls keep returning 'holding' until a drag, `end()` or `cancel()`.
   */
  poll(now: number): GesturePhase {
    if (this.origin && !this.dragging && !this.holding && now - this.startedAt >= HOLD_THRESHOLD_MS) this.holding = true;
    return this.phase();
  }

  /** 'hold' only when a poll recognized the hold; a long press that was never polled stays a click. */
  end(): GestureResult {
    const result = !this.origin ? 'inactive' : this.dragging ? 'drag' : this.holding ? 'hold' : 'click';
    this.cancel();
    return result;
  }

  cancel(): void {
    this.origin = null;
    this.startedAt = Number.NaN;
    this.dragging = false;
    this.holding = false;
  }

  private phase(): GesturePhase {
    if (!this.origin) return 'inactive';
    return this.dragging ? 'dragging' : this.holding ? 'holding' : 'pressed';
  }
}
