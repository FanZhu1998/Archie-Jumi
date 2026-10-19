import { describe, expect, it } from 'vitest';
import {
  PetEngine, PAIR_COOLDOWN, BAT_MAX, BAT_MIN, CHASE_SPEED, HELD_PET_MAX, LEAP_HEIGHT, PAIR_SPEED, POUNCE_CROUCH, POUNCE_LEAP, QUIET_SPEED,
  TOY_RANGE_X, TOY_RANGE_Y, TOY_SPEED, TROT_SPEED, WAKE_DURATION, WALK_SPEED,
  batChance, curiousApproachChance, energyFactor, pounceChance, speedFor, treatHeight,
} from '../src/core/engine';
import { PointerGesture, exceedsDragThreshold } from '../src/core/input';
import { defaultPreferences } from '../src/shared/defaults';
import { PET_IDS } from '../src/shared/types';
import type { Personality, PetId, PetState, Point, Preferences } from '../src/shared/types';

const scene = { width: 1280, height: 720 };
const step = (engine: PetEngine, seconds: number) => {
  for (let remaining = seconds; remaining > 0.000001; remaining -= 0.1) engine.step(Math.min(0.1, remaining));
};
const pet = (engine: PetEngine, id: PetId = 'archie') => engine.snapshot().pets.find(candidate => candidate.id === id)!;
const make = (preferences = defaultPreferences(), random = () => 0.5) => new PetEngine(preferences, scene, random);
function seeded(seed: number): () => number {
  let value = seed;
  return () => { value = (Math.imul(value, 1664525) + 1013904223) | 0; return (value >>> 0) / 4294967296; };
}
function preferencesWithoutSocial(): Preferences {
  const preferences = defaultPreferences();
  preferences.pets.archie.personality.sociability = 0;
  preferences.pets.jumi.personality.sociability = 0;
  return preferences;
}

describe('PetEngine interaction contracts', () => {
  it('starts in the supplied normalized positions with recognizable independent pets', () => {
    const engine = make();
    expect(pet(engine).x).toBeCloseTo(1280 * 0.35);
    expect(pet(engine, 'jumi').x).toBeCloseTo(1280 * 0.65);
    expect(engine.positions().archie.y).toBeCloseTo(0.72);
    expect(engine.snapshot().pets.map(value => value.id)).toEqual(['archie', 'jumi']);
  });

  it('restarts petting instead of queueing it, then settles after two seconds', () => {
    const engine = make();
    engine.command({ type: 'pet', petId: 'archie' });
    step(engine, 1.5);
    engine.command({ type: 'pet', petId: 'archie' });
    expect(pet(engine).actionTime).toBe(0);
    step(engine, 1.9);
    expect(pet(engine).action).toBe('pet');
    step(engine, 0.2);
    expect(pet(engine).action).toBe('sit');
  });

  it('keeps requested sleep indefinitely until an interaction, with no absence penalties', () => {
    const engine = make();
    engine.command({ type: 'nap', petId: 'archie' });
    step(engine, 240);
    expect(pet(engine)).toMatchObject({ action: 'sleep', forcedSleep: true });
    // 1.1.0: the treat drops ahead and the kitten walks over before eating (see 'treats' below).
    engine.command({ type: 'treat', petId: 'archie' });
    expect(pet(engine)).toMatchObject({ forcedSleep: false });
    expect(engine.snapshot().treats).toHaveLength(1);
    step(engine, 3);
    expect(pet(engine)).toMatchObject({ action: 'eat', forcedSleep: false });
    step(engine, 3);
    expect(pet(engine).action).toBe('sit');
  });

  it('holds the carried pose during drag and lands in bounds on release', () => {
    const engine = make();
    engine.command({ type: 'drag-start', petId: 'archie', point: { x: 200, y: 200 } });
    step(engine, 15);
    expect(pet(engine)).toMatchObject({ action: 'carried', x: 200, y: 200 });
    engine.command({ type: 'drag', petId: 'archie', point: { x: 300, y: 300 } });
    engine.command({ type: 'drag-end', petId: 'archie', point: { x: -900, y: 9000 } });
    expect(pet(engine).action).toBe('land');
    expect(pet(engine).x).toBeGreaterThan(0);
    expect(pet(engine).y).toBeLessThan(scene.height);
    step(engine, 0.6);
    expect(pet(engine).action).toBe('sit');
  });

  it('does not leave hidden or restored kittens stuck in a carried state', () => {
    const engine = make();
    engine.command({ type: 'drag-start', petId: 'archie', point: { x: 300, y: 300 } });
    engine.command({ type: 'hide', petId: 'archie' });
    const time = pet(engine).actionTime;
    step(engine, 3);
    expect(pet(engine).actionTime).toBe(time);
    engine.command({ type: 'show', petId: 'archie' });
    expect(pet(engine)).toMatchObject({ visible: true, action: 'sit' });
  });

  it('maintains exactly one toy, limits play to thirty seconds and leaves the other kitten independent', () => {
    const engine = make();
    engine.command({ type: 'nap', petId: 'jumi' });
    engine.command({ type: 'play', petId: 'archie', automatic: true });
    const initial = engine.snapshot().toy!;
    step(engine, 1);
    expect(engine.snapshot().toy!.x).not.toBe(initial.x);
    expect(pet(engine, 'jumi')).toMatchObject({ action: 'sleep', forcedSleep: true });
    step(engine, 28.9);
    expect(engine.snapshot().toy).not.toBeNull();
    step(engine, 0.2);
    expect(engine.snapshot().toy).toBeNull();
    engine.command({ type: 'play', petId: 'archie' });
    engine.command({ type: 'play', petId: 'jumi' });
    expect(engine.snapshot().toy!.petId).toBe('jumi');
    expect(pet(engine).action).toBe('sit');
  });

  it('holds a dragged automatic toy, clamps its position and resumes motion after release', () => {
    const engine = make();
    engine.command({ type: 'play', petId: 'archie', automatic: true });
    engine.command({ type: 'toy-move', point: { x: 500, y: 400 }, held: true });
    step(engine, 1);
    expect(engine.snapshot().toy).toMatchObject({ x: 500, y: 400, held: true });
    engine.command({ type: 'toy-move', point: { x: -100, y: 9999 }, held: false });
    expect(engine.snapshot().toy!.x).toBeGreaterThan(0);
    expect(engine.snapshot().toy!.y).toBeLessThan(scene.height);
    engine.command({ type: 'end-play' });
    expect(engine.snapshot().toy).toBeNull();
  });
});

describe('shared activities', () => {
  it('approaches, faces inward, greets, and finishes without leaving a target', () => {
    const engine = make();
    engine.command({ type: 'pair', kind: 'nose_touch' });
    expect(engine.snapshot().pair).toMatchObject({ phase: 'approach', kind: 'nose_touch' });
    step(engine, 3);
    expect(engine.snapshot().pair!.phase).toBe('together');
    expect(pet(engine)).toMatchObject({ action: 'nose_touch', facing: 'right' });
    expect(pet(engine, 'jumi')).toMatchObject({ action: 'nose_touch', facing: 'left' });
    step(engine, 3);
    expect(engine.snapshot().pair).toBeNull();
    expect(engine.snapshot().pets.every(value => value.target === null)).toBe(true);
  });

  it('cancels coordination immediately on user input and enforces the cancellation cooldown', () => {
    const preferences = preferencesWithoutSocial();
    const engine = make(preferences);
    engine.command({ type: 'pair', kind: 'nose_touch' });
    engine.command({ type: 'pet', petId: 'archie' });
    expect(engine.snapshot().pair).toBeNull();
    expect(pet(engine).action).toBe('pet');
    step(engine, 3);
    engine.command({ type: 'pair', kind: 'nap' });
    expect(engine.snapshot().pair).toBeNull();
    step(engine, PAIR_COOLDOWN);
    for (const petId of ['archie', 'jumi'] as const) engine.command({ type: 'move', petId, point: pet(engine, petId) });
    step(engine, 0.6);
    engine.command({ type: 'pair', kind: 'nap' });
    expect(engine.snapshot().pair).not.toBeNull();
  });

  it('enforces the same cooldown after successful completion', () => {
    const engine = make();
    engine.command({ type: 'pair', kind: 'nose_touch' });
    step(engine, 6);
    expect(engine.snapshot().pair).toBeNull();
    engine.command({ type: 'pair', kind: 'nap' });
    expect(engine.snapshot().pair).toBeNull();
  });

  it('lets a sleeping partner remain asleep when the other kitten is interrupted', () => {
    const engine = make();
    engine.command({ type: 'pair', kind: 'nap' });
    step(engine, 3);
    expect(pet(engine, 'jumi').action).toBe('sleep');
    engine.command({ type: 'pet', petId: 'archie' });
    expect(engine.snapshot().pair).toBeNull();
    expect(pet(engine).action).toBe('pet');
    expect(pet(engine, 'jumi').action).toBe('sleep');
  });

  it('does not start without space, with a hidden partner, or during requested sleep', () => {
    const tiny = new PetEngine(defaultPreferences(), { width: 200, height: 150 });
    tiny.command({ type: 'pair', kind: 'nap' });
    expect(tiny.snapshot().pair).toBeNull();
    const engine = make();
    engine.command({ type: 'hide', petId: 'jumi' });
    engine.command({ type: 'pair', kind: 'nap' });
    expect(engine.snapshot().pair).toBeNull();
    engine.command({ type: 'show', petId: 'jumi' });
    engine.command({ type: 'nap', petId: 'jumi' });
    engine.command({ type: 'pair', kind: 'nap' });
    expect(engine.snapshot().pair).toBeNull();
  });
});

