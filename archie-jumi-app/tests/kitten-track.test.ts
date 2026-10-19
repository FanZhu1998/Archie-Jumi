import { describe, expect, it } from 'vitest';
import { CROSSFADE_MS, LAND_SQUASH_MS } from '../src/core/motion';
import { BREATH_PHASES, DRAG_SMOOTHING_S, FIRST_PAGE_WAIT_S, KittenTrack, PairTrack, SWING_SETTLE_S, type Drawable, type TrackInput } from '../src/rendering/kitten-track';
import type { Action, AtlasFrame, Facing, PairState, PetState } from '../src/shared/types';

interface Page { name: string; closed: boolean }
const page = (name: string): Page => ({ name, closed: false });
const frame = (x: number): AtlasFrame => ({ x, y: 0, w: 512, h: 512, duration: 100 });
const petState = (patch: Partial<PetState> = {}): PetState => ({
  id: 'archie', x: 400, y: 300, action: 'idle', actionTime: 0, facing: 'right', forcedSleep: false, visible: true,
  size: 128, target: null, speed: 0, leap: null, held: false, ...patch,
});

/** A small scene: pages load when `loaded` says so; `observe` feeds one frame at renderer time `time`. */
function harness(id: 'archie' | 'jumi' = 'archie') {
  const track = new KittenTrack<Page>(id);
  const pages = new Map<Action, Page>();
  const idle = page('idle');
  const loaded = new Set<Action>(['idle']);
  const drawable = (action: Action): Drawable<Page> | null => {
    if (action === 'idle') return { page: idle, clip: 'idle' };
    if (!loaded.has(action)) return null;
    if (!pages.has(action)) pages.set(action, page(action));
    const value = pages.get(action)!;
    return value.closed ? null : { page: value, clip: action };
  };
  const observe = (pet: PetState, time: number, extra: Partial<TrackInput<Page>> = {}) => {
    track.observe({ pet, time, calm: false, pair: null, ready: drawable(pet.action), fallback: drawable('idle'), isOpen: value => !value.closed, ...extra });
    // The renderer then draws the shown clip's frame.
    if (track.page) track.drawn = { page: track.page, frame: frame(track.clip!.length), facing: pet.facing };
  };
  const fade = (time: number, drawFacing: Facing = 'right', calm = false) => track.fade({ time, drawFacing, calm, isOpen: value => !value.closed });
  return { track, loaded, pages, observe, fade };
}

describe('kitten track: facing and turn tweens', () => {
  it('records a facing change with the previous facing on the renderer clock, never on the first sight', () => {
    const { track, observe } = harness();
    observe(petState({ facing: 'right' }), 10);
    expect(track.facingChange).toBeNull();
    observe(petState({ facing: 'left' }), 10.5);
    expect(track.facingChange).toEqual({ from: 'right', at: 10.5 });
    observe(petState({ facing: 'left' }), 10.6);
    expect(track.facingChange).toEqual({ from: 'right', at: 10.5 });
  });

  it('starts no turn under reduced motion or Quiet Mode', () => {
    const { track, observe } = harness();
    observe(petState({ facing: 'right' }), 1, { calm: true });
    observe(petState({ facing: 'left' }), 2, { calm: true });
    expect(track.facingChange).toBeNull();
  });
});

