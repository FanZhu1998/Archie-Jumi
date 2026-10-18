import { PET_IDS } from '../shared/types';
import type { Action, PairState, PetCommand, PetId, PetState, Point, Preferences, SceneSnapshot, Size, ToyState } from '../shared/types';

export const PAIR_COOLDOWN = 120;
export const PLAY_DURATION = 30;
export const PET_DURATION = 2;

interface RuntimePet extends PetState {
  remaining: number;
  movement: 'wander' | 'quiet' | 'pair' | 'toy' | null;
}

const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const copyPreferences = (preferences: Preferences): Preferences => JSON.parse(JSON.stringify(preferences)) as Preferences;

/** Pure, deterministic behavior model. All durations are seconds, all scene points are DIP. */
export class PetEngine {
  private preferences: Preferences;
  private scene: Size;
  private readonly pets: Record<PetId, RuntimePet>;
  private toy: ToyState | null = null;
  private pair: PairState | null = null;
  private time = 0;
  private pairAvailableAt = 0;
  private nextSocialAt: number;
  private toyOrigin: Point | null = null;
  private toyElapsed = 0;

  constructor(preferences: Preferences, scene: Size, private readonly random: () => number = Math.random) {
    this.preferences = copyPreferences(preferences);
    this.scene = this.validScene(scene);
    this.pets = Object.fromEntries(PET_IDS.map(id => {
      const pref = preferences.pets[id];
      const size = clamp(finite(pref.size, 128), 96, 192);
      const point = this.clampPet({ x: pref.position.x * this.scene.width, y: pref.position.y * this.scene.height }, size);
      return [id, { id, ...point, action: 'idle', actionTime: 0, facing: id === 'archie' ? 'right' : 'left',
        forcedSleep: false, visible: pref.visible, size, target: null, remaining: this.between(4, 9), movement: null } satisfies RuntimePet];
    })) as Record<PetId, RuntimePet>;
    this.nextSocialAt = this.between(35, 70);
    if (preferences.quiet) this.enterQuiet();
  }

  /** The caller pauses stepping while hidden. Large resume gaps never cause catch-up behavior. */
  step(elapsed: number): void {
    const dt = clamp(finite(elapsed, 0), 0, 0.25);
    if (dt === 0) return;
    this.time += dt;
    this.updateToy(dt);
    for (const pet of Object.values(this.pets)) {
      if (!pet.visible) continue;
      pet.actionTime += dt;
      if (pet.action === 'carried') continue;
      if (this.preferences.quiet) {
        if (pet.target) this.advance(pet, dt, 55);
        if (!pet.target && pet.action !== 'sit') this.act(pet, 'sit', Infinity);
        continue;
      }
      if (this.pair && pet.movement === 'pair') {
        if (pet.target) this.advance(pet, dt, 65);
        continue;
      }
      if (this.toy?.petId === pet.id) {
        this.followToy(pet, dt);
        continue;
      }
      if (pet.target) {
        this.advance(pet, dt, pet.action === 'trot' ? 80 : 38);
        if (!pet.target) this.act(pet, 'sit', this.between(4, 9));
        continue;
      }
      if (pet.forcedSleep) continue;
      pet.remaining -= dt;
      if (pet.remaining <= 0) this.finishAction(pet);
    }
    this.updatePair(dt);
    if (!this.preferences.quiet && !this.preferences.reducedMotion && this.time >= this.nextSocialAt) {
      this.nextSocialAt = this.time + this.between(30, 55);
      const sociability = (this.preferences.pets.archie.personality.sociability + this.preferences.pets.jumi.personality.sociability) / 2;
      if (this.unit() < sociability) this.startPair(this.unit() < 0.65 ? 'nose_touch' : 'nap');
    }
  }

