import { afterEach, describe, expect, it, vi } from 'vitest';
import { HELD_PET_MAX } from '../src/core/engine';
import { PURR_FADE_IN_S, PURR_FADE_OUT_S, PURR_LOOP_LEVEL, PURR_LOOP_MAX_S, PURR_RELEASE_S, PURR_VOLUME_S, PetSound } from '../src/rendering/sound';

/** Records automation calls as [kind, ...arguments]. */
class FakeParam {
  events: (string | number)[][] = [];
  constructor(public value = 0) {}
  setValueAtTime(value: number, time: number) { this.events.push(['set', value, time]); return this; }
  setTargetAtTime(target: number, time: number, constant: number) { this.events.push(['target', target, time, constant]); return this; }
  linearRampToValueAtTime(value: number, time: number) { this.events.push(['ramp', value, time]); return this; }
  cancelAndHoldAtTime(time: number) { this.events.push(['hold', time]); return this; }
  cancelScheduledValues(time: number) { this.events.push(['cancel', time]); return this; }
}
class FakeNode {
  outputs: unknown[] = [];
  disconnected = false;
  connect(target: unknown) { this.outputs.push(target); return target; }
  disconnect() { this.disconnected = true; }
}
class FakeOscillator extends FakeNode {
  type = 'sine';
  frequency = new FakeParam(440);
  startAt: number | null = null;
  stopAt: number | null = null;
  onended: (() => void) | null = null;
  start(time = 0) { this.startAt = time; }
  stop(time = 0) { this.stopAt = time; }
}
class FakeGain extends FakeNode { gain = new FakeParam(1); }
class FakeFilter extends FakeNode { type = 'lowpass'; frequency = new FakeParam(350); }
class FakeContext {
  currentTime = 10;
  destination = new FakeNode();
  oscillators: FakeOscillator[] = [];
  gains: FakeGain[] = [];
  filters: FakeFilter[] = [];
  resumes = 0;
  suspends = 0;
  createOscillator() { const node = new FakeOscillator(); this.oscillators.push(node); return node; }
  createGain() { const node = new FakeGain(); this.gains.push(node); return node; }
  createBiquadFilter() { const node = new FakeFilter(); this.filters.push(node); return node; }
  async resume() { this.resumes++; }
  async suspend() { this.suspends++; }
  /** Moves audio time on and ends every oscillator whose stop time has passed. */
  advance(seconds: number) {
    this.currentTime += seconds;
    for (const node of this.oscillators) {
      if (node.stopAt === null || node.stopAt > this.currentTime || !node.onended) continue;
      const ended = node.onended;
      node.onended = null;
      ended();
    }
  }
  /** The gains connected to the speakers, oldest first: one per voice. */
  outputs() { return this.gains.filter(gain => gain.outputs.includes(this.destination)); }
}
const setup = () => {
  const context = new FakeContext();
  return { context, sound: new PetSound(() => context as unknown as AudioContext) };
};

afterEach(() => { vi.useRealTimers(); });