describe('kitten track: shown clip and action changes', () => {
  it('keeps showing the previous clip while the next page loads, then changes with a crossfade source', () => {
    const { track, loaded, observe } = harness();
    loaded.add('sit');
    observe(petState({ action: 'sit' }), 1);
    expect(track.clip).toBe('sit');
    const sitFrame = track.drawn;
    observe(petState({ action: 'walk', speed: 55 }), 2);
    expect(track.clip).toBe('sit');
    expect(track.change).toEqual({ from: 'sit', at: 1 });
    loaded.add('walk');
    observe(petState({ action: 'walk', speed: 55, actionTime: 0.1 }), 2.1);
    expect(track.clip).toBe('walk');
    expect(track.change).toEqual({ from: 'sit', at: 2.1 });
    expect(track.outgoing).toEqual(sitFrame);
    expect(track.page?.name).toBe('walk');
  });

  it('falls back to the idle clip only when the shown page was closed meanwhile, and cuts out of it', () => {
    const { track, loaded, pages, observe, fade } = harness();
    loaded.add('sit');
    observe(petState({ action: 'sit' }), 1);
    pages.get('sit')!.closed = true;
    observe(petState({ action: 'groom' }), 2);
    expect(track.clip).toBe('idle');
    expect(track.change).toEqual({ from: 'sit', at: 2 });
    expect(fade(2.01)).toBeNull();   // the outgoing sit page is closed
    observe(petState({ action: 'groom' }), 2.05);
    expect(track.clip).toBe('idle');
    // The idle stopgap was never the kitten's real pose: the real clip replaces it with a cut.
    loaded.add('groom');
    observe(petState({ action: 'groom', actionTime: 0.1 }), 2.1);
    expect(track.clip).toBe('groom');
    expect(track.outgoing).toBeNull();
    expect(track.change).toEqual({ from: 'groom', at: 2.1 });
  });

  it('opens on the action\'s own page: a kitten first seen waits briefly for it, and never crossfades out of the stopgap', () => {
    // A recreated overlay restoring a nap: only the idle page is decoded yet.
    const { track, loaded, observe, fade } = harness();
    observe(petState({ action: 'sleep' }), 1);
    expect(track.clip).toBeNull();   // nothing drawn yet
    observe(petState({ action: 'sleep' }), 1 + FIRST_PAGE_WAIT_S / 2);
    expect(track.clip).toBeNull();
    loaded.add('sleep');
    observe(petState({ action: 'sleep' }), 1 + FIRST_PAGE_WAIT_S * 0.75);
    expect(track.clip).toBe('sleep');
    expect(track.outgoing).toBeNull();
    expect(track.change?.from).toBe('sleep');
    // A slow page: after the wait the idle stopgap shows, and the real clip later cuts in.
    const slow = harness();
    slow.observe(petState({ action: 'sit' }), 5);
    expect(slow.track.clip).toBeNull();
    slow.observe(petState({ action: 'sit' }), 5 + FIRST_PAGE_WAIT_S);
    expect(slow.track.clip).toBe('idle');
    slow.observe(petState({ action: 'sit' }), 5.4);
    slow.loaded.add('sit');
    slow.observe(petState({ action: 'sit' }), 5.5);
    expect(slow.track.clip).toBe('sit');
    expect(slow.track.outgoing).toBeNull();
    expect(slow.fade(5.52)).toBeNull();   // idle → sit would crossfade, but not out of the stopgap
    // A kitten whose page failed draws the idle clip at once (it is what draws that action).
    const failed = harness();
    failed.observe(petState({ action: 'eat' }), 9, { ready: { page: page('idle'), clip: 'idle' } });
    expect(failed.track.clip).toBe('idle');
    expect(failed.fade(9)).toBeNull();
  });

  it('crossfades only between seated stills, for 120 ms, never when calm or across a turn', () => {
    const { loaded, observe, fade } = harness();
    loaded.add('sit'); loaded.add('pet'); loaded.add('pounce');
    observe(petState({ action: 'sit' }), 1);
    observe(petState({ action: 'pet' }), 2);
    const first = fade(2)!;
    expect(first.t).toBe(0);
    expect(first.outgoing.page.name).toBe('sit');
    expect(fade(2 + CROSSFADE_MS / 2000)!.t).toBeCloseTo(0.5, 9);
    expect(fade(2 + CROSSFADE_MS / 1000)).toBeNull();
    expect(fade(2.01)).toBeNull();   // once over, the outgoing frame is gone
    // A change into a different still cuts.
    observe(petState({ action: 'pounce' }), 3);
    expect(fade(3)).toBeNull();
    // Calm (reduced motion or Quiet Mode) never crossfades.
    observe(petState({ action: 'sit' }), 4);
    observe(petState({ action: 'pet' }), 5);
    expect(fade(5.01, 'right', true)).toBeNull();
    // A turn: once the drawn facing differs from the outgoing frame's, the fade ends for good.
    observe(petState({ action: 'sit' }), 6);
    observe(petState({ action: 'pet' }), 7);
    expect(fade(7.01, 'right')).not.toBeNull();
    expect(fade(7.02, 'left')).toBeNull();
    expect(fade(7.03, 'right')).toBeNull();
  });

  it('counts the engine action from its first frame, across same-action restarts', () => {
    const { track, loaded, observe } = harness();
    loaded.add('sleep');
    observe(petState({ action: 'sleep', actionTime: 3 }), 7);
    expect(track.actionSince).toBe(7);
    observe(petState({ action: 'sleep', actionTime: 0.1 }), 8);
    expect(track.actionSince).toBe(7);
    observe(petState({ action: 'wake' }), 9);
    expect(track.actionSince).toBe(9);
  });

  it('marks landings, including a new landing that restarts the land clip', () => {
    const { track, loaded, observe } = harness();
    loaded.add('carried'); loaded.add('land');
    observe(petState({ action: 'carried' }), 1);
    expect(track.landedAt).toBeNull();
    observe(petState({ action: 'land', actionTime: 0.03 }), 2);
    expect(track.landedAt).toBe(2);
    observe(petState({ action: 'land', actionTime: 0.3 }), 2.3);
    expect(track.landedAt).toBe(2);
    observe(petState({ action: 'land', actionTime: 0.02 }), 2.4);
    expect(track.landedAt).toBe(2.4);
    expect(track.change).toEqual({ from: 'land', at: 2.4 });
    expect(track.outgoing).toBeNull();
  });

  it('forgets everything on reset, so a kitten shown again starts without tweens', () => {
    const { track, loaded, observe } = harness();
    loaded.add('land');
    observe(petState({ action: 'land', facing: 'left' }), 1);
    track.reset();
    expect([track.clip, track.page, track.change, track.outgoing, track.drawn, track.facing, track.landedAt, track.actionSince]).toEqual([null, null, null, null, null, null, null, null]);
    observe(petState({ action: 'idle', facing: 'right' }), 2);
    expect(track.facingChange).toBeNull();
  });
});

