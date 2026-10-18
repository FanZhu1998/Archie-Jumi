import { describe, expect, it } from 'vitest';
import { PetEngine, PAIR_COOLDOWN } from '../src/core/engine';
import { PointerGesture, exceedsDragThreshold } from '../src/core/input';
import { defaultPreferences } from '../src/shared/defaults';
import type { PetId, Preferences } from '../src/shared/types';

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
    engine.command({ type: 'treat', petId: 'archie' });
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
