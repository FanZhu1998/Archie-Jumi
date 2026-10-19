import { describe, expect, it } from 'vitest';
import {
  CursorFeed, CursorRest, FEED_INTERVAL_MS, OUTSIDE, POINT_DEPART, POINT_REST_MS, POINT_WAIT_MS, PointChoice, REST_RADIUS, decideCursorFeed,
  type CursorMessage, type FeedState, type Rect,
} from '../src/main/cursor-feed';
import { HOVER_GUARD_MS, decideInput, needsFreshSample, type InputDecisionState } from '../src/main/input-routing';
import type { InputTarget, Point } from '../src/shared/types';

const kitten: Rect = { x: 100, y: 100, width: 50, height: 40 };
const toy: Rect = { x: 400, y: 300, width: 20, height: 20 };
const inside = (x: number, y: number): FeedState => ({ inside: true, x, y });

describe('cursor feed decision', () => {
  it('sends the position on entry and on every move inside', () => {
    expect(decideCursorFeed(OUTSIDE, { x: 120, y: 110 }, [kitten])).toEqual({ message: { inside: true, x: 120, y: 110 }, next: inside(120, 110) });
    expect(decideCursorFeed(inside(120, 110), { x: 121, y: 110 }, [kitten])).toEqual({ message: { inside: true, x: 121, y: 110 }, next: inside(121, 110) });
  });

  it('stays silent while the cursor stands still inside', () => {
    expect(decideCursorFeed(inside(120, 110), { x: 120, y: 110 }, [kitten])).toEqual({ message: null, next: inside(120, 110) });
  });

  it('sends exactly one leave message, then stays silent outside', () => {
    const left = decideCursorFeed(inside(120, 110), { x: 500, y: 500 }, [kitten]);
    expect(left).toEqual({ message: { inside: false }, next: OUTSIDE });
    expect(decideCursorFeed(left.next, { x: 510, y: 500 }, [kitten])).toEqual({ message: null, next: OUTSIDE });
    expect(decideCursorFeed(OUTSIDE, { x: 0, y: 0 }, [])).toEqual({ message: null, next: OUTSIDE });
  });

  it('treats an unavailable or non-finite sample as outside', () => {
    expect(decideCursorFeed(inside(120, 110), null, [kitten])).toEqual({ message: { inside: false }, next: OUTSIDE });
    expect(decideCursorFeed(OUTSIDE, null, [kitten]).message).toBeNull();
    expect(decideCursorFeed(OUTSIDE, { x: Number.NaN, y: 110 }, [kitten]).message).toBeNull();
    expect(decideCursorFeed(inside(1, 1), { x: Infinity, y: 0 }, [{ x: -Infinity, y: -1, width: Infinity, height: 2 }]).message).toEqual({ inside: false });
  });

  it('includes rect edges', () => {
    for (const point of [{ x: 100, y: 100 }, { x: 150, y: 140 }, { x: 150, y: 100 }, { x: 100, y: 140 }]) {
      expect(decideCursorFeed(OUTSIDE, point, [kitten]).message).toEqual({ inside: true, ...point });
    }
    expect(decideCursorFeed(OUTSIDE, { x: 150.01, y: 120 }, [kitten]).message).toBeNull();
    expect(decideCursorFeed(OUTSIDE, { x: 99.99, y: 120 }, [kitten]).message).toBeNull();
  });

  it('uses any of several rects and moves between them without a leave message', () => {
    expect(decideCursorFeed(OUTSIDE, { x: 410, y: 310 }, [kitten, toy]).message).toEqual({ inside: true, x: 410, y: 310 });
    expect(decideCursorFeed(inside(120, 110), { x: 410, y: 310 }, [kitten, toy]).message).toEqual({ inside: true, x: 410, y: 310 });
  });
});

