import { describe, expect, it } from 'vitest';
import { PAIR_SPEED, QUIET_SPEED, speedFor } from '../src/core/engine';
import {
  BREATH_PERIOD_S, CARRY_LIFT, CARRY_PIVOT, CROSSFADE_ACTIONS, CROSSFADE_MS, EAT_NOD_DEG, LAND_SQUASH_MS, MIN_HIT_SCALE, STEP_LENGTH, STEP_PERIOD_LIMITS_MS, TURN_MS,
  clipSeconds, crossfade, crossfades, framePoint, frameUV, identityPose, isAmbientOnly, placementBounds, poseFor, poseKey, restPlacement, squeezed, stepPeriodMs,
  type Placement, type Pose, type PoseInput,
} from '../src/core/motion';
import { ACTIONS, type Facing, type PetState } from '../src/shared/types';

const degrees = (radians: number) => radians * 180 / Math.PI;
const radians = (value: number) => value * Math.PI / 180;
const petState = (patch: Partial<PetState> = {}): PetState => ({
  id: 'archie', x: 400, y: 300, action: 'idle', actionTime: 0, facing: 'right', forcedSleep: false, visible: true,
  size: 128, target: null, speed: 0, leap: null, held: false, ...patch,
});
const pose = (pet: Partial<PetState> = {}, patch: Partial<Omit<PoseInput, 'pet'>> = {}): Pose => poseFor({
  pet: petState(pet), time: 100, reducedMotion: false, velocityX: 0, facingChange: null, actionChange: null, breathPhase: 0, ...patch,
});
function seeded(seed: number): () => number {
  let value = seed;
  return () => { value = (Math.imul(value, 1664525) + 1013904223) | 0; return (value >>> 0) / 4294967296; };
}

/** A 2D context transform with canvas semantics: translate/rotate/scale each post-multiply the current matrix. */
class CanvasTransform {
  a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
  translate(x: number, y: number) { this.e += this.a * x + this.c * y; this.f += this.b * x + this.d * y; }
  rotate(angle: number) {
    const cos = Math.cos(angle), sin = Math.sin(angle), { a, b, c, d } = this;
    this.a = a * cos + c * sin; this.b = b * cos + d * sin; this.c = c * cos - a * sin; this.d = d * cos - b * sin;
  }
  scale(x: number, y: number) { this.a *= x; this.b *= x; this.c *= y; this.d *= y; }
  apply(x: number, y: number) { return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f }; }
}
/** Where the renderer's documented draw call puts sprite-local point (lx, ly) (measured from the ground anchor). */
function drawnLocal(lx: number, ly: number, anchorX: number, anchorY: number, value: Pose) {
  const context = new CanvasTransform();
  context.translate(anchorX + value.dx, anchorY + value.dy);
  context.rotate(value.rotation);
  context.scale(value.scaleX, value.scaleY);
  return context.apply(lx, ly);
}
/** Where drawImage(…, offsetX, offsetY, width, height) under that transform puts frame point (u, v). */
const drawnFrame = (u: number, v: number, p: Placement) => drawnLocal(p.offsetX + u * p.width, p.offsetY + v * p.height, p.anchorX, p.anchorY, p.pose);
/** Today's overlay geometry for a 512 × 512 frame with its ground anchor at (256, 464). */
function spritePlacement(centerX: number, centerY: number, size: number, value: Pose): Placement {
  const scale = size / (512 * 0.85), width = 512 * scale, height = 512 * scale;
  return { anchorX: centerX - width / 2 + 256 * scale, anchorY: centerY - height / 2 + 464 * scale, offsetX: -256 * scale, offsetY: -464 * scale, width, height, pose: value };
}
function randomPlacement(random: () => number): Placement {
  const between = (min: number, max: number) => min + random() * (max - min);
  const width = between(40, 300), height = between(40, 300);
  const signX = random() < 0.3 ? -1 : 1, signY = random() < 0.15 ? -1 : 1;
  return {
    anchorX: between(-200, 3000), anchorY: between(-200, 2000), offsetX: -between(0, 1) * width, offsetY: -between(0, 1) * height, width, height,
    pose: { ...identityPose('right'), dx: between(-30, 30), dy: between(-60, 10), rotation: between(-Math.PI, Math.PI),
      scaleX: signX * between(MIN_HIT_SCALE, 2), scaleY: signY * between(MIN_HIT_SCALE, 2) },
  };
}

describe('motion layer: reduced motion and tween flags', () => {
  it('returns the identity pose for every action under reduced motion, whatever else is going on', () => {
    for (const action of ACTIONS) for (const facing of ['left', 'right'] as Facing[]) for (const elapsed of [0, 0.07, 0.5, 3.3, 61.2]) {
      const leap = action === 'pounce' ? { fromX: 0, fromY: 0, toX: 50, toY: 0, progress: 0.5, height: 45 } : null;
      const result = pose(
        { action, facing, actionTime: elapsed, speed: 120, held: action === 'pet', leap },
        { reducedMotion: true, time: 100 + elapsed, velocityX: 900, facingChange: { from: facing === 'left' ? 'right' : 'left', at: 100 }, actionChange: { from: 'carried', at: 100 }, breathPhase: 1.3 },
      );
      expect(result).toEqual(identityPose(facing));
    }
  });

  it('leaves still poses alone and tweens only during turns, crossfades, squashes and leaps', () => {
    expect(pose({ action: 'nose_touch', actionTime: 0.4 })).toEqual(identityPose('right'));
    expect(pose({ action: 'pounce', actionTime: 0.1, facing: 'left' })).toEqual(identityPose('left'));   // the crouch
    for (const action of ['idle', 'sit', 'groom', 'sleep', 'pet', 'eat', 'wake', 'carried'] as const) {
      expect(pose({ action, actionTime: 0.3 }, { velocityX: 200 }).tweening).toBe(false);
    }
    expect(pose({ action: 'walk', actionTime: 0.3, speed: 60 }).tweening).toBe(false);
    expect(pose({ action: 'trot', actionTime: 0.3, speed: 120 }).drawFacing).toBe('right');
  });
});

