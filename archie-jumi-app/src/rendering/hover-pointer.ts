/**
 * The overlay's trusted hover pointer: the newer of the latest real DOM pointer event and the
 * latest main-process cursor-feed message, or the feed alone while smoke tests script the cursor.
 * Pure; no DOM.
 */
import type { Point } from '../shared/types';

/** With a main-process cursor feed, a real DOM pointer position is trusted for hover only this long. */
export const EVENT_POINTER_TTL_MS = 250;

export interface HoverSources {
  /** Latest real pointer-event position, or null (none yet, or the pointer left the window). */
  event: Point | null;
  /** When `event` was recorded (renderer monotonic ms). */
  eventAt: number;
  /** Position of the latest feed message while it says inside; null after a leave or before any message. */
  feed: Point | null;
  /** When the latest feed message arrived (renderer monotonic ms); -Infinity before the first one. */
  feedAt: number;
  now: number;
  /**
   * The feed carries a scripted cursor (smoke tests): it alone decides hover, so a real mouse moved
   * during the run can neither end nor start a hover.
   */
  feedOnly?: boolean;
}

/**
 * Unless `feedOnly`, the newer source wins, so moving off a kitten ends hover on that very
 * pointer event. A real event is trusted only for EVENT_POINTER_TTL_MS: after hook loss or a
 * missed move, an old position must not keep the window interactive. A feed message stays valid
 * until the next one, because the feed sends on every change while inside and once on leaving; a
 * feed leave that is newer than the event yields null.
 */
export function trustedHoverPointer(s: HoverSources): Point | null {
  if (s.feedOnly) return s.feed;
  const eventFresh = s.event !== null && s.now - s.eventAt <= EVENT_POINTER_TTL_MS;
  if (eventFresh && s.eventAt >= s.feedAt) return s.event;
  return s.feed;
}
