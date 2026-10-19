import { describe, expect, it } from 'vitest';
import {
  CRUMBS_S, DEFAULT_SPRITE_HEIGHT, DUST_PUFF_S, HEART_PUFF_S, HEART_RISE_S, HEART_SIZE, HELD_HEART_INTERVAL_S, MAX_PARTICLES, STATIC_Z_SIZES, Z_INTERVAL_S, Z_LIFE_S,
  crumbs, dustPuff, heartPuff, particleBounds, petHearts, sleepZs, type Particle,
} from '../src/core/effects';

const KINDS = ['heart', 'z', 'dust', 'crumb', 'puff'];
const effects: ReadonlyArray<readonly [string, (time: number, reduced: boolean) => Particle[]]> = [
  ['click hearts', (time, reduced) => petHearts(300, 200, time, false, reduced)],
  ['held hearts', (time, reduced) => petHearts(300, 200, time, true, reduced)],
  ['sleep zs', (time, reduced) => sleepZs(320, 240, time, reduced)],
  ['sleep zs (large sprite)', (time, reduced) => sleepZs(320, 240, time, reduced, 225.9)],
  ['dust puff', (time, reduced) => dustPuff(400, 380, time, 128, reduced)],
  ['crumbs', (time, reduced) => crumbs(420, 380, time, 192, reduced)],
  ['heart puff', (time, reduced) => heartPuff(500, 260, time, reduced)],
];
const times = (from: number, to: number, step: number) => {
  const values: number[] = [];
  for (let index = 0; from + index * step < to; index++) values.push(from + index * step);
  return values;
};

describe('analytic particles: contracts', () => {
  it('keeps every particle finite, its alpha in [0, 1] and at most eight per effect', () => {
    // A dense grid plus every window edge and birth time (±1 ns). The checks are plain comparisons
    // collected per effect and asserted once: an expect per particle field costs seconds here.
    const edges = [0, HEART_RISE_S, DUST_PUFF_S, CRUMBS_S, HEART_PUFF_S, 0.6 * HEART_PUFF_S, Z_LIFE_S,
      ...Array.from({ length: 16 }, (_, k) => k * HELD_HEART_INTERVAL_S), ...Array.from({ length: 12 }, (_, k) => k * Z_INTERVAL_S)];
    const grid = [...times(0, 12, 0.005), ...edges.flatMap(edge => [edge - 1e-9, edge, edge + 1e-9]), 100000.123, 0.8, 1.6, 3.3];
    let seen = 0;
    for (const [name, effect] of effects) for (const reduced of [false, true]) {
      const violations: string[] = [];
      for (const time of grid) {
        const particles = effect(time, reduced);
        seen += particles.length;
        const at = `${name} reduced=${reduced} t=${time}`;
        if (particles.length > MAX_PARTICLES) violations.push(`${at}: ${particles.length} particles`);
        particles.forEach((item, index) => {
          if (!KINDS.includes(item.kind)) violations.push(`${at} #${index}: kind ${item.kind}`);
          if (![item.x, item.y, item.size, item.alpha, item.rotation].every(Number.isFinite)) violations.push(`${at} #${index}: not finite ${JSON.stringify(item)}`);
          if (!(item.alpha >= 0 && item.alpha <= 1)) violations.push(`${at} #${index}: alpha ${item.alpha}`);
          if (!(item.size >= 0)) violations.push(`${at} #${index}: size ${item.size}`);
        });
      }
      expect(violations.slice(0, 20)).toEqual([]);
    }
    // The checks really ran over a dense stream of particles.
    expect(seen).toBeGreaterThan(30000);
  });

  it('is deterministic: equal inputs give equal particles, with no state between calls', () => {
    for (const [, effect] of effects) for (const time of [0.01, 0.2, 0.55, 1.3, 2.9, 7.25]) {
      const first = effect(time, false);
      effect(time + 0.37, false);   // an unrelated call in between changes nothing
      expect(effect(time, false)).toEqual(first);
    }
  });

  it('varies particles by index, not by chance', () => {
    // Two held hearts of the same age drift differently, and a later identical age repeats exactly.
    const second = petHearts(300, 200, HELD_HEART_INTERVAL_S + 0.5, true, false).at(-1)!;
    const third = petHearts(300, 200, 2 * HELD_HEART_INTERVAL_S + 0.5, true, false).at(-1)!;
    expect(second.y).toBeCloseTo(third.y, 9);   // same age, same rise
    expect(second.x).not.toBeCloseTo(third.x, 3);
    const dust = dustPuff(400, 380, 0.1, 128, false);
    expect(new Set(dust.map(item => item.size.toFixed(6))).size).toBeGreaterThan(1);
  });

  it('returns nothing for invalid input or outside the effect window', () => {
    expect(petHearts(NaN, 200, 0.5, false, false)).toEqual([]);
    expect(petHearts(300, 200, NaN, true, false)).toEqual([]);
    expect(petHearts(300, 200, -0.1, false, false)).toEqual([]);
    expect(sleepZs(320, Infinity, 1, false)).toEqual([]);
    expect(sleepZs(320, 240, -1, false)).toEqual([]);
    expect(dustPuff(400, 380, -0.01, 128, false)).toEqual([]);
    expect(dustPuff(400, 380, 0.1, 0, false)).toEqual([]);
    expect(dustPuff(400, 380, 0.1, NaN, false)).toEqual([]);
    expect(crumbs(400, NaN, 0.1, 128, false)).toEqual([]);
    expect(crumbs(400, 380, 0.1, -5, false)).toEqual([]);
    expect(heartPuff(500, 260, NaN, false)).toEqual([]);
    expect(heartPuff(500, 260, -0.2, false)).toEqual([]);
  });
});