describe('motion layer: turn, crossfade, landing and leap', () => {
  it('turns over 140 ms: scaleX |cos(πt)|, the old facing until the midpoint, then the new one', () => {
    expect(TURN_MS).toBe(140);
    const facingChange = { from: 'right' as const, at: 0 };
    const turning = (ms: number) => pose({ action: 'idle', facing: 'left' }, { time: ms / 1000, facingChange });
    expect(turning(0)).toMatchObject({ scaleX: 1, drawFacing: 'right', tweening: true });
    expect(turning(35).scaleX).toBeCloseTo(Math.SQRT1_2, 6);
    expect(turning(69)).toMatchObject({ drawFacing: 'right', tweening: true });
    expect(turning(69).scaleX).toBeLessThan(MIN_HIT_SCALE);
    expect(turning(71)).toMatchObject({ drawFacing: 'left', tweening: true });
    expect(turning(71).scaleX).toBeLessThan(MIN_HIT_SCALE);
    expect(turning(105).scaleX).toBeCloseTo(Math.SQRT1_2, 6);
    expect(turning(140)).toMatchObject({ scaleX: 1, drawFacing: 'left', tweening: false });
    expect(turning(900)).toMatchObject({ scaleX: 1, drawFacing: 'left', tweening: false });
    for (let ms = 0; ms < 140; ms++) expect(turning(ms).scaleX).toBeCloseTo(Math.abs(Math.cos(Math.PI * ms / 140)), 9);
    // A recorded change that already matches the facing (turned back) is not a turn.
    expect(pose({ facing: 'left' }, { time: 0.03, facingChange: { from: 'left', at: 0 } })).toMatchObject({ scaleX: 1, drawFacing: 'left', tweening: false });
  });

  it('fades facing-relative rotation through a turn so a walking lean flips sign without a jump', () => {
    const facingChange = { from: 'right' as const, at: 0 };
    const walking = (ms: number) => pose({ action: 'walk', facing: 'left', speed: 60, actionTime: 1 }, { time: ms / 1000, facingChange }).rotation;
    let previous = walking(0);
    expect(degrees(previous)).toBeCloseTo(2, 9);
    for (let ms = 1; ms <= 150; ms++) {
      const rotation = walking(ms);
      expect(Math.abs(rotation - previous)).toBeLessThan(0.002);
      previous = rotation;
    }
    expect(degrees(previous)).toBeCloseTo(-2, 9);
  });

  it('crossfades for 120 ms after a change between seated stills only, never under reduced motion', () => {
    expect(CROSSFADE_MS).toBe(120);
    const change = { from: 'walk' as const, at: 0 };
    expect(crossfade(null, 5)).toBeNull();
    expect(crossfade(change, 0)).toEqual({ from: 'walk', t: 0 });
    expect(crossfade(change, 0.06)?.t).toBeCloseTo(0.5, 9);
    expect(crossfade(change, 0.119)?.t).toBeGreaterThan(0.99);
    expect(crossfade(change, 0.12)).toBeNull();
    expect(crossfade(change, -0.01)).toEqual({ from: 'walk', t: 0 });
    expect(crossfade({ from: 'walk', at: NaN }, 1)).toBeNull();
    expect(crossfade(change, NaN)).toBeNull();
    // Only the near-identical seated stills dissolve; every other change cuts (no double exposure).
    expect(CROSSFADE_ACTIONS).toEqual(['idle', 'sit', 'pet']);
    for (const from of ACTIONS) for (const to of ACTIONS) {
      expect(crossfades(from, to)).toBe(from !== to && CROSSFADE_ACTIONS.includes(from) && CROSSFADE_ACTIONS.includes(to));
    }
    expect(crossfades('sit', 'pet')).toBe(true);
    expect(crossfades('sit', 'pounce')).toBe(false);
    expect(crossfades('carried', 'land')).toBe(false);
    const seated = { from: 'idle' as const, at: 0 };
    expect(pose({ action: 'sit' }, { time: 0.06, actionChange: seated }).tweening).toBe(true);
    expect(pose({ action: 'sit' }, { time: 0.12, actionChange: seated }).tweening).toBe(false);
    expect(pose({ action: 'sit' }, { time: 0.06, actionChange: seated, reducedMotion: true }).tweening).toBe(false);
    // A cut is not a tween: no display-rate frames for a walk → sit change.
    expect(pose({ action: 'sit' }, { time: 0.06, actionChange: change }).tweening).toBe(false);
  });

  it('squashes on landing for 220 ms from the renderer action-change time, easing out', () => {
    expect(LAND_SQUASH_MS).toBe(220);
    const actionChange = { from: 'carried' as const, at: 10 };
    const landing = (ms: number, actionTime = 0) => pose({ action: 'land', actionTime }, { time: 10 + ms / 1000, actionChange });
    expect(landing(0)).toMatchObject({ scaleX: 1.08, scaleY: 0.88, tweening: true });
    const mid = landing(110);
    expect(mid.scaleY).toBeGreaterThan(0.94);   // ease-out: past the linear midpoint
    expect(mid.scaleY).toBeLessThan(1);
    expect(mid.scaleX).toBeGreaterThan(1);
    expect(mid.scaleX).toBeLessThan(1.04);
    let previous = landing(0);
    for (let ms = 5; ms < 220; ms += 5) {
      const next = landing(ms);
      expect(next.scaleY).toBeGreaterThan(previous.scaleY);
      expect(next.scaleX).toBeLessThan(previous.scaleX);
      expect(next.tweening).toBe(true);
      previous = next;
    }
    expect(landing(220)).toMatchObject({ scaleX: 1, scaleY: 1, tweening: false });
    expect(landing(400)).toMatchObject({ scaleX: 1, scaleY: 1, tweening: false });
    // The renderer clock wins over engine time; without a recorded change, engine time is used.
    expect(landing(0, 5)).toMatchObject({ scaleX: 1.08, scaleY: 0.88 });
    expect(pose({ action: 'land', actionTime: 0 })).toMatchObject({ scaleX: 1.08, scaleY: 0.88, tweening: true });
    expect(pose({ action: 'land', actionTime: 0.3 })).toMatchObject({ scaleX: 1, scaleY: 1, tweening: false });
  });

  it('lifts a leap along a sine arc with the shadow shrinking toward 55 % at the apex', () => {
    const height = 0.35 * 128;
    const leaping = (progress: number) => pose({ action: 'pounce', actionTime: 0.3, leap: { fromX: 100, fromY: 300, toX: 160, toY: 300, progress, height } });
    expect(leaping(0)).toMatchObject({ dy: 0, shadowScale: 1, tweening: true });
    expect(leaping(0.25).dy).toBeCloseTo(-height * Math.SQRT1_2, 9);
    expect(leaping(0.5).dy).toBeCloseTo(-height, 9);
    expect(leaping(0.5).shadowScale).toBeCloseTo(0.55, 9);
    expect(leaping(0.5).tweening).toBe(true);
    expect(leaping(1).dy).toBeCloseTo(0, 9);
    expect(leaping(1).shadowScale).toBeCloseTo(1, 9);
    expect(leaping(1).tweening).toBe(false);
    for (let progress = 0; progress <= 1; progress += 0.01) {
      const result = leaping(progress);
      expect(result.dy).toBeLessThanOrEqual(0);
      expect(result.dy).toBeGreaterThanOrEqual(-height - 1e-9);
      expect(result.shadowScale).toBeGreaterThanOrEqual(0.55 - 1e-9);
      expect(result.shadowDy).toBe(0);   // the shadow stays on the ground under the moving position
    }
    expect(leaping(1.4).dy).toBeCloseTo(0, 9);
    expect(leaping(-0.2).dy).toBeCloseTo(0, 9);
  });
});

