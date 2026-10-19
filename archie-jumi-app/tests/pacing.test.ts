import { describe, expect, it } from 'vitest';
import { ACTIVE_INTERVAL_MS, AMBIENT_INTERVAL_MS, FAST_INTERVAL_MS, FramePacer, layerChange } from '../src/rendering/pacing';

/** Runs a pacer over `seconds` of 60 Hz rAF frames; `fast(now)` says whether the render at `now` reports a tween. */
function rendersPerSecond(fast: (now: number) => boolean, refreshHz = 60, seconds = 3): number {
  const pacer = new FramePacer();
  let renders = 0;
  for (let now = 0; now < seconds * 1000; now += 1000 / refreshHz) {
    if (!pacer.due(now)) continue;
    renders++;
    pacer.rendered(now, fast(now));
  }
  return renders / seconds;
}

describe('frame pacing', () => {
  it('renders at most 30 Hz without tweens', () => {
    expect(ACTIVE_INTERVAL_MS).toBeCloseTo(1000 / 30, 9);
    expect(rendersPerSecond(() => false)).toBeCloseTo(30, 0);
    expect(rendersPerSecond(() => false, 144)).toBeLessThanOrEqual(30.5);
  });

  it('renders every frame while a tween or renderer-clock effect runs, capped at 60 Hz', () => {
    expect(FAST_INTERVAL_MS).toBeCloseTo(1000 / 60, 9);
    expect(rendersPerSecond(() => true)).toBeCloseTo(60, 0);
    expect(rendersPerSecond(() => true, 144)).toBeLessThanOrEqual(61);
    expect(rendersPerSecond(() => true, 144)).toBeGreaterThanOrEqual(47);
    // A 140 ms turn every second adds only the frames inside it.
    const withTurns = rendersPerSecond(now => now % 1000 < 140);
    expect(withTurns).toBeGreaterThan(30);
    expect(withTurns).toBeLessThan(36);
  });

  it('lets ambient-only changes draw at most 6 Hz (the spec allows up to 12 Hz)', () => {
    expect(AMBIENT_INTERVAL_MS).toBeCloseTo(1000 / 6, 9);
    for (const refreshHz of [60, 144]) {
      const pacer = new FramePacer();
      let drawn = 0;
      for (let now = 0; now < 6000; now += 1000 / refreshHz) {
        if (!pacer.due(now)) continue;
        if (pacer.ambientDue(now)) { drawn++; pacer.ambientDrawn(now); }
        pacer.rendered(now, false);
      }
      expect(drawn / 6).toBeLessThanOrEqual(6.01);
      expect(drawn / 6).toBeGreaterThanOrEqual(5.5);
    }
  });

  it('renders right away after a reset', () => {
    const pacer = new FramePacer();
    pacer.rendered(1000, false);
    pacer.ambientDrawn(1000);
    expect(pacer.due(1010)).toBe(false);
    expect(pacer.ambientDue(1010)).toBe(false);
    pacer.reset();
    expect(pacer.due(1010)).toBe(true);
    expect(pacer.ambientDue(1010)).toBe(true);
  });

  it('classifies layer changes: anything drawn first or active is active, scale-only breathing is ambient', () => {
    expect(layerChange(null, { active: 'a', ambient: 'b' })).toBe('active');
    expect(layerChange({ active: 'a', ambient: 'b' }, { active: 'a', ambient: 'b' })).toBe('none');
    expect(layerChange({ active: 'a', ambient: 'b' }, { active: 'a', ambient: 'c' })).toBe('ambient');
    expect(layerChange({ active: 'a', ambient: 'b' }, { active: 'x', ambient: 'c' })).toBe('active');
  });
});
