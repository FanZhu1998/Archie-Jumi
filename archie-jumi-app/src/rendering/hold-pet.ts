/**
 * Hold-to-pet and its purr (Phase 2 spec 6.1). Pure; no DOM.
 *
 * `HoldToPet` turns one press on a kitten into pet commands. A quick click pets for 2 s, as in 1.0.2.
 * A press that stays within the drag threshold for HOLD_THRESHOLD_MS (src/core/input.ts) starts a held
 * pet; releasing or cancelling that press ends it (the engine lets a hold released within 2 s pet on to
 * 2 s, as long as a click). A press that becomes a drag sends nothing here: the engine's drag-start ends a
 * held pet, so a drag after a hold is still a drag.
 *
 * `PurrControl` decides when the looping purr starts and stops. It follows the scene's held pet while
 * sound is on and the scene runs, and starts at most once per held pet, so the loop's own safety cap
 * ending a moment before the engine's never restarts it.
 */
import type { GesturePhase, GestureResult } from '../core/input';
import type { PetId, PetState } from '../shared/types';

/** The pet commands a press sends. All are local (overlay to engine); `pet-hold` and `pet-release` never cross IPC. */
export interface PressCommand { type: 'pet' | 'pet-hold' | 'pet-release'; petId: PetId }

export class HoldToPet {
  private petId: PetId | null = null;
  private holding = false;
  private dragging = false;

  /** A press on `petId` began. */
  press(petId: PetId): void {
    this.petId = petId;
    this.holding = false;
    this.dragging = false;
  }

  /** The kitten being pressed, or null. */
  get pressed(): PetId | null {
    return this.petId;
  }

  /** A held pet was started for the current press and not yet released. */
  get holdSent(): boolean {
    return this.holding;
  }

  /** Call every frame while pressed, with `gesture.poll(now)`. Returns `pet-hold` once, on the first 'holding'. */
  poll(phase: GesturePhase): PressCommand | null {
    if (this.petId === null || this.holding || this.dragging || phase !== 'holding') return null;
    this.holding = true;
    return { type: 'pet-hold', petId: this.petId };
  }

  /** The press became a drag. The drag commands take over (the engine's drag-start ends a held pet). */
  dragged(): void {
    this.dragging = true;
    this.holding = false;
  }

  /**
   * The press ended with `result` (from `gesture.end()`): a held pet is released, a click pets for 2 s,
   * and a drag sends nothing. A recognized hold whose `pet-hold` was never sent counts as a click.
   */
  release(result: GestureResult): PressCommand | null {
    const petId = this.petId, holding = this.holding, dragging = this.dragging;
    this.reset();
    if (petId === null || dragging || result === 'drag' || result === 'inactive') return null;
    return { type: holding ? 'pet-release' : 'pet', petId };
  }

  /** The press was cancelled (lost capture, pause, Quiet Mode): a held pet that is still running is released. */
  cancel(): PressCommand | null {
    const petId = this.petId, holding = this.holding;
    this.reset();
    return petId !== null && holding ? { type: 'pet-release', petId } : null;
  }

  private reset(): void {
    this.petId = null;
    this.holding = false;
    this.dragging = false;
  }
}

export interface PurrInput {
  pets: readonly Pick<PetState, 'held' | 'visible'>[];
  sound: boolean;
  quiet: boolean;
  /** The scene is running: neither paused nor hidden. */
  running: boolean;
}

/** The looping purr plays while a visible kitten is held, sound is on, Quiet Mode is off and the scene runs. */
export function purrLoopWanted(input: PurrInput): boolean {
  return input.sound && !input.quiet && input.running && input.pets.some(pet => pet.held && pet.visible);
}

export type PurrChange = 'start' | 'stop' | null;

export class PurrControl {
  private started = false;

  /**
   * `wanted` comes from purrLoopWanted, `playing` says whether the loop sounds now. Returns what to do
   * this frame: start the loop once per held pet, stop it as soon as it is no longer wanted.
   */
  update(wanted: boolean, playing: boolean): PurrChange {
    if (!wanted) {
      this.started = false;
      return playing ? 'stop' : null;
    }
    if (this.started) return null;
    this.started = true;
    return 'start';
  }
}
