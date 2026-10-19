import { PET_IDS } from '../shared/types';
import type { Action, Facing, PairState, Personality, PetCommand, PetId, PetState, Point, Preferences, SceneSnapshot, ScenePetCarryOver, Size, ToyState, TreatState } from '../shared/types';

/** Scene state carried from a previous overlay generation (only `pets` is used). */
export interface EngineCarryOver { pets: Partial<Record<PetId, ScenePetCarryOver>> }

export const PAIR_COOLDOWN = 120;
export const PLAY_DURATION = 30;
export const PET_DURATION = 2;

// Movement speeds in DIP/s. Walk, trot and toy chase are multiplied by `energyFactor(energy)`
// (0.8 to 1.2); the pair approach and the quiet-mode walk are not.
export const WALK_SPEED = 55;
export const TROT_SPEED = 85;
export const CHASE_SPEED = 90;
export const PAIR_SPEED = 65;
export const QUIET_SPEED = 55;

/** A held pet (press and hold) lasts at most this many seconds, then the kitten sits. */
export const HELD_PET_MAX = 8;
/** The stretch after sleep, in seconds; matches the wake clip. */
export const WAKE_DURATION = 1.1;

// Pounce, in seconds: a stationary crouch, then a leap that moves the kitten linearly from
// `leap.from` to `leap.to` (the motion layer draws the arc, apex `leap.height` = LEAP_HEIGHT × size),
// then a `land`.
export const POUNCE_CROUCH = 0.2;
export const POUNCE_LEAP = 0.45;
export const POUNCE_DURATION = POUNCE_CROUCH + POUNCE_LEAP;
export const POUNCE_LAND = 0.3;
export const LEAP_HEIGHT = 0.35;
// Batting in automatic play: the toy rolls BAT_MIN to BAT_MAX DIP in the kitten's facing direction,
// starting at BAT_SPEED DIP/s and decelerating to rest.
export const BAT_MIN = 60;
export const BAT_MAX = 120;
export const BAT_SPEED = 300;
// Automatic toy: random waypoints within ±TOY_RANGE_X × ±TOY_RANGE_Y DIP of the play origin,
// travelled at TOY_SPEED DIP/s with an ease-out near each waypoint.
export const TOY_RANGE_X = 160;
export const TOY_RANGE_Y = 60;
export const TOY_SPEED = 110;

// Treat lifecycle. Durations in seconds; heights and distances are multiples of the kitten's size.
export const TREAT_FALL = 0.35;
export const TREAT_BOUNCE = 0.18;
export const TREAT_DROP_HEIGHT = 0.55;
export const TREAT_BOUNCE_HEIGHT = 0.08;
export const TREAT_AHEAD = 1.1;
export const TREAT_EAT_OFFSET = 0.35;
export const EAT_DURATION = 2.8;
export const CRUMBS_DURATION = 0.6;

// Cursor curiosity. Distances are multiples of the kitten's size; the cursor speed is in DIP/s.
export const CURIOUS_RADIUS = 1.6;
export const CURIOUS_DWELL = 2.5;
export const CURIOUS_MAX_CURSOR_SPEED = 400;
export const CURIOUS_DISTANCE = 0.8;
export const CURIOUS_LOST_AFTER = 0.5;
export const CURIOUS_COOLDOWN_MIN = 90;
export const CURIOUS_COOLDOWN_MAX = 180;

// Internal tuning (sizes are multiples of the kitten's size).
// Toy chase distances (to the toy's chase point). Separate thresholds give hysteresis, so a toy
// hovering at the edge of the range causes no trot/sit flicker: a chase always covers at least
// POUNCE_REACH − CHASE_STOP.
/** A trotting kitten stops to eye the toy once this close. */
const CHASE_STOP = 0.8;
/** When the eyeing ends, the kitten pounces if the toy is this close (otherwise it chases again). */
const POUNCE_REACH = 1.2;
/** An eyeing kitten gives up waiting and chases as soon as the toy is farther than this. */
const CHASE_RESUME = 1.5;
/** Closer than this the kitten just watches the toy instead of leaping onto it again. */
const LEAP_MIN = 0.3;
/** A leap lands this far short of the toy, so the front paws come down on it. */
const LEAP_LAND_OFFSET = 0.25;
/** The toy must lie within this distance of the front paws to be batted. */
const BAT_REACH = 0.6;
/** Seconds the kitten eyes the toy before deciding to pounce (also after each landing). */
const POUNCE_EYE = 0.35;
/**
 * Seconds the kitten watches a toy that lies right under its paws (TOY_WATCH to 2 × TOY_WATCH), before it
 * may pounce on it where it lies.
 */
const TOY_WATCH = 0.75;
/** Within this many DIP of a waypoint the toy slows down (ease-out), to TOY_MIN_EASE of its speed. */
const TOY_EASE_DISTANCE = 45;
const TOY_MIN_EASE = 0.2;
/** Waypoints lie at least this many DIP from the origin, alternating sides. */
const TOY_MIN_OFFSET = 40;
const TOY_PAUSE_CHANCE = 0.35;
const TOY_PAUSE_MAX = 0.6;
const LOOK_AROUND_CHANCE = 0.45;
const EDGE_SIT_CHANCE = 0.12;
/** Seconds: time constant of the smoothed cursor speed. */
const CURSOR_SMOOTHING = 0.25;
/** A curious kitten already this close to its approach point just sits. */
const CURIOUS_MIN_STEP = 0.15;
/** A treat is dropped on the other side when the clamp would leave it closer than this. */
const TREAT_MIN_SPACE = 0.5;
/** The kitten walks to its treat when the eating spot is farther than this. */
const TREAT_WALK_THRESHOLD = 0.4;
/** Centre spacing of a nose touch, as a fraction of the two sizes summed; a curious approach keeps at least this from the partner. */
const NOSE_TOUCH_SPACING = 0.43;