describe('motion layer: stepping, bob and lean', () => {
  it('derives the step period from speed and size, clamped and monotonic in speed', () => {
    expect(STEP_LENGTH).toBe(0.15);
    expect(STEP_PERIOD_LIMITS_MS).toEqual({ walk: [180, 660], trot: [110, 430] });
    expect(stepPeriodMs('walk', 55, 128)).toBeCloseTo(0.15 * 128 / 55 * 1000, 9);
    expect(stepPeriodMs('trot', 85, 128)).toBeCloseTo(0.15 * 128 / 85 * 1000, 9);
    expect(stepPeriodMs('walk', 1, 128)).toBe(660);
    expect(stepPeriodMs('walk', 1e6, 128)).toBe(180);
    expect(stepPeriodMs('trot', 1, 128)).toBe(430);
    expect(stepPeriodMs('trot', 1e6, 128)).toBe(110);
    for (const speed of [0, -5, NaN]) {
      expect(stepPeriodMs('walk', speed, 128)).toBe(660);
      expect(stepPeriodMs('trot', speed, 128)).toBe(430);
    }
    for (const [action, min, max] of [['walk', 180, 660], ['trot', 110, 430]] as const) for (const size of [96, 128, 192]) {
      let previous = Infinity;
      for (let speed = 1; speed <= 800; speed += 1) {
        const period = stepPeriodMs(action, speed, size);
        expect(period).toBeLessThanOrEqual(previous);
        expect(period).toBeGreaterThanOrEqual(min);
        expect(period).toBeLessThanOrEqual(max);
        previous = period;
      }
    }
    expect(stepPeriodMs('walk', 100, 192)).toBeGreaterThan(stepPeriodMs('walk', 100, 96));
  });

  it('steps inside the clamp for every default speed and size, so energy and size change the cadence', () => {
    const gaits = { walk: [...[0, 0.25, 0.5, 0.75, 1].map(energy => speedFor('walk', energy)), PAIR_SPEED, QUIET_SPEED], trot: [0, 0.25, 0.5, 0.75, 1].flatMap(energy => [speedFor('trot', energy), speedFor('chase', energy)]) };
    for (const action of ['walk', 'trot'] as const) for (const size of [96, 128, 192]) for (const speed of gaits[action]) {
      const [min, max] = STEP_PERIOD_LIMITS_MS[action], period = stepPeriodMs(action, speed, size);
      expect(period).toBeGreaterThan(min);
      expect(period).toBeLessThan(max);
      expect(period).toBeCloseTo(STEP_LENGTH * size / speed * 1000, 9);
    }
    // At the default size the energy slider changes the stepping, not only the speed (the paws keep pace).
    for (const gait of ['walk', 'trot'] as const) {
      const slow = stepPeriodMs(gait, speedFor(gait, 0), 128), fast = stepPeriodMs(gait, speedFor(gait, 1), 128);
      expect(slow / fast).toBeCloseTo(1.5, 9);
    }
    expect(stepPeriodMs('walk', speedFor('walk', 0.5), 192)).toBeCloseTo(2 * stepPeriodMs('walk', speedFor('walk', 0.5), 96), 9);
  });

  it('speed-matches walk and trot clip time and leaves every other clip on action time', () => {
    // At 64 DIP/s a step of 0.15 × 128 DIP takes 300 ms: one authored 320 ms cycle per 0.6 s of walking.
    expect(clipSeconds(petState({ action: 'walk', speed: 64, actionTime: 0.6 }), 320)).toBeCloseTo(0.32, 9);
    expect(clipSeconds(petState({ action: 'walk', speed: 80, actionTime: 1 }), 320)).toBeCloseTo(320 / (2 * STEP_LENGTH * 128 / 80 * 1000), 9);
    expect(clipSeconds(petState({ action: 'trot', speed: 150, actionTime: 2 * STEP_LENGTH * 128 / 150 }), 210)).toBeCloseTo(0.21, 9);
    expect(clipSeconds(petState({ action: 'sit', actionTime: 3.25 }), 1600)).toBe(3.25);
    expect(clipSeconds(petState({ action: 'pet', actionTime: 0.75, speed: 99 }), 1700)).toBe(0.75);
    expect(clipSeconds(petState({ action: 'walk', speed: 0, actionTime: 3 }), 320)).toBe(0);   // standing in a walk holds a frame
    expect(clipSeconds(petState({ action: 'walk', speed: 55, actionTime: 3 }), 0)).toBe(3);
    expect(clipSeconds(petState({ action: 'walk', speed: 55, actionTime: NaN }), 320)).toBe(0);
    // A faster walk plays the clip faster (it used to sit at the clamp for every default speed).
    expect(clipSeconds(petState({ action: 'walk', speed: speedFor('walk', 1), actionTime: 1 }), 320))
      .toBeGreaterThan(clipSeconds(petState({ action: 'walk', speed: speedFor('walk', 0), actionTime: 1 }), 320) * 1.4);
  });

  it('changes two-frame walk frames exactly on step boundaries, in step with the bob', () => {
    const frameAt = (seconds: number) => Math.floor(seconds * 1000 / 160) % 2;   // the authored 2 × 160 ms walk
    for (const speed of [44, 66, 90, 140, 400]) {
      const stepMs = stepPeriodMs('walk', speed, 128);
      for (let actionTime = 0; actionTime < 3; actionTime += 0.013) {
        const steps = actionTime * 1000 / stepMs;
        if (Math.abs(steps - Math.round(steps)) < 1e-6) continue;
        expect(frameAt(clipSeconds(petState({ action: 'walk', speed, actionTime }), 320))).toBe(Math.floor(steps) % 2);
      }
    }
  });

  it('bobs once per step (twice per cycle) by up to 2.5 % of size and leans 2° walking, 3° trotting', () => {
    const size = 128, speed = 120, stepMs = stepPeriodMs('walk', speed, size);
    const walking = (actionTime: number, facing: Facing = 'right') => pose({ action: 'walk', speed, size, actionTime, facing });
    for (let step = 0; step < 6; step++) {
      expect(walking(step * stepMs / 1000).dy).toBeCloseTo(0, 9);
      expect(walking((step + 0.5) * stepMs / 1000).dy).toBeCloseTo(-0.025 * size, 9);
    }
    for (let actionTime = 0; actionTime < 2; actionTime += 0.01) {
      const dy = walking(actionTime).dy;
      expect(dy).toBeLessThanOrEqual(0);
      expect(dy).toBeGreaterThanOrEqual(-0.025 * size - 1e-9);
    }
    // Positive rotation is clockwise on screen: the top of a right-walking kitten leans right.
    expect(degrees(walking(0.3).rotation)).toBeCloseTo(2, 9);
    expect(degrees(walking(0.3, 'left').rotation)).toBeCloseTo(-2, 9);
    expect(degrees(pose({ action: 'trot', speed: 150, actionTime: 0.3 }).rotation)).toBeCloseTo(3, 9);
    expect(walking(0.5 * stepMs / 1000)).toMatchObject({ shadowDy: 0, shadowScale: 1, shadowAlpha: 1 });
    // A walking kitten that is standing still (waiting for its partner) neither bobs nor leans.
    expect(pose({ action: 'walk', speed: 0, actionTime: 0.37 })).toEqual(identityPose('right'));
  });
});