function harness(origin: Point | null = { x: 0, y: 0 }) {
  let cursor: Point | null = { x: -1e6, y: -1e6 };
  let now = 1000;
  let callback: (() => void) | null = null;
  const intervals: number[] = [];
  const sent: CursorMessage[] = [];
  const sampled: (Point | null)[] = [];
  let samples = 0;
  const feed = new CursorFeed({
    source: () => cursor,
    origin: () => origin,
    send: message => sent.push(message),
    now: () => now,
    onSample: sample => { samples++; sampled.push(sample); },
    setInterval: (fn, ms) => { callback = fn; intervals.push(ms); return 'handle'; },
    clearInterval: () => { callback = null; },
  });
  return {
    feed, sent, intervals, sampled,
    get samples() { return samples; },
    get now() { return now; },
    get scheduled() { return callback !== null; },
    move(point: Point | null) { cursor = point; },
    advance(ms: number) { now += ms; },
    tick() { callback?.(); },
  };
}

describe('CursorFeed', () => {
  it('polls at 33 ms only between start and stop, and stop resets to outside without sending', () => {
    const h = harness();
    h.feed.setRegion([kitten]);
    expect(h.feed.active()).toBe(false);
    h.move({ x: 120, y: 110 });
    h.feed.tick();
    expect(h.sent).toEqual([]);
    h.feed.start();
    expect(h.intervals).toEqual([FEED_INTERVAL_MS]);
    expect(h.feed.active()).toBe(true);
    h.tick();
    expect(h.sent).toEqual([{ inside: true, x: 120, y: 110 }]);
    expect(h.feed.insideInterest()).toBe(true);
    h.feed.stop();
    expect(h.scheduled).toBe(false);
    expect(h.feed.active()).toBe(false);
    expect(h.feed.insideInterest()).toBe(false);
    expect(h.feed.outsideSince()).toBeNull();
    expect(h.sent).toHaveLength(1);
    h.feed.start();
    h.tick();
    expect(h.sent).toEqual([{ inside: true, x: 120, y: 110 }, { inside: true, x: 120, y: 110 }]);
  });

  it('sends nothing while the cursor moves around outside the region', () => {
    const h = harness();
    h.feed.setRegion([kitten]);
    h.feed.start();
    for (let i = 0; i < 20; i++) { h.move({ x: 600 + i, y: 600 }); h.tick(); }
    expect(h.sent).toEqual([]);
    expect(h.samples).toBe(20);
  });

  it('sends one leave message and records when the cursor left', () => {
    const h = harness();
    h.feed.setRegion([kitten]);
    h.feed.start();
    expect(h.feed.outsideSince()).toBe(1000);
    h.move({ x: 120, y: 110 }); h.advance(33); h.tick();
    expect(h.feed.outsideSince()).toBeNull();
    h.move({ x: 700, y: 110 }); h.advance(33); h.tick();
    h.move({ x: 710, y: 110 }); h.advance(33); h.tick();
    expect(h.sent).toEqual([{ inside: true, x: 120, y: 110 }, { inside: false }]);
    expect(h.feed.outsideSince()).toBe(1066);
  });

  it('evaluates a new region at once: a kitten walking under a stationary cursor, then away', () => {
    const h = harness();
    h.move({ x: 300, y: 300 });
    h.feed.setRegion([kitten]);
    h.feed.start();
    h.tick();
    expect(h.sent).toEqual([]);
    h.feed.setRegion([{ x: 280, y: 280, width: 50, height: 40 }]);
    expect(h.sent).toEqual([{ inside: true, x: 300, y: 300 }]);
    h.feed.setRegion([{ x: 284, y: 280, width: 50, height: 40 }]);
    expect(h.sent).toHaveLength(1);
    h.feed.setRegion([{ x: 500, y: 280, width: 50, height: 40 }]);
    expect(h.sent).toEqual([{ inside: true, x: 300, y: 300 }, { inside: false }]);
  });

  it('converts screen DIP to scene DIP with the overlay origin', () => {
    const h = harness({ x: -1200, y: -244 });
    h.feed.setRegion([kitten]);
    h.feed.start();
    h.move({ x: -1200 + 120, y: -244 + 110 });
    h.tick();
    expect(h.sent).toEqual([{ inside: true, x: 120, y: 110 }]);
  });

  it('treats a missing origin or a throwing source as outside', () => {
    const h = harness(null);
    h.feed.setRegion([{ x: -1e7, y: -1e7, width: 2e7, height: 2e7 }]);
    h.feed.start();
    h.tick();
    expect(h.sent).toEqual([]);
    const failing = new CursorFeed({ source: () => { throw new Error('no screen'); }, origin: () => ({ x: 0, y: 0 }), send: () => {}, now: () => 0, setInterval: () => 1, clearInterval: () => {} });
    failing.setRegion([kitten]);
    failing.start();
    expect(() => failing.tick()).not.toThrow();
    expect(failing.insideInterest()).toBe(false);
  });

  it('samples on demand without notifying the owner, and not while stopped', () => {
    const h = harness();
    h.feed.setRegion([kitten]);
    h.move({ x: 120, y: 110 });
    h.feed.sampleNow();
    expect(h.sent).toEqual([]);
    h.feed.start();
    h.feed.sampleNow();
    expect(h.sent).toEqual([{ inside: true, x: 120, y: 110 }]);
    expect(h.feed.insideInterest()).toBe(true);
    expect(h.samples).toBe(0);
    h.tick();
    expect(h.samples).toBe(1);
  });

  it('hands the owner each evaluated sample in scene DIP, or null when there is none', () => {
    const h = harness({ x: 10, y: 20 });
    h.feed.setRegion([kitten]);
    h.feed.start();
    h.move({ x: 130, y: 130 }); h.tick();
    h.move(null); h.tick();
    h.move({ x: Number.NaN, y: 1 }); h.tick();
    expect(h.sampled).toEqual([{ x: 120, y: 110 }, null, null]);
  });

  it('reports the cursor inside attention squares, which never count as hover for the guard', () => {
    const square: Rect = { x: 0, y: 0, width: 300, height: 300 };
    const h = harness();
    h.feed.setRegion([kitten], [square]);
    h.feed.start();
    h.move({ x: 250, y: 250 }); h.advance(16); h.tick();
    h.move({ x: 251, y: 250 }); h.advance(16); h.tick();
    expect(h.sent).toEqual([{ inside: true, x: 250, y: 250 }, { inside: true, x: 251, y: 250 }]);
    expect(h.feed.insideInterest()).toBe(false);
    expect(h.feed.outsideSince()).toBe(1000);
    // Onto the sprite rect: hover; back into the square only: outside again from that moment.
    h.move({ x: 120, y: 110 }); h.advance(16); h.tick();
    expect([h.feed.insideInterest(), h.feed.outsideSince()]).toEqual([true, null]);
    h.move({ x: 200, y: 110 }); h.advance(16); h.tick();
    expect([h.feed.insideInterest(), h.feed.outsideSince()]).toEqual([false, 1064]);
    expect(h.sent.at(-1)).toEqual({ inside: true, x: 200, y: 110 });
    // A region without squares still reports nothing there; the default is no squares.
    h.feed.setRegion([kitten]);
    expect(h.sent.at(-1)).toEqual({ inside: false });
  });

  it('keeps running when sending fails', () => {
    let attempts = 0;
    const feed = new CursorFeed({ source: () => ({ x: 120, y: 110 }), origin: () => ({ x: 0, y: 0 }), send: () => { attempts++; throw new Error('renderer gone'); }, now: () => 0, setInterval: () => 1, clearInterval: () => {} });
    feed.start();
    expect(() => feed.setRegion([kitten])).not.toThrow();
    expect(attempts).toBe(1);
    expect(feed.insideInterest()).toBe(true);
  });
});