describe('preferences, bounds and time', () => {
  it('quiet mode removes toys, settles at the bottom and does not autonomously resume activity', () => {
    const preferences = defaultPreferences();
    const engine = make(preferences);
    engine.command({ type: 'play', petId: 'archie' });
    preferences.quiet = true;
    engine.setPreferences(preferences);
    expect(engine.snapshot().toy).toBeNull();
    step(engine, 15);
    const resting = engine.snapshot().pets;
    expect(resting.every(value => value.action === 'sit' && value.y > 600)).toBe(true);
    step(engine, 180);
    expect(engine.snapshot().pets.map(({ x, y, action }) => ({ x, y, action })))
      .toEqual(resting.map(({ x, y, action }) => ({ x, y, action })));
    engine.command({ type: 'play', petId: 'archie' });
    expect(engine.snapshot().toy).toBeNull();
    preferences.quiet = false;
    engine.setPreferences(preferences);
    expect(pet(engine).action).toBe('wake');
  });

  it('reduced motion avoids roaming and pouncing while preserving direct interactions', () => {
    const preferences = defaultPreferences();
    preferences.reducedMotion = true;
    const engine = make(preferences, () => 0);
    const initial = engine.positions();
    step(engine, 90);
    expect(engine.positions()).toEqual(initial);
    engine.command({ type: 'play', petId: 'archie', automatic: true });
    step(engine, 4);
    expect(pet(engine).action).toBe('sit');
    expect(engine.positions()).toEqual(initial);
    engine.command({ type: 'pet', petId: 'archie' });
    expect(pet(engine).action).toBe('pet');
  });

  it('uses personality energy to change a deterministic behavior choice', () => {
    const preferences = preferencesWithoutSocial();
    preferences.pets.archie.personality.energy = 0;
    preferences.pets.jumi.personality.energy = 1;
    const engine = make(preferences, () => 0.3);
    step(engine, 6);
    expect(pet(engine).action).toBe('idle');
    expect(pet(engine, 'jumi').action).toBe('walk');
  });

  it('keeps current positions when unrelated preferences change, but honors explicit positions', () => {
    const preferences = defaultPreferences();
    const engine = make(preferences);
    engine.command({ type: 'move', petId: 'archie', point: { x: 300, y: 250 } });
    preferences.sound = true;
    preferences.pets.archie.name = 'Little Archie';
    engine.setPreferences(preferences);
    expect(pet(engine)).toMatchObject({ x: 300, y: 250 });
    preferences.pets.archie.position = { x: 0.5, y: 0.5 };
    engine.setPreferences(preferences);
    expect(pet(engine)).toMatchObject({ x: 640, y: 360 });
  });

  it('cancels drag and toy activity and retains normalized positions on resize', () => {
    const engine = make();
    engine.command({ type: 'drag-start', petId: 'archie', point: { x: 300, y: 250 } });
    engine.command({ type: 'play', petId: 'jumi' });
    const previous = engine.positions();
    engine.resize({ width: 1920, height: 1080 });
    expect(engine.positions().archie.x).toBeCloseTo(previous.archie.x);
    expect(engine.positions().archie.y).toBeCloseTo(previous.archie.y);
    expect(pet(engine).action).toBe('land');
    expect(engine.snapshot().toy).toBeNull();
    engine.resize({ width: 30, height: 20 });
    expect(pet(engine)).toMatchObject({ x: 15, y: 10 });
  });

  it('clamps extreme saved points and rejects invalid time without a catch-up burst', () => {
    const preferences = defaultPreferences();
    preferences.pets.archie.position = { x: -100, y: 900 };
    const engine = make(preferences);
    expect(pet(engine).x).toBeGreaterThan(0);
    expect(pet(engine).y).toBeLessThan(scene.height);
    engine.step(NaN);
    engine.step(-10);
    expect(engine.snapshot().time).toBe(0);
    engine.step(3600);
    expect(engine.snapshot().time).toBe(0.25);
  });

  it('is reproducible with a seeded RNG and returns snapshots that cannot mutate the engine', () => {
    const first = make(defaultPreferences(), seeded(123));
    const second = make(defaultPreferences(), seeded(123));
    step(first, 120);
    step(second, 120);
    expect(first.snapshot()).toEqual(second.snapshot());
    const snapshot = first.snapshot();
    snapshot.pets[0].x = -1000;
    expect(pet(first).x).toBeGreaterThan(0);
  });
});

describe('pointer gesture threshold', () => {
  it('requires more than six logical pixels, using both axes', () => {
    expect(exceedsDragThreshold({ x: 0, y: 0 }, { x: 6, y: 0 })).toBe(false);
    expect(exceedsDragThreshold({ x: 0, y: 0 }, { x: 5, y: 5 })).toBe(true);
  });
  it('never turns a completed drag back into a click, and supports cancellation', () => {
    const gesture = new PointerGesture();
    gesture.begin({ x: 100, y: 100 });
    expect(gesture.move({ x: 110, y: 100 })).toBe('dragging');
    expect(gesture.move({ x: 100, y: 100 })).toBe('dragging');
    expect(gesture.end()).toBe('drag');
    gesture.begin({ x: 100, y: 100 });
    gesture.move({ x: 103, y: 101 });
    expect(gesture.end()).toBe('click');
    gesture.begin({ x: 1, y: 1 });
    gesture.cancel();
    expect(gesture.end()).toBe('inactive');
  });
});

describe('scene carry-over from a previous overlay', () => {
  const carry = (archie: Partial<{ action: string; facing: string; forcedSleep: boolean }>, jumi?: Partial<{ action: string; facing: string; forcedSleep: boolean }>) => ({
    pets: {
      archie: { action: 'idle', facing: 'right', forcedSleep: false, ...archie },
      ...(jumi ? { jumi: { action: 'idle', facing: 'left', forcedSleep: false, ...jumi } } : {}),
    },
  }) as unknown as ConstructorParameters<typeof PetEngine>[3];
  const restored = (value: ConstructorParameters<typeof PetEngine>[3], preferences = preferencesWithoutSocial()) => new PetEngine(preferences, scene, () => 0.5, value);

  it('restores facing', () => {
    const engine = restored(carry({ facing: 'left' }, { facing: 'right' }));
    expect(pet(engine)).toMatchObject({ facing: 'left', action: 'idle' });
    expect(pet(engine, 'jumi')).toMatchObject({ facing: 'right', action: 'idle' });
  });

  it('restores a requested nap as an indefinite forced sleep', () => {
    const engine = restored(carry({ action: 'sleep', forcedSleep: true }));
    expect(pet(engine)).toMatchObject({ action: 'sleep', forcedSleep: true });
    step(engine, 240);
    expect(pet(engine)).toMatchObject({ action: 'sleep', forcedSleep: true });
    engine.command({ type: 'pet', petId: 'archie' });
    expect(pet(engine)).toMatchObject({ action: 'pet', forcedSleep: false });
  });

  it('restores an ordinary nap with a fresh duration, then wakes', () => {
    const engine = restored(carry({ action: 'sleep' }));
    expect(pet(engine)).toMatchObject({ action: 'sleep', forcedSleep: false, actionTime: 0 });
    step(engine, 29.9);
    expect(pet(engine).action).toBe('sleep');
    step(engine, 0.3);
    expect(pet(engine).action).toBe('wake');
  });

  it.each(['walk', 'trot', 'carried', 'pet', 'eat', 'pounce', 'land', 'nose_touch', 'groom'])('starts %s from the usual defaults', action => {
    const engine = restored(carry({ action }));
    expect(pet(engine)).toMatchObject({ action: 'idle', forcedSleep: false, target: null, actionTime: 0 });
  });

  it('lets quiet mode win over a restored nap, which returns when quiet mode ends', () => {
    const preferences = preferencesWithoutSocial();
    preferences.quiet = true;
    const engine = restored(carry({ action: 'sleep', forcedSleep: true }), preferences);
    expect(pet(engine)).toMatchObject({ action: 'walk', forcedSleep: true });
    step(engine, 15);
    expect(pet(engine).action).toBe('sit');
    preferences.quiet = false;
    engine.setPreferences(preferences);
    expect(pet(engine)).toMatchObject({ action: 'sleep', forcedSleep: true });
  });

  it('behaves exactly like a fresh engine without carry-over and restores only listed kittens', () => {
    const plain = new PetEngine(defaultPreferences(), scene, seeded(7));
    const empty = new PetEngine(defaultPreferences(), scene, seeded(7), null);
    step(plain, 60); step(empty, 60);
    expect(empty.snapshot()).toEqual(plain.snapshot());
    const partial = restored(carry({ facing: 'left' }));
    expect(pet(partial, 'jumi')).toMatchObject({ facing: 'left', action: 'idle' });
  });
});

// Phase 2 (1.1.0) behaviors. The helpers step at the renderer's 30 Hz.

