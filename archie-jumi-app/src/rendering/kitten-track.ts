/**
 * Renderer-side observation of the scene across frames (Phase 2 spec 5.4, 5.5, 5.7). Pure; no DOM.
 *
 * Per kitten: which clip is shown (the previous one stays while the next action's page loads, so the
 * kitten never flashes the idle pose mid-transition; a kitten seen for the first time waits briefly
 * for its own page), action and facing changes on the renderer clock (for poseFor, the crossfade and
 * the turn tween), the breathing phase, landings (the dust puff) and the smoothed horizontal drag
 * velocity (the carried swing, settling after a release). For the pair: the nose-touch contact.
 * Times are renderer seconds; `P` is the page type (opaque here).
 */
import { LAND_SQUASH_MS, crossfade, crossfades, type ActionChange, type FacingChange } from '../core/motion';
import type { Action, AtlasFrame, Facing, PairState, PetId, PetState, Point } from '../shared/types';

/** Breathing phase offsets (s) so the two kittens do not breathe in step, except in a shared nap (0 for both). */
export const BREATH_PHASES: Readonly<Record<PetId, number>> = { archie: 0, jumi: 1.7 };
/** Time constant of the smoothed drag velocity, seconds. */
export const DRAG_SMOOTHING_S = 0.12;
/** Instantaneous drag speeds are clamped to this, DIP/s (a jump such as a drag start is not a swing). */
export const DRAG_MAX_SPEED = 4000;
/** A smoothed drag speed below this counts as still, DIP/s, so the swing settles exactly. */
export const DRAG_REST_SPEED = 1;
/** After a release the carried swing eases back to upright over this long (with the landing squash), seconds. */
export const SWING_SETTLE_S = LAND_SQUASH_MS / 1000;
/**
 * A kitten seen for the first time (startup, shown again) waits at most this long for its action's
 * page before drawing the idle stopgap, so a restored nap does not open on the idle pose. Seconds.
 */
export const FIRST_PAGE_WAIT_S = 0.25;

/** A page and the clip drawn from it. */
export interface Drawable<P> { page: P; clip: Action }
/** A frame as drawn, with its page and the facing it was drawn for. */
export interface DrawnFrame<P> { page: P; frame: AtlasFrame; facing: Facing }
/** A crossfade to draw this frame: the outgoing frame (opacity 1 − t) and the incoming one's opacity t. */
export interface Fade<P> { outgoing: DrawnFrame<P>; t: number }

export interface TrackInput<P> {
  pet: PetState;
  time: number;
  /** Reduced motion or Quiet Mode: no turn tweens. */
  calm: boolean;
  pair: PairState | null;
  /** What draws pet.action now, or null while its page is still loading. */
  ready: Drawable<P> | null;
  /** Drawn when neither `ready` nor the shown clip is available (the idle clip). */
  fallback: Drawable<P> | null;
  /** Whether a page may still be drawn (an evicted page is closed). */
  isOpen: (page: P) => boolean;
}

const sharedNap = (pair: PairState | null) => pair?.kind === 'nap' && pair.phase === 'together';

export class KittenTrack<P> {
  /** Last observed engine facing. */
  facing: Facing | null = null;
  /** Latest facing change (starts a turn tween), or null. */
  facingChange: FacingChange | null = null;
  /** The clip being drawn and the page it is drawn from (null before the first observation). */
  clip: Action | null = null;
  page: P | null = null;
  /** Clip time in seconds for `clip`; the renderer holds it while the next action's page loads. */
  seconds = 0;
  /** Latest change of the shown clip, or a landing restart: poseFor's actionChange and the crossfade. */
  change: ActionChange | null = null;
  /** The frame drawn just before `change`, which the crossfade fades out. */
  outgoing: DrawnFrame<P> | null = null;
  /** The incoming frame drawn last. */
  drawn: DrawnFrame<P> | null = null;
  /** Breathing phase offset in seconds, latched when the shown clip changes (so breathing never jumps). */
  breathPhase: number;
  /** When the engine action last changed by name (the sleep z's count from it), or null. */
  actionSince: number | null = null;
  /** When the kitten last landed (the dust puff), or null. */
  landedAt: number | null = null;
  /**
   * Smoothed horizontal drag velocity in DIP/s while carried; after a release into the landing it
   * eases from the last carried value to 0 over SWING_SETTLE_S; 0 otherwise.
   */
  velocityX = 0;
  private action: Action | null = null;
  private actionTime = 0;
  private drag: { x: number; at: number } | null = null;
  /** The last carried velocity and when the carry ended, while the swing settles. */
  private release: { velocityX: number; at: number } | null = null;
  /** The shown clip is the idle stopgap: neither the action's page nor a kept clip was drawable. */
  private stopgap = false;
  /** When this kitten was first seen without a drawable page of its own (FIRST_PAGE_WAIT_S), or null. */
  private waitingSince: number | null = null;

  constructor(readonly id: PetId) {
    this.breathPhase = BREATH_PHASES[id];
  }

