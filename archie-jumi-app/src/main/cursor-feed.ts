/**
 * Main-process cursor feed (plan F1). The main process samples the cursor and tells the overlay
 * renderer where it is while it lies inside the renderer's interest region, plus one message when
 * it leaves, so hover never depends on Electron's Windows mouse-forwarding hook. Steady-state IPC
 * is zero while the cursor is elsewhere. Pure decision plus a small timer class with injected
 * dependencies; no runtime electron import.
 */
import type { Point, Rect } from '../shared/types';

export type { Rect } from '../shared/types';
export interface FeedState { inside: boolean; x: number; y: number }
export type CursorMessage = { inside: true; x: number; y: number } | { inside: false };

/**
 * About 30 Hz in practice. Windows rounds main-process timers up to its ~15.6 ms tick: measured in
 * Electron 44, a 33 ms request fired every ~47 ms (max 60), while a 16 ms request fires every ~31 ms
 * (max 44). So hover is noticed within ~33 ms, well inside the 100 ms target.
 */
export const FEED_INTERVAL_MS = 16;
export const OUTSIDE: FeedState = Object.freeze({ inside: false, x: Number.NaN, y: Number.NaN });

/** Edges are inclusive. */
export function rectContains(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

/**
 * `sample` is in scene DIP (cursor screen point minus the overlay's content origin), or null when
 * unavailable. Sends a position on entry and on every change while inside, one `inside: false`
 * on leaving, and nothing while the cursor stays outside or stands still.
 */
export function decideCursorFeed(prev: FeedState, sample: Point | null, rects: readonly Rect[]): { message: CursorMessage | null; next: FeedState } {
  const point = sample && Number.isFinite(sample.x) && Number.isFinite(sample.y) ? sample : null;
  if (point && rects.some(rect => rectContains(rect, point))) {
    const changed = !prev.inside || prev.x !== point.x || prev.y !== point.y;
    return { message: changed ? { inside: true, x: point.x, y: point.y } : null, next: { inside: true, x: point.x, y: point.y } };
  }
  return { message: prev.inside ? { inside: false } : null, next: OUTSIDE };
}

export interface CursorFeedDeps {
  /** Cursor position in screen DIP, or null when unavailable. */
  source: () => Point | null;
  /** The overlay's content-bounds origin in screen DIP, or null without an overlay. */
  origin: () => Point | null;
  send: (message: CursorMessage) => void;
  /** Monotonic clock in ms. */
  now: () => number;
  /** Called after every evaluation so the owner can re-run its input decision (hover guard). */
  onSample?: () => void;
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export class CursorFeed {
  private state: FeedState = OUTSIDE;
  private rects: readonly Rect[] = [];
  private running = false;
  private handle: unknown = null;
  private outsideAt: number | null = null;

  constructor(private readonly deps: CursorFeedDeps) {}

  /** Starts polling. Until a sample says otherwise the cursor counts as outside since now. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.state = OUTSIDE;
    this.outsideAt = this.deps.now();
    const schedule = this.deps.setInterval ?? ((callback: () => void, ms: number) => setInterval(callback, ms));
    this.handle = schedule(() => this.tick(), FEED_INTERVAL_MS);
    (this.handle as { unref?: () => void } | null)?.unref?.();
  }

  /** Stops polling and resets to OUTSIDE. Sends nothing. */
  stop(): void {
    if (this.running) {
      const cancel = this.deps.clearInterval ?? ((handle: unknown) => clearInterval(handle as Parameters<typeof clearInterval>[0]));
      cancel(this.handle);
    }
    this.running = false;
    this.handle = null;
    this.state = OUTSIDE;
    this.outsideAt = null;
  }

  /** Replaces the interest region and evaluates at once, which detects a kitten walking under a stationary cursor. */
  setRegion(rects: readonly Rect[]): void {
    this.rects = rects.map(rect => ({ ...rect }));
    if (this.running) this.evaluate();
  }

  /** One polling step; does nothing while stopped. */
  tick(): void {
    if (this.running) this.evaluate();
  }

  /**
   * Samples now without notifying `onSample`, so the owner can judge a fresh renderer report
   * against a sample taken after it (and attribute the decision to that report). Sends a cursor
   * message as usual when the state changed. Does nothing while stopped.
   */
  sampleNow(): void {
    if (this.running) this.evaluate(false);
  }

  insideInterest(): boolean { return this.state.inside; }
  outsideSince(): number | null { return this.state.inside ? null : this.outsideAt; }
  active(): boolean { return this.running; }

  private evaluate(notify = true): void {
    const { message, next } = decideCursorFeed(this.state, this.sample(), this.rects);
    if (next.inside) this.outsideAt = null;
    else if (this.state.inside || this.outsideAt === null) this.outsideAt = this.deps.now();
    this.state = next;
    // A failed send or decision must never break the feed timer.
    if (message) {
      try { this.deps.send(message); } catch { /* The owner logs delivery problems. */ }
    }
    if (!notify) return;
    try { this.deps.onSample?.(); } catch { /* See above. */ }
  }

  private sample(): Point | null {
    try {
      const point = this.deps.source(), origin = this.deps.origin();
      return point && origin ? { x: point.x - origin.x, y: point.y - origin.y } : null;
    } catch {
      return null;
    }
  }
}