describe('motion layer: resting, petting, carrying, waking and eating', () => {
  it('breathes ±0.7 % awake and ±1.5 % asleep on a 3.4 s cycle, phase-shifted by breathPhase', () => {
    expect(BREATH_PERIOD_S).toBe(3.4);
    for (const [action, amplitude] of [['idle', 0.007], ['sit', 0.007], ['groom', 0.007], ['sleep', 0.015]] as const) {
      let low = Infinity, high = -Infinity;
      for (let time = 0; time < 3.4; time += 0.01) {
        const value = pose({ action, actionTime: 1 }, { time });
        low = Math.min(low, value.scaleY); high = Math.max(high, value.scaleY);
        expect(value.scaleY).toBeCloseTo(pose({ action, actionTime: 1 }, { time: time + 3.4 }).scaleY, 9);
        expect(value.scaleX).toBe(1);
        expect(value.dy).toBe(0);
      }
      expect(high).toBeLessThanOrEqual(1 + amplitude + 1e-12);
      expect(low).toBeGreaterThanOrEqual(1 - amplitude - 1e-12);
      expect(high).toBeGreaterThan(1 + amplitude * 0.99);
      expect(low).toBeLessThan(1 - amplitude * 0.99);
    }
    // In a shared nap both kittens get breathPhase 0 and breathe together; otherwise they differ.
    const archie = pose({ id: 'archie', action: 'sleep' }, { time: 12.3, breathPhase: 0 });
    expect(pose({ id: 'jumi', action: 'sleep' }, { time: 12.3, breathPhase: 0 }).scaleY).toBe(archie.scaleY);
    expect(Math.abs(pose({ id: 'jumi', action: 'sleep' }, { time: 12.3, breathPhase: 1.7 }).scaleY - archie.scaleY)).toBeGreaterThan(0.001);
    expect(pose({ action: 'sleep' }, { time: 10, breathPhase: 2 }).scaleY).toBeCloseTo(pose({ action: 'sleep' }, { time: 12 }).scaleY, 12);
  });

  it('tilts ±2° while grooming and nuzzles ±2° at 1 Hz while petted, mirrored for left', () => {
    let groomPeak = 0, petPeak = 0;
    for (let actionTime = 0; actionTime < 3; actionTime += 0.01) {
      const groom = pose({ action: 'groom', actionTime }).rotation;
      const petted = pose({ action: 'pet', actionTime, held: true }).rotation;
      groomPeak = Math.max(groomPeak, Math.abs(degrees(groom)));
      petPeak = Math.max(petPeak, Math.abs(degrees(petted)));
      expect(pose({ action: 'pet', actionTime: actionTime + 1 }).rotation).toBeCloseTo(petted, 9);
      expect(pose({ action: 'pet', actionTime, facing: 'left' }).rotation).toBeCloseTo(-petted, 12);
    }
    expect(groomPeak).toBeLessThanOrEqual(2 + 1e-9);
    expect(groomPeak).toBeGreaterThan(1.99);
    expect(petPeak).toBeLessThanOrEqual(2 + 1e-9);
    expect(petPeak).toBeGreaterThan(1.99);
  });

  it('swings a carried kitten like a pendulum about its middle, within ±8°, the shadow left on the ground', () => {
    const size = 128, pivot = CARRY_PIVOT * size;
    const carried = (velocityX: number) => pose({ action: 'carried', size }, { velocityX });
    expect(carried(0)).toMatchObject({ rotation: 0, dx: 0, dy: 0, scaleX: 1, scaleY: 1, shadowScale: 0.6, shadowAlpha: 0.5, shadowDy: CARRY_LIFT * size, tweening: false });
    const right = carried(240);
    expect(degrees(right.rotation)).toBeCloseTo(4, 9);
    expect(degrees(carried(5000).rotation)).toBeCloseTo(8, 9);
    expect(degrees(carried(-5000).rotation)).toBeCloseTo(-8, 9);
    expect(carried(-240).rotation).toBeCloseTo(-right.rotation, 12);
    expect(carried(NaN).rotation).toBe(0);
    // Dragged right, the paws (the ground anchor) trail left and the head leans forward, while the held middle stays put.
    const paws = drawnLocal(0, 0, 400, 500, right);
    const middle = drawnLocal(0, -pivot, 400, 500, right);
    const head = drawnLocal(0, -1.05 * size, 400, 500, right);
    expect(paws.x).toBeLessThan(400 - 3);
    expect(head.x).toBeGreaterThan(400 + 3);
    expect(middle.x).toBeCloseTo(400, 9);
    expect(middle.y).toBeCloseTo(500 - pivot, 9);
  });

  it('lets a released swing settle about the same pivot while landing, then stands upright', () => {
    const size = 128, pivot = CARRY_PIVOT * size;
    const actionChange = { from: 'carried' as const, at: 100 };
    const carried = pose({ action: 'carried', size }, { velocityX: 400 });
    // The first landing frame keeps the carried swing (the renderer then eases velocityX to 0): no jump.
    const landing = pose({ action: 'land', size }, { velocityX: 400, actionChange });
    expect(landing.rotation).toBeCloseTo(carried.rotation, 12);
    expect(landing.dx).toBeCloseTo(carried.dx, 12);
    expect(landing.dy).toBeCloseTo(carried.dy, 12);
    expect(landing).toMatchObject({ scaleX: 1.08, scaleY: 0.88, tweening: true });
    // The held middle stays put while the swing settles, as while carried.
    const middle = drawnLocal(0, -pivot / landing.scaleY, 400, 500, landing);
    expect(middle.x).toBeCloseTo(400, 9);
    // Past the squash a settling swing still tweens; without one the kitten stands upright.
    expect(pose({ action: 'land', size }, { velocityX: 30, time: 101, actionChange })).toMatchObject({ scaleX: 1, scaleY: 1, tweening: true });
    expect(pose({ action: 'land', size }, { velocityX: 0, time: 101, actionChange })).toMatchObject({ rotation: 0, dx: 0, dy: 0, tweening: false });
  });

  it('stretches across the wake clip and nods forward about the paws at 2 Hz while eating', () => {
    expect(pose({ action: 'wake', actionTime: 0 }).scaleX).toBe(1);
    expect(pose({ action: 'wake', actionTime: 0.55 }).scaleX).toBeCloseTo(1.06, 9);
    expect(pose({ action: 'wake', actionTime: 1.1 }).scaleX).toBe(1);
    expect(pose({ action: 'wake', actionTime: 2 }).scaleX).toBe(1);
    for (let actionTime = 0; actionTime <= 1.1; actionTime += 0.01) {
      const scaleX = pose({ action: 'wake', actionTime }).scaleX;
      expect(scaleX).toBeGreaterThanOrEqual(1);
      expect(scaleX).toBeLessThanOrEqual(1.06 + 1e-12);
    }
    // The nod rotates about the ground anchor: the paws (and shadow) stay on the ground line.
    const eating = (actionTime: number, facing: Facing = 'right') => pose({ action: 'eat', actionTime, size: 150, facing });
    expect(EAT_NOD_DEG).toBe(1.5);
    expect(eating(0).rotation).toBe(0);
    expect(degrees(eating(0.25).rotation)).toBeCloseTo(1.5, 9);   // forward: the head dips toward the treat
    expect(degrees(eating(0.25, 'left').rotation)).toBeCloseTo(-1.5, 9);
    expect(eating(0.5).rotation).toBeCloseTo(0, 9);
    for (let actionTime = 0; actionTime < 2; actionTime += 0.01) {
      const value = eating(actionTime);
      expect(value).toMatchObject({ dx: 0, dy: 0, scaleX: 1, scaleY: 1, shadowDy: 0, tweening: false });
      expect(degrees(value.rotation)).toBeGreaterThanOrEqual(0);
      expect(degrees(value.rotation)).toBeLessThanOrEqual(1.5 + 1e-9);
      expect(eating(actionTime + 0.5).rotation).toBeCloseTo(value.rotation, 9);
      const paws = drawnLocal(0, 0, 400, 500, value);
      expect(paws.x).toBeCloseTo(400, 9);
      expect(paws.y).toBeCloseTo(500, 9);
    }
  });

  it('mirrors facing-relative motion exactly for a left-facing kitten', () => {
    const cases = [['walk', { speed: 70 }], ['trot', { speed: 140 }], ['groom', {}], ['pet', {}], ['eat', {}], ['sit', {}], ['wake', {}]] as const;
    for (const [action, patch] of cases) for (const actionTime of [0.13, 0.7, 2.21]) {
      const right = pose({ action, actionTime, facing: 'right', ...patch });
      const left = pose({ action, actionTime, facing: 'left', ...patch });
      expect(left).toEqual({ ...right, rotation: right.rotation === 0 ? 0 : -right.rotation, drawFacing: 'left' });
    }
  });

  it('scales with the kitten and survives invalid numbers', () => {
    const small = pose({ action: 'walk', size: 96, speed: 66, actionTime: 0.5 * stepPeriodMs('walk', 66, 96) / 1000 });
    const large = pose({ action: 'walk', size: 192, speed: 66, actionTime: 0.5 * stepPeriodMs('walk', 66, 192) / 1000 });
    expect(small.dy).toBeCloseTo(-0.025 * 96, 9);
    expect(large.dy).toBeCloseTo(-0.025 * 192, 9);
    const broken = pose({ action: 'sleep', actionTime: NaN, size: NaN }, { time: NaN, breathPhase: NaN });
    expect(Object.values(broken).filter(value => typeof value === 'number').every(Number.isFinite)).toBe(true);
  });
});

