import { describe, expect, it } from 'vitest';
import { HOVER_GUARD_MS, decideInput, ignoreOptionsFor, parseInputRouting, type InputDecisionState } from '../src/main/input-routing';

const state = (patch: Partial<InputDecisionState> = {}): InputDecisionState => ({
  sceneReady: true, overlayVisible: true, hidden: false, paused: false, quiet: false, recovering: false,
  report: { target: null, capture: false }, feedActive: true, cursorInsideInterest: true, outsideSinceMs: null, nowMs: 10_000,
  ...patch,
});
const hover = { target: 'archie' as const, capture: false };
const capture = { target: 'archie' as const, capture: true };

describe('authoritative input decision', () => {
  it('is click-through when idle and interactive for capture or hover', () => {
    expect(decideInput(state())).toEqual({ interactive: false, reason: 'idle' });
    expect(decideInput(state({ report: hover }))).toEqual({ interactive: true, reason: 'hover' });
    expect(decideInput(state({ report: { target: 'toy', capture: false } }))).toEqual({ interactive: true, reason: 'hover' });
    expect(decideInput(state({ report: capture }))).toEqual({ interactive: true, reason: 'capture' });
    expect(decideInput(state({ report: { target: null, capture: true } }))).toEqual({ interactive: true, reason: 'capture' });
  });

  it.each([
    ['hidden', { hidden: true }],
    ['paused', { paused: true }],
    ['quiet', { quiet: true }],
    ['recovering', { recovering: true }],
    ['not-ready', { sceneReady: false }],
    ['not-ready', { overlayVisible: false }],
  ] as const)('is always click-through when %s, even while capturing', (reason, patch) => {
    expect(decideInput(state({ ...patch, report: hover }))).toEqual({ interactive: false, reason });
    expect(decideInput(state({ ...patch, report: capture }))).toEqual({ interactive: false, reason });
  });

  it('prefers the more specific reason when several apply', () => {
    expect(decideInput(state({ hidden: true, overlayVisible: false })).reason).toBe('hidden');
    expect(decideInput(state({ recovering: true, hidden: true, sceneReady: false })).reason).toBe('recovering');
    expect(decideInput(state({ paused: true, quiet: true })).reason).toBe('paused');
  });

  it('trips the hover guard exactly when the cursor has been outside every interest rect for 300 ms', () => {
    const outside = { report: hover, cursorInsideInterest: false, outsideSinceMs: 10_000 };
    expect(decideInput(state({ ...outside, nowMs: 10_000 + HOVER_GUARD_MS - 1 }))).toEqual({ interactive: true, reason: 'hover' });
    expect(decideInput(state({ ...outside, nowMs: 10_000 + HOVER_GUARD_MS }))).toEqual({ interactive: false, reason: 'hover-guard' });
    expect(HOVER_GUARD_MS).toBe(300);
  });

  it('never applies the guard to a capture, while inside, or without a running feed', () => {
    const stale = { cursorInsideInterest: false, outsideSinceMs: 0, nowMs: 60_000 };
    expect(decideInput(state({ ...stale, report: capture }))).toEqual({ interactive: true, reason: 'capture' });
    expect(decideInput(state({ ...stale, report: hover, cursorInsideInterest: true, outsideSinceMs: null }))).toEqual({ interactive: true, reason: 'hover' });
    expect(decideInput(state({ ...stale, report: hover, feedActive: false }))).toEqual({ interactive: true, reason: 'hover' });
    expect(decideInput(state({ ...stale, report: hover, outsideSinceMs: null }))).toEqual({ interactive: true, reason: 'hover' });
  });
});

describe('input routing mode', () => {
  it('defaults to polling and accepts only the explicit hybrid switch', () => {
    expect(parseInputRouting([])).toBe('polling');
    expect(parseInputRouting(['electron', '.', '--input-routing=hybrid'])).toBe('hybrid');
    expect(parseInputRouting(['--input-routing=HYBRID', '--input-routing', 'hybrid'])).toBe('polling');
  });

  it('forwards mouse moves only in hybrid mode', () => {
    expect(ignoreOptionsFor('polling')).toBeUndefined();
    expect(ignoreOptionsFor('hybrid')).toEqual({ forward: true });
  });
});