/** Steps for `seconds`; `after` runs after every step with the time elapsed in this call. */
function run(engine: PetEngine, seconds: number, after?: (time: number) => void): void {
  const count = Math.round(seconds * 30);
  for (let i = 1; i <= count; i++) {
    engine.step(1 / 30);
    after?.(i / 30);
  }
}

/** Like `run`, feeding the cursor (a point, null, or a function of the elapsed time) before every step. */
function watch(engine: PetEngine, cursor: Point | null | ((time: number) => Point | null), seconds: number, after?: (time: number) => void): void {
  const count = Math.round(seconds * 30);
  for (let i = 1; i <= count; i++) {
    engine.observeCursor(typeof cursor === 'function' ? cursor(i / 30) : cursor);
    engine.step(1 / 30);
    after?.(i / 30);
  }
}

/** Steps until `done` (at most `seconds`); returns the elapsed time, or null if it never happened. */
function until(engine: PetEngine, done: () => boolean, seconds = 30): number | null {
  for (let i = 1; i <= Math.round(seconds * 30); i++) {
    engine.step(1 / 30);
    if (done()) return i / 30;
  }
  return null;
}

/** Consecutive actions of one kitten; a restarted action is listed again. */
function actionSequence(engine: PetEngine, id: PetId, seconds: number): string[] {
  const actions: string[] = [pet(engine, id).action];
  run(engine, seconds, () => {
    const now = pet(engine, id);
    if (now.actionTime < 1e-9 || now.action !== actions.at(-1)) actions.push(now.action);
  });
  return actions;
}

/** Archie alone (Jumi hidden) with energy 0, so a constant random source never sends him wandering. */
function lonelyArchie(personality: Partial<Personality> = {}, patch: Partial<Preferences> = {}, random: () => number = () => 0.5): PetEngine {
  const preferences = { ...preferencesWithoutSocial(), ...patch };
  preferences.pets.archie.personality = { ...preferences.pets.archie.personality, energy: 0, ...personality };
  const engine = make(preferences, random);
  engine.command({ type: 'hide', petId: 'jumi' });
  return engine;
}

/** Archie at playfulness 1 (always pounces, always bats) playing alone. */
function playfulArchie(automatic: boolean, random: () => number = () => 0.5): PetEngine {
  const preferences = preferencesWithoutSocial();
  preferences.pets.archie.personality.playfulness = 1;
  const engine = make(preferences, random);
  engine.command({ type: 'hide', petId: 'jumi' });
  engine.command({ type: 'play', petId: 'archie', automatic });
  return engine;
}

const SIZE = 128;
const bottomEdge = scene.height - (SIZE * 0.55 + 8);
const landed = (engine: PetEngine) => pet(engine).action === 'land' && pet(engine).actionTime < 1e-9;

describe('speeds and personality', () => {
  it('scales walk, trot and toy-chase speed by 0.8 to 1.2 with energy; pair and quiet speeds stay fixed', () => {
    expect(energyFactor(0)).toBeCloseTo(0.8);
    expect(energyFactor(1)).toBeCloseTo(1.2);
    expect(speedFor('walk', 0)).toBeCloseTo(44);
    expect(speedFor('walk', 1)).toBeCloseTo(66);
    expect(speedFor('trot', 0)).toBeCloseTo(68);
    expect(speedFor('trot', 1)).toBeCloseTo(102);
    expect(speedFor('chase', 0)).toBeCloseTo(72);
    expect(speedFor('chase', 1)).toBeCloseTo(108);
    expect([speedFor('walk', 0.5), speedFor('trot', 0.5), speedFor('chase', 0.5)]).toEqual([WALK_SPEED, TROT_SPEED, CHASE_SPEED]);
    expect([PAIR_SPEED, QUIET_SPEED]).toEqual([65, 55]);
  });

  it('moves at the speed it reports, and reports 0 when stationary', () => {
    for (const energy of [0, 1]) {
      const preferences = preferencesWithoutSocial();
      preferences.pets.archie.personality.energy = energy;
      const engine = make(preferences);
      engine.step(0.1);
      expect(pet(engine)).toMatchObject({ action: 'idle', speed: 0 });
      engine.command({ type: 'come', petId: 'archie', point: { x: 1000, y: pet(engine).y } });
      const before = pet(engine).x;
      engine.step(0.1);
      expect(pet(engine).action).toBe('walk');
      expect(pet(engine).speed).toBeCloseTo(speedFor('walk', energy));
      expect(pet(engine).x - before).toBeCloseTo(speedFor('walk', energy) * 0.1);
    }
    const chase = make(preferencesWithoutSocial());
    chase.command({ type: 'play', petId: 'archie' });
    chase.command({ type: 'toy-move', point: { x: 1100, y: 550 }, held: false });
    chase.step(0.1);
    expect(pet(chase).action).toBe('trot');
    expect(pet(chase).speed).toBeCloseTo(speedFor('chase', 0.35));
    const pair = make(preferencesWithoutSocial());
    pair.command({ type: 'pair', kind: 'nose_touch' });
    pair.step(0.1);
    expect(pet(pair).speed).toBe(PAIR_SPEED);
    const quietPreferences = preferencesWithoutSocial();
    quietPreferences.quiet = true;
    const quiet = make(quietPreferences);
    quiet.step(0.1);
    expect(pet(quiet).speed).toBe(QUIET_SPEED);
  });

  it('lets playfulness raise the chance of trotting on a wander', () => {
    const preferences = preferencesWithoutSocial();
    for (const id of PET_IDS) preferences.pets[id].personality.energy = 1;
    preferences.pets.archie.personality.playfulness = 1;
    preferences.pets.jumi.personality.playfulness = 0;
    const engine = make(preferences, () => 0.13);
    step(engine, 4.8);
    expect(pet(engine)).toMatchObject({ action: 'trot' });
    expect(pet(engine, 'jumi')).toMatchObject({ action: 'walk' });
    expect(pet(engine).speed).toBeCloseTo(speedFor('trot', 1));
    expect(pet(engine, 'jumi').speed).toBeCloseTo(speedFor('walk', 1));
  });

  it('maps playfulness and sociability to curiosity, pounce and batting chances', () => {
    const traits = (playfulness: number, sociability: number): Personality => ({ playfulness, sociability, energy: 0.5 });
    expect(curiousApproachChance(traits(0, 0))).toBeCloseTo(0.2);
    expect(curiousApproachChance(traits(1, 0))).toBeCloseTo(0.55);
    expect(curiousApproachChance(traits(0, 1))).toBeCloseTo(0.5);
    expect(curiousApproachChance(traits(1, 1))).toBeCloseTo(0.85);
    expect(pounceChance(traits(0, 0))).toBeCloseTo(0.45);
    expect(pounceChance(traits(1, 0))).toBe(1);
    expect(batChance(traits(0, 0))).toBeCloseTo(0.5);
    expect(batChance(traits(1, 0))).toBe(1);
  });
});