  command(command: PetCommand): void {
    if (command.type === 'end-play') { this.endPlay(); return; }
    if (command.type === 'toy-move') {
      if (this.toy && !this.preferences.quiet) {
        const point = this.clampToy(command.point);
        Object.assign(this.toy, point, { held: command.held });
        this.toyOrigin = { ...point };
        this.toyElapsed = 0;
      }
      return;
    }
    if (command.type === 'pair') {
      if (!this.preferences.quiet) this.startPair(command.kind);
      return;
    }
    const pet = this.pets[command.petId];
    if (!pet) return;
    if (command.type === 'hide') {
      this.interrupt(pet.id);
      this.act(pet, pet.forcedSleep ? 'sleep' : 'sit', pet.forcedSleep ? Infinity : this.between(4, 8));
      pet.visible = false;
      this.preferences.pets[pet.id].visible = false;
      return;
    }
    if (command.type === 'show') {
      pet.visible = true;
      this.preferences.pets[pet.id].visible = true;
      if (this.preferences.quiet) this.quietPet(pet);
      return;
    }
    if (!pet.visible || this.preferences.quiet) return;
    this.interrupt(pet.id);
    pet.forcedSleep = false;
    switch (command.type) {
      case 'pet': this.act(pet, 'pet', PET_DURATION); break;
      case 'treat': this.act(pet, 'eat', 2.8); break;
      case 'nap':
        pet.forcedSleep = true;
        this.act(pet, 'sleep', Infinity);
        break;
      case 'wake': this.act(pet, 'wake', 0.8); break;
      case 'play': {
        this.endPlay();
        const point = this.clampToy({ x: pet.x + (pet.facing === 'left' ? -1 : 1) * pet.size * 1.15, y: pet.y + pet.size * 0.25 });
        this.toy = { ...point, petId: pet.id, remaining: PLAY_DURATION, automatic: command.automatic ?? false, held: false };
        this.toyOrigin = { ...point };
        this.toyElapsed = 0;
        this.act(pet, 'sit', 0.5);
        break;
      }
      case 'move':
        Object.assign(pet, this.clampPet(command.point, pet.size));
        this.act(pet, 'land', 0.5);
        break;
      case 'drag-start':
      case 'drag':
        Object.assign(pet, this.clampPet(command.point, pet.size));
        if (pet.action !== 'carried') this.act(pet, 'carried', Infinity);
        break;
      case 'drag-end':
        Object.assign(pet, this.clampPet(command.point, pet.size));
        this.act(pet, 'land', 0.5);
        break;
    }
  }

  setPreferences(preferences: Preferences): void {
    const wasQuiet = this.preferences.quiet;
    const wasReduced = this.preferences.reducedMotion;
    const previous = this.preferences;
    this.preferences = copyPreferences(preferences);
    for (const id of PET_IDS) {
      const pet = this.pets[id];
      const pref = preferences.pets[id];
      if (pet.visible && !pref.visible) {
        this.interrupt(id);
        this.act(pet, pet.forcedSleep ? 'sleep' : 'sit', pet.forcedSleep ? Infinity : this.between(4, 8));
      }
      pet.visible = pref.visible;
      pet.size = clamp(finite(pref.size, 128), 96, 192);
      const positionChanged = previous.pets[id].position.x !== pref.position.x || previous.pets[id].position.y !== pref.position.y;
      const point = positionChanged ? { x: pref.position.x * this.scene.width, y: pref.position.y * this.scene.height } : pet;
      Object.assign(pet, this.clampPet(point, pet.size));
      if (pet.target) pet.target = this.clampPet(pet.target, pet.size);
    }
    if (preferences.quiet && !wasQuiet) this.enterQuiet();
    else if (preferences.quiet) {
      for (const pet of Object.values(this.pets)) this.quietPet(pet);
    } else if (wasQuiet) {
      for (const pet of Object.values(this.pets)) this.act(pet, pet.forcedSleep ? 'sleep' : 'wake', pet.forcedSleep ? Infinity : 0.8);
    }
    if (preferences.reducedMotion && !wasReduced && !preferences.quiet) {
      this.cancelPair();
      for (const pet of Object.values(this.pets)) {
        if (pet.target || pet.action === 'pounce') this.act(pet, 'sit', this.between(4, 8));
      }
    }
  }

  resize(scene: Size): void {
    const positions = this.positions();
    this.scene = this.validScene(scene);
    this.cancelPair();
    this.endPlay();
    for (const pet of Object.values(this.pets)) {
      const point = positions[pet.id];
      Object.assign(pet, this.clampPet({ x: point.x * this.scene.width, y: point.y * this.scene.height }, pet.size));
      if (pet.action === 'carried' || pet.target) this.act(pet, 'land', 0.5);
      if (this.preferences.quiet) this.quietPet(pet);
    }
  }

  snapshot(): SceneSnapshot {
    const pets = PET_IDS.map(id => {
      const { remaining: _remaining, movement: _movement, ...pet } = this.pets[id];
      return { ...pet, target: pet.target ? { ...pet.target } : null };
    });
    return { pets, toy: this.toy ? { ...this.toy } : null, pair: this.pair ? { ...this.pair } : null, time: this.time, quiet: this.preferences.quiet };
  }

