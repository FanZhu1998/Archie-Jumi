import { describe, expect, it } from 'vitest';
import { EVENT_POINTER_TTL_MS, trustedHoverPointer, type HoverSources } from '../src/rendering/hover-pointer';

const onKitten = { x: 400, y: 300 }, offKitten = { x: 412, y: 300 };
const sources = (patch: Partial<HoverSources>): HoverSources => ({ event: null, eventAt: 0, feed: null, feedAt: Number.NEGATIVE_INFINITY, now: 1000, ...patch });

describe('trusted hover pointer', () => {
  it('uses a real event that is newer than the latest feed message', () => {
    // Moving off the sprite (still inside the interest margin) ends hover on that pointermove.
    expect(trustedHoverPointer(sources({ feed: onKitten, feedAt: 980, event: offKitten, eventAt: 990 }))).toEqual(offKitten);
  });

  it('uses a feed message that is newer than the latest real event', () => {
    expect(trustedHoverPointer(sources({ event: offKitten, eventAt: 980, feed: onKitten, feedAt: 990 }))).toEqual(onKitten);
  });

  it('yields null for a feed leave that is newer than the event', () => {
    expect(trustedHoverPointer(sources({ event: onKitten, eventAt: 980, feed: null, feedAt: 990 }))).toBeNull();
  });

  it('trusts a real event only for the TTL, then falls back to the feed state', () => {
    const event = { event: offKitten, eventAt: 1000 - EVENT_POINTER_TTL_MS };
    expect(trustedHoverPointer(sources({ ...event }))).toEqual(offKitten);
    expect(trustedHoverPointer(sources({ ...event, now: 1001 }))).toBeNull();
    // A resting cursor stays on the kitten: the older feed position still describes it.
    expect(trustedHoverPointer(sources({ ...event, now: 1001, feed: onKitten, feedAt: 600 }))).toEqual(onKitten);
    // After a feed leave, a stale event never brings hover back (hook loss, missed moves).
    expect(trustedHoverPointer(sources({ ...event, now: 5000, feed: null, feedAt: 600 }))).toBeNull();
  });

  it('follows the feed alone while the cursor is scripted, whatever real events arrive', () => {
    // A real mouse moved during a smoke run neither ends the scripted hover...
    expect(trustedHoverPointer(sources({ feedOnly: true, feed: onKitten, feedAt: 600, event: offKitten, eventAt: 990 }))).toEqual(onKitten);
    // ...nor starts one.
    expect(trustedHoverPointer(sources({ feedOnly: true, feed: null, feedAt: 600, event: onKitten, eventAt: 990 }))).toBeNull();
    // Outside smoke runs the newer real event still wins.
    expect(trustedHoverPointer(sources({ feedOnly: false, feed: onKitten, feedAt: 600, event: offKitten, eventAt: 990 }))).toEqual(offKitten);
  });

  it('uses the feed alone when there is no event pointer', () => {
    expect(trustedHoverPointer(sources({ feed: onKitten, feedAt: 10 }))).toEqual(onKitten);
    expect(trustedHoverPointer(sources({}))).toBeNull();
  });
});