describe('idle variety', () => {
  it('looks around while idle: turns away for 1 to 1.6 s, then back, without moving', () => {
    const engine = lonelyArchie({}, {}, () => 0.3);
    const start = pet(engine);
    const turns: number[] = [];
    let facing = start.facing;
    run(engine, 12, time => {
      const now = pet(engine);
      expect(now).toMatchObject({ action: 'idle', x: start.x, y: start.y });
      if (now.facing !== facing) {
        turns.push(time);
        facing = now.facing;
      }
    });
    expect(turns).toHaveLength(2);
    expect(turns[1] - turns[0]).toBeGreaterThanOrEqual(1);
    expect(turns[1] - turns[0]).toBeLessThanOrEqual(1.6 + 1 / 30);
    expect(facing).toBe(start.facing);
    // Gentler motion: no look-around (it would be two instant flips).
    const gentle = lonelyArchie({}, { reducedMotion: true }, () => 0.3);
    run(gentle, 12, () => expect(pet(gentle).facing).toBe(start.facing));
  });

  it('drops a pending look-around when gentler motion is turned on, so the facing never snaps', () => {
    // With this random source the second idle starts at 5.5 s and looks away from 1.14 s to 2.32 s into it.
    for (const at of [5.6, 7]) {
      const preferences = preferencesWithoutSocial();
      preferences.pets.archie.personality.energy = 0;
      preferences.pets.jumi.visible = false;
      const engine = make(preferences, () => 0.3);
      run(engine, at);
      expect(pet(engine).action).toBe('idle');
      // Before the look starts the kitten still faces right; mid-look it faces left and just stays so.
      const facing = pet(engine).facing;
      expect(facing).toBe(at < 6.5 ? 'right' : 'left');
      engine.setPreferences({ ...preferences, reducedMotion: true });
      run(engine, 5, () => expect(pet(engine)).toMatchObject({ action: 'idle', facing }));
    }
  });

  it('chains sit, groom, sit: grooming follows a sit where it would not follow an idle', () => {
    const engine = lonelyArchie();
    expect(actionSequence(engine, 'archie', 37)).toEqual(['idle', 'sit', 'groom', 'sit', 'groom', 'sit']);
  });

  it('now and then walks to the bottom edge and sits there for 12 to 20 s', () => {
    const engine = lonelyArchie({ energy: 1 }, {}, () => 0.1);
    step(engine, 4.6);
    expect(pet(engine)).toMatchObject({ action: 'walk', target: { x: pet(engine).x, y: bottomEdge } });
    expect(until(engine, () => pet(engine).action === 'sit', 5)).not.toBeNull();
    expect(pet(engine)).toMatchObject({ y: bottomEdge, actionTime: 0 });
    let longest = 0;
    until(engine, () => {
      if (pet(engine).actionTime < longest) return true;
      longest = pet(engine).actionTime;
      return false;
    }, 25);
    expect(longest).toBeGreaterThanOrEqual(12);
    expect(longest).toBeLessThanOrEqual(20);
    const gentle = lonelyArchie({ energy: 1 }, { reducedMotion: true }, () => 0.1);
    const still = pet(gentle);
    step(gentle, 30);
    expect(pet(gentle)).toMatchObject({ x: still.x, y: still.y });
  });

  it('stretches for 1.1 s when waking, whether woken or after a nap ends', () => {
    expect(WAKE_DURATION).toBe(1.1);
    const engine = make();
    engine.command({ type: 'nap', petId: 'archie' });
    step(engine, 5);
    engine.command({ type: 'wake', petId: 'archie' });
    step(engine, 1);
    expect(pet(engine).action).toBe('wake');
    step(engine, 0.2);
    expect(pet(engine).action).toBe('sit');
    const napper = new PetEngine(preferencesWithoutSocial(), scene, () => 0.5, { pets: { archie: { action: 'sleep', facing: 'right', forcedSleep: false } } });
    expect(until(napper, () => pet(napper).action === 'wake', 31)).not.toBeNull();
    expect(until(napper, () => pet(napper).action !== 'wake', 2)).toBeCloseTo(WAKE_DURATION, 1);
  });

  it('is seeded: the same seed replays the same variety, which includes every kind of it', () => {
    interface Segment { id: PetId; action: string; facings: string[]; start: number; end: number; y: number }
    const trace = (seed: number): Segment[] => {
      const engine = make(preferencesWithoutSocial(), seeded(seed));
      const segments: Segment[] = [];
      const open = new Map<PetId, Segment>();
      run(engine, 600, time => {
        for (const now of engine.snapshot().pets) {
          const current = open.get(now.id);
          if (!current || current.action !== now.action || now.actionTime < 1e-9) {
            if (current) segments.push({ ...current, end: time });
            open.set(now.id, { id: now.id, action: now.action, facings: [now.facing], start: time, end: time, y: now.y });
          } else if (current.facings.at(-1) !== now.facing) current.facings.push(now.facing);
        }
      });
      return segments;
    };
    const first = trace(7);
    expect(trace(7)).toEqual(first);
    expect(trace(8)).not.toEqual(first);
    const follows = (from: string, to: string) => PET_IDS.some(id => {
      const mine = first.filter(segment => segment.id === id);
      return mine.some((segment, index) => index > 0 && mine[index - 1].action === from && segment.action === to);
    });
    expect(first.some(s => s.action === 'idle' && s.facings.length === 3 && s.facings[0] === s.facings[2])).toBe(true);
    expect(follows('sit', 'groom')).toBe(true);
    expect(follows('groom', 'sit')).toBe(true);
    expect(first.some(s => s.action === 'sit' && Math.abs(s.y - bottomEdge) < 1e-6 && s.end - s.start >= 12)).toBe(true);
    const wakes = first.filter(s => s.action === 'wake');
    expect(wakes.length).toBeGreaterThan(0);
    for (const wake of wakes) expect(wake.end - wake.start).toBeCloseTo(WAKE_DURATION, 1);
  });
});

describe('cursor curiosity', () => {
  const leftOf = (engine: PetEngine, distance = 150): Point => ({ x: pet(engine).x - distance, y: pet(engine).y });

  it('notices a cursor resting nearby for 2.5 s, faces it, walks to 0.8 × size from it and sits 4 to 8 s', () => {
    const engine = lonelyArchie({ playfulness: 1, sociability: 1 });
    const start = pet(engine);
    const cursor = leftOf(engine);
    watch(engine, cursor, 2.4);
    expect(pet(engine)).toMatchObject({ action: 'idle', facing: 'right', x: start.x });
    watch(engine, cursor, 0.2);
    expect(pet(engine)).toMatchObject({ action: 'walk', facing: 'left', target: { x: cursor.x + 0.8 * SIZE, y: cursor.y } });
    watch(engine, cursor, 1.5);
    expect(pet(engine)).toMatchObject({ action: 'sit', facing: 'left', x: cursor.x + 0.8 * SIZE, y: cursor.y, speed: 0 });
    let sat = pet(engine).actionTime, sitting = true;
    watch(engine, cursor, 10, () => {
      sitting &&= pet(engine).action === 'sit';
      if (sitting) sat = pet(engine).actionTime;
    });
    expect(sitting).toBe(false);
    expect(sat).toBeGreaterThanOrEqual(4);
    expect(sat).toBeLessThanOrEqual(8);
  });

  it('treats a non-finite cursor as unknown', () => {
    const engine = lonelyArchie({ playfulness: 1, sociability: 1 });
    const near = leftOf(engine);
    watch(engine, { x: Number.NaN, y: near.y }, 3);
    watch(engine, { x: near.x, y: Number.POSITIVE_INFINITY }, 3);
    expect(pet(engine)).toMatchObject({ facing: 'right', target: null });
  });

  it('only turns to face the cursor when it does not feel like walking over', () => {
    const engine = lonelyArchie({ playfulness: 0, sociability: 0 });
    const start = pet(engine);
    watch(engine, leftOf(engine), 3);
    expect(pet(engine)).toMatchObject({ action: 'idle', facing: 'left', x: start.x, y: start.y, target: null });
  });

  it('ignores a cursor that keeps darting about, comes and goes, or rests too far away', () => {
    const engine = lonelyArchie({ playfulness: 1, sociability: 1 });
    const near = leftOf(engine);
    const unchanged = () => expect(pet(engine)).toMatchObject({ facing: 'right', target: null });
    watch(engine, time => ({ x: near.x + (Math.round(time * 30) % 2) * 20, y: near.y }), 5, unchanged);
    watch(engine, time => (Math.round(time * 30) % 60 === 0 ? null : near), 8, unchanged);
    watch(engine, leftOf(engine, 1.7 * SIZE), 5, unchanged);
    expect(pet(engine).action).not.toBe('walk');
    watch(engine, near, 2.6);
    expect(pet(engine).facing).toBe('left');
  });

  it('gives up walking over when the cursor is gone for 0.5 s or darts away', () => {
    const lost = lonelyArchie({ playfulness: 1, sociability: 1 });
    const cursor = leftOf(lost);
    watch(lost, cursor, 2.6);
    expect(pet(lost).action).toBe('walk');
    watch(lost, null, 0.4);
    expect(pet(lost).action).toBe('walk');
    watch(lost, null, 0.15);
    expect(pet(lost)).toMatchObject({ action: 'sit', target: null });
    expect(pet(lost).x).toBeGreaterThan(cursor.x + 0.8 * SIZE);
    const darted = lonelyArchie({ playfulness: 1, sociability: 1 });
    watch(darted, cursor, 2.6);
    expect(pet(darted).action).toBe('walk');
    watch(darted, time => ({ x: cursor.x + (Math.round(time * 30) % 2) * 30, y: cursor.y }), 0.3);
    expect(pet(darted)).toMatchObject({ action: 'sit', target: null });
  });

  it('waits out its 90 to 180 s cooldown before reacting again', () => {
    const engine = lonelyArchie({ playfulness: 1, sociability: 1 });
    watch(engine, leftOf(engine), 6);
    expect(pet(engine)).toMatchObject({ action: 'sit', facing: 'left' });
    const right = { x: pet(engine).x + 150, y: pet(engine).y };
    let turnedAt: number | null = null;
    watch(engine, right, 140, time => { if (turnedAt === null && pet(engine).facing === 'right') turnedAt = 6 + time; });
    // Noticed at 2.5 s; the cooldown (135 s with this random source) ends at 137.5 s, then 2.5 s more of rest.
    expect(turnedAt).toBeCloseTo(140, 0);
  });

  it.each<[string, Partial<Preferences>, ((engine: PetEngine) => void) | null, ((engine: PetEngine) => void) | null]>([
    ['curiosity is turned off', { curious: false }, null, null],
    ['in quiet mode', { quiet: true }, null, null],
    ['during a requested nap', {}, engine => engine.command({ type: 'nap', petId: 'archie' }), null],
    // Playing used up no cooldown: once play is over, a resting cursor gets its reaction.
    ['while playing', {}, engine => engine.command({ type: 'play', petId: 'archie' }), engine => {
      engine.command({ type: 'end-play' });
      watch(engine, leftOf(engine), 2.6);
      expect(pet(engine).facing).toBe('left');
    }],
    // The treat (falling, walk, eating, crumbs) outlasts the 5.5 s window.
    ['while going for a treat', {}, engine => engine.command({ type: 'treat', petId: 'archie' }), engine => expect(engine.snapshot().treats).toHaveLength(1)],
  ])('never reacts when %s', (_name, patch, setup, afterwards) => {
    const engine = lonelyArchie({ playfulness: 1, sociability: 1 }, patch);
    setup?.(engine);
    watch(engine, () => leftOf(engine), 5.5, () => {
      expect(pet(engine).facing).toBe('right');
      // Not even watching for the cursor: no dwell builds up and no attention square is published.
      expect(engine.attentivePets()).not.toContain('archie');
    });
    afterwards?.(engine);
  });

  it('never walks onto its partner: an approach stops at the nose-touch spacing', () => {
    const preferences = defaultPreferences();
    for (const id of PET_IDS) preferences.pets[id].personality = { playfulness: 1, sociability: 1, energy: 0 };
    const spacing = 0.43 * 2 * SIZE;
    const setUp = (archie: Point, jumi: Point) => {
      const engine = make(preferences);
      engine.command({ type: 'move', petId: 'archie', point: archie });
      engine.command({ type: 'move', petId: 'jumi', point: jumi });
      run(engine, 0.6);
      expect([pet(engine).action, pet(engine, 'jumi').action]).toEqual(['sit', 'sit']);
      return engine;
    };
    const gap = (engine: PetEngine) => Math.hypot(pet(engine).x - pet(engine, 'jumi').x, pet(engine).y - pet(engine, 'jumi').y);
    const cursor = { x: 850, y: 400 };
    // Jumi sits between Archie and the cursor: he walks only as far as the spacing and sits facing it.
    const between = setUp({ x: 650, y: 400 }, { x: 800, y: 400 });
    watch(between, cursor, 2.6);
    expect(pet(between)).toMatchObject({ action: 'walk', facing: 'right' });
    watch(between, cursor, 2);
    expect(pet(between)).toMatchObject({ action: 'sit', facing: 'right', y: 400 });
    expect(pet(between).x).toBeCloseTo(800 - spacing, 6);
    expect(pet(between, 'jumi')).toMatchObject({ x: 800, y: 400 });
    // Already that close (as a nose touch leaves them): he only turns to the cursor.
    const close = setUp({ x: 650, y: 400 }, { x: 760, y: 400 });
    watch(close, cursor, 4, () => expect(pet(close)).toMatchObject({ x: 650, y: 400 }));
    expect(pet(close).facing).toBe('right');
    // Nor where the partner is heading: both notice at once, Archie (first) walks up from below the
    // cursor, and Jumi stops short of the spot he is walking to, not just of where he is.
    const heading = setUp({ x: 850, y: 550 }, { x: 720, y: 470 });
    watch(heading, cursor, 2.6);
    expect([pet(heading).action, pet(heading, 'jumi').action]).toEqual(['walk', 'walk']);
    watch(heading, cursor, 4);
    expect([pet(heading).action, pet(heading, 'jumi').action]).toEqual(['sit', 'sit']);
    expect(pet(heading).x).toBeCloseTo(850, 6);
    expect(pet(heading).y).toBeCloseTo(cursor.y + 0.8 * SIZE, 6);
    expect(gap(heading)).toBeGreaterThanOrEqual(spacing - 1e-6);
    expect(gap(between)).toBeGreaterThanOrEqual(spacing - 1e-6);
  });

  it('only turns to face the cursor under reduced motion', () => {
    const engine = lonelyArchie({ playfulness: 1, sociability: 1 }, { reducedMotion: true });
    const start = pet(engine);
    watch(engine, leftOf(engine), 10, () => expect(pet(engine)).toMatchObject({ x: start.x, y: start.y }));
    expect(pet(engine).facing).toBe('left');
  });

  it('lists the kittens watching for the cursor, including one on its way over', () => {
    const engine = lonelyArchie({ playfulness: 1, sociability: 1 });
    expect(engine.attentivePets()).toEqual(['archie']);
    watch(engine, leftOf(engine), 2.6);
    expect(pet(engine).action).toBe('walk');
    expect(engine.attentivePets()).toEqual(['archie']);
    watch(engine, null, 2);
    expect(engine.attentivePets()).toEqual([]);
    const both = make(preferencesWithoutSocial());
    expect(both.attentivePets()).toEqual(['archie', 'jumi']);
    both.command({ type: 'nap', petId: 'jumi' });
    expect(both.attentivePets()).toEqual(['archie']);
    expect(make({ ...defaultPreferences(), curious: false }).attentivePets()).toEqual([]);
    expect(make({ ...defaultPreferences(), quiet: true }).attentivePets()).toEqual([]);
  });

  it('stops an approach when curiosity is turned off', () => {
    const preferences = { ...preferencesWithoutSocial() };
    preferences.pets.archie.personality = { playfulness: 1, sociability: 1, energy: 0 };
    const engine = make(preferences);
    engine.command({ type: 'hide', petId: 'jumi' });
    watch(engine, leftOf(engine), 2.6);
    expect(pet(engine).action).toBe('walk');
    engine.setPreferences({ ...preferences, curious: false });
    expect(pet(engine)).toMatchObject({ action: 'sit', target: null });
  });
});

