/**
 * Frame pacing for the overlay (Phase 2 spec 5.6). The frame loop keeps running at display rate (the
 * engine steps, the heartbeat counts its frames and the self-heal watches it); this decides when it
 * renders and which layer changes are drawn:
 *  - every frame (at most 60 Hz) while a pose tween or a renderer-clock effect is in its short window;
 *  - otherwise at most 30 Hz, and a layer is redrawn only when its quantized key changes;
 *  - a change that is ambient only (breathing, sleep z's, the groom tilt) is drawn at an ambient
 *    cadence (the spec allows up to 12 Hz), for all layers on the same frames: the shortest interval
 *    any visible kitten wants (`ambientIntervalMs`). Each compositor frame of the transparent
 *    full-screen overlay costs a few milliseconds of GPU-process CPU, so this rate decides what a
 *    resting scene costs: two napping kittens measured about 0.86 % of total CPU at 6 Hz, 0.92 % at
 *    8 Hz and 0.99 % at 12 Hz (benchmark, 12 logical processors), against the < 1 % budget. So a nap
 *    draws at 4 Hz, and at 3 Hz once it has gone DEEP_NAP_AFTER_S without an active change.
 * Pure; times are milliseconds on one clock that never runs backwards (the overlay keeps the latest of
 * performance.now() and rAF timestamps).
 */
import type { Action } from '../shared/types';

export const ACTIVE_INTERVAL_MS = 1000 / 30;
export const FAST_INTERVAL_MS = 1000 / 60;
/** Awake breathing (idle, sit and every other action): steps stay well under a pixel. */
export const AMBIENT_INTERVAL_MS = 1000 / 6;
/** The groom tilt (±2° on a 1.2 s cycle): slow periodic motion, but at 12 Hz each step stays under 1°. */
export const TILT_INTERVAL_MS = 1000 / 12;
/** A nap: its breathing and rising z's. */
export const NAP_INTERVAL_MS = 1000 / 4;
/** A nap that has gone DEEP_NAP_AFTER_S without an active change. */
export const DEEP_NAP_INTERVAL_MS = 1000 / 3;
export const DEEP_NAP_AFTER_S = 20;
/** rAF timestamps jitter; a frame this much early still counts (1.0.2 used the same tolerance). */
export const PACING_TOLERANCE_MS = 1;

/** One visible kitten as the ambient cadence sees it: its action and how long since its layers last drew an active change. */
export interface AmbientKitten { action: Action; stillSeconds: number }

/** The ambient cadence a kitten wants: milliseconds between the frames that draw its ambient-only changes. */
export function ambientIntervalMs(kitten: AmbientKitten): number {
  if (kitten.action === 'groom') return TILT_INTERVAL_MS;
  if (kitten.action === 'sleep') return kitten.stillSeconds >= DEEP_NAP_AFTER_S ? DEEP_NAP_INTERVAL_MS : NAP_INTERVAL_MS;
  return AMBIENT_INTERVAL_MS;
}

/** The scene's ambient cadence: the shortest interval a visible kitten wants (all layers share the frames); AMBIENT_INTERVAL_MS without kittens. */
export function sceneAmbientIntervalMs(kittens: readonly AmbientKitten[]): number {
  return kittens.length ? Math.min(...kittens.map(ambientIntervalMs)) : AMBIENT_INTERVAL_MS;
}

/** A layer's content as quantized keys: `active` changes are drawn at once, `ambient`-only ones at the ambient cadence. */
export interface LayerKeys { active: string; ambient: string }
export type LayerChange = 'none' | 'active' | 'ambient';

/** How `next` differs from what the layer shows (`drawn` null means nothing is drawn yet). */
export function layerChange(drawn: LayerKeys | null, next: LayerKeys): LayerChange {
  if (!drawn || drawn.active !== next.active) return 'active';
  return drawn.ambient !== next.ambient ? 'ambient' : 'none';
}

export class FramePacer {
  private lastRender = Number.NEGATIVE_INFINITY;
  private lastAmbient = Number.NEGATIVE_INFINITY;
  private fast = false;

  /** Whether the frame at `now` should render: every frame up to 60 Hz while fast, else at most 30 Hz. */
  due(now: number): boolean {
    const interval = this.fast ? FAST_INTERVAL_MS : ACTIVE_INTERVAL_MS;
    return now - this.lastRender >= interval - PACING_TOLERANCE_MS;
  }

  /** Records a render; `fast` is whether a tween or renderer-clock effect is running (render the next frames too). */
  rendered(now: number, fast: boolean): void {
    this.lastRender = now;
    this.fast = fast;
  }

  /** Whether ambient-only layer changes may be drawn at `now`, at most once per `intervalMs` (the scene's ambient cadence). */
  ambientDue(now: number, intervalMs = AMBIENT_INTERVAL_MS): boolean {
    return now - this.lastAmbient >= intervalMs - PACING_TOLERANCE_MS;
  }

  /** Records that ambient-only changes were drawn at `now`. */
  ambientDrawn(now: number): void {
    this.lastAmbient = now;
  }

  /** Forgets the history (after a pause): the next frame renders. */
  reset(): void {
    this.lastRender = Number.NEGATIVE_INFINITY;
    this.lastAmbient = Number.NEGATIVE_INFINITY;
    this.fast = false;
  }
}