  /** Forgets everything (the kitten was hidden): it reappears without a turn, crossfade or dust. */
  reset(): void {
    this.facing = null;
    this.facingChange = null;
    this.clip = null;
    this.page = null;
    this.seconds = 0;
    this.change = null;
    this.outgoing = null;
    this.drawn = null;
    this.breathPhase = BREATH_PHASES[this.id];
    this.actionSince = null;
    this.landedAt = null;
    this.velocityX = 0;
    this.action = null;
    this.actionTime = 0;
    this.drag = null;
    this.release = null;
    this.stopgap = false;
    this.waitingSince = null;
  }

  observe(input: TrackInput<P>): void {
    const { pet, time } = input;
    if (this.facing !== null && pet.facing !== this.facing) this.facingChange = input.calm ? null : { from: this.facing, at: time };
    this.facing = pet.facing;

    const restarted = pet.action === this.action && pet.actionTime < this.actionTime;
    if (pet.action !== this.action) this.actionSince = time;
    this.action = pet.action;
    this.actionTime = pet.actionTime;
    this.observeDrag(pet, time);

    const kept = this.clip !== null && this.page !== null && input.isOpen(this.page) ? { page: this.page, clip: this.clip } : null;
    // First sight: give the action's own page a moment rather than open on the idle stopgap.
    if (this.clip === null && !input.ready) {
      this.waitingSince ??= time;
      if (time - this.waitingSince < FIRST_PAGE_WAIT_S) return;
    }
    const next = input.ready ?? kept ?? input.fallback;
    if (!next) return;
    if (next.clip !== this.clip) {
      // The first clip, and leaving the stopgap, cut: the stopgap was never the kitten's real pose.
      const from = this.stopgap ? null : this.clip;
      this.outgoing = from !== null ? this.drawn : null;
      this.change = { from: from ?? next.clip, at: time };
      this.breathPhase = sharedNap(input.pair) ? 0 : BREATH_PHASES[this.id];
      if (next.clip === 'land') this.landedAt = time;
    } else if (restarted && pet.action === 'land' && next.clip === 'land') {
      // A new landing without leaving the land clip (moved again at once): squash and dust again.
      this.change = { from: 'land', at: time };
      this.outgoing = null;
      this.landedAt = time;
    }
    // A real clip ends the stopgap; keeping the shown clip keeps whatever it was.
    this.stopgap = input.ready ? false : kept ? this.stopgap : true;
    this.waitingSince = null;
    this.clip = next.clip;
    this.page = next.page;
  }

  /**
   * The crossfade to draw at `time`, or null. It runs for CROSSFADE_MS after a change of the shown
   * clip, only between near-identical seated stills (`crossfades`), never when `calm`, never from a
   * closed page, and never once the drawn facing differs from the outgoing frame's: a turn during a
   * fade would leave a mirrored ghost. Once it is over or refused, the outgoing frame is dropped.
   */
  fade(input: { time: number; drawFacing: Facing; calm: boolean; isOpen: (page: P) => boolean }): Fade<P> | null {
    const outgoing = this.outgoing, change = this.change, clip = this.clip;
    const timing = !input.calm && outgoing && change && clip && crossfades(change.from, clip) ? crossfade(change, input.time) : null;
    if (!outgoing || !timing || outgoing.facing !== input.drawFacing || !input.isOpen(outgoing.page)) {
      this.outgoing = null;
      return null;
    }
    return { outgoing, t: timing.t };
  }

  /**
   * The carried swing's input: exponentially smoothed velocity of successive drag positions, decaying
   * to 0 when still; after a release into the landing, the last value eases to 0 over SWING_SETTLE_S.
   */
  private observeDrag(pet: PetState, time: number): void {
    if (pet.action !== 'carried') {
      if (this.drag !== null) this.release = this.velocityX !== 0 ? { velocityX: this.velocityX, at: time } : null;
      this.drag = null;
      const release = this.release, settle = release && pet.action === 'land' ? Math.max(0, time - release.at) / SWING_SETTLE_S : 1;
      if (release && settle < 1) this.velocityX = release.velocityX * (0.5 + 0.5 * Math.cos(Math.PI * settle));
      else { this.release = null; this.velocityX = 0; }
      return;
    }
    this.release = null;
    const previous = this.drag;
    if (previous && !(time > previous.at)) return;
    this.drag = { x: pet.x, at: time };
    if (!previous) return;
    const dt = time - previous.at;
    const instant = Math.max(-DRAG_MAX_SPEED, Math.min(DRAG_MAX_SPEED, (pet.x - previous.x) / dt));
    this.velocityX += (instant - this.velocityX) * (1 - Math.exp(-dt / DRAG_SMOOTHING_S));
    if (!Number.isFinite(this.velocityX) || Math.abs(this.velocityX) < DRAG_REST_SPEED) this.velocityX = 0;
  }
}

/** Detects the nose contact of a nose touch (the pair entering its `together` phase), I8. */
export class PairTrack {
  private key = '';
  /** Renderer time of the latest contact, or null. */
  contactAt: number | null = null;
  /** Where the heart puff of the latest contact is drawn (set by the renderer at contact), or null. */
  contact: Point | null = null;

  /** True exactly when the pair has just entered a nose touch's `together` phase. */
  observe(pair: PairState | null, time: number): boolean {
    const key = pair ? `${pair.kind}:${pair.phase}` : '';
    const touched = key === 'nose_touch:together' && key !== this.key;
    this.key = key;
    if (touched) {
      this.contactAt = time;
      this.contact = null;
    }
    return touched;
  }
}
