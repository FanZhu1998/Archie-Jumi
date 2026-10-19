import { describe, expect, it } from 'vitest';
import { BALL_RADIUS, RELEASE_BOUNCE_DIP, RELEASE_BOUNCE_S, THREAD_MAX_TRAIL, THREAD_REST, ToyVisual, releaseBounce } from '../src/rendering/toy-visual';
import type { ToyState } from '../src/shared/types';

const toy = (patch: Partial<ToyState> = {}): ToyState => ({ x: 500, y: 300, petId: 'jumi', remaining: 20, automatic: true, held: false, ...patch });
const restThread = (x: number, y: number) => THREAD_REST.map(point => ({ x: x + point.x, y: y + point.y }));

describe('yarn toy visual', () => {
  it('draws the 1.0.2 toy under reduced motion or Quiet Mode, whatever the toy does', () => {
    const visual = new ToyVisual();
    for (let i = 0; i < 20; i++) {
      const view = visual.observe(toy({ x: 500 + i * 7, held: i % 2 === 0 }), i / 30, true)!;
      expect(view).toEqual({ x: 500 + i * 7, y: 300, angle: 0, thread: restThread(500 + i * 7, 300), bouncing: false });
    }
  });

  it('rolls by the travelled distance over the radius, clockwise to the right and back to the left', () => {
    const visual = new ToyVisual();
    expect(visual.observe(toy({ x: 500 }), 0, false)!.angle).toBe(0);
    expect(visual.observe(toy({ x: 510 }), 1 / 30, false)!.angle).toBeCloseTo(10 / BALL_RADIUS, 9);
    expect(visual.observe(toy({ x: 513, y: 304 }), 2 / 30, false)!.angle).toBeCloseTo(15 / BALL_RADIUS, 9);
    expect(visual.observe(toy({ x: 503, y: 304 }), 3 / 30, false)!.angle).toBeCloseTo(5 / BALL_RADIUS, 9);
    // A purely vertical move keeps rolling the way it last rolled.
    expect(visual.observe(toy({ x: 503, y: 314 }), 4 / 30, false)!.angle).toBeCloseTo(-5 / BALL_RADIUS, 9);
  });

  it('trails the thread along recent positions while moving, within its limit, and relaxes once the ball rests', () => {
    const visual = new ToyVisual();
    let view = visual.observe(toy({ x: 500 }), 0, false)!;
    expect(view.thread).toEqual(restThread(500, 300));
    let time = 0, x = 500;
    for (let i = 0; i < 12; i++) { time += 1 / 30; x += 110 / 30; view = visual.observe(toy({ x }), time, false)!; }
    // Moving right, every trailing point lags to the left of its rest position; the start stays on the ball.
    const rest = restThread(x, 300);
    expect(view.thread[0]).toEqual(rest[0]);
    for (let i = 1; i < rest.length; i++) {
      expect(view.thread[i].x).toBeLessThan(rest[i].x - 1);
      expect(Math.hypot(view.thread[i].x - rest[i].x, view.thread[i].y - rest[i].y)).toBeLessThanOrEqual(THREAD_MAX_TRAIL + 1e-9);
    }
    expect(rest[3].x - view.thread[3].x).toBeGreaterThan(rest[2].x - view.thread[2].x);
    for (let i = 0; i < 12; i++) { time += 1 / 30; view = visual.observe(toy({ x }), time, false)!; }
    expect(view.thread).toEqual(rest);
    // A fast roll (a batted toy) is limited.
    for (let i = 0; i < 12; i++) { time += 1 / 30; x += 300 / 30; view = visual.observe(toy({ x }), time, false)!; }
    const fast = restThread(x, 300);
    for (let i = 1; i < fast.length; i++) expect(Math.hypot(view.thread[i].x - fast[i].x, view.thread[i].y - fast[i].y)).toBeLessThanOrEqual(THREAD_MAX_TRAIL + 1e-9);
  });

  it('bounces briefly when the user releases a held ball, and never on its own', () => {
    expect(releaseBounce(0)).toBe(0);
    expect(releaseBounce(RELEASE_BOUNCE_S / 4)).toBeCloseTo(RELEASE_BOUNCE_DIP * 0.75, 9);
    expect(releaseBounce(RELEASE_BOUNCE_S)).toBe(0);
    expect(releaseBounce(-1)).toBe(0);
    for (let t = 0; t < RELEASE_BOUNCE_S; t += 0.01) expect(releaseBounce(t)).toBeLessThanOrEqual(RELEASE_BOUNCE_DIP);

    const visual = new ToyVisual();
    expect(visual.observe(toy(), 0, false)!.bouncing).toBe(false);
    expect(visual.observe(toy({ held: true }), 0.1, false)!.bouncing).toBe(false);
    const released = visual.observe(toy({ held: false }), 0.2, false)!;
    expect(released.bouncing).toBe(true);
    expect(released.y).toBe(300);
    const hop = visual.observe(toy({ held: false }), 0.2 + RELEASE_BOUNCE_S / 4, false)!;
    expect(hop.y).toBeCloseTo(300 - RELEASE_BOUNCE_DIP * 0.75, 9);
    // The thread hangs from the ball: its start hops with it, its far end stays down.
    expect(hop.thread[0].y).toBeCloseTo(300 + THREAD_REST[0].y - RELEASE_BOUNCE_DIP * 0.75, 9);
    expect(hop.thread[3].y).toBeCloseTo(300 + THREAD_REST[3].y, 9);
    expect(visual.observe(toy({ held: false }), 0.2 + RELEASE_BOUNCE_S, false)!.bouncing).toBe(false);
  });

  it('starts every new toy still', () => {
    const visual = new ToyVisual();
    visual.observe(toy({ x: 100, held: true }), 0, false);
    visual.observe(toy({ x: 160, held: true }), 0.1, false);
    expect(visual.observe(null, 0.2, false)).toBeNull();
    const fresh = visual.observe(toy({ x: 600 }), 0.3, false)!;
    expect(fresh).toEqual({ x: 600, y: 300, angle: 0, thread: restThread(600, 300), bouncing: false });
    expect(visual.observe(toy({ x: NaN }), 0.4, false)).toBeNull();
  });
});
