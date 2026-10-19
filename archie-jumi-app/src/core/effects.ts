/**
 * Analytic particles (Phase 2 spec 3.2). Pure and deterministic, no DOM and no stored state: every
 * particle is a function of the effect's inputs and its index, varied by an integer hash of the index.
 *
 * Units: positions are scene DIP, times seconds, rotation radians (canvas convention, positive =
 * clockwise). `size` is in DIP and means, per kind:
 *  - heart: the 1.0.2 overlay heart path with its origin at (x, y), rotated by `rotation` and scaled
 *    by size / HEART_PATH_WIDTH (HEART_SIZE 16 is today's heart, drawn at scale 0.8);
 *  - z: the font size of a '600 {size}px Segoe UI' "z" drawn with fillText at (x, y) with today's
 *    left/alphabetic alignment, rotated about (x, y);
 *  - dust, puff: the diameter of a soft round blob centred at (x, y);
 *  - crumb: the diameter of a crumb centred at (x, y), rotated by `rotation`.
 * Every alpha is within [0, 1] (particles may sit at 0 at the very start or end of their life),
 * each call returns at most MAX_PARTICLES particles, and an effect outside its window returns [].
 */
import type { Rect } from '../shared/types';

export interface Particle { kind: 'heart' | 'z' | 'dust' | 'crumb' | 'puff'; x: number; y: number; size: number; alpha: number; rotation: number }
export type ParticleKind = Particle['kind'];

export const MAX_PARTICLES = 8;
/** Width of the 1.0.2 heart path in its own units (it spans x ±9.6, y −12.2..4 around its origin). */
export const HEART_PATH_WIDTH = 20;
/** Today's heart (the path at scale 0.8). */
export const HEART_SIZE = 16;
/** Each pet heart rises and fades over this long; a held pet adds one every HELD_HEART_INTERVAL_S. */
export const HEART_RISE_S = 1.6, HELD_HEART_INTERVAL_S = 0.8;
export const HEART_RISE_DIP = 30;
/** A new sleep z every Z_INTERVAL_S, each living Z_LIFE_S (so at most three at once). */
export const Z_INTERVAL_S = 1.1, Z_LIFE_S = 3.2;
/** Font sizes of today's two static z's (the lower one first). */
export const STATIC_Z_SIZES = [15, 11] as const;
/** Font sizes of a rising z at birth and at the end of its life. */
export const Z_SIZE_START = 9, Z_SIZE_END = 15;
/** Drawn sprite height of a 128 DIP kitten (frame height × size / (0.85 × frame height)): the default z layout. */
export const DEFAULT_SPRITE_HEIGHT = 128 / 0.85;
/** Effect windows, seconds. */
export const DUST_PUFF_S = 0.35, CRUMBS_S = 0.6, HEART_PUFF_S = 0.9;

const SALT_HEART = 0x2c1b3c6d, SALT_Z = 0x297a2d39, SALT_DUST = 0x6c8e9cf5, SALT_CRUMB = 0x4f6cdd1d, SALT_PUFF = 0x1b873593;