type Movement = 'wander' | 'quiet' | 'pair' | 'toy' | 'curious' | 'come' | 'treat' | 'edge';
/** `chase` is the trot used to follow the toy. */
export type Gait = 'walk' | 'trot' | 'chase';

/** Idle look-around, in actionTime seconds: face away at `start`, back to `facing` at `end`. */
interface LookAround { start: number; end: number; facing: Facing; turned: boolean }

interface RuntimePet extends PetState {
  remaining: number;
  movement: Movement | null;
  /** Seconds the cursor has rested near this kitten (cursor curiosity). */
  dwell: number;
  /** Engine time before which this kitten ignores the cursor (curiosity cooldown). */
  curiousAt: number;
  look: LookAround | null;
  /** The current pounce has no leap: the toy lay right under the paws when it began. */
  pounceInPlace: boolean;
}

interface RuntimeTreat extends TreatState {
  /** Where the kitten stands to eat it (pet-centre coordinates). */
  spot: Point;
}

/** A batted toy rolling to rest (quadratic ease-out). */
interface ToyRoll { fromX: number; fromY: number; toX: number; toY: number; elapsed: number; duration: number }

const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const copyPreferences = (preferences: Preferences): Preferences => JSON.parse(JSON.stringify(preferences)) as Preferences;
const trait = (value: number) => clamp(finite(value, 0.5), 0, 1);

/** Personality energy scales walk, trot and chase speed: 0.8 at energy 0, 1.2 at energy 1. */
export function energyFactor(energy: number): number {
  return 0.8 + 0.4 * trait(energy);
}

/** Movement speed in DIP/s for a gait at the given personality energy. */
export function speedFor(gait: Gait, energy: number): number {
  const base = gait === 'walk' ? WALK_SPEED : gait === 'trot' ? TROT_SPEED : CHASE_SPEED;
  return base * energyFactor(energy);
}

/**
 * Height in DIP of a dropped treat above its ground line, `elapsed` seconds after the drop: an
 * accelerating fall from TREAT_DROP_HEIGHT × size over TREAT_FALL, then one small bounce of
 * TREAT_BOUNCE_HEIGHT × size over TREAT_BOUNCE, then 0.
 */
export function treatHeight(elapsed: number, size: number): number {
  const t = Math.max(0, finite(elapsed, 0));
  if (t < TREAT_FALL) {
    const u = t / TREAT_FALL;
    return TREAT_DROP_HEIGHT * size * (1 - u * u);
  }
  if (t < TREAT_FALL + TREAT_BOUNCE) {
    const u = (t - TREAT_FALL) / TREAT_BOUNCE;
    return TREAT_BOUNCE_HEIGHT * size * 4 * u * (1 - u);
  }
  return 0;
}

/** Probability that a kitten walks over to a resting cursor once it has noticed it. */
export function curiousApproachChance(personality: Personality): number {
  return clamp(0.2 + 0.35 * trait(personality.playfulness) + 0.3 * trait(personality.sociability), 0, 0.85);
}

/** Probability that a kitten in range of the toy pounces now (otherwise it watches a little longer). */
export function pounceChance(personality: Personality): number {
  return clamp(0.45 + 0.55 * trait(personality.playfulness), 0, 1);
}

