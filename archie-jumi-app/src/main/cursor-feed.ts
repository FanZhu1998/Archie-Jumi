/**
 * Main-process cursor feed (plan F1). The main process samples the cursor and tells the overlay
 * renderer where it is while it lies inside the renderer's interest region, plus one message when
 * it leaves, so hover never depends on Electron's Windows mouse-forwarding hook. Steady-state IPC
 * is zero while the cursor is elsewhere. The region is the sprite and toy rects plus the cursor-
 * curiosity attention squares (1.1.0); only the sprite and toy rects count for the hover guard, so a
 * stale hover report is still cleared once the cursor leaves them, even inside a square. Pure decision
 * plus a small timer class with injected dependencies; no runtime electron import.
 *
 * Also the pure helpers for Come here (I9): where the cursor rests (`CursorRest`) and waiting for the
 * user to point after choosing it in a kitten's menu (`PointChoice`).
 */
import type { Point, Rect, Size } from '../shared/types';

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
  /**
   * Called after every evaluation so the owner can re-run its input decision (hover guard), with the
   * sample just evaluated (scene DIP, or null when unavailable).
   */
  onSample?: (sample: Point | null) => void;
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export class CursorFeed {
  private state: FeedState = OUTSIDE;
  /** Sprite and toy rects: the hover guard's region. */
  private rects: readonly Rect[] = [];
  /** `rects` plus the attention squares: where the cursor is reported. */
  private region: readonly Rect[] = [];
  /** The latest sample lies inside `rects`. */
  private hover = false;
  private running = false;
  private handle: unknown = null;
  /** When the cursor last left `rects` (or the feed started), while it is outside them. */
  private outsideAt: number | null = null;

  constructor(private readonly deps: CursorFeedDeps) {}

  /** Starts polling. Until a sample says otherwise the cursor counts as outside since now. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.state = OUTSIDE;
    this.hover = false;
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
    this.hover = false;
    this.outsideAt = null;
  }

  /**
   * Replaces the interest region (sprite and toy `rects`, plus `attention` squares that are reported but
   * never count as hover) and evaluates at once, which detects a kitten walking under a stationary cursor.
   */
  setRegion(rects: readonly Rect[], attention: readonly Rect[] = []): void {
    this.rects = rects.map(rect => ({ ...rect }));
    this.region = [...this.rects, ...attention.map(rect => ({ ...rect }))];
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

  /** The latest sample lies inside a sprite or toy rect (the hover guard's region; attention squares never count). */
  insideInterest(): boolean { return this.hover; }
  /** When the cursor left the sprite and toy rects, or null while it is inside them. */
  outsideSince(): number | null { return this.hover ? null : this.outsideAt; }
  active(): boolean { return this.running; }

  private evaluate(notify = true): void {
    const raw = this.sample();
    const sample = raw && Number.isFinite(raw.x) && Number.isFinite(raw.y) ? raw : null;
    const { message, next } = decideCursorFeed(this.state, sample, this.region);
    const hover = sample !== null && this.rects.some(rect => rectContains(rect, sample));
    if (hover) this.outsideAt = null;
    else if (this.hover || this.outsideAt === null) this.outsideAt = this.deps.now();
    this.hover = hover;
    this.state = next;
    // A failed send or decision must never break the feed timer.
    if (message) {
      try { this.deps.send(message); } catch { /* The owner logs delivery problems. */ }
    }
    if (!notify) return;
    try { this.deps.onSample?.(sample ? { ...sample } : null); } catch { /* See above. */ }
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

/** Come here (I9): the cursor still counts as resting while it stays within this many DIP of where it stopped. */
export const REST_RADIUS = 4;

/** A rest of the cursor: where it is now (scene DIP) and since when (ms) it has stayed within REST_RADIUS. */
export interface CursorRestState { point: Point; since: number }

/**
 * Where the cursor rests, from the feed's samples and their times. Only samples inside the scene count; one
 * outside it, or none, ends the current rest. Remembers the last point where the cursor rested for at least
 * `minRestMs` (in memory only). Pure.
 */
export class CursorRest {
  private current: { anchor: Point; point: Point; since: number } | null = null;
  private last: Point | null = null;

  constructor(private readonly minRestMs: number) {}

  observe(sample: Point | null, now: number, scene: Size): void {
    const inside = sample !== null && Number.isFinite(sample.x) && Number.isFinite(sample.y)
      && sample.x >= 0 && sample.y >= 0 && sample.x <= scene.width && sample.y <= scene.height;
    if (!inside) {
      this.current = null;
      return;
    }
    const point = { x: sample.x, y: sample.y };
    const current = this.current;
    if (!current || Math.hypot(point.x - current.anchor.x, point.y - current.anchor.y) > REST_RADIUS) this.current = { anchor: point, point, since: now };
    else current.point = point;
    if (now - this.current!.since >= this.minRestMs) this.last = { ...point };
  }

  /** The current rest, or null while the cursor moves, is outside the scene or unknown. */
  resting(): CursorRestState | null {
    return this.current ? { point: { ...this.current.point }, since: this.current.since } : null;
  }

  /** The last point where the cursor rested for at least `minRestMs` (it may still be resting there). */
  lastRest(): Point | null {
    return this.last ? { ...this.last } : null;
  }

  reset(): void {
    this.current = null;
    this.last = null;
  }
}

/** After Come here in a kitten's menu: how far the cursor must first get from where the item was clicked (DIP). */
export const POINT_DEPART = 64;
/** ...then how long it must rest inside the scene (ms), and how long main waits at most (ms). */
export const POINT_REST_MS = 300;
export const POINT_WAIT_MS = 6000;

/**
 * Waits for the user to point after choosing Come here in a kitten's menu (always opened on the kitten): the
 * cursor must first get more than POINT_DEPART DIP from where the item was clicked, so a hand that stays on
 * the menu row chooses nothing, then rest POINT_REST_MS inside the scene. Gives up after POINT_WAIT_MS. Pure.
 */
export class PointChoice {
  private departed: boolean;

  /** `from`: the cursor (scene DIP) when the item was clicked, null when unknown; `startedAt` in ms. */
  constructor(private readonly from: Point | null, private readonly startedAt: number) {
    this.departed = from === null;
  }

  /** Feed every sample with the current rest: the chosen point, 'expired' once the wait is over, or null to keep waiting. */
  update(sample: Point | null, rest: CursorRestState | null, now: number): Point | 'expired' | null {
    if (now - this.startedAt > POINT_WAIT_MS) return 'expired';
    const from = this.from;
    if (!this.departed && sample && from && Math.hypot(sample.x - from.x, sample.y - from.y) > POINT_DEPART) this.departed = true;
    return this.departed && rest && now - rest.since >= POINT_REST_MS ? { ...rest.point } : null;
  }
}