describe('analytic particles: Gentler motion', () => {
  it('shows today\'s single static heart and two static z\'s, and no new particles', () => {
    const heart: Particle = { kind: 'heart', x: 300, y: 200, size: HEART_SIZE, alpha: 1, rotation: 0 };
    for (const time of [0, 0.4, 1.7, 7.9, NaN]) for (const held of [false, true]) expect(petHearts(300, 200, time, held, true)).toEqual([heart]);
    expect(HEART_SIZE).toBe(16);   // the 1.0.2 heart path at scale 0.8 (size / HEART_PATH_WIDTH)
    // 1.0.2 drew z's at (0.25, 0.32) and (0.32, 0.21) of the sprite: the small one 0.07 × width right, 0.11 × height up.
    for (const time of [0, 2.5, 40]) {
      expect(sleepZs(320, 240, time, true)).toEqual([
        { kind: 'z', x: 320, y: 240, size: 15, alpha: 1, rotation: 0 },
        { kind: 'z', x: 320 + 0.07 * DEFAULT_SPRITE_HEIGHT, y: 240 - 0.11 * DEFAULT_SPRITE_HEIGHT, size: 11, alpha: 1, rotation: 0 },
      ]);
    }
    expect(STATIC_Z_SIZES).toEqual([15, 11]);
    const large = sleepZs(320, 240, 1, true, 200);
    expect(large[1].x).toBeCloseTo(334, 9);
    expect(large[1].y).toBeCloseTo(218, 9);
    for (const time of times(0, 1, 0.01)) {
      expect(dustPuff(400, 380, time, 128, true)).toEqual([]);
      expect(crumbs(400, 380, time, 128, true)).toEqual([]);
      expect(heartPuff(500, 260, time, true)).toEqual([]);
    }
  });
});