  positions(): Record<PetId, Point> {
    return Object.fromEntries(PET_IDS.map(id => [id, {
      x: clamp(this.pets[id].x / this.scene.width, 0, 1), y: clamp(this.pets[id].y / this.scene.height, 0, 1),
    }])) as Record<PetId, Point>;
  }

  private act(pet: RuntimePet, action: Action, duration: number): void {
    pet.action = action;
    pet.actionTime = 0;
    pet.remaining = duration;
    pet.target = null;
    pet.movement = null;
  }

  private finishAction(pet: RuntimePet): void {
    if (pet.action === 'sleep') { this.act(pet, 'wake', 0.8); return; }
    if (['pet', 'eat', 'wake', 'land', 'pounce', 'nose_touch'].includes(pet.action)) {
      this.act(pet, 'sit', this.between(4, 8));
      return;
    }
    const personality = this.preferences.pets[pet.id].personality;
    const draw = this.unit();
    if (!this.preferences.reducedMotion && draw < 0.15 + personality.energy * 0.3) {
      this.act(pet, personality.playfulness > 0.65 && this.unit() < 0.25 ? 'trot' : 'walk', Infinity);
      pet.target = this.clampPet({ x: pet.x + this.between(-170, 170), y: pet.y + this.between(-65, 65) }, pet.size);
      pet.movement = 'wander';
    } else if (draw > 0.88 - (1 - personality.energy) * 0.15) {
      this.act(pet, 'sleep', this.between(18, 42));
    } else if (draw > 0.63) this.act(pet, 'groom', this.between(3, 5));
    else this.act(pet, this.unit() < 0.45 ? 'idle' : 'sit', this.between(5, 11));
  }

  private advance(pet: RuntimePet, dt: number, speed: number): void {
    if (!pet.target) return;
    const dx = pet.target.x - pet.x;
    const dy = pet.target.y - pet.y;
    const distance = Math.hypot(dx, dy);
    if (Math.abs(dx) > 1) pet.facing = dx < 0 ? 'left' : 'right';
    if (distance <= Math.max(0.5, speed * dt)) {
      Object.assign(pet, pet.target);
      pet.target = null;
      if (pet.movement !== 'pair' && pet.movement !== 'toy') pet.movement = null;
    } else {
      pet.x += dx / distance * speed * dt;
      pet.y += dy / distance * speed * dt;
    }
  }

  private interrupt(id: PetId): void {
    this.cancelPair();
    if (this.toy?.petId === id) this.endPlay();
    this.pets[id].target = null;
    this.pets[id].movement = null;
  }

  private updateToy(dt: number): void {
    if (!this.toy) return;
    this.toy.remaining -= dt;
    if (this.toy.remaining <= 0) { this.endPlay(); return; }
    this.toyElapsed += dt;
    if (this.toy.automatic && !this.toy.held && this.toyOrigin && !this.preferences.reducedMotion) {
      const point = this.clampToy({ x: this.toyOrigin.x + Math.sin(this.toyElapsed * 1.7) * 100,
        y: this.toyOrigin.y + Math.sin(this.toyElapsed * 0.9) * 35 });
      Object.assign(this.toy, point);
    }
  }

  private followToy(pet: RuntimePet, dt: number): void {
    if (!this.toy) return;
    const target = this.clampPet({ x: this.toy.x, y: this.toy.y - pet.size * 0.2 }, pet.size);
    const dx = target.x - pet.x;
    if (Math.abs(dx) > 2) pet.facing = dx < 0 ? 'left' : 'right';
    if (this.preferences.reducedMotion) {
      if (pet.action !== 'sit') this.act(pet, 'sit', Infinity);
      return;
    }
    if (pet.action === 'pounce') {
      pet.remaining -= dt;
      if (pet.remaining <= 0) this.act(pet, 'sit', 0.75);
      return;
    }
    const distance = Math.hypot(target.x - pet.x, target.y - pet.y);
    if (distance > pet.size * 0.35) {
      if (pet.action !== 'trot') this.act(pet, 'trot', Infinity);
      pet.target = target;
      pet.movement = 'toy';
      this.advance(pet, dt, 90);
    } else {
      if (pet.action === 'trot') this.act(pet, 'sit', 0.35);
      pet.remaining -= dt;
      if (pet.remaining <= 0) this.act(pet, 'pounce', 0.65);
    }
  }

  private endPlay(): void {
    if (this.toy) {
      const pet = this.pets[this.toy.petId];
      if (!pet.forcedSleep && pet.action !== 'carried') this.act(pet, 'sit', this.between(4, 8));
    }
    this.toy = null;
    this.toyOrigin = null;
    this.toyElapsed = 0;
  }