describe('hold-to-pet', () => {
  it('pets while held, ending a nap, then sits for 4 to 8 s after the release', () => {
    const engine = make();
    engine.command({ type: 'nap', petId: 'archie' });
    engine.command({ type: 'pet-hold', petId: 'archie' });
    expect(pet(engine)).toMatchObject({ action: 'pet', held: true, forcedSleep: false });
    step(engine, 5);
    expect(pet(engine)).toMatchObject({ action: 'pet', held: true });
    engine.command({ type: 'pet-release', petId: 'archie' });
    expect(pet(engine)).toMatchObject({ action: 'sit', held: false, actionTime: 0 });
    step(engine, 5.9);
    expect(pet(engine).action).toBe('sit');
  });

  it('caps a held pet at 8 s; a release after that changes nothing', () => {
    expect(HELD_PET_MAX).toBe(8);
    const engine = make();
    engine.command({ type: 'pet-hold', petId: 'archie' });
    step(engine, 7.9);
    expect(pet(engine)).toMatchObject({ action: 'pet', held: true });
    step(engine, 0.2);
    expect(pet(engine)).toMatchObject({ action: 'sit', held: false });
    const sitting = pet(engine).actionTime;
    engine.command({ type: 'pet-release', petId: 'archie' });
    expect(pet(engine)).toMatchObject({ action: 'sit', actionTime: sitting });
  });

  it('pets at least as long as a click when a hold is released early: the same pet carries on to 2 s', () => {
    const engine = make();
    engine.command({ type: 'pet-hold', petId: 'archie' });
    run(engine, 0.1);
    engine.command({ type: 'pet-release', petId: 'archie' });
    expect(pet(engine)).toMatchObject({ action: 'pet', held: false });
    // Not restarted: the pose, the heart and the 2 s count keep going from the hold's start.
    expect(pet(engine).actionTime).toBeCloseTo(0.1);
    run(engine, 1.8);
    expect(pet(engine)).toMatchObject({ action: 'pet', held: false });
    run(engine, 0.2);
    expect(pet(engine)).toMatchObject({ action: 'sit', held: false });
    // A hold released after 2 s or more sits at once.
    const long = make();
    long.command({ type: 'pet-hold', petId: 'archie' });
    run(long, 2.5);
    long.command({ type: 'pet-release', petId: 'archie' });
    expect(pet(long)).toMatchObject({ action: 'sit', held: false, actionTime: 0 });
  });

  it('keeps the 2 s pet for a click and ignores a release without a hold', () => {
    const engine = make();
    engine.command({ type: 'pet', petId: 'archie' });
    expect(pet(engine)).toMatchObject({ action: 'pet', held: false });
    engine.command({ type: 'pet-release', petId: 'archie' });
    expect(pet(engine)).toMatchObject({ action: 'pet', held: false });
    step(engine, 2.1);
    expect(pet(engine).action).toBe('sit');
    const quiet = make({ ...defaultPreferences(), quiet: true });
    quiet.command({ type: 'pet-hold', petId: 'archie' });
    expect(pet(quiet).held).toBe(false);
  });

  it.each<[string, (engine: PetEngine) => void]>([
    ['a drag', engine => engine.command({ type: 'drag-start', petId: 'archie', point: { x: 500, y: 500 } })],
    ['hiding', engine => engine.command({ type: 'hide', petId: 'archie' })],
    ['quiet mode', engine => engine.setPreferences({ ...defaultPreferences(), quiet: true })],
    ['a click', engine => engine.command({ type: 'pet', petId: 'archie' })],
    ['a treat', engine => engine.command({ type: 'treat', petId: 'archie' })],
    ['play', engine => engine.command({ type: 'play', petId: 'archie' })],
    ['come here', engine => engine.command({ type: 'come', petId: 'archie', point: { x: 900, y: 400 } })],
  ])('ends a held pet on %s', (_name, interrupt) => {
    const engine = make();
    engine.command({ type: 'pet-hold', petId: 'archie' });
    step(engine, 1);
    interrupt(engine);
    expect(pet(engine).held).toBe(false);
    step(engine, 1);
    expect(pet(engine).held).toBe(false);
  });
});