describe('hover guard with the cursor feed', () => {
  /** The owner's input-mode handler: a hover report is judged against a sample taken after it. */
  function handleReport(h: ReturnType<typeof harness>, target: InputTarget) {
    const report = { target, capture: false };
    if (needsFreshSample(report, h.feed.active(), h.feed.insideInterest())) h.feed.sampleNow();
    const state: InputDecisionState = {
      sceneReady: true, overlayVisible: true, hidden: false, paused: false, quiet: false, recovering: false, report,
      feedActive: h.feed.active(), cursorInsideInterest: h.feed.insideInterest(), outsideSinceMs: h.feed.outsideSince(), nowMs: h.now,
    };
    return decideInput(state);
  }

  it('does not trip on a hover report that arrives between ticks after a fast entry', () => {
    const h = harness();
    h.feed.setRegion([kitten]);
    h.feed.start();
    for (let i = 0; i < 10; i++) { h.advance(6000); h.tick(); }
    // A forwarded move reaches the renderer before main's next tick sees the cursor inside.
    h.move({ x: 120, y: 110 });
    expect(handleReport(h, 'archie')).toEqual({ interactive: true, reason: 'hover' });
    expect(h.sent).toEqual([{ inside: true, x: 120, y: 110 }]);
  });

  it('still trips on a stale hover report while the cursor stays far away', () => {
    const h = harness();
    h.feed.setRegion([kitten]);
    h.feed.start();
    h.advance(HOVER_GUARD_MS + 10); h.tick();
    expect(handleReport(h, 'archie')).toEqual({ interactive: false, reason: 'hover-guard' });
    expect(h.sent).toEqual([]);
  });

  it('trips on a stale hover report at 300 ms with the cursor inside an attention square, off the sprite', () => {
    // A hung renderer reported 'archie'; the cursor then moved off the sprite rect but stays inside the
    // curiosity square around him, where positions keep flowing to the renderer.
    const square: Rect = { x: 0, y: 0, width: 400, height: 400 };
    const h = harness();
    h.feed.setRegion([kitten], [square]);
    h.feed.start();
    h.move({ x: 120, y: 110 }); h.tick();
    expect(handleReport(h, 'archie')).toEqual({ interactive: true, reason: 'hover' });
    h.move({ x: 300, y: 300 }); h.tick();
    const leftAt = h.now;
    h.advance(HOVER_GUARD_MS - 1); h.move({ x: 301, y: 300 }); h.tick();
    expect(handleReport(h, 'archie')).toEqual({ interactive: true, reason: 'hover' });
    h.advance(1); h.move({ x: 302, y: 300 }); h.tick();
    expect(h.feed.outsideSince()).toBe(leftAt);
    expect(handleReport(h, 'archie')).toEqual({ interactive: false, reason: 'hover-guard' });
    expect(h.sent).toEqual([{ inside: true, x: 120, y: 110 }, { inside: true, x: 300, y: 300 }, { inside: true, x: 301, y: 300 }, { inside: true, x: 302, y: 300 }]);
  });

  it('asks for a fresh sample only for a hover report the latest sample places outside', () => {
    expect(needsFreshSample({ target: 'archie', capture: false }, true, false)).toBe(true);
    expect(needsFreshSample({ target: 'toy', capture: false }, true, false)).toBe(true);
    expect(needsFreshSample({ target: 'archie', capture: false }, true, true)).toBe(false);
    expect(needsFreshSample({ target: 'archie', capture: true }, true, false)).toBe(false);
    expect(needsFreshSample({ target: null, capture: false }, true, false)).toBe(false);
    expect(needsFreshSample({ target: 'jumi', capture: false }, false, false)).toBe(false);
  });
});

