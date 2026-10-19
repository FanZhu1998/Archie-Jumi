/**
 * Procedural motion layer (plan 4.1; Phase 2 spec 3.1). Pure and deterministic, no DOM.
 *
 * Units: lengths are scene DIP, times are seconds unless a name ends in `Ms`, angles are radians in
 * the canvas convention (positive = clockwise on screen, y pointing down).
 *
 * Drawing convention. The renderer draws every kitten with exactly this transform, and `frameUV`
 * inverts exactly this transform:
 *
 *   ctx.translate(anchorX + pose.dx, anchorY + pose.dy);
 *   ctx.rotate(pose.rotation);
 *   ctx.scale(pose.scaleX, pose.scaleY);
 *   ctx.drawImage(page, sx, sy, sw, sh, offsetX, offsetY, width, height);   // the frame for pose.drawFacing
 *
 * so a sprite-local point (lx, ly), measured from the ground anchor before the pose is applied,
 * lands at  anchor + (dx, dy) + R(rotation) · (scaleX · lx, scaleY · ly)  in the scene.
 * The shadow ignores dx, dy, rotation and scale: it stays on the ground, centred at
 * (anchorX, anchorY + shadowDy), with its radii multiplied by shadowScale and its alpha by shadowAlpha.
 */
import type { Action, Facing, PetState, Point, Rect } from '../shared/types';

export const TURN_MS = 140, CROSSFADE_MS = 120, LAND_SQUASH_MS = 220;
/**
 * The only actions whose stills crossfade into each other: the near-identical seated silhouettes
 * (bundled masks overlap by IoU ≥ about 0.8). Any other action change cuts, because a dissolve between
 * different photographic stills reads as a double exposure (plan 4.1's evaluation clause).
 */
export const CROSSFADE_ACTIONS: readonly Action[] = ['idle', 'sit', 'pet'];

/**
 * One step covers this fraction of the kitten's size; two steps make one stride (one clip cycle).
 * Tuned so every default gait speed (energy-scaled walk 44–66, trot 68–102, chase 72–108 DIP/s) at
 * every kitten size (96–192 DIP) lands inside the clamp, so stepping follows speed and size.
 */
export const STEP_LENGTH = 0.15;
/** Clamp for the duration of one step, in ms (a safety net for extreme speeds, not the usual result). */
export const STEP_PERIOD_LIMITS_MS: Readonly<Record<'walk' | 'trot', readonly [number, number]>> = { walk: [180, 660], trot: [110, 430] };
/** Walk/trot lift at mid-step, as a fraction of size (one bob per step, two per cycle). */
export const BOB_FRACTION = 0.025;
/** Lean into the direction of travel, in degrees. */
export const LEAN_DEG = { walk: 2, trot: 3 } as const;
export const BREATH_PERIOD_S = 3.4;
/** Breathing amplitude of scaleY: idle, sit and groom (awake) and sleep. */
export const BREATH_AWAKE = 0.007, BREATH_ASLEEP = 0.015;
export const GROOM_TILT_DEG = 2, GROOM_TILT_PERIOD_S = 1.2;
export const NUZZLE_DEG = 2, NUZZLE_HZ = 1;
export const CARRY_SWING_MAX_DEG = 8;
/** Smoothed drag speed (DIP/s) at which the carried swing reaches CARRY_SWING_MAX_DEG. */
export const CARRY_SWING_FULL_SPEED = 480;
/** The carried kitten swings about a point this fraction of size above its ground anchor (about its centre, where it is held). */
export const CARRY_PIVOT = 0.48;
/** How far below the paws the ground shadow of a carried kitten stays (shadowDy), as a fraction of size. */
export const CARRY_LIFT = 0.2;
export const CARRY_SHADOW_SCALE = 0.6, CARRY_SHADOW_ALPHA = 0.5;
/** Landing squash at touchdown; both ease back to 1 over LAND_SQUASH_MS. */
export const LAND_SQUASH_X = 1.08, LAND_SQUASH_Y = 0.88;
/** Shadow scale at the apex of a leap. */
export const LEAP_SHADOW_MIN = 0.55;
/** Wake stretch: scaleX peaks at 1 + WAKE_STRETCH halfway through WAKE_STRETCH_S (the wake clip). */
export const WAKE_STRETCH = 0.06, WAKE_STRETCH_S = 1.1;
/** Eating nods the head forward by up to EAT_NOD_DEG, EAT_NOD_HZ times a second, about the paws (they stay on the ground). */
export const EAT_NOD_DEG = 1.5, EAT_NOD_HZ = 2;
/**
 * frameUV refuses to invert a sprite squeezed thinner than this (mid-turn). The overlay keeps an
 * already hovered kitten hit through its rest placement meanwhile (see `squeezed`).
 */
