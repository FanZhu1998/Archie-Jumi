/**
 * The compact, read-only scene summary that `window.__archieJumi.scene` exposes to the native smoke
 * test (Phase 2 spec 6.5). Cheap values only; the overlay builds it on demand when the getter is read.
 * Pure.
 */
import type { Action, Facing, PetId, SceneSnapshot, TreatState } from '../shared/types';

export interface PetSummary {
  id: PetId;
  action: Action;
  /** Seconds in the current action (0.01 s). */
  actionTime: number;
  held: boolean;
  /** Leap progress 0..1 while airborne in a pounce (0.001), otherwise null. */
  leap: number | null;
  /** Kitten centre in scene DIP (0.1 DIP). */
  x: number;
  y: number;
  size: number;
  facing: Facing;
  /** Current movement speed in DIP/s (0.1). */
  speed: number;
  visible: boolean;
}

export interface SceneSummary {
  pets: PetSummary[];
  treats: { petId: PetId; phase: TreatState['phase'] }[];
  toy: { x: number; y: number; held: boolean; automatic: boolean } | null;
  /** `kind:phase` of the pair activity, or null. */
  pair: string | null;
  /** Kittens that may notice the cursor now (engine.attentivePets()). */
  attentive: PetId[];
  /** Attention squares in the interest region the renderer last sent. */
  attention: number;
}

/** Rounds to `digits` decimals (dividing by an integer power of ten avoids results such as 0.30000000000000004). */
const fixed = (value: number, digits: number) => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

export function summarizeScene(snapshot: SceneSnapshot, attentive: readonly PetId[], attention: number): SceneSummary {
  return {
    pets: snapshot.pets.map(pet => ({
      id: pet.id, action: pet.action, actionTime: fixed(pet.actionTime, 2), held: pet.held,
      leap: pet.leap ? fixed(pet.leap.progress, 3) : null,
      x: fixed(pet.x, 1), y: fixed(pet.y, 1), size: pet.size, facing: pet.facing, speed: fixed(pet.speed, 1), visible: pet.visible,
    })),
    treats: snapshot.treats.map(treat => ({ petId: treat.petId, phase: treat.phase })),
    toy: snapshot.toy ? { x: fixed(snapshot.toy.x, 1), y: fixed(snapshot.toy.y, 1), held: snapshot.toy.held, automatic: snapshot.toy.automatic } : null,
    pair: snapshot.pair ? `${snapshot.pair.kind}:${snapshot.pair.phase}` : null,
    attentive: [...attentive],
    attention,
  };
}