describe('Come here: where the cursor rests', () => {
  const scene = { width: 1000, height: 600 };

  it('remembers the last spot where the cursor rested for the minimum time, inside the scene only', () => {
    const rest = new CursorRest(500);
    rest.observe({ x: 100, y: 100 }, 0, scene);
    rest.observe({ x: 100 + REST_RADIUS, y: 100 }, 499, scene);
    expect(rest.lastRest()).toBeNull();
    expect(rest.resting()).toEqual({ point: { x: 104, y: 100 }, since: 0 });
    rest.observe({ x: 101, y: 101 }, 500, scene);
    expect(rest.lastRest()).toEqual({ x: 101, y: 101 });
    // Moving on, then pausing too briefly elsewhere, keeps the remembered spot.
    rest.observe({ x: 300, y: 100 }, 520, scene);
    expect(rest.resting()).toEqual({ point: { x: 300, y: 100 }, since: 520 });
    rest.observe({ x: 300, y: 100 }, 900, scene);
    expect(rest.lastRest()).toEqual({ x: 101, y: 101 });
    // Outside the scene (the taskbar) or unknown: no rest, however long.
    for (const outside of [{ x: 500, y: 620 }, { x: -1, y: 50 }, null]) {
      rest.observe(outside, 1000, scene);
      rest.observe(outside, 5000, scene);
      expect(rest.resting()).toBeNull();
    }
    expect(rest.lastRest()).toEqual({ x: 101, y: 101 });
    rest.reset();
    expect([rest.lastRest(), rest.resting()]).toEqual([null, null]);
  });

  it('ends a rest once the cursor drifts more than the radius from where it stopped', () => {
    const rest = new CursorRest(500);
    rest.observe({ x: 100, y: 100 }, 0, scene);
    rest.observe({ x: 103, y: 100 }, 200, scene);
    rest.observe({ x: 100 + REST_RADIUS + 1, y: 100 }, 400, scene);
    expect(rest.resting()).toEqual({ point: { x: 105, y: 100 }, since: 400 });
    rest.observe({ x: 105, y: 100 }, 899, scene);
    expect(rest.lastRest()).toBeNull();
  });
});