describe('toy play: pounce, batting and waypoints', () => {
  it('pounces with a 0.2 s crouch in place, a 0.45 s leap toward the toy (apex 0.35 × size), then a 0.3 s landing', () => {
    const engine = playfulArchie(false);
    const toy = engine.snapshot().toy!;
    const start = pet(engine);
    const samples: PetState[] = [];
    run(engine, 2, () => samples.push(pet(engine)));
    const crouch = samples.filter(s => s.action === 'pounce' && s.leap === null);
    const leap = samples.filter(s => s.action === 'pounce' && s.leap !== null);
    const land = samples.filter(s => s.action === 'land');
    expect(crouch.length).toBeGreaterThan(0);
    for (const s of crouch) expect(s).toMatchObject({ x: start.x, y: start.y, speed: 0 });
    expect(crouch.every(s => s.actionTime < POUNCE_CROUCH + 1e-9)).toBe(true);
    expect(leap.length).toBeGreaterThanOrEqual(13);
    const first = leap[0].leap!;
    expect(first).toMatchObject({ fromX: start.x, fromY: start.y, height: LEAP_HEIGHT * SIZE });
    expect(first.toX).toBeCloseTo(toy.x - 0.25 * SIZE);
    expect(first.toY).toBeCloseTo(toy.y - 0.2 * SIZE);
    let progress = 0;
    for (const s of leap) {
      const l = s.leap!;
      expect(l).toMatchObject({ fromX: first.fromX, toX: first.toX, height: first.height });
      expect(l.progress).toBeGreaterThanOrEqual(progress);
      progress = l.progress;
      expect(l.progress).toBeCloseTo((s.actionTime - POUNCE_CROUCH) / POUNCE_LEAP, 9);
      expect(s.x).toBeCloseTo(l.fromX + (l.toX - l.fromX) * l.progress, 9);
      expect(s.y).toBeCloseTo(l.fromY + (l.toY - l.fromY) * l.progress, 9);
      expect(s.speed).toBeCloseTo(Math.hypot(l.toX - l.fromX, l.toY - l.fromY) / POUNCE_LEAP);
    }
    expect(progress).toBeGreaterThan(0.9);
    expect(land.length).toBeGreaterThanOrEqual(8);
    expect(land.length).toBeLessThanOrEqual(11);
    expect(land[0]).toMatchObject({ x: first.toX, y: first.toY, leap: null, speed: 0 });
    const away = (s: PetState) => Math.hypot(toy.x - s.x, toy.y - s.y);
    expect(away(land[0])).toBeLessThan(away(start) / 3);
    // Landed with the toy under its paws: it never leaps from there (no hop on the spot) and stays put,
    // and so does the toy (it pounces on it in place instead; see below).
    const after = pet(engine);
    run(engine, 3, () => {
      expect(pet(engine)).toMatchObject({ x: after.x, y: after.y, leap: null, speed: 0 });
      expect(engine.snapshot().toy).toMatchObject({ x: toy.x, y: toy.y });
    });
  });

  /** Pounce starts and leaps of the toy's kitten over `seconds`, checking `each` after every step. */
  function countPounces(engine: PetEngine, seconds: number, each?: () => void): { pounces: number; leaps: number } {
    let pounces = 0, leaps = 0, action = pet(engine).action, leaping = false;
    run(engine, seconds, () => {
      const now = pet(engine);
      if (now.action === 'pounce' && action !== 'pounce') pounces++;
      if (now.leap && !leaping) leaps++;
      action = now.action;
      leaping = now.leap !== null;
      each?.();
    });
    return { pounces, leaps };
  }

  it('keeps unattended manual play lively: by a still toy it pounces again and again, in place', () => {
    for (const [seed, playfulness] of [[1, 0.35], [2, 0.35], [3, 0], [4, 1]] as const) {
      const preferences = preferencesWithoutSocial();
      preferences.pets.archie.personality.playfulness = playfulness;
      const engine = make(preferences, seeded(seed));
      engine.command({ type: 'hide', petId: 'jumi' });
      engine.command({ type: 'play', petId: 'archie', automatic: false });
      const toy = engine.snapshot().toy!;
      let landedAt: Point | null = null;
      const counts = countPounces(engine, 29.9, () => {
        expect(engine.snapshot().toy).toMatchObject({ x: toy.x, y: toy.y });
        const now = pet(engine);
        if (now.action === 'land') landedAt ??= { x: now.x, y: now.y };
        if (landedAt) expect(now).toMatchObject({ ...landedAt, leap: null, speed: 0 });
      });
      // One real leap onto the toy, then pounces where it lies (1.0.2 pounced on the spot all session
      // long; before this fix it was one pounce and 28 s of staring). Over 40 seeds: 5 to 13 pounces.
      expect(counts.leaps).toBe(1);
      expect(counts.pounces).toBeGreaterThanOrEqual(5);
    }
  });

  it('pounces in place when play starts with the toy already under its paws (kitten at the scene edge)', () => {
    const preferences = preferencesWithoutSocial();
    const engine = make(preferences, seeded(5));
    engine.command({ type: 'hide', petId: 'jumi' });
    engine.command({ type: 'move', petId: 'archie', point: { x: scene.width, y: 400 } });
    run(engine, 0.6);
    expect(pet(engine).facing).toBe('right');
    engine.command({ type: 'play', petId: 'archie', automatic: false });
    const start = pet(engine);
    const counts = countPounces(engine, 29.9, () => expect(pet(engine)).toMatchObject({ x: start.x, y: start.y, leap: null }));
    expect(counts.leaps).toBe(0);
    expect(counts.pounces).toBeGreaterThanOrEqual(5);
  });

  it('caps the leap when the user carries a held toy far off during the crouch', () => {
    const longest = (1.2 + 0.25) * SIZE;
    for (const far of [{ x: 1250, y: 560 }, { x: 30, y: 30 }]) {
      const engine = playfulArchie(false);
      const spawn = engine.snapshot().toy!;
      engine.command({ type: 'toy-move', point: { x: spawn.x, y: spawn.y }, held: true });
      expect(until(engine, () => pet(engine).action === 'pounce', 3)).not.toBeNull();
      engine.command({ type: 'toy-move', point: far, held: true });
      expect(until(engine, () => pet(engine).leap !== null, 1)).not.toBeNull();
      const leap = pet(engine).leap!;
      const length = Math.hypot(leap.toX - leap.fromX, leap.toY - leap.fromY);
      expect(length).toBeGreaterThan(SIZE);
      expect(length).toBeLessThanOrEqual(longest + 1e-9);
      expect(pet(engine).speed).toBeLessThanOrEqual(longest / POUNCE_LEAP + 1e-9);
      // Still toward the toy, and after the miss the chase goes on.
      expect(Math.sign(leap.toX - leap.fromX)).toBe(Math.sign(far.x - leap.fromX));
      expect(Math.sign(leap.toY - leap.fromY)).toBe(Math.sign(far.y - 0.2 * SIZE - leap.fromY));
      expect(until(engine, () => pet(engine).action === 'trot', 3)).not.toBeNull();
    }
    // A small move during the crouch still re-aims the leap at the toy, uncapped.
    const engine = playfulArchie(false);
    const spawn = engine.snapshot().toy!;
    expect(until(engine, () => pet(engine).action === 'pounce', 3)).not.toBeNull();
    const moved = { x: spawn.x + 30, y: spawn.y };
    engine.command({ type: 'toy-move', point: moved, held: true });
    expect(until(engine, () => pet(engine).leap !== null, 1)).not.toBeNull();
    expect(pet(engine).leap!.toX).toBeCloseTo(moved.x - 0.25 * SIZE);
  });

  it('bats the toy 60 to 120 DIP onward after landing in automatic play', () => {
    const engine = playfulArchie(true);
    expect(until(engine, () => landed(engine), 10)).not.toBeNull();
    const dir = pet(engine).facing === 'left' ? -1 : 1;
    const at = engine.snapshot().toy!;
    run(engine, 0.1);
    const rolling = engine.snapshot().toy!;
    // Rolling off at up to 300 DIP/s, far faster than the toy's own 110 DIP/s, and straight ahead.
    expect((rolling.x - at.x) * dir).toBeGreaterThan(20);
    expect(rolling.y).toBe(at.y);
    run(engine, 0.5);
    const rolled = (engine.snapshot().toy!.x - at.x) * dir;
    expect(rolled).toBeGreaterThanOrEqual(BAT_MIN);
    expect(rolled).toBeLessThanOrEqual(BAT_MAX);
  });

  it('keeps a toy batted near the scene edge inside the scene', () => {
    let bats = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const preferences = preferencesWithoutSocial();
      preferences.pets.archie.personality.playfulness = 1;
      const engine = make(preferences, seeded(seed));
      engine.command({ type: 'hide', petId: 'jumi' });
      engine.command({ type: 'move', petId: 'archie', point: { x: scene.width, y: 400 } });
      run(engine, 0.6);
      engine.command({ type: 'play', petId: 'archie', automatic: true });
      let previous: Point = { ...engine.snapshot().toy! };
      run(engine, 29, () => {
        const toy = engine.snapshot().toy!;
        expect(toy.x).toBeGreaterThanOrEqual(20);
        expect(toy.x).toBeLessThanOrEqual(scene.width - 20);
        expect(toy.y).toBeGreaterThanOrEqual(20);
        expect(toy.y).toBeLessThanOrEqual(scene.height - 20);
        // A batted toy rolls off faster than the toy ever moves by itself.
        if (Math.hypot(toy.x - previous.x, toy.y - previous.y) * 30 > TOY_SPEED + 1) bats++;
        previous = { x: toy.x, y: toy.y };
      });
    }
    expect(bats).toBeGreaterThan(0);
  });

  it('never bats a toy the user is holding', () => {
    const engine = playfulArchie(true);
    const held = { x: 700, y: 540 };
    engine.command({ type: 'toy-move', point: held, held: true });
    const actions = new Set<string>();
    run(engine, 6, () => {
      actions.add(pet(engine).action);
      expect(engine.snapshot().toy).toMatchObject({ ...held, held: true });
    });
    expect(actions.has('land')).toBe(true);
  });

  it('moves an automatic toy between waypoints near the play origin at up to 110 DIP/s, with short pauses', () => {
    const engine = make(preferencesWithoutSocial(), seeded(2));
    engine.command({ type: 'hide', petId: 'jumi' });
    engine.command({ type: 'play', petId: 'archie', automatic: true });
    const origin = engine.snapshot().toy!;
    let previous: Point = { x: origin.x, y: origin.y }, rollingUntil = -1, firstLanding: number | null = null, pauses = 0, fastest = 0;
    const offset = { x: 0, y: 0 };
    run(engine, 29, time => {
      const toy = engine.snapshot().toy!;
      if (landed(engine)) {
        firstLanding ??= time;
        rollingUntil = time + 0.8;
      }
      const moved = Math.hypot(toy.x - previous.x, toy.y - previous.y);
      if (time > rollingUntil) {
        fastest = Math.max(fastest, moved * 30);
        if (moved === 0) pauses++;
      }
      if (firstLanding === null) {
        offset.x = Math.max(offset.x, Math.abs(toy.x - origin.x));
        offset.y = Math.max(offset.y, Math.abs(toy.y - origin.y));
      }
      previous = { x: toy.x, y: toy.y };
    });
    expect(firstLanding).toBeGreaterThan(2);
    expect(offset.x).toBeGreaterThan(40);
    expect(offset.x).toBeLessThanOrEqual(TOY_RANGE_X + 1e-9);
    expect(offset.y).toBeLessThanOrEqual(TOY_RANGE_Y + 1e-9);
    expect(fastest).toBeLessThanOrEqual(TOY_SPEED + 1e-6);
    expect(fastest).toBeGreaterThan(TOY_SPEED * 0.9);
    expect(pauses).toBeGreaterThan(0);
  });

  it('chases without flicker: every trot and every pause to eye the toy lasts a while', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const preferences = preferencesWithoutSocial();
      preferences.pets.archie.personality.playfulness = seed % 2 ? 1 : 0.4;
      const engine = make(preferences, seeded(seed));
      engine.command({ type: 'hide', petId: 'jumi' });
      engine.command({ type: 'play', petId: 'archie', automatic: true });
      let action = pet(engine).action, since = 0, shortest = Infinity;
      run(engine, 29, time => {
        if (pet(engine).action === action) return;
        if (action === 'trot' || action === 'sit') shortest = Math.min(shortest, time - since);
        action = pet(engine).action;
        since = time;
      });
      expect(shortest).toBeGreaterThanOrEqual(0.25);
    }
  });

  it('re-centres automatic play where a held toy is let go', () => {
    const engine = make(preferencesWithoutSocial(), seeded(4));
    engine.command({ type: 'hide', petId: 'jumi' });
    engine.command({ type: 'play', petId: 'archie', automatic: true });
    const release = { x: 1000, y: 300 };
    engine.command({ type: 'toy-move', point: release, held: true });
    run(engine, 1, () => expect(engine.snapshot().toy).toMatchObject(release));
    engine.command({ type: 'toy-move', point: release, held: false });
    let travelled = 0;
    run(engine, 2, () => {
      const toy = engine.snapshot().toy!;
      expect(Math.abs(toy.x - release.x)).toBeLessThanOrEqual(TOY_RANGE_X + 1e-9);
      expect(Math.abs(toy.y - release.y)).toBeLessThanOrEqual(TOY_RANGE_Y + 1e-9);
      travelled = Math.max(travelled, Math.abs(toy.x - release.x));
    });
    expect(travelled).toBeGreaterThan(20);
  });
});

