/**
 * Heartbeat watchdog and automatic-recovery budget (plan F4). Pure, with an injected monotonic
 * clock in ms. Missed beats are counted per watchdog tick, never derived from wall-clock gaps, so
 * a late timer after sleep or a clock jump cannot trigger recovery on its own.
 */
export type WatchdogVerdict = 'none' | 'kick' | 'recover';
export type WatchdogCause = 'missed-beats' | 'frame-stall';

export const MISSED_BEATS_TO_RECOVER = 3;
export const ZERO_FRAME_BEATS_TO_KICK = 3;
export const ZERO_FRAME_BEATS_TO_RECOVER = 10;

export class HeartbeatWatchdog {
  private armed = false;
  private graceUntil = Number.NEGATIVE_INFINITY;
  private beatSinceTick = false;
  private missCount = 0;
  private zeroFrames = 0;
  /** Zero-frame beats counted when this stall episode was kicked; null until the kick. */
  private kickedAt: number | null = null;
  private cause: WatchdogCause | null = null;

  constructor(private readonly now: () => number) {}

  /** Armed only while the scene should be running; any arm/disarm transition starts from zero. */
  arm(armed: boolean): void {
    if (armed === this.armed) return;
    this.armed = armed;
    this.reset();
  }

  /** Suppresses verdicts and miss counting for `ms` from now (extends, never shortens, a window). */
  grace(ms: number): void {
    this.graceUntil = Math.max(this.graceUntil, this.now() + ms);
  }

  graceRemaining(): number {
    return Math.max(0, this.graceUntil - this.now());
  }

  /** A renderer heartbeat; `frames` counts frame-loop ticks since its previous beat. */
  beat(frames: number): void {
    if (!this.armed) return;
    this.beatSinceTick = true;
    this.missCount = 0;
    if (frames > 0) {
      this.zeroFrames = 0;
      this.kickedAt = null;
    } else {
      this.zeroFrames++;
    }
  }

  /** Called by the owner every second. */
  tick(): WatchdogVerdict {
    if (!this.armed) return 'none';
    const beat = this.beatSinceTick;
    this.beatSinceTick = false;
    if (this.inGrace()) return 'none';
    if (!beat) this.missCount++;
    if (this.missCount >= MISSED_BEATS_TO_RECOVER) return this.recover('missed-beats');
    // A frame stall is always kicked first, even one that built up during grace, and the
    // recover countdown (7 more zero-frame beats) starts at the kick.
    if (this.kickedAt === null && this.zeroFrames >= ZERO_FRAME_BEATS_TO_KICK) {
      this.kickedAt = this.zeroFrames;
      this.cause = 'frame-stall';
      return 'kick';
    }
    if (this.kickedAt !== null && this.zeroFrames - this.kickedAt >= ZERO_FRAME_BEATS_TO_RECOVER - ZERO_FRAME_BEATS_TO_KICK) return this.recover('frame-stall');
    return 'none';
  }

  get isArmed(): boolean { return this.armed; }
  get misses(): number { return this.missCount; }
  get zeroFrameBeats(): number { return this.zeroFrames; }
  /** Why the most recent kick or recover verdict was given. */
  get lastCause(): WatchdogCause | null { return this.cause; }

  private recover(cause: WatchdogCause): WatchdogVerdict {
    this.cause = cause;
    this.reset();
    return 'recover';
  }

  private inGrace(): boolean {
    return this.now() < this.graceUntil;
  }

  private reset(): void {
    this.beatSinceTick = false;
    this.missCount = 0;
    this.zeroFrames = 0;
    this.kickedAt = null;
  }
}

export const RECOVERY_LIMIT = 3;
export const RECOVERY_WINDOW_MS = 10 * 60 * 1000;
export const RECOVERY_DELAYS_MS: readonly number[] = [500, 2000, 5000];

export type RecoveryAttempt = { allowed: true; delayMs: number } | { allowed: false };

/** At most three automatic recoveries per rolling ten minutes, with growing delays. */
export class RecoveryBudget {
  private attempts: number[] = [];

  next(now: number): RecoveryAttempt {
    this.prune(now);
    if (this.attempts.length >= RECOVERY_LIMIT) return { allowed: false };
    this.attempts.push(now);
    return { allowed: true, delayMs: RECOVERY_DELAYS_MS[this.attempts.length - 1] };
  }

  remaining(now: number): number {
    this.prune(now);
    return RECOVERY_LIMIT - this.attempts.length;
  }

  /** A manual Show All starts a fresh budget. */
  reset(): void {
    this.attempts = [];
  }

  private prune(now: number): void {
    this.attempts = this.attempts.filter(at => now - at < RECOVERY_WINDOW_MS);
  }
}
