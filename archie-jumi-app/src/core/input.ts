import type { Point } from '../shared/types';

/** Distances are in device-independent pixels, including on scaled monitors. */
export const DRAG_THRESHOLD = 6;

export function exceedsDragThreshold(start: Point, current: Point): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) > DRAG_THRESHOLD;
}

/** A drag remains a drag even when the pointer returns to its starting point. */
export class PointerGesture {
  private origin: Point | null = null;
  private dragging = false;

  begin(point: Point): void {
    this.origin = { ...point };
    this.dragging = false;
  }

  move(point: Point): 'inactive' | 'pressed' | 'dragging' {
    if (!this.origin) return 'inactive';
    this.dragging ||= exceedsDragThreshold(this.origin, point);
    return this.dragging ? 'dragging' : 'pressed';
  }

  end(): 'inactive' | 'click' | 'drag' {
    const result = !this.origin ? 'inactive' : this.dragging ? 'drag' : 'click';
    this.cancel();
    return result;
  }

  cancel(): void {
    this.origin = null;
    this.dragging = false;
  }
}
