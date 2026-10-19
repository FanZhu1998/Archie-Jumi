/**
 * The yarn toy's look (Phase 2 spec 5.5): the ball rolls (rotation = travelled distance ÷ radius), its
 * thread trails along the ball's recent positions, and a ball released by the user bounces briefly.
 * Pure; no DOM. Under reduced motion or Quiet Mode it is drawn exactly as in 1.0.2 (still stripes,
 * resting thread, no bounce). Times are renderer seconds, lengths scene DIP.
 */
import type { Point, ToyState } from '../shared/types';

/** Drawn radius of the yarn ball (its hit radius is TOY_RADIUS = 18). */
export const BALL_RADIUS = 17;
/** The 1.0.2 thread relative to the ball centre: start, two Bézier control points, end. */
export const THREAD_REST: readonly Point[] = [{ x: 12, y: 6 }, { x: 23, y: 25 }, { x: 43, y: -12 }, { x: 52, y: 14 }];
/** How far back along the ball's path (s) each thread point trails; the start stays on the ball. */
export const THREAD_LAG_S: readonly number[] = [0, 0.07, 0.15, 0.24];
/** A trailing thread point lags its rest position by at most this many DIP. */
export const THREAD_MAX_TRAIL = 40;
/** The release bounce: two decaying hops over RELEASE_BOUNCE_S, the first RELEASE_BOUNCE_DIP high. */
export const RELEASE_BOUNCE_S = 0.45, RELEASE_BOUNCE_DIP = 8;
/** Recent positions are kept this long (a little more than the longest lag). */
const HISTORY_S = 0.3;

export interface ToyView {
  /** Drawn ball centre (the release bounce included): what the toy hit test and interest rect use. */
  x: number;
  y: number;
  /** Stripe rotation in radians (positive = clockwise, rolling to the right). */
  angle: number;
  /** Thread start, two control points and end, in scene DIP. */
  thread: Point[];
  /** The release bounce is running (a renderer-clock effect: render at display rate). */
  bouncing: boolean;
}

/** Height of the release bounce `since` seconds after release (0 outside the window). */
export function releaseBounce(since: number): number {
  if (!(since >= 0) || since >= RELEASE_BOUNCE_S) return 0;
  const p = since / RELEASE_BOUNCE_S;
  return RELEASE_BOUNCE_DIP * Math.abs(Math.sin(2 * Math.PI * p)) * (1 - p);
}

function limit(x: number, y: number, max: number): Point {
  const length = Math.hypot(x, y);
  return length > max ? { x: x / length * max, y: y / length * max } : { x, y };
}

export class ToyVisual {
  private history: { x: number; y: number; t: number }[] = [];
  private angle = 0;
  private direction = 1;
  private last: Point | null = null;
  private held = false;
  private releasedAt = Number.NEGATIVE_INFINITY;

  /** Forgets the toy (play ended): the next toy starts still. */
  reset(): void {
    this.history = [];
    this.angle = 0;
    this.direction = 1;
    this.last = null;
    this.held = false;
    this.releasedAt = Number.NEGATIVE_INFINITY;
  }

  /** Observes the engine toy at renderer time `time` and returns how to draw it (null without a toy). */
  observe(toy: ToyState | null, time: number, calm: boolean): ToyView | null {
    if (!toy || !Number.isFinite(toy.x) || !Number.isFinite(toy.y)) {
      this.reset();
      return null;
    }
    if (calm) {
      this.reset();
      this.held = toy.held;
      return { x: toy.x, y: toy.y, angle: 0, thread: THREAD_REST.map(point => ({ x: toy.x + point.x, y: toy.y + point.y })), bouncing: false };
    }
    if (this.last) {
      const dx = toy.x - this.last.x, dy = toy.y - this.last.y;
      if (dx !== 0) this.direction = dx < 0 ? -1 : 1;
      this.angle = (this.angle + this.direction * Math.hypot(dx, dy) / BALL_RADIUS) % (2 * Math.PI);
    }
    if (this.held && !toy.held) this.releasedAt = time;
    this.held = toy.held;
    this.last = { x: toy.x, y: toy.y };
    const latest = this.history.at(-1);
    if (latest && time <= latest.t) {
      latest.x = toy.x;
      latest.y = toy.y;
    } else {
      this.history.push({ x: toy.x, y: toy.y, t: time });
    }
    // Keep one sample older than the window so the oldest lag can still be interpolated.
    while (this.history.length > 2 && this.history[1].t <= time - HISTORY_S) this.history.shift();

    const bounce = releaseBounce(time - this.releasedAt);
    const thread = THREAD_REST.map((rest, index) => {
      const past = this.positionAt(time - THREAD_LAG_S[index]);
      const trail = limit(past.x - toy.x, past.y - toy.y, THREAD_MAX_TRAIL);
      // The thread hangs from the ball: its start hops with the bounce, its far end stays on the ground.
      const lift = bounce * (1 - index / (THREAD_REST.length - 1));
      return { x: toy.x + rest.x + trail.x, y: toy.y + rest.y + trail.y - lift };
    });
    return { x: toy.x, y: toy.y - bounce, angle: this.angle, thread, bouncing: time - this.releasedAt < RELEASE_BOUNCE_S };
  }

  /** The ball position at renderer time `t`, interpolated from recent samples (the oldest one before them). */
  private positionAt(t: number): Point {
    const history = this.history;
    for (let index = history.length - 1; index > 0; index--) {
      const a = history[index - 1], b = history[index];
      if (t >= a.t) {
        if (t >= b.t) return { x: b.x, y: b.y };
        const f = (t - a.t) / (b.t - a.t);
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
      }
    }
    return history.length ? { x: history[0].x, y: history[0].y } : { x: 0, y: 0 };
  }
}