export const MIN_HIT_SCALE = 0.05;
/** poseKey quantization: half a pixel and a quarter degree. */
export const KEY_PX_STEP = 0.5, KEY_DEG_STEP = 0.25;

/** The renderer's latest observed facing change (`at` on the renderer clock, seconds). */
export interface FacingChange { from: Facing; at: number }
/** The renderer's latest observed action change into the current action (`at` on the renderer clock, seconds). */
export interface ActionChange { from: Action; at: number }

export interface PoseInput {
  pet: PetState;
  /** Renderer clock, seconds (the same clock as the `at` of both changes). */
  time: number;
  reducedMotion: boolean;
  /**
   * Smoothed horizontal drag velocity in DIP/s while carried, from the renderer. While landing after a
   * carry the renderer eases it to 0, so the swing settles instead of snapping upright; 0 otherwise.
   */
  velocityX: number;
  facingChange: FacingChange | null;
  actionChange: ActionChange | null;
  /** Seconds added to `time` for breathing; 0 for both kittens in a shared nap so they breathe together. */
  breathPhase: number;
}

export interface Pose {
  /** Offset of the drawn anchor from the ground anchor, DIP. */
  dx: number;
  dy: number;
  scaleX: number;
  scaleY: number;
  /** Radians, positive = clockwise on screen. */
  rotation: number;
  /** Draw the frame of this facing (it differs from pet.facing during the first half of a turn). */
  drawFacing: Facing;
  /** Sprite opacity multiplier (always 1 today). */
  alpha: number;
  shadowScale: number;
  shadowAlpha: number;
  /** The ground shadow's offset below the ground anchor, DIP (positive = down). */
  shadowDy: number;
  /** A short tween is running (turn, crossfade between CROSSFADE_ACTIONS, land squash, release swing, leap): render at display rate. */
  tweening: boolean;
}

/** A drawn sprite: its rect relative to the ground anchor (before the pose) and the pose applied about that anchor. */
export interface Placement { anchorX: number; anchorY: number; offsetX: number; offsetY: number; width: number; height: number; pose: Pose }

const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const clamp01 = (value: number) => clamp(value, 0, 1);
const radians = (degrees: number) => degrees * Math.PI / 180;
/** 0 at every whole number, 1 halfway between: one smooth bump per unit. */
const bump = (cycles: number) => 0.5 - 0.5 * Math.cos(2 * Math.PI * cycles);
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
/** Poses never carry -0 (it would make equal poses compare unequal in tests and keys). */
const tidy = (value: number) => value === 0 ? 0 : value;

/** The pose that changes nothing: what reduced motion draws. */
export function identityPose(facing: Facing): Pose {
  return { dx: 0, dy: 0, scaleX: 1, scaleY: 1, rotation: 0, drawFacing: facing, alpha: 1, shadowScale: 1, shadowAlpha: 1, shadowDy: 0, tweening: false };
}

/**
 * Duration of one step in ms: the time to cover STEP_LENGTH × size at `speed` (DIP/s), clamped to
 * STEP_PERIOD_LIMITS_MS ([180, 660] for walk, [110, 430] for trot). Non-increasing in speed; a
 * stationary or invalid speed gives the slowest step.
 */
export function stepPeriodMs(action: 'walk' | 'trot', speed: number, size: number): number {
  const [min, max] = STEP_PERIOD_LIMITS_MS[action === 'trot' ? 'trot' : 'walk'];
  if (!(speed > 0)) return max;
  return clamp(STEP_LENGTH * Math.max(0, finite(size, 128)) / speed * 1000, min, max);
}

/**
 * Animation time (seconds) to feed `animationFrame` for the pet's current clip. Walk and trot are
 * speed-matched: one clip cycle (`authoredCycleMs`, the sum of the clip's frame durations) takes two
 * steps, so the paws keep pace with the ground. A walking kitten that is standing still (speed 0,
 * e.g. waiting for its partner) holds the first frame. Other clips run on `actionTime` as today.
 * Under reduced motion the renderer keeps passing 0 instead, as today.
 */