describe('treats', () => {
  it('drops a treat 1.1 × size ahead that falls for 0.35 s, bounces once and comes to rest', () => {
    const engine = make();
    const start = pet(engine);
    engine.command({ type: 'treat', petId: 'archie' });
    expect(engine.snapshot().treats).toEqual([{ petId: 'archie', x: start.x + 1.1 * SIZE, y: start.y, z: 0.55 * SIZE, phase: 'falling', elapsed: 0 }]);
    expect(pet(engine)).toMatchObject({ action: 'idle', facing: 'right', x: start.x });
    const heights: number[] = [];
    run(engine, 0.5, () => heights.push(engine.snapshot().treats[0].z));
    const falling = heights.slice(0, 10);
    for (let i = 1; i < falling.length; i++) expect(falling[i]).toBeLessThan(falling[i - 1]);
    const bounce = Math.max(...heights.slice(10));
    expect(bounce).toBeGreaterThan(0.07 * SIZE);
    expect(bounce).toBeLessThanOrEqual(0.08 * SIZE);
    run(engine, 0.1);
    expect(engine.snapshot().treats[0]).toMatchObject({ phase: 'resting', z: 0 });
    expect(treatHeight(0, SIZE)).toBeCloseTo(0.55 * SIZE);
    expect(treatHeight(0.35, SIZE)).toBeCloseTo(0);
    expect(treatHeight(0.35 + 0.09, SIZE)).toBeCloseTo(0.08 * SIZE);
    expect(treatHeight(0.53, SIZE)).toBe(0);
  });

  it('walks over at walking speed, eats for 2.8 s, leaves crumbs for 0.6 s and then sits', () => {
    const engine = make();
    const start = pet(engine);
    engine.command({ type: 'treat', petId: 'archie' });
    const treatX = engine.snapshot().treats[0].x;
    const timeline: { entry: string; at: number }[] = [];
    run(engine, 9, time => {
      const kitten = pet(engine), treat = engine.snapshot().treats[0];
      const entry = `${kitten.action}/${treat?.phase ?? 'gone'}`;
      if (timeline.at(-1)?.entry !== entry) timeline.push({ entry, at: time });
      if (kitten.action === 'walk') expect(kitten.speed).toBeCloseTo(speedFor('walk', 0.35));
    });
    expect(timeline.map(item => item.entry)).toEqual(['idle/falling', 'walk/resting', 'eat/resting', 'sit/eaten', 'sit/gone']);
    const at = Object.fromEntries(timeline.map(item => [item.entry, item.at]));
    expect(at['walk/resting']).toBeCloseTo(0.53, 1);
    expect(at['sit/eaten'] - at['eat/resting']).toBeCloseTo(2.8, 1);
    expect(at['sit/gone'] - at['sit/eaten']).toBeCloseTo(0.6, 1);
    expect(pet(engine).x).toBeCloseTo(treatX - 0.35 * SIZE);
    expect(pet(engine).y).toBe(start.y);
  });

  it('eats on the spot when the treat comes to rest close enough', () => {
    const engine = new PetEngine(defaultPreferences(), { width: 260, height: 720 }, () => 0.5);
    const start = pet(engine);
    engine.command({ type: 'treat', petId: 'archie' });
    expect(until(engine, () => pet(engine).action !== 'idle', 1)).toBeCloseTo(0.53, 1);
    expect(pet(engine)).toMatchObject({ action: 'eat', x: start.x, y: start.y });
  });

  it('drops the treat on the other side when the scene edge leaves no room ahead', () => {
    const engine = make();
    engine.command({ type: 'move', petId: 'archie', point: { x: scene.width, y: 400 } });
    step(engine, 0.6);
    expect(pet(engine).facing).toBe('right');
    engine.command({ type: 'treat', petId: 'archie' });
    expect(pet(engine).facing).toBe('left');
    expect(engine.snapshot().treats[0].x).toBeCloseTo(pet(engine).x - 1.1 * SIZE);
  });

  it.each<[string, (engine: PetEngine) => void]>([
    ['a pet', engine => engine.command({ type: 'pet', petId: 'archie' })],
    ['a held pet', engine => engine.command({ type: 'pet-hold', petId: 'archie' })],
    ['play', engine => engine.command({ type: 'play', petId: 'archie' })],
    ['come here', engine => engine.command({ type: 'come', petId: 'archie', point: { x: 300, y: 300 } })],
    ['a drag', engine => engine.command({ type: 'drag-start', petId: 'archie', point: { x: 300, y: 300 } })],
    ['a nap', engine => engine.command({ type: 'nap', petId: 'archie' })],
    ['hiding', engine => engine.command({ type: 'hide', petId: 'archie' })],
    ['quiet mode', engine => engine.setPreferences({ ...defaultPreferences(), quiet: true })],
  ])('cancels the treat on %s', (_name, cancel) => {
    const engine = make();
    engine.command({ type: 'treat', petId: 'archie' });
    step(engine, 1);
    expect(pet(engine).action).toBe('walk');
    cancel(engine);
    expect(engine.snapshot().treats).toEqual([]);
    step(engine, 5);
    expect(engine.snapshot().treats).toEqual([]);
    expect(pet(engine).action).not.toBe('eat');
  });

  it('keeps one treat per kitten: a second treat replaces the first, the other kitten keeps its own', () => {
    const engine = make();
    engine.command({ type: 'treat', petId: 'archie' });
    engine.command({ type: 'treat', petId: 'jumi' });
    step(engine, 1);
    engine.command({ type: 'treat', petId: 'archie' });
    const treats = engine.snapshot().treats;
    expect(treats.map(treat => treat.petId)).toEqual(['archie', 'jumi']);
    expect(treats[0]).toMatchObject({ phase: 'falling', elapsed: 0 });
    expect(treats[1].phase).toBe('resting');
    engine.command({ type: 'pet', petId: 'archie' });
    expect(engine.snapshot().treats.map(treat => treat.petId)).toEqual(['jumi']);
  });

  it('serves the treat at the eating spot under reduced motion, and the kitten eats at once', () => {
    const engine = make({ ...defaultPreferences(), reducedMotion: true });
    const start = pet(engine);
    engine.command({ type: 'treat', petId: 'archie' });
    expect(pet(engine)).toMatchObject({ action: 'eat', x: start.x, y: start.y });
    expect(engine.snapshot().treats).toEqual([{ petId: 'archie', x: start.x + 0.35 * SIZE, y: start.y, z: 0, phase: 'resting', elapsed: 0 }]);
    step(engine, 2.9);
    expect(pet(engine).action).toBe('sit');
    expect(engine.snapshot().treats[0].phase).toBe('eaten');
    step(engine, 0.7);
    expect(engine.snapshot().treats).toEqual([]);
    expect(pet(engine)).toMatchObject({ x: start.x, y: start.y });
  });

  it('serves a pending treat at once when gentler motion is turned on', () => {
    const preferences = defaultPreferences();
    const engine = make(preferences);
    engine.command({ type: 'treat', petId: 'archie' });
    step(engine, 1);
    const walking = pet(engine);
    expect(walking.action).toBe('walk');
    engine.setPreferences({ ...preferences, reducedMotion: true });
    expect(pet(engine)).toMatchObject({ action: 'eat', x: walking.x, y: walking.y, target: null });
    expect(engine.snapshot().treats[0]).toMatchObject({ phase: 'resting', z: 0, x: walking.x + 0.35 * SIZE });
  });

  it('clears treats on resize, so a kitten never walks off toward a treat from the old scene', () => {
    const engine = new PetEngine(defaultPreferences(), { width: 3072, height: 1728 }, () => 0.5);
    engine.command({ type: 'move', petId: 'archie', point: { x: 2765, y: 1200 } });
    run(engine, 0.6);
    engine.command({ type: 'treat', petId: 'archie' });
    run(engine, 1);
    expect(pet(engine).action).toBe('walk');
    engine.resize(scene);
    expect(engine.snapshot().treats).toEqual([]);
    const maxX = scene.width - (SIZE * 0.62 + 8);
    run(engine, 8, () => {
      expect(pet(engine).x).toBeLessThanOrEqual(maxX + 1e-9);
      expect(pet(engine).action).not.toBe('eat');
    });
  });

  it('keeps shared activities from starting while a treat is pending', () => {
    const engine = make();
    engine.command({ type: 'treat', petId: 'archie' });
    engine.command({ type: 'pair', kind: 'nose_touch' });
    expect(engine.snapshot().pair).toBeNull();
  });
});

