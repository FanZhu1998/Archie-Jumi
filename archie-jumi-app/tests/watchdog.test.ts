import { describe, expect, it } from 'vitest';
import { HeartbeatWatchdog, RECOVERY_WINDOW_MS, RecoveryBudget } from '../src/main/watchdog';

function armed(start = 0) {
  let now = start;
  const watchdog = new HeartbeatWatchdog(() => now);
  watchdog.arm(true);
  return { watchdog, advance: (ms: number) => { now += ms; }, set: (ms: number) => { now = ms; } };
}
/** One second of healthy operation: a beat with frames, then the owner's tick. */
const healthySecond = (w: HeartbeatWatchdog, frames = 30) => { w.beat(frames); return w.tick(); };

describe('HeartbeatWatchdog missed beats', () => {
  it('counts misses per tick and recovers on the third consecutive missed tick', () => {
    const { watchdog } = armed();
    expect(watchdog.tick()).toBe('none');
    expect(watchdog.tick()).toBe('none');
    expect(watchdog.misses).toBe(2);
    expect(watchdog.tick()).toBe('recover');
    expect(watchdog.lastCause).toBe('missed-beats');
    expect(watchdog.misses).toBe(0);
  });

  it('resets the miss streak on any beat', () => {
    const { watchdog } = armed();
    watchdog.tick(); watchdog.tick();
    expect(healthySecond(watchdog)).toBe('none');
    expect(watchdog.misses).toBe(0);
    expect(watchdog.tick()).toBe('none');
    expect(watchdog.tick()).toBe('none');
    expect(watchdog.tick()).toBe('recover');
  });

  it('does not count ticks inside a grace window', () => {
    const { watchdog, advance } = armed();
    watchdog.grace(10_000);
    for (let second = 0; second < 9; second++) { expect(watchdog.tick()).toBe('none'); advance(1000); }
    expect(watchdog.misses).toBe(0);
    expect(watchdog.graceRemaining()).toBe(1000);
    advance(1000);
    expect(watchdog.graceRemaining()).toBe(0);
    expect(watchdog.tick()).toBe('none');
    expect(watchdog.tick()).toBe('none');
    expect(watchdog.tick()).toBe('recover');
  });

  it('never shortens an existing grace window', () => {
    const { watchdog, advance } = armed();
    watchdog.grace(10_000);
    advance(1000);
    watchdog.grace(2000);
    expect(watchdog.graceRemaining()).toBe(9000);
  });

  it('does not recover because of clock jumps or one late tick after sleep', () => {
    const { watchdog, advance } = armed();
    for (let i = 0; i < 5; i++) { advance(1000); expect(healthySecond(watchdog)).toBe('none'); }
    advance(3_600_000);
    expect(healthySecond(watchdog)).toBe('none');
    advance(8 * 3_600_000);
    expect(watchdog.tick()).toBe('none');
    expect(watchdog.misses).toBe(1);
    advance(1000);
    expect(healthySecond(watchdog)).toBe('none');
  });

  it('ignores beats and ticks while disarmed, and disarming resets the counters', () => {
    const { watchdog } = armed();
    watchdog.tick(); watchdog.tick();
    watchdog.arm(false);
    expect(watchdog.isArmed).toBe(false);
    expect(watchdog.misses).toBe(0);
    for (let i = 0; i < 10; i++) expect(watchdog.tick()).toBe('none');
    watchdog.arm(true);
    watchdog.arm(true);
    expect(watchdog.tick()).toBe('none');
    expect(watchdog.tick()).toBe('none');
    expect(watchdog.tick()).toBe('recover');
  });
});