describe('kitten track: breathing phase', () => {
  const nap: PairState = { kind: 'nap', phase: 'together', elapsed: 0 };
  it('breathes in step only in a shared nap, latched when the clip changes', () => {
    for (const id of ['archie', 'jumi'] as const) {
      const { track, loaded, observe } = harness(id);
      loaded.add('walk'); loaded.add('sleep');
      expect(track.breathPhase).toBe(BREATH_PHASES[id]);
      observe(petState({ id, action: 'walk' }), 1, { pair: { kind: 'nap', phase: 'approach', elapsed: 1 } });
      expect(track.breathPhase).toBe(BREATH_PHASES[id]);
      observe(petState({ id, action: 'sleep' }), 2, { pair: nap });
      expect(track.breathPhase).toBe(0);
      // The pair ends with both still asleep: no clip change, so the phase does not jump.
      observe(petState({ id, action: 'sleep', actionTime: 0 }), 8, { pair: null });
      expect(track.breathPhase).toBe(0);
      observe(petState({ id, action: 'idle' }), 30, { pair: null });
      expect(track.breathPhase).toBe(BREATH_PHASES[id]);
    }
    expect(BREATH_PHASES.archie).not.toBe(BREATH_PHASES.jumi);
  });
});

describe('kitten track: carried swing velocity', () => {
  it('smooths the drag velocity exponentially and decays it to exactly 0 when still', () => {
    const { track, loaded, observe } = harness();
    loaded.add('carried');
    observe(petState({ action: 'carried', x: 100 }), 1);
    expect(track.velocityX).toBe(0);
    observe(petState({ action: 'carried', x: 110 }), 1 + 1 / 30);
    const first = track.velocityX;
    expect(first).toBeCloseTo(300 * (1 - Math.exp(-1 / 30 / DRAG_SMOOTHING_S)), 6);
    let time = 1 + 1 / 30, x = 110;
    for (let i = 0; i < 30; i++) { time += 1 / 60; x += 5; observe(petState({ action: 'carried', x }), time); }
    expect(track.velocityX).toBeGreaterThan(250);
    expect(track.velocityX).toBeLessThanOrEqual(300.0001);
    for (let i = 0; i < 120; i++) { time += 1 / 60; observe(petState({ action: 'carried', x }), time); }
    expect(track.velocityX).toBe(0);
    for (let i = 0; i < 10; i++) { time += 1 / 60; x -= 8; observe(petState({ action: 'carried', x }), time); }
    expect(track.velocityX).toBeLessThan(0);
    // Released: the swing does not snap upright but eases from the last carried value to exactly 0.
    const carried = track.velocityX, released = time + 1 / 60;
    expect(SWING_SETTLE_S).toBeCloseTo(LAND_SQUASH_MS / 1000, 12);
    observe(petState({ action: 'land', x }), released);
    expect(track.velocityX).toBe(carried);
    let previous = carried;
    for (let at = released + 0.01; at < released + SWING_SETTLE_S - 1e-6; at += 0.01) {
      observe(petState({ action: 'land', x, actionTime: at - released }), at);
      expect(Math.abs(track.velocityX)).toBeLessThan(Math.abs(previous));
      expect(Math.abs(previous - track.velocityX)).toBeLessThan(Math.abs(carried) * 0.1);   // no step
      expect(Math.sign(track.velocityX)).toBe(-1);
      previous = track.velocityX;
    }
    observe(petState({ action: 'land', x, actionTime: SWING_SETTLE_S }), released + SWING_SETTLE_S);
    expect(track.velocityX).toBe(0);
    observe(petState({ action: 'sit', x }), released + 1);
    expect(track.velocityX).toBe(0);
    // A release straight into anything but a landing (or with no swing) does not settle.
    const other = harness();
    other.loaded.add('carried');
    other.observe(petState({ action: 'carried', x: 0 }), 1);
    other.observe(petState({ action: 'carried', x: 20 }), 1.05);
    other.observe(petState({ action: 'sit', x: 20 }), 1.1);
    expect(other.track.velocityX).toBe(0);
  });

  it('ignores repeated timestamps and clamps jumps', () => {
    const { track, loaded, observe } = harness();
    loaded.add('carried');
    observe(petState({ action: 'carried', x: 0 }), 1);
    observe(petState({ action: 'carried', x: 500 }), 1);
    expect(track.velocityX).toBe(0);
    observe(petState({ action: 'carried', x: 5000 }), 1.001);
    expect(Math.abs(track.velocityX)).toBeLessThanOrEqual(4000);
  });
});

describe('pair track', () => {
  it('reports the nose contact once, when a nose touch enters its together phase', () => {
    const pair = new PairTrack();
    expect(pair.observe({ kind: 'nose_touch', phase: 'approach', elapsed: 1 }, 1)).toBe(false);
    expect(pair.observe({ kind: 'nose_touch', phase: 'together', elapsed: 0 }, 2)).toBe(true);
    expect(pair.contactAt).toBe(2);
    expect(pair.observe({ kind: 'nose_touch', phase: 'together', elapsed: 0.5 }, 2.5)).toBe(false);
    expect(pair.observe(null, 4)).toBe(false);
    expect(pair.observe({ kind: 'nap', phase: 'together', elapsed: 0 }, 5)).toBe(false);
    expect(pair.contactAt).toBe(2);
    expect(pair.observe({ kind: 'nose_touch', phase: 'together', elapsed: 0 }, 9)).toBe(true);
    expect(pair.contactAt).toBe(9);
  });
});
