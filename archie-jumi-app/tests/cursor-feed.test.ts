import { describe, expect, it } from 'vitest';
import { CursorFeed, FEED_INTERVAL_MS, OUTSIDE, decideCursorFeed, type CursorMessage, type FeedState, type Rect } from '../src/main/cursor-feed';
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
  let samples = 0;
  const feed = new CursorFeed({
    source: () => cursor,
    origin: () => origin,
    send: message => sent.push(message),
    now: () => now,
    onSample: () => { samples++; },
    setInterval: (fn, ms) => { callback = fn; intervals.push(ms); return 'handle'; },
    clearInterval: () => { callback = null; },
  });
  return {
    feed, sent, intervals,
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

  it('asks for a fresh sample only for a hover report the latest sample places outside', () => {
    expect(needsFreshSample({ target: 'archie', capture: false }, true, false)).toBe(true);
    expect(needsFreshSample({ target: 'toy', capture: false }, true, false)).toBe(true);
    expect(needsFreshSample({ target: 'archie', capture: false }, true, true)).toBe(false);
    expect(needsFreshSample({ target: 'archie', capture: true }, true, false)).toBe(false);
    expect(needsFreshSample({ target: null, capture: false }, true, false)).toBe(false);
    expect(needsFreshSample({ target: 'jumi', capture: false }, false, false)).toBe(false);
  });
});