describe('motion layer: render keys', () => {
  it('quantizes pose keys to 0.5 px and 0.25° and keeps breathing as the ambient part', () => {
    const base: Pose = { ...identityPose('right'), dx: 1.1, dy: -2.1, scaleX: 1.02, scaleY: 0.998, rotation: radians(1.1) };
    const key = poseKey(base, 150);
    expect(poseKey({ ...base }, 150)).toBe(key);
    // Changes smaller than half a quantum keep the key (tweening is not part of it).
    const jitter: Partial<Pose> = { dx: 1.15, dy: -2.05, rotation: radians(1.05), scaleX: 1.0201, scaleY: 0.9982, tweening: true };
    expect(poseKey({ ...base, ...jitter }, 150)).toBe(key);
    const changes: Partial<Pose>[] = [
      { dy: -2.6 }, { dx: 1.4 }, { rotation: radians(1.4) }, { scaleX: 1.025 }, { drawFacing: 'left' },
      { shadowDy: 1 }, { shadowScale: 0.6 }, { shadowAlpha: 0.5 }, { alpha: 0.5 },
    ];
    for (const change of changes) expect(poseKey({ ...base, ...change }, 150)).not.toBe(key);
    // Scale steps follow the drawn height: a larger sprite resolves finer changes.
    expect(poseKey({ ...base, scaleY: 0.9982 }, 2000)).not.toBe(poseKey(base, 2000));
    // Breathing alone (scaleY) is an ambient-only change; anything else is not.
    expect(isAmbientOnly(key, poseKey({ ...base, scaleY: 1.006 }, 150))).toBe(true);
    expect(isAmbientOnly(key, key)).toBe(false);
    expect(isAmbientOnly(key, poseKey({ ...base, dy: -3 }, 150))).toBe(false);
    expect(isAmbientOnly(key, poseKey({ ...base, dy: -3, scaleY: 1.006 }, 150))).toBe(false);
    expect(isAmbientOnly('not-a-key', key)).toBe(false);
  });

  it('keys the groom tilt as ambient when asked, so a grooming kitten is not redrawn at the active rate', () => {
    const groom = (actionTime: number) => pose({ action: 'groom', actionTime }, { time: 50 });
    const ambientKey = (value: Pose) => poseKey(value, 150, { ambientRotation: true });
    let tiltChanges = 0, previous = ambientKey(groom(0));
    for (let actionTime = 0.01; actionTime < 2.4; actionTime += 0.01) {
      const next = ambientKey(groom(actionTime));
      if (next !== previous) { expect(isAmbientOnly(previous, next)).toBe(true); tiltChanges++; }
      previous = next;
    }
    expect(tiltChanges).toBeGreaterThan(20);
    // The same rotation is an active change in the default key, and a different rotation still changes the key.
    expect(isAmbientOnly(poseKey(groom(0), 150), poseKey(groom(0.3), 150))).toBe(false);
    expect(ambientKey(groom(0))).not.toBe(ambientKey(groom(0.3)));
    // Switching between the two key shapes (a turn starting mid-groom) is an active change.
    expect(isAmbientOnly(ambientKey(groom(0.3)), poseKey(groom(0.3), 150))).toBe(false);
  });

  it('keeps one key under reduced motion and only ambient key changes while napping', () => {
    const reducedKeys = new Set<string>();
    for (let time = 0; time < 10; time += 0.05) reducedKeys.add(poseKey(pose({ action: 'sleep', actionTime: time }, { time, reducedMotion: true }), 150));
    expect(reducedKeys.size).toBe(1);
    let previous = poseKey(pose({ action: 'sleep' }, { time: 0 }), 150), changes = 0;
    for (let time = 0.01; time < 3.4; time += 0.01) {
      const next = poseKey(pose({ action: 'sleep' }, { time }), 150);
      if (next !== previous) { expect(isAmbientOnly(previous, next)).toBe(true); changes++; }
      previous = next;
    }
    expect(changes).toBeGreaterThan(4);
    expect(changes).toBeLessThan(60);   // a few steps per breath, not a redraw per frame
    // Walking changes the active part.
    const stepMs = stepPeriodMs('walk', 120, 128);
    const a = poseKey(pose({ action: 'walk', speed: 120, actionTime: 0 }), 150), b = poseKey(pose({ action: 'walk', speed: 120, actionTime: 0.5 * stepMs / 1000 }), 150);
    expect(a).not.toBe(b);
    expect(isAmbientOnly(a, b)).toBe(false);
  });
});