describe('looping purr (hold-to-pet)', () => {
  it('fades in to its level and is capped at the longest held pet', () => {
    const { context, sound } = setup();
    expect(PURR_LOOP_MAX_S).toBe(HELD_PET_MAX);
    sound.startPurrLoop(0.5);
    expect(sound.purring).toBe(true);
    expect(context.resumes).toBe(1);
    const [output] = context.outputs();
    expect(output.gain.events).toEqual([['set', 0, 10], ['target', PURR_LOOP_LEVEL * 0.5, 10, PURR_FADE_IN_S], ['target', 0, 10 + HELD_PET_MAX, PURR_FADE_OUT_S]]);
    expect(context.oscillators).toHaveLength(3);
    for (const node of context.oscillators) {
      expect(node.startAt).toBe(10);
      expect(node.stopAt).toBe(10 + HELD_PET_MAX + PURR_RELEASE_S);
    }
    context.advance(HELD_PET_MAX - 0.01);
    expect(sound.purring).toBe(true);
    context.advance(0.02);
    expect(sound.purring).toBe(false);
  });

  it('a second start while purring only applies the volume', () => {
    const { context, sound } = setup();
    sound.startPurrLoop(0.5);
    context.advance(1);
    sound.startPurrLoop(1);
    expect(context.oscillators).toHaveLength(3);
    expect(context.outputs()[0].gain.events.at(-1)).toEqual(['target', PURR_LOOP_LEVEL, 11, PURR_VOLUME_S]);
  });

  it('applies a volume change live, clamped, and only while the loop plays', () => {
    const { context, sound } = setup();
    expect(() => sound.setPurrVolume(0.7)).not.toThrow();
    sound.startPurrLoop(0.2);
    const [output] = context.outputs();
    context.advance(2);
    sound.setPurrVolume(5);
    expect(output.gain.events.at(-1)).toEqual(['target', PURR_LOOP_LEVEL, 12, PURR_VOLUME_S]);
    sound.setPurrVolume(Number.NaN);
    expect(output.gain.events.at(-1)).toEqual(['target', 0, 12, PURR_VOLUME_S]);
    const events = output.gain.events.length;
    // Past the cap but before the oscillators stop: the capped fade-out must not be undone.
    context.advance(HELD_PET_MAX - 2 + 0.1);
    expect(context.oscillators[0].onended).not.toBeNull();
    sound.setPurrVolume(1);
    expect(output.gain.events).toHaveLength(events);
    context.advance(PURR_RELEASE_S);
    sound.setPurrVolume(1);
    sound.stopPurrLoop();
    sound.setPurrVolume(1);
    expect(output.gain.events).toHaveLength(events);
  });

  it('stops with a quick fade, then releases every node', () => {
    const { context, sound } = setup();
    sound.startPurrLoop(1);
    context.advance(2);
    sound.stopPurrLoop();
    expect(sound.purring).toBe(false);
    const [output] = context.outputs();
    expect(output.gain.events.slice(-2)).toEqual([['hold', 12], ['target', 0, 12, PURR_FADE_OUT_S]]);
    for (const node of context.oscillators) expect(node.stopAt).toBe(12 + PURR_RELEASE_S);
    context.advance(PURR_RELEASE_S);
    expect([...context.oscillators, ...context.gains, ...context.filters].every(node => node.disconnected)).toBe(true);
    // The next held pet gets a fresh loop.
    sound.startPurrLoop(1);
    expect(sound.purring).toBe(true);
    expect(context.oscillators).toHaveLength(6);
  });

  it('stop() silences every voice, then suspends the device; a new purr in between keeps it awake', () => {
    vi.useFakeTimers();
    const { context, sound } = setup();
    sound.startPurrLoop(1);
    sound.stop();
    expect(sound.purring).toBe(false);
    expect(context.outputs()[0].gain.events.slice(-2)).toEqual([['hold', 10], ['target', 0, 10, PURR_FADE_OUT_S]]);
    vi.advanceTimersByTime(PURR_RELEASE_S * 1000 - 1);
    expect(context.suspends).toBe(0);
    vi.advanceTimersByTime(1);
    expect(context.suspends).toBe(1);
    sound.startPurrLoop(1);
    sound.stop();
    sound.startPurrLoop(1);
    vi.advanceTimersByTime(5000);
    expect(context.suspends).toBe(1);
    expect(sound.purring).toBe(true);
  });

  it('never throws when audio is unavailable', async () => {
    const sound = new PetSound(() => { throw new Error('No audio device'); });
    expect(() => sound.startPurrLoop(1)).not.toThrow();
    expect(sound.purring).toBe(false);
    expect(() => sound.setPurrVolume(1)).not.toThrow();
    expect(() => sound.stopPurrLoop()).not.toThrow();
    expect(() => sound.stop()).not.toThrow();
    await expect(sound.purr(1)).resolves.toBeUndefined();
  });
});

describe('one-shot purr (click)', () => {
  it('plays at most once every 1.5 s, and stop() fades it and its modulation out', async () => {
    const { context, sound } = setup();
    await sound.purr(1);
    await sound.purr(1);
    expect(context.oscillators).toHaveLength(2);
    expect(sound.purring).toBe(false);
    sound.stop();
    const [output] = context.outputs();
    expect(output.gain.events.slice(-2)).toEqual([['hold', 10], ['target', 0, 10, PURR_FADE_OUT_S]]);
    const modulation = context.gains.find(gain => gain.outputs.includes(output.gain))!;
    expect(modulation.gain.events.slice(-2)).toEqual([['hold', 10], ['target', 0, 10, PURR_FADE_OUT_S]]);
    for (const node of context.oscillators) expect(node.stopAt).toBe(10 + PURR_RELEASE_S);
  });
});