export function clipSeconds(pet: PetState, authoredCycleMs: number): number {
  const actionTime = Math.max(0, finite(pet.actionTime, 0));
  const action = pet.action;
  if (action !== 'walk' && action !== 'trot') return actionTime;
  if (!(authoredCycleMs > 0) || !Number.isFinite(authoredCycleMs)) return actionTime;
  const speed = finite(pet.speed, 0);
  if (!(speed > 0)) return 0;
  const strideMs = 2 * stepPeriodMs(action, speed, pet.size);
  return actionTime * authoredCycleMs / strideMs;
}

/**
 * Crossfade from the outgoing action's frame, for CROSSFADE_MS after an action change: `t` runs from
 * 0 to 1 (the outgoing frame's opacity is 1 − t, the incoming one's t), then null. Does not look at
 * reduced motion or at which actions changed: the renderer crossfades only when `crossfades` allows
 * it and never under reduced motion (poseFor never reports it as tweening then).
 */
export function crossfade(actionChange: ActionChange | null, time: number): { from: Action; t: number } | null {
  if (!actionChange || !Number.isFinite(actionChange.at) || !Number.isFinite(time)) return null;
  const t = Math.max(0, (time - actionChange.at) * 1000 / CROSSFADE_MS);
  return t < 1 ? { from: actionChange.from, t } : null;
}

/** Whether a change between these two actions crossfades (both near-identical seated stills); every other change cuts. */
export function crossfades(from: Action, to: Action): boolean {
  return from !== to && CROSSFADE_ACTIONS.includes(from) && CROSSFADE_ACTIONS.includes(to);
}

/** Turn progress in [0, 1) while a facing change tweens (TURN_MS), else null. */
function turnProgress(change: FacingChange | null, facing: Facing, time: number): number | null {
  if (!change || (change.from !== 'left' && change.from !== 'right') || change.from === facing || !Number.isFinite(change.at)) return null;
  const t = Math.max(0, (time - change.at) * 1000 / TURN_MS);
  return t < 1 ? t : null;
}

/** Landing squash progress in [0, 1), timed from the renderer's action change (engine time without one), else null. */
function landProgress(change: ActionChange | null, time: number, actionTime: number): number | null {
  const since = change && Number.isFinite(change.at) ? time - change.at : actionTime;
  const t = clamp01(since * 1000 / LAND_SQUASH_MS);
  return t < 1 ? t : null;
}

/**
 * The carried pendulum for a smoothed drag velocity: dragged right, the dangling paws trail to the left
 * (clockwise). The offset turns the rotation about the anchor into a rotation about the held middle.
 */
function carrySwing(velocityX: number, size: number): { rotation: number; dx: number; dy: number } {
  const angle = radians(CARRY_SWING_MAX_DEG) * clamp(finite(velocityX, 0) / CARRY_SWING_FULL_SPEED, -1, 1);
  const pivot = CARRY_PIVOT * size;
  return { rotation: angle, dx: -pivot * Math.sin(angle), dy: -pivot * (1 - Math.cos(angle)) };
}

