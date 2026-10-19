import { describe, expect, it } from 'vitest';
import { PetEngine } from '../src/core/engine';
import { HOLD_THRESHOLD_MS, PointerGesture } from '../src/core/input';
import { HoldToPet, PurrControl, purrLoopWanted, type PressCommand } from '../src/rendering/hold-pet';
import { defaultPreferences } from '../src/shared/defaults';
import type { PetId } from '../src/shared/types';

/** A press driven the way the overlay drives it: begin with the press time, poll every frame, move, end. */
function press(petId: PetId = 'archie', at = 1000) {
  const gesture = new PointerGesture(), hold = new HoldToPet();
  gesture.begin({ x: 100, y: 100 }, at);
  hold.press(petId);
  /** Polls once per 16 ms frame from `from` to `to`; returns what was sent and when. */
  const frames = (from: number, to: number) => {
    const sent: { at: number; command: PressCommand }[] = [];
    for (let now = from; now <= to; now += 16) {
      const command = hold.poll(gesture.poll(now));
      if (command) sent.push({ at: now, command });
    }
    return sent;
  };
  return { gesture, hold, frames };
}

describe('hold-to-pet commands', () => {
  it('a quick click pets for 2 s and never holds', () => {
    const { gesture, hold, frames } = press();
    expect(frames(1000, 1000 + HOLD_THRESHOLD_MS - 1)).toEqual([]);
    expect(hold.release(gesture.end())).toEqual({ type: 'pet', petId: 'archie' });
    expect(hold.pressed).toBeNull();
  });

  it('sends pet-hold once, on the first frame at the threshold, and pet-release when the press ends', () => {
    const { gesture, hold, frames } = press('jumi');
    expect(frames(1000, 3000)).toEqual([{ at: 1352, command: { type: 'pet-hold', petId: 'jumi' } }]);
    expect(hold.holdSent).toBe(true);
    expect(hold.release(gesture.end())).toEqual({ type: 'pet-release', petId: 'jumi' });
    expect(hold.holdSent).toBe(false);
    expect(hold.cancel()).toBeNull();
  });

  it('a drag after a hold is still a drag: the press sends nothing more', () => {
    const { gesture, hold, frames } = press();
    expect(frames(1000, 1400)).toHaveLength(1);
    expect(gesture.move({ x: 107, y: 100 })).toBe('dragging');
    hold.dragged();
    expect(hold.holdSent).toBe(false);
    expect(frames(1416, 2000)).toEqual([]);
    expect(hold.release(gesture.end())).toBeNull();
  });

  it('a drag before the threshold never becomes a hold', () => {
    const { gesture, hold, frames } = press();
    expect(frames(1000, 1200)).toEqual([]);
    gesture.move({ x: 100, y: 108 });
    hold.dragged();
    expect(frames(1216, 3000)).toEqual([]);
    expect(hold.release(gesture.end())).toBeNull();
  });

  it('a press that became a drag never pets, whatever phase or result follows', () => {
    const hold = new HoldToPet();
    hold.press('archie');
    hold.dragged();
    expect(hold.poll('holding')).toBeNull();
    expect(hold.release('hold')).toBeNull();
    hold.press('jumi');
    hold.dragged();
    expect(hold.release('click')).toBeNull();
  });

  it('a cancelled hold is released exactly once; a cancelled plain press sends nothing', () => {
    const held = press('jumi');
    held.frames(1000, 1400);
    expect(held.hold.cancel()).toEqual({ type: 'pet-release', petId: 'jumi' });
    expect(held.hold.cancel()).toBeNull();
    expect(held.hold.release('hold')).toBeNull();
    const plain = press();
    plain.frames(1000, 1100);
    expect(plain.hold.cancel()).toBeNull();
    expect(plain.hold.release('click')).toBeNull();
  });

  it('a new press starts fresh', () => {
    const { hold, frames } = press();
    frames(1000, 1400);
    hold.press('jumi');
    expect(hold.holdSent).toBe(false);
    expect(hold.poll('holding')).toEqual({ type: 'pet-hold', petId: 'jumi' });
    expect(hold.poll('holding')).toBeNull();
  });

  it('a slow click just past the threshold still pets as long as a click, through the engine', () => {
    const engine = new PetEngine(defaultPreferences(), { width: 1280, height: 720 }, () => 0.5);
    const archie = () => engine.snapshot().pets.find(pet => pet.id === 'archie')!;
    const { gesture, hold, frames } = press();
    for (const { command } of frames(1000, 1450)) engine.command(command);
    expect(archie()).toMatchObject({ action: 'pet', held: true });
    engine.step(0.1);
    const release = hold.release(gesture.end());
    expect(release).toEqual({ type: 'pet-release', petId: 'archie' });
    engine.command(release!);
    expect(archie()).toMatchObject({ action: 'pet', held: false });
    for (let i = 0; i < 54; i++) engine.step(1 / 30);
    expect(archie().action).toBe('pet');
    for (let i = 0; i < 6; i++) engine.step(1 / 30);
    expect(archie().action).toBe('sit');
  });

  it('does nothing without a press, and treats an unsent hold as a click', () => {
    const idle = new HoldToPet();
    expect(idle.poll('holding')).toBeNull();
    expect(idle.release('click')).toBeNull();
    expect(idle.cancel()).toBeNull();
    const unsent = new HoldToPet();
    unsent.press('archie');
    expect(unsent.release('hold')).toEqual({ type: 'pet', petId: 'archie' });
    expect(unsent.release('inactive')).toBeNull();
  });
});

describe('purr loop control', () => {
  const pets = (held: boolean, visible = true) => [{ held, visible }, { held: false, visible: true }];
  const running = { pets: pets(true), sound: true, quiet: false, running: true };

  it('wants the loop only while a visible kitten is held with sound on, Quiet Mode off and the scene running', () => {
    expect(purrLoopWanted(running)).toBe(true);
    expect(purrLoopWanted({ ...running, pets: [{ held: false, visible: true }, { held: true, visible: true }] })).toBe(true);
    for (const patch of [{ pets: pets(false) }, { pets: pets(true, false) }, { sound: false }, { quiet: true }, { running: false }]) {
      expect(purrLoopWanted({ ...running, ...patch })).toBe(false);
    }
  });

  it('starts once per held pet and stops as soon as the loop is no longer wanted', () => {
    const control = new PurrControl();
    expect(control.update(false, false)).toBeNull();
    expect(control.update(true, false)).toBe('start');
    expect(control.update(true, true)).toBeNull();
    // The loop's own cap ended it a moment before the engine ended the held pet: no restart.
    expect(control.update(true, false)).toBeNull();
    expect(control.update(false, false)).toBeNull();
    // The next held pet gets its own loop, and a release fades it out.
    expect(control.update(true, false)).toBe('start');
    expect(control.update(false, true)).toBe('stop');
    expect(control.update(false, false)).toBeNull();
  });

  it('starts again when sound comes back during the same held pet', () => {
    const control = new PurrControl();
    expect(control.update(true, false)).toBe('start');
    expect(control.update(false, true)).toBe('stop');
    expect(control.update(true, false)).toBe('start');
  });
});
