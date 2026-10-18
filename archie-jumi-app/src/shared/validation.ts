import { defaultPreferences } from './defaults';
import { PET_IDS, type Preferences, type PetCommand, type Size, type Point } from './types';
const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const bounded = (v: unknown, fallback: number, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
const bool = (v: unknown, fallback: boolean) => typeof v === 'boolean' ? v : fallback;
const str = (v: unknown, fallback: string, max = 64) => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : fallback;
export function normalizePreferences(value: unknown, base: Preferences = defaultPreferences()): Preferences {
  const v = obj(value), pets = obj(v.pets);
  const result: Preferences = { ...base, pets: structuredClone(base.pets), sound: bool(v.sound, base.sound), volume: bounded(v.volume, base.volume, 0, 1), reducedMotion: bool(v.reducedMotion, base.reducedMotion), quiet: bool(v.quiet, base.quiet), launchAtLogin: bool(v.launchAtLogin, base.launchAtLogin), shortcut: str(v.shortcut, base.shortcut, 100), selectedDisplay: v.selectedDisplay === null ? null : typeof v.selectedDisplay === 'string' ? v.selectedDisplay.slice(0, 80) : base.selectedDisplay, curious: bool(v.curious, base.curious ?? true) };
  for (const id of PET_IDS) {
    const p = obj(pets[id]), b = base.pets[id], personality = obj(p.personality), position = obj(p.position);
    result.pets[id] = { name: str(p.name, b.name, 32), visible: bool(p.visible, b.visible), size: bounded(p.size, b.size, 96, 192), personality: { playfulness: bounded(personality.playfulness, b.personality.playfulness, 0, 1), energy: bounded(personality.energy, b.personality.energy, 0, 1), sociability: bounded(personality.sociability, b.personality.sociability, 0, 1) }, position: { x: bounded(position.x, b.position.x, 0, 1), y: bounded(position.y, b.position.y, 0, 1) } };
  }
  return result;
}
export function validCommand(value: unknown, scene: Size): PetCommand | null {
  const c = obj(value), type = c.type;
  if (type === 'end-play') return { type };
  if (type === 'pair' && (c.kind === 'nap' || c.kind === 'nose_touch')) return { type, kind: c.kind };
  const point = obj(c.point);
  const validPoint = typeof point.x === 'number' && Number.isFinite(point.x) && typeof point.y === 'number' && Number.isFinite(point.y);
  const clipped: Point = { x: bounded(point.x, 0, 0, scene.width), y: bounded(point.y, 0, 0, scene.height) };
  if (type === 'toy-move' && validPoint && typeof c.held === 'boolean') return { type, point: clipped, held: c.held };
  const petId = c.petId;
  if (petId !== 'archie' && petId !== 'jumi') return null;
  if (type === 'pet' || type === 'treat' || type === 'nap' || type === 'wake' || type === 'hide' || type === 'show') return { type, petId };
  if (type === 'play') return { type, petId, automatic: c.automatic === true };
  if ((type === 'move' || type === 'drag-start' || type === 'drag' || type === 'drag-end' || type === 'come') && validPoint) return { type, petId, point: clipped };
  return null;
}