describe('analytic particles: timelines', () => {
  it('raises one heart for 1.6 s after a click, fading in and out', () => {
    expect(HEART_RISE_S).toBe(1.6);
    let previousY = Infinity, peak = 0;
    for (const time of times(0, HEART_RISE_S, 0.01)) {
      const hearts = petHearts(300, 200, time, false, false);
      expect(hearts).toHaveLength(1);
      expect(hearts[0].kind).toBe('heart');
      expect(hearts[0].y).toBeLessThan(previousY);
      expect(hearts[0].y).toBeLessThanOrEqual(200);
      previousY = hearts[0].y;
      peak = Math.max(peak, hearts[0].alpha);
    }
    expect(peak).toBe(1);
    expect(petHearts(300, 200, 0, false, false)[0].alpha).toBe(0);
    expect(petHearts(300, 200, 1.595, false, false)[0].alpha).toBeLessThan(0.02);
    expect(200 - previousY).toBeGreaterThan(25);
    expect(petHearts(300, 200, HEART_RISE_S, false, false)).toEqual([]);
    expect(petHearts(300, 200, 1.95, false, false)).toEqual([]);
  });

  it('adds a held heart every 0.8 s, each rising for 1.6 s', () => {
    expect(HELD_HEART_INTERVAL_S).toBe(0.8);
    expect(petHearts(300, 200, 0.4, true, false)).toHaveLength(1);
    expect(petHearts(300, 200, 1.2, true, false)).toHaveLength(2);
    expect(petHearts(300, 200, 2.0, true, false)).toHaveLength(2);
    expect(petHearts(300, 200, 7.9, true, false)).toHaveLength(2);
    for (let index = 0; index < 10; index++) {
      const born = petHearts(300, 200, index * HELD_HEART_INTERVAL_S + 0.001, true, false);
      expect(born.at(-1)!.y).toBeCloseTo(200, 1);   // the newest heart starts at the origin
      expect(born.length).toBeLessThanOrEqual(3);
    }
    // The first held heart rises exactly like a click heart.
    expect(petHearts(300, 200, 0.7, true, false)).toEqual(petHearts(300, 200, 0.7, false, false));
  });

  it('raises, drifts, grows and fades sleep z\'s, at most three at a time', () => {
    expect(Z_LIFE_S).toBeLessThan(3 * Z_INTERVAL_S);
    let previous: Particle | null = null;
    for (const time of times(0, Z_LIFE_S, 0.01)) {
      const zs = sleepZs(320, 240, time, false);
      expect(zs.length).toBeLessThanOrEqual(3);
      expect(zs.length).toBeGreaterThanOrEqual(1);
      const first = zs[0];   // the oldest z first (draw order); here always the one born at 0
      expect(first.kind).toBe('z');
      expect(first.y).toBeLessThanOrEqual(240);
      if (previous) {
        expect(first.y).toBeLessThan(previous.y);
        expect(first.size).toBeGreaterThan(previous.size);
      }
      previous = first;
    }
    expect(sleepZs(320, 240, 0, false)[0].alpha).toBe(0);
    expect(previous!.alpha).toBeLessThan(0.02);
    expect(sleepZs(320, 240, 1.2, false)).toHaveLength(2);
    expect(sleepZs(320, 240, 2.3, false)).toHaveLength(3);
    for (const time of times(0, 60, 0.05)) expect(sleepZs(320, 240, time, false).length).toBeLessThanOrEqual(3);
    // Any monotonic clock works: a long-running renderer clock still yields a steady stream.
    expect(sleepZs(320, 240, 86400.5, false).length).toBeGreaterThanOrEqual(2);
  });

  it('puffs dust out on both sides of the paws for 0.35 s after landing', () => {
    expect(DUST_PUFF_S).toBe(0.35);
    const early = dustPuff(400, 380, 0.05, 128, false), late = dustPuff(400, 380, 0.3, 128, false);
    expect(early).toHaveLength(6);
    expect(early.filter(item => item.x < 400)).toHaveLength(3);
    expect(early.filter(item => item.x > 400)).toHaveLength(3);
    const spread = (items: Particle[]) => items.reduce((sum, item) => sum + Math.abs(item.x - 400), 0) / items.length;
    expect(spread(late)).toBeGreaterThan(spread(early));
    for (const item of [...early, ...late]) {
      expect(item.kind).toBe('dust');
      expect(item.y).toBeLessThanOrEqual(380);
    }
    expect(late.every(item => item.alpha < early[0].alpha + 0.3)).toBe(true);
    expect(dustPuff(400, 380, DUST_PUFF_S, 128, false)).toEqual([]);
    expect(dustPuff(400, 380, 2, 128, false)).toEqual([]);
    // The puff scales with the kitten.
    expect(spread(dustPuff(400, 380, 0.2, 192, false))).toBeCloseTo(spread(dustPuff(400, 380, 0.2, 96, false)) * 2, 9);
  });

  it('scatters crumbs that hop once, settle on the ground and fade within 0.6 s', () => {
    expect(CRUMBS_S).toBe(0.6);
    for (const time of times(0, CRUMBS_S, 0.01)) {
      const items = crumbs(420, 380, time, 128, false);
      expect(items).toHaveLength(5);
      for (const item of items) {
        expect(item.kind).toBe('crumb');
        expect(item.y + item.size / 2).toBeLessThanOrEqual(380 + 1e-9);
        expect(Math.abs(item.x - 420)).toBeLessThan(0.3 * 128);
      }
    }
    const settled = crumbs(420, 380, 0.45, 128, false);
    for (const item of settled) expect(item.y + item.size / 2).toBeCloseTo(380, 9);
    expect(crumbs(420, 380, 0.1, 128, false).every(item => item.alpha === 1)).toBe(true);
    expect(crumbs(420, 380, 0.595, 128, false).every(item => item.alpha < 0.02)).toBe(true);
    expect(crumbs(420, 380, CRUMBS_S, 128, false)).toEqual([]);
  });

  it('pops a heart with a burst of puffs at nose contact for 0.9 s', () => {
    expect(HEART_PUFF_S).toBe(0.9);
    const burst = heartPuff(500, 260, 0.1, false);
    expect(burst.filter(item => item.kind === 'puff')).toHaveLength(5);
    expect(burst.at(-1)!.kind).toBe('heart');   // drawn last, over the puffs
    expect(burst.filter(item => item.kind === 'puff').every(item => item.y < 260)).toBe(true);   // the fan opens upward
    expect(heartPuff(500, 260, 0.6, false).map(item => item.kind)).toEqual(['heart']);
    const heart = heartPuff(500, 260, 0.5, false).at(-1)!;
    expect(heart.kind).toBe('heart');
    expect(heart.y).toBeLessThan(260);
    expect(heart.alpha).toBe(1);
    expect(heartPuff(500, 260, 0.895, false).at(-1)!.alpha).toBeLessThan(0.02);
    expect(heartPuff(500, 260, HEART_PUFF_S, false)).toEqual([]);
  });
});

describe('analytic particles: bounds', () => {
  it('bounds drawn particles conservatively, or returns null for none', () => {
    expect(particleBounds([])).toBeNull();
    const items = [...petHearts(300, 200, 2.1, true, false), ...sleepZs(320, 240, 2.5, false), ...dustPuff(400, 380, 0.2, 128, false)];
    const bounds = particleBounds(items)!;
    for (const item of items) {
      const reach = item.kind === 'heart' ? 0.7 * item.size : item.kind === 'z' ? 0.8 * item.size : item.size / 2;
      expect(item.x - reach).toBeGreaterThanOrEqual(bounds.x);
      expect(item.y - reach).toBeGreaterThanOrEqual(bounds.y);
      expect(item.x + reach).toBeLessThanOrEqual(bounds.x + bounds.width);
      expect(item.y + reach).toBeLessThanOrEqual(bounds.y + bounds.height);
    }
    expect(particleBounds([{ kind: 'dust', x: 10, y: 20, size: 8, alpha: 1, rotation: 0 }])).toEqual({ x: 6, y: 16, width: 8, height: 8 });
  });
});