describe('Come here: waiting for the user to point', () => {
  const scene = { width: 1000, height: 600 };
  /** Drives a choice with samples every 16 ms along `path` (a function of ms since the click). */
  function drive(from: Point | null, path: (ms: number) => Point | null, until = POINT_WAIT_MS + 100) {
    const rest = new CursorRest(500), choice = new PointChoice(from, 0);
    for (let ms = 0; ms <= until; ms += 16) {
      const sample = path(ms);
      rest.observe(sample, ms, scene);
      const result = choice.update(sample, rest.resting(), ms);
      if (result !== null) return { result, ms };
    }
    return null;
  }
  const row = { x: 400, y: 300 };

  it('chooses nothing while the hand stays on the menu row, and gives up after 6 s', () => {
    expect(drive(row, () => row)).toEqual({ result: 'expired', ms: Math.ceil((POINT_WAIT_MS + 1) / 16) * 16 });
    // Nudging within the departure distance is still the menu row.
    expect(drive(row, ms => ({ x: row.x + Math.min(ms / 10, POINT_DEPART - 1), y: row.y }))?.result).toBe('expired');
  });

  it('sends the point where the cursor rests about 300 ms after moving away', () => {
    const goal = { x: 700, y: 150 };
    // Still on the row for a second, then a 400 ms glide to the goal, where it stays.
    const path = (ms: number) => ms < 1000 ? row : ms < 1400 ? { x: row.x + (goal.x - row.x) * (ms - 1000) / 400, y: row.y + (goal.y - row.y) * (ms - 1000) / 400 } : goal;
    const chosen = drive(row, path);
    expect(chosen?.result).toEqual(goal);
    expect(chosen!.ms).toBeGreaterThanOrEqual(1400 + POINT_REST_MS);
    expect(chosen!.ms).toBeLessThan(1400 + POINT_REST_MS + 32);
  });

  it('ignores pauses outside the scene and gives up when the cursor never rests inside it', () => {
    const path = (ms: number) => ms < 500 ? { x: 900, y: 650 } : { x: 100 + (Math.floor(ms / 16) % 2) * 50, y: 100 };
    expect(drive(row, path)?.result).toBe('expired');
  });

  it('takes any rest when the click point was unknown', () => {
    expect(drive(null, () => ({ x: 50, y: 60 }))).toEqual({ result: { x: 50, y: 60 }, ms: 304 });
  });
});