describe('motion layer: hit-test inverse', () => {
  it('matches the canvas drawing transform and inverts it exactly, including rotation and negative scale', () => {
    const random = seeded(7);
    for (let trial = 0; trial < 400; trial++) {
      const placement = randomPlacement(random);
      for (let sample = 0; sample < 5; sample++) {
        const u = -0.2 + random() * 1.4, v = -0.2 + random() * 1.4;
        const drawn = drawnFrame(u, v, placement), forward = framePoint(u, v, placement);
        expect(forward.x).toBeCloseTo(drawn.x, 9);
        expect(forward.y).toBeCloseTo(drawn.y, 9);
        const back = frameUV(drawn.x, drawn.y, placement);
        expect(back).not.toBeNull();
        expect(back!.u).toBeCloseTo(u, 9);
        expect(back!.v).toBeCloseTo(v, 9);
      }
    }
  });

  it('round-trips the poses the motion layer actually produces', () => {
    const poses = [
      pose({ action: 'walk', facing: 'left', speed: 80, actionTime: 0.61 }, { time: 0.03, facingChange: { from: 'right', at: 0 } }),
      pose({ action: 'carried' }, { velocityX: 333 }),
      pose({ action: 'land' }, { time: 0.05, actionChange: { from: 'pounce', at: 0 } }),
      pose({ action: 'pounce', leap: { fromX: 0, fromY: 0, toX: 60, toY: 0, progress: 0.4, height: 44.8 } }),
      pose({ action: 'groom', actionTime: 0.31 }, { time: 7.7 }),
    ];
    for (const value of poses) {
      const placement = spritePlacement(640, 360, 128, value);
      for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
        const point = framePoint(i / 8, j / 8, placement), back = frameUV(point.x, point.y, placement)!;
        expect(back.u).toBeCloseTo(i / 8, 9);
        expect(back.v).toBeCloseTo(j / 8, 9);
      }
    }
  });

  it('reduces to today\'s hit test for the identity pose', () => {
    const placement = spritePlacement(400, 300, 128, identityPose('right'));
    const rectX = 400 - placement.width / 2, rectY = 300 - placement.height / 2;
    for (const [x, y] of [[rectX, rectY], [400, 300], [rectX + 37.5, rectY + 99.25], [rectX + placement.width - 0.01, rectY + placement.height - 0.01]]) {
      const uv = frameUV(x, y, placement)!;
      expect(uv.u).toBeCloseTo((x - rectX) / placement.width, 12);
      expect(uv.v).toBeCloseTo((y - rectY) / placement.height, 12);
    }
    // The ground anchor sits at the paws: about 0.478 × size below the pet centre.
    expect(placement.anchorY - 300).toBeCloseTo((464 / 512 - 0.5) * 128 / 0.85, 9);
    const square: Placement = { anchorX: 100, anchorY: 200, offsetX: -50, offsetY: -90, width: 100, height: 100, pose: identityPose('left') };
    expect(frameUV(75, 160, square)).toEqual({ u: 0.25, v: 0.5 });
  });

  it('reports the squeeze window of a turn or landing squash, and the rest shape it squeezes', () => {
    const input = (pet: Partial<PetState>, patch: Partial<Omit<PoseInput, 'pet'>> = {}): PoseInput => ({
      pet: petState(pet), time: 100, reducedMotion: false, velocityX: 0, facingChange: null, actionChange: null, breathPhase: 0, ...patch,
    });
    for (let ms = 0; ms < TURN_MS; ms += 5) {
      const turning = input({ facing: 'left' }, { time: 100 + ms / 1000, facingChange: { from: 'right', at: 100 } });
      expect(squeezed(turning)).toBe(true);
      expect(poseFor(turning).tweening).toBe(true);
    }
    expect(squeezed(input({ facing: 'left' }, { time: 100 + TURN_MS / 1000 + 1e-6, facingChange: { from: 'right', at: 100 } }))).toBe(false);
    expect(squeezed(input({ facing: 'left' }, { time: 100.05, facingChange: { from: 'left', at: 100 } }))).toBe(false);
    for (let ms = 0; ms < LAND_SQUASH_MS; ms += 5) expect(squeezed(input({ action: 'land' }, { time: 100 + ms / 1000, actionChange: { from: 'carried', at: 100 } }))).toBe(true);
    expect(squeezed(input({ action: 'land' }, { time: 100 + LAND_SQUASH_MS / 1000 + 1e-6, actionChange: { from: 'carried', at: 100 } }))).toBe(false);
    // Other tweens do not squeeze; reduced motion never does.
    expect(squeezed(input({ action: 'pounce', leap: { fromX: 0, fromY: 0, toX: 50, toY: 0, progress: 0.5, height: 40 } }))).toBe(false);
    expect(squeezed(input({ action: 'sit' }, { time: 100.03, actionChange: { from: 'idle', at: 100 } }))).toBe(false);
    expect(squeezed(input({ action: 'land' }, { reducedMotion: true, actionChange: { from: 'carried', at: 100 } }))).toBe(false);
    // The rest shape keeps the anchor, offsets, rotation and frame, at scale 1.
    const squash = poseFor(input({ action: 'land' }, { actionChange: { from: 'carried', at: 100 } }));
    const placement = spritePlacement(400, 300, 128, { ...squash, rotation: radians(3) });
    const rest = restPlacement(placement);
    expect(rest).toEqual({ ...placement, pose: { ...placement.pose, scaleX: 1, scaleY: 1 } });
    expect(placement.pose.scaleY).toBeCloseTo(0.88, 9);
  });

  it('refuses to invert a nearly flat sprite or non-finite input', () => {
    const placement = (patch: Partial<Pose>): Placement => ({ anchorX: 100, anchorY: 200, offsetX: -50, offsetY: -90, width: 100, height: 100, pose: { ...identityPose('right'), ...patch } });
    expect(frameUV(100, 150, placement({ scaleX: 0.049 }))).toBeNull();
    expect(frameUV(100, 150, placement({ scaleX: -0.049 }))).toBeNull();
    expect(frameUV(100, 150, placement({ scaleY: 0.04 }))).toBeNull();
    expect(frameUV(100, 150, placement({ scaleX: MIN_HIT_SCALE }))).not.toBeNull();
    expect(frameUV(100, 150, placement({ scaleX: -MIN_HIT_SCALE }))).not.toBeNull();
    expect(frameUV(100, 150, placement({ scaleX: NaN }))).toBeNull();
    expect(frameUV(100, 150, placement({ rotation: Infinity }))).toBeNull();
    expect(frameUV(NaN, 150, placement({}))).toBeNull();
    expect(frameUV(100, 150, { ...placement({}), width: 0 })).toBeNull();
    expect(frameUV(100, 150, { ...placement({}), anchorX: NaN })).toBeNull();
  });

  it('bounds every pixel of the transformed sprite, tightly', () => {
    const random = seeded(11);
    for (let trial = 0; trial < 150; trial++) {
      const placement = randomPlacement(random);
      const bounds = placementBounds(placement);
      let touchesLeft = false, touchesTop = false, touchesRight = false, touchesBottom = false;
      for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
        const point = framePoint(i / 10, j / 10, placement);
        expect(point.x).toBeGreaterThanOrEqual(bounds.x - 1e-9);
        expect(point.y).toBeGreaterThanOrEqual(bounds.y - 1e-9);
        expect(point.x).toBeLessThanOrEqual(bounds.x + bounds.width + 1e-9);
        expect(point.y).toBeLessThanOrEqual(bounds.y + bounds.height + 1e-9);
        touchesLeft ||= Math.abs(point.x - bounds.x) < 1e-9;
        touchesTop ||= Math.abs(point.y - bounds.y) < 1e-9;
        touchesRight ||= Math.abs(point.x - bounds.x - bounds.width) < 1e-6;
        touchesBottom ||= Math.abs(point.y - bounds.y - bounds.height) < 1e-6;
      }
      expect([touchesLeft, touchesTop, touchesRight, touchesBottom]).toEqual([true, true, true, true]);
    }
    const today = spritePlacement(400, 300, 128, identityPose('left'));
    const rect = placementBounds(today);
    expect(rect.x).toBeCloseTo(400 - today.width / 2, 9);
    expect(rect.y).toBeCloseTo(300 - today.height / 2, 9);
    expect(rect.width).toBeCloseTo(today.width, 9);
    expect(rect.height).toBeCloseTo(today.height, 9);
    expect(placementBounds({ ...today, anchorX: NaN }).x).toBeNaN();
  });
});