/** Probability that a landing in automatic play bats the toy away. */
export function batChance(personality: Personality): number {
  return clamp(0.5 + 0.5 * trait(personality.playfulness), 0, 1);
}

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
  private toyWaypoint: Point | null = null;
  private toyPause = 0;
  private toyRoll: ToyRoll | null = null;
  private treats: Partial<Record<PetId, RuntimeTreat>> = {};
  /** Latest observed cursor, the sample used by the previous step, its smoothed speed, and seconds unknown. */
  private cursor: Point | null = null;
  private cursorSample: Point | null = null;
  private cursorSpeed = 0;
  private cursorAway = 0;

  constructor(preferences: Preferences, scene: Size, private readonly random: () => number = Math.random, carryOver: EngineCarryOver | null = null) {
    this.preferences = copyPreferences(preferences);
    this.scene = this.validScene(scene);
    this.pets = Object.fromEntries(PET_IDS.map(id => {
      const pref = preferences.pets[id];
      const size = clamp(finite(pref.size, 128), 96, 192);
      const point = this.clampPet({ x: pref.position.x * this.scene.width, y: pref.position.y * this.scene.height }, size);
      return [id, { id, ...point, action: 'idle', actionTime: 0, facing: id === 'archie' ? 'right' : 'left',
        forcedSleep: false, visible: pref.visible, size, target: null, speed: 0, leap: null, held: false, remaining: this.between(4, 9), movement: null,
        dwell: 0, curiousAt: 0, look: null, pounceInPlace: false } satisfies RuntimePet];
    })) as Record<PetId, RuntimePet>;
    this.nextSocialAt = this.between(35, 70);
    if (carryOver) for (const id of PET_IDS) this.restore(this.pets[id], carryOver.pets?.[id]);
    if (preferences.quiet) this.enterQuiet();
  }

  /**
   * Restores what a recreated overlay should keep: facing, a requested nap, or an ordinary nap
   * with a fresh duration. Everything else starts from the usual defaults; quiet mode still wins.
   */
  private restore(pet: RuntimePet, saved: ScenePetCarryOver | undefined): void {
    if (!saved) return;
    if (saved.facing === 'left' || saved.facing === 'right') pet.facing = saved.facing;
    if (saved.forcedSleep === true) {
      pet.forcedSleep = true;
      this.act(pet, 'sleep', Infinity);
    } else if (saved.action === 'sleep') {
      this.act(pet, 'sleep', this.between(18, 42));
    }
  }

  /**
   * The latest cursor position in scene DIP (the same coordinates as pet centres), or null while
   * it is unknown or away. Call at any rate (typically once per rendered frame); each `step()`
   * samples the latest value once and derives a smoothed cursor speed from successive samples.
   */
  observeCursor(point: Point | null): void {
    this.cursor = point && Number.isFinite(point.x) && Number.isFinite(point.y) ? { x: point.x, y: point.y } : null;
  }

  /**
   * Kittens that currently care about the cursor: those that could notice it (cursor curiosity)
   * and those walking over to it. The renderer keeps an attention rect around each so the cursor
   * feed reports the cursor while it matters.
   */
  attentivePets(): PetId[] {
    return PET_IDS.filter(id => {
      const pet = this.pets[id];
      return this.curiousEligible(pet) || (pet.visible && pet.movement === 'curious');
    });
  }

  /** The caller pauses stepping while hidden. Large resume gaps never cause catch-up behavior. */
  step(elapsed: number): void {
    const dt = clamp(finite(elapsed, 0), 0, 0.25);
    if (dt === 0) return;
    this.time += dt;
    this.sampleCursor(dt);
    this.updateToy(dt);
    this.updateTreats(dt);
    for (const pet of Object.values(this.pets)) {
      pet.speed = 0;
      if (!pet.visible) continue;
      pet.actionTime += dt;
      this.updateCuriosity(pet, dt);
      if (pet.action === 'carried') continue;
      if (this.preferences.quiet) {
        if (pet.target) this.advance(pet, dt, QUIET_SPEED);
        if (!pet.target && pet.action !== 'sit') this.act(pet, 'sit', Infinity);
        continue;
      }
      if (this.pair && pet.movement === 'pair') {
        if (pet.target) this.advance(pet, dt, PAIR_SPEED);
        continue;
      }
      if (this.toy?.petId === pet.id) {
        this.followToy(pet, dt);
        continue;
      }
      const treat = this.treats[pet.id];
      if (treat && treat.phase !== 'eaten') {
        this.followTreat(pet, treat, dt);
        continue;
      }
      if (pet.target) {
        this.travel(pet, dt);
        continue;
      }
      if (pet.forcedSleep) continue;
      this.lookAround(pet);
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
        this.resetToyMotion();
      }
      return;
    }
    if (command.type === 'pair') {
      if (!this.preferences.quiet) this.startPair(command.kind);
      return;
    }
    const pet = this.pets[command.petId];
    if (!pet) return;
    if (command.type === 'pet-release') {
      // Only ends a held pet; a release after the cap (or after any interruption) changes nothing.
      if (!pet.held) return;
      // A hold released within PET_DURATION still pets as long as a click: the same pet carries on (not
      // restarted) and ends PET_DURATION after it began, then the kitten sits as after a click.
      if (pet.actionTime < PET_DURATION) {
        pet.held = false;
        pet.remaining = PET_DURATION - pet.actionTime;
      } else {
        this.act(pet, 'sit', this.between(4, 8));
      }
      return;
    }
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
      case 'pet-hold':
        this.act(pet, 'pet', HELD_PET_MAX);
        pet.held = true;
        break;
      case 'treat': this.dropTreat(pet); break;
      case 'nap':
        pet.forcedSleep = true;
        this.act(pet, 'sleep', Infinity);
        break;
      case 'wake': this.act(pet, 'wake', WAKE_DURATION); break;
      case 'play': {
        this.endPlay();
        const point = this.clampToy({ x: pet.x + (pet.facing === 'left' ? -1 : 1) * pet.size * 1.15, y: pet.y + pet.size * 0.25 });
        this.toy = { ...point, petId: pet.id, remaining: PLAY_DURATION, automatic: command.automatic ?? false, held: false };
        this.toyOrigin = { ...point };
        this.resetToyMotion();
        this.act(pet, 'sit', 0.5);
        break;
      }
      case 'come': this.come(pet, command.point); break;
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
      for (const pet of Object.values(this.pets)) this.act(pet, pet.forcedSleep ? 'sleep' : 'wake', pet.forcedSleep ? Infinity : WAKE_DURATION);
    }
    if (preferences.reducedMotion && !wasReduced && !preferences.quiet) {
      this.cancelPair();
      for (const pet of Object.values(this.pets)) this.serveTreat(pet);
      for (const pet of Object.values(this.pets)) {
        // A pending look-around would now be two instant flips: drop it, keeping the current facing.
        pet.look = null;
        if (pet.target || pet.action === 'pounce') this.act(pet, 'sit', this.between(4, 8));
      }
    }
    if (this.preferences.curious === false) {
      for (const pet of Object.values(this.pets)) {
        pet.dwell = 0;
        if (pet.movement === 'curious') this.act(pet, 'sit', this.between(4, 8));
      }
    }
  }

  resize(scene: Size): void {
    const positions = this.positions();
    this.scene = this.validScene(scene);
    this.cancelPair();
    this.endPlay();
    this.clearTreats();
    for (const pet of Object.values(this.pets)) {
      const point = positions[pet.id];
      Object.assign(pet, this.clampPet({ x: point.x * this.scene.width, y: point.y * this.scene.height }, pet.size));
      if (pet.action === 'carried' || pet.target) this.act(pet, 'land', 0.5);
      if (this.preferences.quiet) this.quietPet(pet);
    }
  }

  snapshot(): SceneSnapshot {
    const pets = PET_IDS.map(id => {
      const { remaining: _remaining, movement: _movement, dwell: _dwell, curiousAt: _curiousAt, look: _look, pounceInPlace: _pounceInPlace, ...pet } = this.pets[id];
      return { ...pet, target: pet.target ? { ...pet.target } : null, leap: pet.leap ? { ...pet.leap } : null };
    });
    const treats = PET_IDS.flatMap(id => {
      const treat = this.treats[id];
      return treat ? [{ petId: treat.petId, x: treat.x, y: treat.y, z: treat.z, phase: treat.phase, elapsed: treat.elapsed }] : [];
    });
    return { pets, toy: this.toy ? { ...this.toy } : null, pair: this.pair ? { ...this.pair } : null, time: this.time, quiet: this.preferences.quiet, treats };
  }

  positions(): Record<PetId, Point> {
    return Object.fromEntries(PET_IDS.map(id => [id, {
      x: clamp(this.pets[id].x / this.scene.width, 0, 1), y: clamp(this.pets[id].y / this.scene.height, 0, 1),
    }])) as Record<PetId, Point>;
  }

  /** Starts an action. Every action change also ends a held pet, a leap and a look-around. */
  private act(pet: RuntimePet, action: Action, duration: number): void {
    pet.action = action;
    pet.actionTime = 0;
    pet.remaining = duration;
    pet.target = null;
    pet.movement = null;
    pet.speed = 0;
    pet.leap = null;
    pet.held = false;
    pet.look = null;
    pet.pounceInPlace = false;
  }

  private finishAction(pet: RuntimePet): void {
    if (pet.action === 'sleep') { this.act(pet, 'wake', WAKE_DURATION); return; }
    if (['pet', 'eat', 'wake', 'land', 'pounce', 'nose_touch'].includes(pet.action)) {
      this.act(pet, 'sit', this.between(4, 8));
      return;
    }
    const previous = pet.action;
    const personality = this.preferences.pets[pet.id].personality;
    const draw = this.unit();
    if (!this.preferences.reducedMotion && draw < 0.15 + personality.energy * 0.3) this.wander(pet, personality);
    else if (draw > 0.88 - (1 - personality.energy) * 0.15) this.act(pet, 'sleep', this.between(18, 42));
    // Sit → groom → sit chains: a groom usually ends in a sit, and grooming is more likely right after sitting.
    else if (previous === 'groom') {
      if (this.unit() < 0.2) this.idle(pet);
      else this.act(pet, 'sit', this.between(5, 11));
    } else if (draw > (previous === 'sit' ? 0.43 : 0.63)) this.act(pet, 'groom', this.between(3, 5));
    else if (this.unit() < 0.45) this.idle(pet);
    else this.act(pet, 'sit', this.between(5, 11));
  }

  /** A wander walk or trot (playful kittens trot more often), or now and then an edge-sit. */
  private wander(pet: RuntimePet, personality: Personality): void {
    if (this.unit() < EDGE_SIT_CHANCE) {
      this.edgeSit(pet);
      return;
    }
    const trot = this.unit() < 0.3 * trait(personality.playfulness);
    this.act(pet, trot ? 'trot' : 'walk', Infinity);
    pet.target = this.clampPet({ x: pet.x + this.between(-170, 170), y: pet.y + this.between(-65, 65) }, pet.size);
    pet.movement = 'wander';
  }

  /** Walks to the bottom edge of the scene and sits there for a while. */
  private edgeSit(pet: RuntimePet): void {
    const target = this.clampPet({ x: pet.x, y: this.scene.height }, pet.size);
    if (Math.hypot(target.x - pet.x, target.y - pet.y) <= 1) {
      this.act(pet, 'sit', this.between(12, 20));
      return;
    }
    this.act(pet, 'walk', Infinity);
    pet.target = target;
    pet.movement = 'edge';
  }

  /** Idles, sometimes with a look-around: a brief turn the other way and back (not under reduced motion). */
  private idle(pet: RuntimePet): void {
    this.act(pet, 'idle', this.between(5, 11));
    if (this.preferences.reducedMotion || this.unit() >= LOOK_AROUND_CHANCE) return;
    const start = this.between(0.6, 2.4);
    pet.look = { start, end: start + this.between(1, 1.6), facing: pet.facing, turned: false };
  }

  private lookAround(pet: RuntimePet): void {
    const look = pet.look;
    if (!look || pet.action !== 'idle') return;
    if (!look.turned && pet.actionTime >= look.start) {
      pet.facing = look.facing === 'left' ? 'right' : 'left';
      look.turned = true;
    }
    if (look.turned && pet.actionTime >= look.end) {
      pet.facing = look.facing;
      pet.look = null;
    }
  }

  /** Moves a kitten that has a target (wander, edge-sit, curious approach, come here) and settles it on arrival. */
  private travel(pet: RuntimePet, dt: number): void {
    const movement = pet.movement;
    if (movement === 'curious' && (this.cursorAway >= CURIOUS_LOST_AFTER || this.cursorSpeed > CURIOUS_MAX_CURSOR_SPEED)) {
      this.act(pet, 'sit', this.between(4, 8));
      return;
    }
    this.advance(pet, dt, this.speedOf(pet, pet.action === 'trot' ? 'trot' : 'walk'));
    if (pet.target) return;
    if (movement === 'curious') {
      if (this.cursor) this.face(pet, this.cursor.x);
      this.act(pet, 'sit', this.between(4, 8));
    } else if (movement === 'come') this.act(pet, 'sit', this.between(6, 10));
    else if (movement === 'edge') this.act(pet, 'sit', this.between(12, 20));
    else this.act(pet, 'sit', this.between(4, 9));
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
      pet.speed = 0;
      if (pet.movement !== 'pair' && pet.movement !== 'toy') pet.movement = null;
    } else {
      pet.x += dx / distance * speed * dt;
      pet.y += dy / distance * speed * dt;
      pet.speed = speed;
    }
  }

  private speedOf(pet: RuntimePet, gait: Gait): number {
    return speedFor(gait, this.preferences.pets[pet.id].personality.energy);
  }

  private face(pet: RuntimePet, x: number, deadzone = 1): void {
    if (Math.abs(x - pet.x) > deadzone) pet.facing = x < pet.x ? 'left' : 'right';
  }

  private interrupt(id: PetId): void {
    this.cancelPair();
    if (this.toy?.petId === id) this.endPlay();
    delete this.treats[id];
    this.pets[id].target = null;
    this.pets[id].movement = null;
    this.pets[id].dwell = 0;
  }

  /** Walks to a point (come here) and sits there; reduced motion moves instantly. */
  private come(pet: RuntimePet, point: Point): void {
    const target = this.clampPet(point, pet.size);
    if (this.preferences.reducedMotion) {
      Object.assign(pet, target);
      this.act(pet, 'sit', this.between(6, 10));
      return;
    }
    this.act(pet, 'walk', Infinity);
    pet.target = target;
    pet.movement = 'come';
  }

  private sampleCursor(dt: number): void {
    const current = this.cursor;
    if (!current) {
      this.cursorAway += dt;
      this.cursorSample = null;
      this.cursorSpeed = 0;
      return;
    }
    this.cursorAway = 0;
    const instant = this.cursorSample ? Math.hypot(current.x - this.cursorSample.x, current.y - this.cursorSample.y) / dt : 0;
    this.cursorSpeed += (instant - this.cursorSpeed) * (1 - Math.exp(-dt / CURSOR_SMOOTHING));
    this.cursorSample = current;
  }

  private curiousEligible(pet: RuntimePet): boolean {
    const resting = pet.action === 'idle' || pet.action === 'sit' || pet.action === 'groom';
    return this.preferences.curious !== false
      && !this.preferences.quiet
      && pet.visible
      && resting
      && !pet.forcedSleep
      && !pet.target
      && !this.pair
      && this.toy?.petId !== pet.id
      && !this.treats[pet.id]
      && this.time >= pet.curiousAt;
  }

  /** Cursor curiosity: a cursor resting near an idle, sitting or grooming kitten gets noticed. */
  private updateCuriosity(pet: RuntimePet, dt: number): void {
    const cursor = this.cursor;
    const near = cursor !== null
      && this.cursorSpeed < CURIOUS_MAX_CURSOR_SPEED
      && Math.hypot(cursor.x - pet.x, cursor.y - pet.y) <= CURIOUS_RADIUS * pet.size;
    if (!near || !this.curiousEligible(pet)) {
      pet.dwell = 0;
      return;
    }
    pet.dwell += dt;
    if (pet.dwell >= CURIOUS_DWELL) this.noticeCursor(pet, cursor);
  }

  /** Faces the cursor; then, depending on personality, walks over to it and sits. Starts the cooldown. */
  private noticeCursor(pet: RuntimePet, cursor: Point): void {
    pet.dwell = 0;
    pet.curiousAt = this.time + this.between(CURIOUS_COOLDOWN_MIN, CURIOUS_COOLDOWN_MAX);
    pet.look = null;
    this.face(pet, cursor.x);
    if (this.preferences.reducedMotion) return;
    if (this.unit() >= curiousApproachChance(this.preferences.pets[pet.id].personality)) return;
    const dx = pet.x - cursor.x;
    const dy = pet.y - cursor.y;
    const distance = Math.hypot(dx, dy);
    const reach = CURIOUS_DISTANCE * pet.size;
    const approach = distance > reach ? this.clampPet({ x: cursor.x + dx / distance * reach, y: cursor.y + dy / distance * reach }, pet.size) : null;
    const target = approach ? this.keepApart(pet, approach) : null;
    if (!target || Math.hypot(target.x - pet.x, target.y - pet.y) < CURIOUS_MIN_STEP * pet.size) {
      this.act(pet, 'sit', this.between(4, 8));
      return;
    }
    this.act(pet, 'walk', Infinity);
    pet.target = target;
    pet.movement = 'curious';
  }

  /**
   * A curious approach never ends on the partner: it stops where its straight path first comes within
   * the nose-touch spacing of the other visible kitten, or of the spot that kitten is heading for.
   * Returns null when the kitten is already that close and would stay that close.
   */
  private keepApart(pet: RuntimePet, target: Point): Point | null {
    const other = this.pets[pet.id === 'archie' ? 'jumi' : 'archie'];
    if (!other.visible) return target;
    const spacing = NOSE_TOUCH_SPACING * (pet.size + other.size);
    const spots: Point[] = [{ x: other.x, y: other.y }, ...(other.target ? [other.target] : [])];
    const ex = target.x - pet.x, ey = target.y - pet.y;
    // A little slack, so a point placed exactly at the spacing does not count as too close.
    const tooClose = (s: number) => spots.some(spot => Math.hypot(pet.x + s * ex - spot.x, pet.y + s * ey - spot.y) < spacing - 1e-6);
    let s = 1;
    for (const spot of spots) {
      const fx = pet.x - spot.x, fy = pet.y - spot.y;
      if (Math.hypot(fx + s * ex, fy + s * ey) >= spacing - 1e-6) continue;
      // The path ends too close to this spot: stop where it first comes that close, the smaller root of
      // |pet + s·e − spot| = spacing (0 when the kitten is already that close).
      const a = ex * ex + ey * ey, b = fx * ex + fy * ey, c = fx * fx + fy * fy - spacing * spacing;
      const disc = b * b - a * c;
      s = a > 0 && disc >= 0 ? clamp((-b - Math.sqrt(disc)) / a, 0, s) : 0;
    }
    // Stopping short for one spot can still leave the kitten close to the other: then it stays.
    if (s <= 0 || tooClose(s)) return null;
    return { x: pet.x + s * ex, y: pet.y + s * ey };
  }

  /** Drops a treat ahead of the kitten; under reduced motion it lies right in front of the kitten, which eats at once. */
  private dropTreat(pet: RuntimePet): void {
    const size = pet.size;
    let dir = pet.facing === 'left' ? -1 : 1;
    if (this.preferences.reducedMotion) {
      const x = clamp(pet.x + dir * TREAT_EAT_OFFSET * size, 0, this.scene.width);
      this.treats[pet.id] = { petId: pet.id, x, y: pet.y, z: 0, phase: 'resting', elapsed: 0, spot: { x: pet.x, y: pet.y } };
      this.act(pet, 'eat', EAT_DURATION);
      return;
    }
    let x = this.clampPet({ x: pet.x + dir * TREAT_AHEAD * size, y: pet.y }, size).x;
    if (Math.abs(x - pet.x) < TREAT_MIN_SPACE * size) {
      const flipped = this.clampPet({ x: pet.x - dir * TREAT_AHEAD * size, y: pet.y }, size).x;
      if (Math.abs(flipped - pet.x) > Math.abs(x - pet.x)) x = flipped;
    }
    if (Math.abs(x - pet.x) > 0.5) dir = x < pet.x ? -1 : 1;
    const spot = this.clampPet({ x: x - dir * TREAT_EAT_OFFSET * size, y: pet.y }, size);
    this.treats[pet.id] = { petId: pet.id, x, y: pet.y, z: TREAT_DROP_HEIGHT * size, phase: 'falling', elapsed: 0, spot };
    // The kitten watches it land, then walks over.
    this.act(pet, 'idle', Infinity);
    pet.facing = dir < 0 ? 'left' : 'right';
  }

  private updateTreats(dt: number): void {
    for (const id of PET_IDS) {
      const treat = this.treats[id];
      if (!treat) continue;
      treat.elapsed += dt;
      if (treat.phase === 'falling') {
        if (treat.elapsed >= TREAT_FALL + TREAT_BOUNCE) {
          treat.phase = 'resting';
          treat.elapsed -= TREAT_FALL + TREAT_BOUNCE;
          treat.z = 0;
        } else {
          treat.z = treatHeight(treat.elapsed, this.pets[id].size);
        }
      } else if (treat.phase === 'eaten' && treat.elapsed >= CRUMBS_DURATION) {
        delete this.treats[id];
      }
    }
  }

  /** A kitten with a falling or resting treat: watch it land, walk to the eating spot, eat, then sit. */
  private followTreat(pet: RuntimePet, treat: RuntimeTreat, dt: number): void {
    if (treat.phase === 'falling') return;
    if (pet.action === 'eat') {
      pet.remaining -= dt;
      if (pet.remaining > 0) return;
      treat.phase = 'eaten';
      treat.elapsed = 0;
      this.act(pet, 'sit', this.between(4, 8));
      return;
    }
    if (pet.movement !== 'treat' && Math.hypot(treat.spot.x - pet.x, treat.spot.y - pet.y) > TREAT_WALK_THRESHOLD * pet.size) {
      this.act(pet, 'walk', Infinity);
      pet.target = { ...treat.spot };
      pet.movement = 'treat';
    }
    if (pet.target) {
      this.advance(pet, dt, this.speedOf(pet, 'walk'));
      if (pet.target) return;
    }
    this.face(pet, treat.x);
    this.act(pet, 'eat', EAT_DURATION);
  }

  /** Reduced motion turned on: a pending treat appears resting right in front of its kitten, which eats now. */
  private serveTreat(pet: RuntimePet): void {
    const treat = this.treats[pet.id];
    if (!treat || treat.phase === 'eaten' || pet.action === 'eat') return;
    const dir = pet.facing === 'left' ? -1 : 1;
    Object.assign(treat, { x: clamp(pet.x + dir * TREAT_EAT_OFFSET * pet.size, 0, this.scene.width), y: pet.y, z: 0, phase: 'resting', elapsed: 0, spot: { x: pet.x, y: pet.y } });
    this.act(pet, 'eat', EAT_DURATION);
  }

  /** Removes every treat; a kitten still on its way to one sits down instead. */
  private clearTreats(): void {
    for (const id of PET_IDS) {
      const treat = this.treats[id];
      if (!treat) continue;
      delete this.treats[id];
      const pet = this.pets[id];
      if (treat.phase !== 'eaten' && pet.action !== 'eat' && pet.action !== 'carried') this.act(pet, 'sit', this.between(4, 8));
    }
  }

  private updateToy(dt: number): void {
    if (!this.toy) return;
    this.toy.remaining -= dt;
    if (this.toy.remaining <= 0) { this.endPlay(); return; }
    if (!this.toy.automatic || this.toy.held || !this.toyOrigin || this.preferences.reducedMotion) {
      this.toyRoll = null;
      return;
    }
    if (this.toyRoll) {
      this.roll(this.toy, this.toyRoll, dt);
      return;
    }
    if (this.toyPause > 0) {
      this.toyPause = Math.max(0, this.toyPause - dt);
      return;
    }
    const waypoint = this.toyWaypoint ??= this.nextWaypoint(this.toy, this.toyOrigin);
    const dx = waypoint.x - this.toy.x;
    const dy = waypoint.y - this.toy.y;
    const distance = Math.hypot(dx, dy);
    const speed = TOY_SPEED * clamp(distance / TOY_EASE_DISTANCE, TOY_MIN_EASE, 1);
    if (distance <= Math.max(0.5, speed * dt)) {
      this.toy.x = waypoint.x;
      this.toy.y = waypoint.y;
      this.toyWaypoint = null;
      if (this.unit() < TOY_PAUSE_CHANCE) this.toyPause = this.between(0, TOY_PAUSE_MAX);
    } else {
      this.toy.x += dx / distance * speed * dt;
      this.toy.y += dy / distance * speed * dt;
    }
  }

  /** The next waypoint lies on the other side of the origin, so automatic play swings back and forth. */
  private nextWaypoint(toy: Point, origin: Point): Point {
    const offset = toy.x - origin.x;
    const side = Math.abs(offset) > 1 ? -Math.sign(offset) : this.unit() < 0.5 ? -1 : 1;
    const dx = this.between(TOY_MIN_OFFSET, TOY_RANGE_X);
    const dy = this.between(-TOY_RANGE_Y, TOY_RANGE_Y);
    const point = this.clampToy({ x: origin.x + side * dx, y: origin.y + dy });
    // Near a scene edge the clamp can leave that side with no room: use the other side.
    return Math.abs(point.x - toy.x) < TOY_MIN_OFFSET / 2 ? this.clampToy({ x: origin.x - side * dx, y: origin.y + dy }) : point;
  }

  private roll(toy: ToyState, roll: ToyRoll, dt: number): void {
    roll.elapsed = Math.min(roll.duration, roll.elapsed + dt);
    const u = roll.elapsed / roll.duration;
    const eased = 1 - (1 - u) * (1 - u);
    toy.x = roll.fromX + (roll.toX - roll.fromX) * eased;
    toy.y = roll.fromY + (roll.toY - roll.fromY) * eased;
    if (roll.elapsed >= roll.duration) this.toyRoll = null;
  }

  private resetToyMotion(): void {
    this.toyWaypoint = null;
    this.toyPause = 0;
    this.toyRoll = null;
  }

  /**
   * The toy's kitten: chase (trot) until the toy is in range, eye it, then pounce: a stationary
   * crouch, a leap onto it, a landing that may bat it away (automatic play), and back to the chase.
   */
  private followToy(pet: RuntimePet, dt: number): void {
    if (!this.toy) return;
    const target = this.clampPet({ x: this.toy.x, y: this.toy.y - pet.size * 0.2 }, pet.size);
    if (this.preferences.reducedMotion) {
      this.face(pet, target.x, 2);
      if (pet.action !== 'sit') this.act(pet, 'sit', Infinity);
      return;
    }
    if (pet.action === 'pounce') {
      this.pounce(pet, this.toy);
      return;
    }
    if (pet.action === 'land') {
      pet.remaining -= dt;
      if (pet.remaining <= 0) this.act(pet, 'sit', POUNCE_EYE);
      return;
    }
    this.face(pet, target.x, 2);
    const distance = Math.hypot(target.x - pet.x, target.y - pet.y);
    if (distance > pet.size * (pet.action === 'trot' ? CHASE_STOP : CHASE_RESUME)) {
      this.chase(pet, target, dt);
      return;
    }
    // In range: eye the toy first (a sit left over from reduced motion has no end, so restart it).
    if (pet.action === 'trot' || !Number.isFinite(pet.remaining)) this.act(pet, 'sit', POUNCE_EYE);
    pet.remaining -= dt;
    if (pet.remaining > 0) return;
    const personality = this.preferences.pets[pet.id].personality;
    if (distance > pet.size * POUNCE_REACH) this.chase(pet, target, dt);
    else if (distance < pet.size * LEAP_MIN) {
      // Right under its paws (a still toy after a landing, or one put down there): watch it a while, then
      // now and then pounce on it where it lies. No leap, so no hop on the spot, and the toy stays put.
      if (pet.actionTime >= TOY_WATCH - 1e-6 && this.unit() < pounceChance(personality)) {
        this.act(pet, 'pounce', POUNCE_DURATION);
        pet.pounceInPlace = true;
      } else {
        this.act(pet, 'sit', this.between(TOY_WATCH, 2 * TOY_WATCH));
      }
    }
    else if (this.unit() < pounceChance(personality)) this.act(pet, 'pounce', POUNCE_DURATION);
    else this.act(pet, 'sit', this.between(0.6, 1.2));
  }

  private chase(pet: RuntimePet, target: Point, dt: number): void {
    if (pet.action !== 'trot') this.act(pet, 'trot', Infinity);
    pet.target = target;
    pet.movement = 'toy';
    this.advance(pet, dt, this.speedOf(pet, 'chase'));
  }

  /**
   * Crouch (leap null), then the leap: progress 0→1 over POUNCE_LEAP, position linear from → to; then land.
   * A pounce in place (toy under the paws) holds the crouch for the whole POUNCE_DURATION and never leaps.
   */
  private pounce(pet: RuntimePet, toy: ToyState): void {
    if (pet.actionTime < POUNCE_CROUCH || (pet.pounceInPlace && pet.actionTime < POUNCE_DURATION)) {
      this.face(pet, toy.x, 2);
      return;
    }
    if (pet.pounceInPlace) {
      this.act(pet, 'land', POUNCE_LAND);
      this.bat(pet, toy);
      return;
    }
    if (!pet.leap) {
      const dx = toy.x - pet.x;
      const dir = Math.abs(dx) > 1 ? Math.sign(dx) : pet.facing === 'left' ? -1 : 1;
      // Land short of the toy (never behind the kitten's start), front paws on it.
      const to = this.clampPet({ x: toy.x - dir * Math.min(LEAP_LAND_OFFSET * pet.size, Math.abs(dx)), y: toy.y - pet.size * 0.2 }, pet.size);
      // A held toy can be carried far off during the crouch: the leap still covers at most the pounce
      // reach plus the landing offset (it then lands short and the chase goes on). Both ends lie inside
      // the clamp, so the shortened end does too.
      const length = Math.hypot(to.x - pet.x, to.y - pet.y), longest = (POUNCE_REACH + LEAP_LAND_OFFSET) * pet.size;
      if (length > longest) {
        to.x = pet.x + (to.x - pet.x) * longest / length;
        to.y = pet.y + (to.y - pet.y) * longest / length;
      }
      pet.facing = dir < 0 ? 'left' : 'right';
      pet.leap = { fromX: pet.x, fromY: pet.y, toX: to.x, toY: to.y, progress: 0, height: LEAP_HEIGHT * pet.size };
    }
    const leap = pet.leap;
    leap.progress = clamp((pet.actionTime - POUNCE_CROUCH) / POUNCE_LEAP, 0, 1);
    pet.x = leap.fromX + (leap.toX - leap.fromX) * leap.progress;
    pet.y = leap.fromY + (leap.toY - leap.fromY) * leap.progress;
    pet.speed = Math.hypot(leap.toX - leap.fromX, leap.toY - leap.fromY) / POUNCE_LEAP;
    if (leap.progress < 1) return;
    this.act(pet, 'land', POUNCE_LAND);
    this.bat(pet, toy);
  }

  /** Automatic play only, never while the user holds the toy: a toy near the front paws rolls away. */
  private bat(pet: RuntimePet, toy: ToyState): void {
    if (!toy.automatic || toy.held || !this.toyOrigin) return;
    const dir = pet.facing === 'left' ? -1 : 1;
    const paws = { x: pet.x + dir * LEAP_LAND_OFFSET * pet.size, y: pet.y + pet.size * 0.2 };
    if (Math.hypot(toy.x - paws.x, toy.y - paws.y) > BAT_REACH * pet.size) return;
    if (this.unit() >= batChance(this.preferences.pets[pet.id].personality)) return;
    const to = this.clampToy({ x: toy.x + dir * this.between(BAT_MIN, BAT_MAX), y: toy.y });
    const distance = Math.hypot(to.x - toy.x, to.y - toy.y);
    this.resetToyMotion();
    if (distance >= 1) this.toyRoll = { fromX: toy.x, fromY: toy.y, toX: to.x, toY: to.y, elapsed: 0, duration: 2 * distance / BAT_SPEED };
  }

  private endPlay(): void {
    if (this.toy) {
      const pet = this.pets[this.toy.petId];
      if (!pet.forcedSleep && pet.action !== 'carried') this.act(pet, 'sit', this.between(4, 8));
    }
    this.toy = null;
    this.toyOrigin = null;
    this.resetToyMotion();
  }

  private startPair(kind: PairState['kind']): void {
    if (this.pair || this.toy || this.time < this.pairAvailableAt) return;
    if (PET_IDS.some(id => this.treats[id])) return;
    const [archie, jumi] = [this.pets.archie, this.pets.jumi];
    if ([archie, jumi].some(pet => !pet.visible || pet.forcedSleep || !['idle', 'sit', 'groom'].includes(pet.action))) return;
    const separation = (archie.size + jumi.size) * (kind === 'nose_touch' ? NOSE_TOUCH_SPACING : 0.49);
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
    this.treats = {};
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