  private startPair(kind: PairState['kind']): void {
    if (this.pair || this.toy || this.time < this.pairAvailableAt) return;
    const [archie, jumi] = [this.pets.archie, this.pets.jumi];
    if ([archie, jumi].some(pet => !pet.visible || pet.forcedSleep || !['idle', 'sit', 'groom'].includes(pet.action))) return;
    const separation = (archie.size + jumi.size) * (kind === 'nose_touch' ? 0.43 : 0.49);
    const maxSize = Math.max(archie.size, jumi.size);
    if (this.scene.width < separation + maxSize * 1.24 + 24 || this.scene.height < maxSize * 1.1 + 24) return;
    const center = { x: clamp((archie.x + jumi.x) / 2, maxSize * 0.62 + 8 + separation / 2,
      this.scene.width - maxSize * 0.62 - 8 - separation / 2), y: (archie.y + jumi.y) / 2 };
    this.pair = { kind, phase: 'approach', elapsed: 0 };
    for (const [index, pet] of [archie, jumi].entries()) {
      this.act(pet, 'walk', Infinity);
      pet.target = this.clampPet({ x: center.x + (index === 0 ? -1 : 1) * separation / 2, y: center.y }, pet.size);
      pet.movement = 'pair';
      if (this.preferences.reducedMotion) {
        Object.assign(pet, pet.target);
        pet.target = null;
      }
    }
  }

  private updatePair(dt: number): void {
    if (!this.pair) return;
    this.pair.elapsed += dt;
    if (this.pair.phase === 'approach') {
      if (this.pair.elapsed > 20) { this.cancelPair(); return; }
      if (PET_IDS.some(id => this.pets[id].target)) return;
      this.pair.phase = 'together';
      this.pair.elapsed = 0;
      for (const id of PET_IDS) {
        const pet = this.pets[id];
        this.act(pet, this.pair.kind === 'nap' ? 'sleep' : 'nose_touch', Infinity);
        pet.movement = 'pair';
        pet.facing = id === 'archie' ? 'right' : 'left';
      }
    } else if (this.pair.elapsed >= (this.pair.kind === 'nap' ? 6 : 2)) {
      const kind = this.pair.kind;
      this.pair = null;
      this.pairAvailableAt = this.time + PAIR_COOLDOWN;
      for (const pet of Object.values(this.pets)) this.act(pet, kind === 'nap' ? 'sleep' : 'sit', kind === 'nap' ? this.between(22, 40) : this.between(5, 9));
    }
  }

  private cancelPair(): void {
    if (!this.pair) return;
    this.pair = null;
    this.pairAvailableAt = this.time + PAIR_COOLDOWN;
    for (const pet of Object.values(this.pets)) {
      if (pet.movement !== 'pair') continue;
      this.act(pet, pet.action === 'sleep' ? 'sleep' : 'sit', pet.action === 'sleep' ? this.between(22, 40) : this.between(4, 8));
    }
  }

  private enterQuiet(): void {
    this.cancelPair();
    this.endPlay();
    for (const pet of Object.values(this.pets)) this.quietPet(pet);
  }

  private quietPet(pet: RuntimePet): void {
    const target = this.clampPet({ x: pet.x, y: this.scene.height }, pet.size);
    this.act(pet, 'walk', Infinity);
    pet.target = target;
    pet.movement = 'quiet';
    if (this.preferences.reducedMotion) {
      Object.assign(pet, target);
      this.act(pet, 'sit', Infinity);
    }
  }

  private clampPet(point: Point, size: number): Point {
    const marginX = Math.min(size * 0.62 + 8, this.scene.width / 2);
    const marginY = Math.min(size * 0.55 + 8, this.scene.height / 2);
    return { x: clamp(finite(point.x, this.scene.width / 2), marginX, this.scene.width - marginX),
      y: clamp(finite(point.y, this.scene.height / 2), marginY, this.scene.height - marginY) };
  }

  private clampToy(point: Point): Point {
    const margin = Math.min(20, this.scene.width / 2, this.scene.height / 2);
    return { x: clamp(finite(point.x, this.scene.width / 2), margin, this.scene.width - margin),
      y: clamp(finite(point.y, this.scene.height / 2), margin, this.scene.height - margin) };
  }

  private validScene(scene: Size): Size {
    return { width: Math.max(1, finite(scene.width, 1280)), height: Math.max(1, finite(scene.height, 720)) };
  }

  private unit(): number { return clamp(finite(this.random(), 0.5), 0, 1 - Number.EPSILON); }
  private between(min: number, max: number): number { return min + this.unit() * (max - min); }
}
