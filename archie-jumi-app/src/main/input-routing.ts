/**
 * The single authoritative input decision for the overlay window (plan F3). Pure: no runtime
 * electron import, so Vitest can load it.
 *
 * - `polling` (default): click-through is `setIgnoreMouseEvents(true)` without forwarding, so no
 *   global mouse hook is installed; hover comes only from the main-process cursor feed.
 * - `hybrid` (`--input-routing=hybrid`): 1.0.1 forwarding (`{ forward: true }`) plus the cursor
 *   feed plus hook re-arming.
 */
import type { InputTarget } from '../shared/types';

export type InputRouting = 'polling' | 'hybrid';
export type InputReason = 'capture' | 'hover' | 'hover-guard' | 'hidden' | 'paused' | 'quiet' | 'recovering' | 'not-ready' | 'idle';
export interface InputDecision { interactive: boolean; reason: InputReason }

export interface InputDecisionState {
  sceneReady: boolean;
  overlayVisible: boolean;
  hidden: boolean;
  paused: boolean;
  quiet: boolean;
  recovering: boolean;
  /** Latest renderer report for the current generation. */
  report: { target: InputTarget; capture: boolean };
  /** Main is polling the cursor. */
  feedActive: boolean;
  /** Latest sample lies inside some interest rect. */
  cursorInsideInterest: boolean;
  /** Monotonic ms when the cursor last left all interest rects (null while inside). */
  outsideSinceMs: number | null;
  nowMs: number;
}

/** How long main's own samples must place the cursor outside every interest rect before a hover report is stale. */
export const HOVER_GUARD_MS = 300;

export function parseInputRouting(argv: readonly string[]): InputRouting {
  return argv.includes('--input-routing=hybrid') ? 'hybrid' : 'polling';
}

/** Options for the click-through call: forwarding only in hybrid mode. */
export function ignoreOptionsFor(routing: InputRouting): { forward: true } | undefined {
  return routing === 'hybrid' ? { forward: true } : undefined;
}

/**
 * A hover report that main's latest sample places outside every interest rect must be judged
 * against a fresh sample first: in hybrid mode a forwarded move can reach the renderer before
 * main's next 33 ms tick sees the cursor inside, and the older sample would trip the hover guard.
 */
export function needsFreshSample(report: InputDecisionState['report'], feedActive: boolean, cursorInsideInterest: boolean): boolean {
  return report.target !== null && !report.capture && feedActive && !cursorInsideInterest;
}

export function hoverGuardTripped(s: InputDecisionState): boolean {
  return s.feedActive && !s.cursorInsideInterest && s.outsideSinceMs !== null && s.nowMs - s.outsideSinceMs >= HOVER_GUARD_MS;
}

export function decideInput(s: InputDecisionState): InputDecision {
  if (s.recovering) return { interactive: false, reason: 'recovering' };
  if (s.hidden) return { interactive: false, reason: 'hidden' };
  if (s.paused) return { interactive: false, reason: 'paused' };
  if (s.quiet) return { interactive: false, reason: 'quiet' };
  if (!s.sceneReady || !s.overlayVisible) return { interactive: false, reason: 'not-ready' };
  if (s.report.capture) return { interactive: true, reason: 'capture' };
  if (s.report.target) return hoverGuardTripped(s) ? { interactive: false, reason: 'hover-guard' } : { interactive: true, reason: 'hover' };
  return { interactive: false, reason: 'idle' };
}