describe('HeartbeatWatchdog frame stalls', () => {
  it('kicks once after three zero-frame beats and recovers after ten', () => {
    const { watchdog } = armed();
    expect(healthySecond(watchdog, 0)).toBe('none');
    expect(healthySecond(watchdog, 0)).toBe('none');
    expect(healthySecond(watchdog, 0)).toBe('kick');
    expect(watchdog.lastCause).toBe('frame-stall');
    for (let beat = 4; beat < 10; beat++) expect(healthySecond(watchdog, 0)).toBe('none');
    expect(watchdog.zeroFrameBeats).toBe(9);
    expect(healthySecond(watchdog, 0)).toBe('recover');
    expect(watchdog.lastCause).toBe('frame-stall');
    expect(watchdog.zeroFrameBeats).toBe(0);
  });

  it('ends a stall episode on a beat with frames, so the next stall kicks again', () => {
    const { watchdog } = armed();
    for (let i = 0; i < 2; i++) healthySecond(watchdog, 0);
    expect(healthySecond(watchdog, 0)).toBe('kick');
    expect(healthySecond(watchdog, 12)).toBe('none');
    expect(watchdog.zeroFrameBeats).toBe(0);
    for (let i = 0; i < 2; i++) expect(healthySecond(watchdog, 0)).toBe('none');
    expect(healthySecond(watchdog, 0)).toBe('kick');
  });

  it('holds frame-stall verdicts during grace and resets them when disarmed', () => {
    const { watchdog, advance } = armed();
    watchdog.grace(5000);
    for (let i = 0; i < 4; i++) { expect(healthySecond(watchdog, 0)).toBe('none'); advance(1000); }
    advance(1000);
    expect(healthySecond(watchdog, 0)).toBe('kick');
    watchdog.arm(false);
    watchdog.arm(true);
    expect(watchdog.zeroFrameBeats).toBe(0);
    expect(healthySecond(watchdog, 0)).toBe('none');
  });

  /** One zero-frame beat and one tick per second, advancing the clock after each tick. */
  const stalledSecond = (w: HeartbeatWatchdog, advance: (ms: number) => void) => { const verdict = healthySecond(w, 0); advance(1000); return verdict; };

  it('kicks a stall that built up during the 10 s grace before it ever recovers, then counts 7 more beats', () => {
    const { watchdog, advance } = armed();
    watchdog.grace(10_000);
    for (let second = 0; second < 10; second++) expect(stalledSecond(watchdog, advance)).toBe('none');
    expect(stalledSecond(watchdog, advance)).toBe('kick');
    expect(watchdog.zeroFrameBeats).toBe(11);
    for (let beat = 0; beat < 6; beat++) expect(stalledSecond(watchdog, advance)).toBe('none');
    expect(stalledSecond(watchdog, advance)).toBe('recover');
    expect(watchdog.lastCause).toBe('frame-stall');
  });

  it('gives a stall that starts early in grace the full countdown after its kick', () => {
    const { watchdog, advance } = armed();
    watchdog.grace(10_000);
    for (let second = 0; second < 2; second++) { expect(healthySecond(watchdog)).toBe('none'); advance(1000); }
    for (let second = 2; second < 10; second++) expect(stalledSecond(watchdog, advance)).toBe('none');
    expect(stalledSecond(watchdog, advance)).toBe('kick');
    expect(watchdog.zeroFrameBeats).toBe(9);
    for (let beat = 0; beat < 6; beat++) expect(stalledSecond(watchdog, advance)).toBe('none');
    expect(stalledSecond(watchdog, advance)).toBe('recover');
  });

  it('holds the kick until an extended grace window ends', () => {
    const { watchdog, advance } = armed();
    watchdog.grace(10_000);
    for (let second = 0; second < 5; second++) expect(stalledSecond(watchdog, advance)).toBe('none');
    watchdog.grace(10_000);
    for (let second = 5; second < 15; second++) expect(stalledSecond(watchdog, advance)).toBe('none');
    expect(stalledSecond(watchdog, advance)).toBe('kick');
    for (let beat = 0; beat < 6; beat++) expect(stalledSecond(watchdog, advance)).toBe('none');
    expect(stalledSecond(watchdog, advance)).toBe('recover');
  });

  it('ends the episode when frames return right after a post-grace kick', () => {
    const { watchdog, advance } = armed();
    watchdog.grace(10_000);
    for (let second = 0; second < 10; second++) stalledSecond(watchdog, advance);
    expect(stalledSecond(watchdog, advance)).toBe('kick');
    expect(healthySecond(watchdog, 20)).toBe('none');
    expect(watchdog.zeroFrameBeats).toBe(0);
    for (let beat = 0; beat < 2; beat++) expect(healthySecond(watchdog, 0)).toBe('none');
    expect(healthySecond(watchdog, 0)).toBe('kick');
  });
});

describe('RecoveryBudget', () => {
  it('allows three recoveries with growing delays, then refuses', () => {
    const budget = new RecoveryBudget();
    expect(budget.remaining(0)).toBe(3);
    expect(budget.next(0)).toEqual({ allowed: true, delayMs: 500 });
    expect(budget.next(1000)).toEqual({ allowed: true, delayMs: 2000 });
    expect(budget.next(2000)).toEqual({ allowed: true, delayMs: 5000 });
    expect(budget.remaining(2000)).toBe(0);
    expect(budget.next(3000)).toEqual({ allowed: false });
  });

  it('uses a rolling ten-minute window', () => {
    const budget = new RecoveryBudget();
    budget.next(0); budget.next(60_000); budget.next(120_000);
    expect(budget.next(RECOVERY_WINDOW_MS - 1)).toEqual({ allowed: false });
    expect(budget.remaining(RECOVERY_WINDOW_MS)).toBe(1);
    expect(budget.next(RECOVERY_WINDOW_MS)).toEqual({ allowed: true, delayMs: 5000 });
    expect(budget.next(RECOVERY_WINDOW_MS + 1)).toEqual({ allowed: false });
    expect(budget.remaining(RECOVERY_WINDOW_MS + 120_000)).toBe(2);
  });

  it('starts fresh after a manual reset', () => {
    const budget = new RecoveryBudget();
    for (let i = 0; i < 3; i++) budget.next(i);
    expect(budget.next(10)).toEqual({ allowed: false });
    budget.reset();
    expect(budget.next(20)).toEqual({ allowed: true, delayMs: 500 });
  });
});