describe('come here', () => {
  it('ends a nap, walks to the point and sits there for 6 to 10 s', () => {
    const engine = make();
    const start = pet(engine);
    engine.command({ type: 'nap', petId: 'archie' });
    engine.command({ type: 'come', petId: 'archie', point: { x: 900, y: 300 } });
    expect(pet(engine)).toMatchObject({ action: 'walk', forcedSleep: false, target: { x: 900, y: 300 } });
    const arrived = until(engine, () => pet(engine).action === 'sit', 15);
    expect(arrived).toBeCloseTo(Math.hypot(900 - start.x, 300 - start.y) / speedFor('walk', 0.35), 1);
    expect(pet(engine)).toMatchObject({ x: 900, y: 300, facing: 'right' });
    let sat = 0;
    until(engine, () => {
      if (pet(engine).action !== 'sit') return true;
      sat = pet(engine).actionTime;
      return false;
    }, 12);
    expect(sat).toBeGreaterThanOrEqual(6);
    expect(sat).toBeLessThanOrEqual(10);
  });

  it('clamps the destination to the scene', () => {
    const engine = make();
    engine.command({ type: 'come', petId: 'archie', point: { x: -500, y: 9999 } });
    expect(pet(engine).target).toEqual({ x: SIZE * 0.62 + 8, y: bottomEdge });
  });

  it('moves at once under reduced motion, then sits; quiet mode ignores it', () => {
    const gentle = make({ ...defaultPreferences(), reducedMotion: true });
    gentle.command({ type: 'come', petId: 'archie', point: { x: 900, y: 300 } });
    expect(pet(gentle)).toMatchObject({ action: 'sit', x: 900, y: 300, target: null });
    const quiet = make({ ...defaultPreferences(), quiet: true });
    step(quiet, 5);
    const resting = pet(quiet);
    quiet.command({ type: 'come', petId: 'archie', point: { x: 900, y: 300 } });
    step(quiet, 5);
    expect(pet(quiet)).toMatchObject({ action: 'sit', x: resting.x, y: resting.y });
  });
});

describe('gentler motion and quiet mode with the Phase 2 behaviors', () => {
  it('never moves a kitten or the toy under reduced motion', () => {
    const preferences = defaultPreferences();
    preferences.reducedMotion = true;
    for (const id of PET_IDS) preferences.pets[id].personality = { playfulness: 1, sociability: 1, energy: 1 };
    const engine = make(preferences, seeded(3));
    const positions = engine.positions();
    let toy: Point | null = null;
    const still = () => {
      expect(engine.positions()).toEqual(positions);
      for (const kitten of engine.snapshot().pets) expect(kitten).toMatchObject({ leap: null, speed: 0 });
      const now = engine.snapshot().toy;
      if (now && toy) expect({ x: now.x, y: now.y }).toEqual(toy);
    };
    const nearArchie = () => ({ x: pet(engine).x - 100, y: pet(engine).y });
    watch(engine, nearArchie, 60, still);
    engine.command({ type: 'treat', petId: 'archie' });
    watch(engine, nearArchie, 5, still);
    engine.command({ type: 'pet-hold', petId: 'jumi' });
    watch(engine, nearArchie, 3, still);
    engine.command({ type: 'pet-release', petId: 'jumi' });
    engine.command({ type: 'play', petId: 'archie', automatic: true });
    toy = { x: engine.snapshot().toy!.x, y: engine.snapshot().toy!.y };
    watch(engine, nearArchie, 25, still);
    toy = null;
    watch(engine, nearArchie, 240, still);
  });

  it('ignores treats, come-here, holds and the cursor in quiet mode', () => {
    const preferences = { ...defaultPreferences(), quiet: true };
    const quiet = make(preferences, seeded(9));
    const control = make(preferences, seeded(9));
    run(control, 30);
    watch(quiet, () => ({ x: pet(quiet).x - 60, y: pet(quiet).y }), 10);
    for (const petId of PET_IDS) {
      quiet.command({ type: 'treat', petId });
      quiet.command({ type: 'come', petId, point: { x: 100, y: 100 } });
      quiet.command({ type: 'pet-hold', petId });
      quiet.command({ type: 'play', petId, automatic: true });
    }
    watch(quiet, () => ({ x: pet(quiet).x - 60, y: pet(quiet).y }), 10);
    quiet.command({ type: 'pet-release', petId: 'archie' });
    watch(quiet, null, 10);
    expect(quiet.snapshot()).toEqual(control.snapshot());
    expect(quiet.snapshot()).toMatchObject({ treats: [], toy: null });
    expect(quiet.attentivePets()).toEqual([]);
  });

  it('returns snapshots whose Phase 2 fields are copies', () => {
    const engine = playfulArchie(false);
    engine.command({ type: 'show', petId: 'jumi' });
    engine.command({ type: 'treat', petId: 'jumi' });
    expect(until(engine, () => pet(engine).leap !== null, 4)).not.toBeNull();
    const snapshot = engine.snapshot();
    const leap = snapshot.pets[0].leap!;
    leap.progress = 99;
    leap.toX = -1;
    snapshot.pets[0].speed = 1e6;
    snapshot.pets[0].held = true;
    snapshot.treats[0].x = -1;
    snapshot.treats[0].phase = 'eaten';
    snapshot.treats.push({ ...snapshot.treats[0], petId: 'archie' });
    const fresh = engine.snapshot();
    expect(fresh.pets[0].leap!.progress).toBeLessThanOrEqual(1);
    expect(fresh.pets[0].leap!.toX).toBeGreaterThan(0);
    expect(fresh.pets[0].speed).toBeLessThan(1000);
    expect(fresh.pets[0].held).toBe(false);
    expect(fresh.treats).toHaveLength(1);
    expect(fresh.treats[0].petId).toBe('jumi');
    expect(fresh.treats[0].x).toBeGreaterThan(0);
    expect(fresh.treats[0].phase).not.toBe('eaten');
  });
});