/** The procedural pose of one kitten, applied about its ground anchor (see the drawing convention above). */
export function poseFor(input: PoseInput): Pose {
  const pet = input.pet;
  const facing: Facing = pet.facing === 'left' ? 'left' : 'right';
  if (input.reducedMotion) return identityPose(facing);

  const time = finite(input.time, 0);
  const size = Math.max(0, finite(pet.size, 128));
  const actionTime = Math.max(0, finite(pet.actionTime, 0));
  const breathTime = time + finite(input.breathPhase, 0);
  const breath = (amplitude: number) => 1 + amplitude * Math.sin(2 * Math.PI * breathTime / BREATH_PERIOD_S);

  let dx = 0, dy = 0, scaleX = 1, scaleY = 1;
  /** Rotation that does not depend on facing (the carried swing). */
  let rotation = 0;
  /** Rotation toward the drawn facing (lean, tilt, nuzzle): mirrored for left and faded through a turn. */
  let facingRotation = 0;
  let shadowScale = 1, shadowAlpha = 1, shadowDy = 0;
  let tweening = false;

  const action = pet.action;
  switch (action) {
    case 'walk':
    case 'trot': {
      const speed = finite(pet.speed, 0);
      if (speed > 0) {
        const steps = actionTime * 1000 / stepPeriodMs(action, speed, size);
        dy -= BOB_FRACTION * size * bump(steps);
        facingRotation += radians(LEAN_DEG[action]);
      }
      break;
    }
    case 'idle':
    case 'sit':
      scaleY *= breath(BREATH_AWAKE);
      break;
    case 'groom':
      scaleY *= breath(BREATH_AWAKE);
      facingRotation += radians(GROOM_TILT_DEG) * Math.sin(2 * Math.PI * actionTime / GROOM_TILT_PERIOD_S);
      break;
    case 'sleep':
      scaleY *= breath(BREATH_ASLEEP);
      break;
    case 'pet':
      facingRotation += radians(NUZZLE_DEG) * Math.sin(2 * Math.PI * NUZZLE_HZ * actionTime);
      break;
    case 'carried': {
      const swing = carrySwing(input.velocityX, size);
      rotation += swing.rotation;
      dx += swing.dx;
      dy += swing.dy;
      shadowScale *= CARRY_SHADOW_SCALE;
      shadowAlpha *= CARRY_SHADOW_ALPHA;
      shadowDy += CARRY_LIFT * size;
      break;
    }
    case 'land': {
      // Timed from the renderer's action-change time (smooth at display rate); engine time otherwise.
      const t = landProgress(input.actionChange, time, actionTime);
      if (t !== null) {
        const eased = easeOutCubic(t);
        scaleX *= LAND_SQUASH_X + (1 - LAND_SQUASH_X) * eased;
        scaleY *= LAND_SQUASH_Y + (1 - LAND_SQUASH_Y) * eased;
        tweening = true;
      }
      // Just released from a carry: the swing settles about the same pivot while the renderer eases velocityX to 0.
      if (finite(input.velocityX, 0) !== 0) {
        const swing = carrySwing(input.velocityX, size);
        rotation += swing.rotation;
        dx += swing.dx;
        dy += swing.dy;
        tweening = true;
      }
      break;
    }
    case 'wake': {
      const t = actionTime / WAKE_STRETCH_S;
      if (t < 1) scaleX *= 1 + WAKE_STRETCH * Math.sin(Math.PI * t);
      break;
    }
    case 'eat':
      // A forward nod about the ground anchor, so the paws stay planted beside the treat.
      facingRotation += radians(EAT_NOD_DEG) * bump(EAT_NOD_HZ * actionTime);
      break;
    default:
      // pounce: the crouch is still and the leap arc follows below; nose_touch: no procedural motion.
      break;
  }

  // The leap arc: the engine moves the position linearly, the motion layer lifts it.
  const leap = pet.leap;
  if (leap) {
    const progress = clamp01(finite(leap.progress, 1));
    const arc = Math.sin(Math.PI * progress);
    dy -= Math.max(0, finite(leap.height, 0)) * arc;
    shadowScale *= 1 - (1 - LEAP_SHADOW_MIN) * arc;
    if (progress < 1) tweening = true;
  }

  // Turn tween: scaleX |cos(πt)| over TURN_MS, the old facing until the midpoint, then the new one.
  let drawFacing = facing, turn = 1;
  const facingChange = input.facingChange;
  const turnT = turnProgress(facingChange, facing, time);
  if (facingChange && turnT !== null) {
    turn = Math.abs(Math.cos(Math.PI * turnT));
    drawFacing = turnT < 0.5 ? facingChange.from : facing;
    tweening = true;
  }
  scaleX *= turn;
  rotation += (drawFacing === 'right' ? 1 : -1) * turn * facingRotation;

  const change = input.actionChange;
  if (change && crossfades(change.from, action) && crossfade(change, time)) tweening = true;

  return {
    dx: tidy(dx), dy: tidy(dy), scaleX: tidy(scaleX), scaleY: tidy(scaleY), rotation: tidy(rotation), drawFacing, alpha: 1,
    shadowScale: tidy(shadowScale), shadowAlpha: tidy(shadowAlpha), shadowDy: tidy(shadowDy), tweening,
  };
}

/**
 * Quantized render-dedupe key: dx, dy and shadowDy in 0.5 DIP steps, rotation in 0.25° steps, scales
 * in steps that move the sprite's extent by 0.5 of `drawnHeightPx` units (pass the drawn sprite
 * height), alphas in 1/64. Shaped "active|ambient": the ambient part is scaleY, which outside tweens
 * only breathing changes (see isAmbientOnly), plus the rotation with `ambientRotation` (the groom
 * tilt, slow periodic motion that the overlay draws at its own ambient cadence).
 */