/** Integer hash of (index, channel, salt) to [0, 1) (murmur3 finalizer): the per-particle variation. */
function noise(index: number, channel: number, salt: number): number {
  let h = (Math.imul(index | 0, 0x9e3779b1) ^ Math.imul(channel | 0, 0x85ebca77) ^ salt) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const allFinite = (...values: number[]) => values.every(Number.isFinite);
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const easeOutQuad = (t: number) => 1 - (1 - t) ** 2;
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
/** Ease-out with a small overshoot (to about 1.1): a pop. */
const easeOutBack = (t: number) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;
/** Opacity over a life fraction p: rises until `fadeIn`, holds, falls from `fadeOut` to 0 at p = 1. */
function envelope(p: number, fadeIn: number, fadeOut: number): number {
  const rising = fadeIn > 0 ? p / fadeIn : 1;
  const falling = fadeOut < 1 ? (1 - p) / (1 - fadeOut) : 1;
  return clamp01(Math.min(rising, falling));
}
function particle(kind: ParticleKind, x: number, y: number, size: number, alpha: number, rotation: number): Particle {
  return { kind, x, y, size: Math.max(0, size), alpha: clamp01(alpha), rotation: rotation === 0 ? 0 : rotation };
}

function risingHeart(originX: number, originY: number, age: number, index: number): Particle {
  const p = age / HEART_RISE_S;
  const drift = (noise(index, 0, SALT_HEART) - 0.5) * 12;
  const phase = noise(index, 1, SALT_HEART);
  const tilt = (noise(index, 2, SALT_HEART) - 0.5) * 0.4;
  const x = originX + drift * easeOutCubic(p) + 1.5 * Math.sin(2 * Math.PI * (1.5 * p + phase));
  const y = originY - HEART_RISE_DIP * easeOutQuad(p);
  const size = HEART_SIZE * (0.55 + 0.45 * easeOutBack(clamp01(age / 0.25)));
  return particle('heart', x, y, size, envelope(p, 0.08, 0.6), tilt * Math.sin(Math.PI * p));
}

/**
 * Pet hearts from `originX/Y` (today's heart point, near the head). A click (`held` false): one heart
 * rising and fading over HEART_RISE_S of `actionTime`. Held: a new heart every HELD_HEART_INTERVAL_S,
 * each with the same rise. Reduced motion: today's single static heart at the origin.
 */
export function petHearts(originX: number, originY: number, actionTime: number, held: boolean, reduced: boolean): Particle[] {
  if (!allFinite(originX, originY)) return [];
  if (reduced) return [particle('heart', originX, originY, HEART_SIZE, 1, 0)];
  if (!Number.isFinite(actionTime) || actionTime < 0) return [];
  const hearts: Particle[] = [];
  const newest = held ? Math.floor(actionTime / HELD_HEART_INTERVAL_S) : 0;
  const oldest = held ? Math.max(0, Math.floor((actionTime - HEART_RISE_S) / HELD_HEART_INTERVAL_S)) : 0;
  for (let index = oldest; index <= newest && hearts.length < MAX_PARTICLES; index++) {
    const age = actionTime - index * HELD_HEART_INTERVAL_S;
    if (age >= 0 && age < HEART_RISE_S) hearts.push(risingHeart(originX, originY, age, index));
  }
  return hearts;
}

/**
 * Sleep z's: rising, drifting to the right, growing and fading, born one every Z_INTERVAL_S of `time`
 * (seconds since the kitten fell asleep is recommended; any clock works). Reduced motion: today's two
 * static z's, the 15 px one at the origin and the 11 px one up and to the right of it. `spriteHeight`
 * (optional, the drawn sprite height in DIP) scales the layout as today's z's scale with the sprite.
 */
export function sleepZs(originX: number, originY: number, time: number, reduced: boolean, spriteHeight = DEFAULT_SPRITE_HEIGHT): Particle[] {
  if (!allFinite(originX, originY)) return [];
  const extent = Number.isFinite(spriteHeight) && spriteHeight > 0 ? spriteHeight : DEFAULT_SPRITE_HEIGHT;
  if (reduced) {
    return [
      particle('z', originX, originY, STATIC_Z_SIZES[0], 1, 0),
      particle('z', originX + 0.07 * extent, originY - 0.11 * extent, STATIC_Z_SIZES[1], 1, 0),
    ];
  }
  if (!Number.isFinite(time) || time < 0) return [];
  const zs: Particle[] = [];
  const newest = Math.floor(time / Z_INTERVAL_S);
  for (let index = Math.max(0, Math.floor((time - Z_LIFE_S) / Z_INTERVAL_S)); index <= newest && zs.length < MAX_PARTICLES; index++) {
    const age = time - index * Z_INTERVAL_S;
    if (age < 0 || age >= Z_LIFE_S) continue;
    const p = age / Z_LIFE_S;
    const jitter = noise(index, 0, SALT_Z) - 0.5, phase = noise(index, 1, SALT_Z), tilt = noise(index, 2, SALT_Z) - 0.5;
    const x = originX + (0.03 * jitter + 0.08 * p) * extent + 0.025 * extent * Math.sin(2 * Math.PI * (0.8 * p + phase));
    const y = originY - 0.23 * extent * easeOutQuad(p);
    const size = Z_SIZE_START + (Z_SIZE_END - Z_SIZE_START) * p;
    zs.push(particle('z', x, y, size, envelope(p, 0.15, 0.6), 0.5 * tilt + 0.12 * Math.sin(2 * Math.PI * (p + phase))));
  }
  return zs;
}

/** A dust puff at the paws for DUST_PUFF_S after landing: six blobs spreading out on both sides and fading. Nothing under reduced motion. */
export function dustPuff(x: number, groundY: number, sinceLand: number, size: number, reduced: boolean): Particle[] {
  if (reduced || !allFinite(x, groundY, sinceLand, size) || size <= 0 || sinceLand < 0 || sinceLand >= DUST_PUFF_S) return [];
  const p = sinceLand / DUST_PUFF_S, spread = easeOutCubic(p);
  const puffs: Particle[] = [];
  for (let index = 0; index < 6; index++) {
    const side = index % 2 === 0 ? -1 : 1;
    const start = 0.1 + 0.06 * noise(index, 0, SALT_DUST), travel = 0.1 + 0.1 * noise(index, 1, SALT_DUST);
    const px = x + side * (start + travel * spread) * size;
    const py = groundY - (0.01 + 0.05 * noise(index, 2, SALT_DUST)) * size * spread;
    const diameter = (0.06 + 0.05 * noise(index, 3, SALT_DUST)) * size * (0.6 + 0.7 * spread);
    puffs.push(particle('dust', px, py, diameter, 0.55 * envelope(p, 0.1, 0.35), 0));
  }
  return puffs;
}

/** Crumbs where a treat was eaten, for CRUMBS_S: five crumbs hop out once, settle on the ground and fade. Nothing under reduced motion. */
export function crumbs(x: number, groundY: number, sinceEaten: number, size: number, reduced: boolean): Particle[] {
  if (reduced || !allFinite(x, groundY, sinceEaten, size) || size <= 0 || sinceEaten < 0 || sinceEaten >= CRUMBS_S) return [];
  const p = sinceEaten / CRUMBS_S, hop = clamp01(p / 0.4);
  const result: Particle[] = [];
  for (let index = 0; index < 5; index++) {
    const scatter = noise(index, 1, SALT_CRUMB) - 0.5;
    const diameter = (0.02 + 0.015 * noise(index, 3, SALT_CRUMB)) * size;
    const px = x + (noise(index, 0, SALT_CRUMB) - 0.5) * 0.16 * size + scatter * 0.14 * size * easeOutCubic(hop);
    const py = groundY - diameter / 2 - (0.015 + 0.03 * noise(index, 2, SALT_CRUMB)) * size * Math.sin(Math.PI * hop);
    const rotation = noise(index, 4, SALT_CRUMB) * 2 * Math.PI + scatter * 6 * hop;
    result.push(particle('crumb', px, py, diameter, envelope(p, 0, 0.5), rotation));
  }
  return result;
}

/**
 * The nose-touch heart puff (I8) at the contact point, for HEART_PUFF_S: a fan of five soft puffs
 * bursting upward (gone after 60 % of the window) behind a heart that pops, rises and fades.
 * Nothing under reduced motion.
 */
export function heartPuff(x: number, y: number, sinceContact: number, reduced: boolean): Particle[] {
  if (reduced || !allFinite(x, y, sinceContact) || sinceContact < 0 || sinceContact >= HEART_PUFF_S) return [];
  const p = sinceContact / HEART_PUFF_S, burst = p / 0.6;
  const result: Particle[] = [];
  if (burst < 1) {
    const spread = easeOutCubic(burst);
    for (let index = 0; index < 5; index++) {
      const angle = -Math.PI / 2 + (index - 2) * 0.62 + (noise(index, 0, SALT_PUFF) - 0.5) * 0.3;
      const radius = (6 + 16 * spread) * (0.85 + 0.3 * noise(index, 1, SALT_PUFF));
      const diameter = (4 + 3 * noise(index, 2, SALT_PUFF)) * (1 - 0.4 * burst);
      result.push(particle('puff', x + Math.cos(angle) * radius, y + Math.sin(angle) * radius * 0.8, diameter, 0.7 * envelope(burst, 0.1, 0.3), 0));
    }
  }
  const size = HEART_SIZE * 1.1 * (0.4 + 0.6 * easeOutBack(clamp01(sinceContact / 0.3)));
  result.push(particle('heart', x, y - 18 * easeOutCubic(p), size, envelope(p, 0.08, 0.6), 0));
  return result;
}

/**
 * Conservative scene bounds of drawn particles (for sizing a non-interactive effects layer), or null
 * for none: a heart reaches 0.85 × size from its origin (the path itself reaches 0.70 × size), a z
 * glyph up to its font size, a blob or crumb half its diameter.
 */
export function particleBounds(particles: readonly Particle[]): Rect | null {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const item of particles) {
    const reach = item.kind === 'heart' ? 0.85 * item.size : item.kind === 'z' ? item.size : item.size / 2;
    if (!allFinite(item.x, item.y, reach)) continue;
    left = Math.min(left, item.x - reach); right = Math.max(right, item.x + reach);
    top = Math.min(top, item.y - reach); bottom = Math.max(bottom, item.y + reach);
  }
  return left <= right ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}
