/**
 * Effect plans for the overlay's non-interactive effect layers (Phase 2 spec 5.5): per kitten the pet
 * hearts, sleep z's, landing dust puff, its dropped treat and the crumbs; for the pair the place of
 * the nose-touch heart puff. Pure; the overlay draws what these return. None of it is hit-tested.
 * Under reduced motion or Quiet Mode (`calm`) only the static 1.0.2 glyphs remain: one heart, two z's
 * and the treat.
 */
import { crumbs, dustPuff, petHearts, sleepZs, type Particle } from '../core/effects';
import { EAT_DURATION } from '../core/engine';
import { framePoint, type Placement } from '../core/motion';
import type { Facing, PetState, Point, Rect, TreatState } from '../shared/types';
import type { LayerKeys } from './pacing';

/** 1.0.2 effect anchors on the untransformed sprite rect: the heart near the head, the first z above it. */
export const HEART_ORIGIN_U = 0.23, HEART_ORIGIN_DY = 10;
export const Z_ORIGIN_U = 0.25, Z_ORIGIN_V = 0.32;
/** The 1.0.2 treat glyph at kitten size 128: a 14 × 8 DIP rounded rect. Treats scale with their kitten. */
export const TREAT_WIDTH = 14, TREAT_HEIGHT = 8, TREAT_REFERENCE_SIZE = 128;
/** While its kitten eats, the treat shrinks to this fraction of its size. */
export const TREAT_EATEN_SCALE = 0.5;
/** Normalized nose point of a right-facing nose_touch frame (bundled art: Archie ≈ 0.87, 0.51; Jumi ≈ 0.90, 0.56). */
export const NOSE_U = 0.88, NOSE_V = 0.53;
/** The heart puff starts this far above the touching noses, DIP. */
export const PUFF_LIFT = 6;

/** A treat to draw: its ground line, height above it and scale (1 at kitten size 128). */
export interface TreatGlyph { x: number; groundY: number; z: number; scale: number }

export interface KittenFx {
  /** Draw order: ground effects first (crumbs, dust), then hearts and z's. */
  particles: Particle[];
  treat: TreatGlyph | null;
  /** The landing dust puff (a renderer-clock effect) is running. */
  dusting: boolean;
}

export interface KittenFxInput {
  pet: PetState;
  /** The kitten's untransformed sprite rect (the 1.0.2 rect) and its ground anchor. */
  rect: Rect;
  anchor: Point;
  /** Renderer seconds. */
  time: number;
  calm: boolean;
  /** When the engine action last changed by name (the z's count from it), and when the kitten last landed. */
  actionSince: number | null;
  landedAt: number | null;
  /** This kitten's treat, if any, and its ground line offset (footOffset of this kitten). */
  treat: TreatState | null;
  footOffset: number;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export function kittenFx(input: KittenFxInput): KittenFx {
  const { pet, rect, time, calm } = input;
  const particles: Particle[] = [];
  let treat: TreatGlyph | null = null;
  if (input.treat) {
    const groundY = input.treat.y + input.footOffset;
    if (input.treat.phase === 'eaten') {
      particles.push(...crumbs(input.treat.x, groundY, input.treat.elapsed, pet.size, calm));
    } else {
      const eaten = !calm && pet.action === 'eat' ? clamp01(pet.actionTime / EAT_DURATION) : 0;
      const scale = pet.size / TREAT_REFERENCE_SIZE * (1 - (1 - TREAT_EATEN_SCALE) * eaten);
      treat = { x: input.treat.x, groundY, z: Math.max(0, input.treat.z), scale };
    }
  }
  const dust = input.landedAt === null ? [] : dustPuff(input.anchor.x, input.anchor.y, time - input.landedAt, pet.size, calm);
  particles.push(...dust);
  if (pet.action === 'pet') {
    particles.push(...petHearts(pet.x + rect.width * HEART_ORIGIN_U, rect.y + HEART_ORIGIN_DY, pet.actionTime, pet.held, calm));
  }
  if (pet.action === 'sleep') {
    const asleep = input.actionSince === null ? pet.actionTime : time - input.actionSince;
    particles.push(...sleepZs(pet.x + rect.width * Z_ORIGIN_U, rect.y + rect.height * Z_ORIGIN_V, asleep, calm, rect.height));
  }
  return { particles: particles.filter(particle => particle.alpha > 0 && particle.size > 0), treat, dusting: dust.length > 0 };
}

/** Scene bounds of a treat glyph and its ground shadow. */
export function treatBounds(treat: TreatGlyph): Rect {
  const halfWidth = TREAT_WIDTH / 2 * treat.scale;
  const top = treat.groundY - treat.z - TREAT_HEIGHT * treat.scale;
  return { x: treat.x - halfWidth, y: top, width: halfWidth * 2, height: treat.groundY + 2 * treat.scale - top };
}

const q = (value: number, step: number) => Math.round(value / step);

/** Quantized particle key (0.5 DIP, 1/64 alpha, 0.25°): equal keys draw the same pixels. */
export function particlesKey(particles: readonly Particle[]): string {
  return particles.map(p => [p.kind, q(p.x, 0.5), q(p.y, 0.5), q(p.size, 0.5), q(p.alpha, 1 / 64), q(p.rotation * 180 / Math.PI, 0.25)].join(',')).join(';');
}

/** Layer keys of a kitten's effects: the sleep z's are ambient, everything else active. */
export function kittenFxKeys(fx: KittenFx): LayerKeys {
  const treat = fx.treat ? [q(fx.treat.x, 0.5), q(fx.treat.groundY, 0.5), q(fx.treat.z, 0.5), q(fx.treat.scale, 1 / 64)].join(',') : '';
  return {
    active: `${treat}|${particlesKey(fx.particles.filter(p => p.kind !== 'z'))}`,
    ambient: particlesKey(fx.particles.filter(p => p.kind === 'z')),
  };
}

/** Where two touching noses meet, lifted by PUFF_LIFT: the midpoint of both drawn nose points. */
export function noseContact(a: { placement: Placement; facing: Facing }, b: { placement: Placement; facing: Facing }): Point {
  const nose = (kitten: { placement: Placement; facing: Facing }) => framePoint(kitten.facing === 'left' ? 1 - NOSE_U : NOSE_U, NOSE_V, kitten.placement);
  const p = nose(a), r = nose(b);
  return { x: (p.x + r.x) / 2, y: (p.y + r.y) / 2 - PUFF_LIFT };
}