export function poseKey(pose: Pose, drawnHeightPx: number, options: { ambientRotation?: boolean } = {}): string {
  const height = Math.max(1, finite(drawnHeightPx, 1));
  const px = (value: number) => Math.round(value / KEY_PX_STEP);
  const scale = (value: number) => Math.round(value * height / KEY_PX_STEP);
  const angle = (value: number) => Math.round(value / radians(KEY_DEG_STEP));
  const opacity = (value: number) => Math.round(value * 64);
  const ambientRotation = options.ambientRotation === true;
  const active = [
    pose.drawFacing === 'left' ? 'l' : 'r', px(pose.dx), px(pose.dy), scale(pose.scaleX), ambientRotation ? '' : angle(pose.rotation), opacity(pose.alpha),
    scale(pose.shadowScale), opacity(pose.shadowAlpha), px(pose.shadowDy),
  ].join(',');
  return active + '|' + (ambientRotation ? `${scale(pose.scaleY)},${angle(pose.rotation)}` : String(scale(pose.scaleY)));
}

/**
 * Whether poseFor squeezes the sprite out of its rest shape for this input: a turn tween (scaleX
 * |cos πt|) or a landing squash. Meanwhile the overlay also hit tests an already hovered or pressed
 * kitten through `restPlacement`, so the squeeze never uncovers a resting cursor for a few frames.
 */
export function squeezed(input: PoseInput): boolean {
  if (input.reducedMotion) return false;
  const pet = input.pet, time = finite(input.time, 0);
  if (turnProgress(input.facingChange, pet.facing === 'left' ? 'left' : 'right', time) !== null) return true;
  return pet.action === 'land' && landProgress(input.actionChange, time, Math.max(0, finite(pet.actionTime, 0))) !== null;
}

/** `placement` back at scale 1, with the same anchor, offsets, rotation and frame: the shape a turn or squash squeezes. */
export function restPlacement(placement: Placement): Placement {
  return { ...placement, pose: { ...placement.pose, scaleX: 1, scaleY: 1 } };
}

/** True when two different pose keys differ only in their ambient part (breathing, the groom tilt), which may render at a lower rate. */
export function isAmbientOnly(prevKey: string, nextKey: string): boolean {
  if (prevKey === nextKey) return false;
  const a = prevKey.lastIndexOf('|'), b = nextKey.lastIndexOf('|');
  return a >= 0 && b >= 0 && prevKey.slice(0, a) === nextKey.slice(0, b);
}

/**
 * Inverse of the drawing transform for hit testing: the scene point (px, py) in the drawn frame's
 * normalized coordinates (u from its left edge, v from its top edge; inside the frame when both are
 * in [0, 1), the range `alphaHit` accepts). Null when |scaleX| or |scaleY| < MIN_HIT_SCALE or any
 * input is not finite.
 */
export function frameUV(px: number, py: number, placement: Placement): { u: number; v: number } | null {
  const pose = placement.pose;
  if (!(Math.abs(pose.scaleX) >= MIN_HIT_SCALE) || !(Math.abs(pose.scaleY) >= MIN_HIT_SCALE)) return null;
  if (!(placement.width > 0) || !(placement.height > 0)) return null;
  const qx = px - (placement.anchorX + pose.dx), qy = py - (placement.anchorY + pose.dy);
  const cos = Math.cos(pose.rotation), sin = Math.sin(pose.rotation);
  const lx = (qx * cos + qy * sin) / pose.scaleX;
  const ly = (qy * cos - qx * sin) / pose.scaleY;
  const u = (lx - placement.offsetX) / placement.width, v = (ly - placement.offsetY) / placement.height;
  return Number.isFinite(u) && Number.isFinite(v) ? { u, v } : null;
}

/** Forward drawing transform: where the frame point (u, v) lands in the scene (the exact inverse of frameUV). */
export function framePoint(u: number, v: number, placement: Placement): Point {
  const pose = placement.pose;
  const lx = (placement.offsetX + u * placement.width) * pose.scaleX;
  const ly = (placement.offsetY + v * placement.height) * pose.scaleY;
  const cos = Math.cos(pose.rotation), sin = Math.sin(pose.rotation);
  return { x: placement.anchorX + pose.dx + lx * cos - ly * sin, y: placement.anchorY + pose.dy + lx * sin + ly * cos };
}

/**
 * Axis-aligned scene bounds of the transformed sprite rect: every pixel `frameUV` can map into the
 * frame lies inside. Non-finite input gives a non-finite rect (buildInterestRects drops those).
 */
export function placementBounds(placement: Placement): Rect {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
    const corner = framePoint(u, v, placement);
    left = Math.min(left, corner.x); right = Math.max(right, corner.x);
    top = Math.min(top, corner.y); bottom = Math.max(bottom, corner.y);
  }
  if (![left, top, right, bottom].every(Number.isFinite)) return { x: NaN, y: NaN, width: NaN, height: NaN };
  return { x: left, y: top, width: right - left, height: bottom - top };
}
