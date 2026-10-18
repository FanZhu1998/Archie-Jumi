/**
 * Pure validators for renderer → main IPC payloads added in 1.0.2. Each returns a fresh,
 * minimal copy (unknown fields dropped) or null; callers drop invalid payloads silently.
 */
import { ACTIONS, PET_IDS } from './types';
import type { Action, Facing, HeartbeatPayload, InputModePayload, InputTarget, InterestPayload, PetId, Rect, SceneCarryOver, ScenePetCarryOver, Size } from './types';

export const MAX_INTEREST_RECTS = 8;
/** A heartbeat counts frames for about one second; anything near this bound is not a real count. */
export const MAX_HEARTBEAT_FRAMES = 100_000;

const TARGETS: readonly InputTarget[] = [null, 'archie', 'jumi', 'toy'];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const validGeneration = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const validTarget = (value: unknown): value is InputTarget => TARGETS.includes(value as InputTarget);

export function validInputModePayload(value: unknown): InputModePayload | null {
  const v = record(value);
  if (!v || !validGeneration(v.generation) || !validTarget(v.target) || typeof v.capture !== 'boolean') return null;
  return { generation: v.generation, target: v.target, capture: v.capture };
}

export function validHeartbeat(value: unknown): HeartbeatPayload | null {
  const v = record(value);
  const report = validInputModePayload(value);
  if (!v || !report) return null;
  const frames = v.frames;
  if (typeof frames !== 'number' || !Number.isSafeInteger(frames) || frames < 0 || frames > MAX_HEARTBEAT_FRAMES) return null;
  return { ...report, frames };
}

/**
 * Interest rectangles are in scene DIP. They may extend a little past the scene edges, but
 * every number must be finite, sizes non-negative and at most twice the scene size.
 */
export function validInterest(value: unknown, scene: Size): InterestPayload | null {
  const v = record(value);
  if (!v || !validGeneration(v.generation) || !Array.isArray(v.rects) || v.rects.length > MAX_INTEREST_RECTS) return null;
  const rects: Rect[] = [];
  for (const item of v.rects as unknown[]) {
    const r = record(item);
    if (!r || !finite(r.x) || !finite(r.y) || !finite(r.width) || !finite(r.height)) return null;
    if (r.width < 0 || r.height < 0 || r.width > scene.width * 2 || r.height > scene.height * 2) return null;
    if (r.x < -scene.width || r.x > scene.width * 2 || r.y < -scene.height || r.y > scene.height * 2) return null;
    rects.push({ x: r.x, y: r.y, width: r.width, height: r.height });
  }
  return { generation: v.generation, rects };
}

function validPetCarryOver(value: unknown): ScenePetCarryOver | null {
  const p = record(value);
  if (!p || typeof p.action !== 'string' || !ACTIONS.includes(p.action as Action)) return null;
  if ((p.facing !== 'left' && p.facing !== 'right') || typeof p.forcedSleep !== 'boolean') return null;
  return { action: p.action as Action, facing: p.facing as Facing, forcedSleep: p.forcedSleep };
}

export function validSceneState(value: unknown): SceneCarryOver | null {
  const v = record(value);
  const pets = record(v?.pets);
  if (!v || !validGeneration(v.generation) || !pets) return null;
  const result = {} as Record<PetId, ScenePetCarryOver>;
  for (const id of PET_IDS) {
    const pet = Object.hasOwn(pets, id) ? validPetCarryOver(pets[id]) : null;
    if (!pet) return null;
    result[id] = pet;
  }
  return { generation: v.generation, pets: result };
}
