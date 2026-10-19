/** Locally synthesized soft purr: no remote audio or microphone access. */
import { HELD_PET_MAX } from '../core/engine';

/** The looping purr of a held pet stops by itself after this many seconds: the held-pet cap. */
export const PURR_LOOP_MAX_S = HELD_PET_MAX;
/** Loop level at volume 1 (the one-shot purr of a click peaks at 0.035). */
export const PURR_LOOP_LEVEL = 0.03;
/** Time constants in seconds: the loop's fade-in (95 % after 0.36 s), any fade-out, and a live volume change. */
export const PURR_FADE_IN_S = 0.12;
export const PURR_FADE_OUT_S = 0.08;
export const PURR_VOLUME_S = 0.05;
/** Oscillators stop this long after a fade-out begins (six fade-out time constants, below -50 dB). */
export const PURR_RELEASE_S = 0.5;
/**
 * Once the last purr has ended (a click's one-shot, a released or capped loop), the audio device is
 * suspended after this long, so Chromium's realtime audio thread does not keep rendering silence.
 */
export const IDLE_SUSPEND_MS = 1000;

/** A sounding purr: the gain that sets its level, the gains a fade-out takes to 0, its oscillators, every node to disconnect, and its timing (context seconds). */
interface Voice {
  output: GainNode;
  faders: AudioParam[];
  sources: OscillatorNode[];
  nodes: AudioNode[];
  /** When its fade-out starts at the latest. */
  endsAt: number;
  /** When its oscillators stop. */
  stopAt: number;
}

const level = (volume: number) => PURR_LOOP_LEVEL * (Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0);

export class PetSound {
  private context: AudioContext | null = null;
  private last = -Infinity;
  private loop: Voice | null = null;
  private readonly voices = new Set<Voice>();
  private suspendTimer: ReturnType<typeof setTimeout> | undefined;
  /** One-shot purrs still waiting for the device to resume (not yet in `voices`). */
  private starting = 0;

  constructor(private readonly createContext: () => AudioContext = () => new AudioContext()) {}

  /** The one-shot purr of a click, at most once every 1.5 s. */
  async purr(volume: number) {
    if (performance.now() - this.last < 1500) return;
    this.last = performance.now();
    this.starting++;
    try {
      const context = this.wake();
      await context.resume();
      const carrier = context.createOscillator(), modulation = context.createOscillator(), modGain = context.createGain(), gain = context.createGain(), filter = context.createBiquadFilter();
      carrier.type = 'triangle'; carrier.frequency.value = 85;
      modulation.frequency.value = 25; modGain.gain.value = 0.018 * volume;
      modulation.connect(modGain); modGain.connect(gain.gain);
      gain.gain.setValueAtTime(0, context.currentTime); gain.gain.linearRampToValueAtTime(0.035 * volume, context.currentTime + 0.15); gain.gain.linearRampToValueAtTime(0, context.currentTime + 1.4);
      filter.type = 'lowpass'; filter.frequency.value = 240;
      carrier.connect(filter); filter.connect(gain); gain.connect(context.destination);
      carrier.start(); modulation.start(); carrier.stop(context.currentTime + 1.5); modulation.stop(context.currentTime + 1.5);
      // Its modulation feeds the output gain directly, so a fade-out takes both to 0.
      const voice: Voice = { output: gain, faders: [gain.gain, modGain.gain], sources: [carrier, modulation], nodes: [carrier, modulation, modGain, filter, gain], endsAt: context.currentTime + 1.5, stopAt: context.currentTime + 1.5 };
      this.voices.add(voice);
      carrier.onended = () => this.ended(voice);
    } catch { /* Audio is optional; a muted or unavailable device never blocks interaction. */ } finally { this.starting--; }
  }

  /**
   * Starts the gentle looping purr of a held pet: a soft fade-in, the 25 Hz flutter with a slow
   * breathing swell, and a fade-out after PURR_LOOP_MAX_S at the latest. While the loop plays, a
   * new call only applies `volume`.
   */
  startPurrLoop(volume: number): void {
    if (this.purring) {
      this.setPurrVolume(volume);
      return;
    }
    this.loop = null;
    try {
      const context = this.wake();
      void context.resume().catch(() => {});
      const now = context.currentTime, endsAt = now + PURR_LOOP_MAX_S;
      const carrier = context.createOscillator(), filter = context.createBiquadFilter();
      const flutter = context.createGain(), output = context.createGain();
      const rumble = context.createOscillator(), rumbleDepth = context.createGain();
      const breath = context.createOscillator(), breathDepth = context.createGain();
      carrier.type = 'triangle'; carrier.frequency.value = 85;
      filter.type = 'lowpass'; filter.frequency.value = 240;
      // The flutter and a slow breathing swell modulate a gain of 1, which never drops below 0.35.
      flutter.gain.value = 1;
      rumble.frequency.value = 25; rumbleDepth.gain.value = 0.45;
      breath.frequency.value = 0.7; breathDepth.gain.value = 0.2;
      rumble.connect(rumbleDepth); rumbleDepth.connect(flutter.gain);
      breath.connect(breathDepth); breathDepth.connect(flutter.gain);
      carrier.connect(filter); filter.connect(flutter); flutter.connect(output); output.connect(context.destination);
      output.gain.setValueAtTime(0, now);
      output.gain.setTargetAtTime(level(volume), now, PURR_FADE_IN_S);
      // The cap: even if nothing stops it, the loop never outlasts the longest held pet.
      output.gain.setTargetAtTime(0, endsAt, PURR_FADE_OUT_S);
      const sources = [carrier, rumble, breath], stopAt = endsAt + PURR_RELEASE_S;
      for (const source of sources) {
        source.start(now);
        source.stop(stopAt);
      }
      const voice: Voice = { output, faders: [output.gain], sources, nodes: [carrier, filter, flutter, output, rumble, rumbleDepth, breath, breathDepth], endsAt, stopAt };
      carrier.onended = () => this.ended(voice);
      this.voices.add(voice);
      this.loop = voice;
    } catch { /* Audio is optional; a muted or unavailable device never blocks interaction. */ }
  }

  /** Applies a volume change to the playing loop at once, with a short glide instead of a click. */
  setPurrVolume(volume: number): void {
    const loop = this.loop, context = this.context;
    if (!loop || !context || context.currentTime >= loop.endsAt) return;
    try {
      loop.output.gain.setTargetAtTime(level(volume), context.currentTime, PURR_VOLUME_S);
    } catch { /* See startPurrLoop. */ }
  }

  /** Fades the loop out (about a quarter of a second) and releases it. */
  stopPurrLoop(): void {
    const loop = this.loop;
    this.loop = null;
    if (loop && this.context) this.fadeOut(loop, this.context.currentTime);
  }

  /** The looping purr is playing: started, not stopped, and before its cap. */
  get purring(): boolean {
    return this.loop !== null && this.context !== null && this.context.currentTime < this.loop.endsAt;
  }

  /**
   * Silences everything (pause, Quiet Mode, sound off): the loop and any one-shot purr fade out
   * quickly, then the audio device is suspended until the next purr.
   */
  stop() {
    const context = this.context;
    if (!context) return;
    this.loop = null;
    const now = context.currentTime;
    for (const voice of this.voices) this.fadeOut(voice, now);
    const fading = [...this.voices].some(voice => voice.stopAt > now);
    clearTimeout(this.suspendTimer);
    this.suspendTimer = setTimeout(() => {
      this.suspendTimer = undefined;
      void context.suspend().catch(() => {});
    }, fading ? PURR_RELEASE_S * 1000 : 0);
  }

  /** The audio context, created on first use. A suspend still pending from `stop()` is cancelled. */
  private wake(): AudioContext {
    clearTimeout(this.suspendTimer);
    this.suspendTimer = undefined;
    return this.context ??= this.createContext();
  }

  /** A quick fade to silence from the current level, then the oscillators stop. */
  private fadeOut(voice: Voice, now: number): void {
    if (voice.endsAt <= now) return;
    try {
      for (const gain of voice.faders) {
        if (typeof gain.cancelAndHoldAtTime === 'function') gain.cancelAndHoldAtTime(now);
        else { gain.cancelScheduledValues(now); gain.setValueAtTime(gain.value, now); }
        gain.setTargetAtTime(0, now, PURR_FADE_OUT_S);
      }
      voice.endsAt = now;
      voice.stopAt = Math.min(voice.stopAt, now + PURR_RELEASE_S);
      for (const source of voice.sources) source.stop(voice.stopAt);
    } catch { /* See startPurrLoop. */ }
  }

  /** A purr's oscillators stopped: its nodes are released, and with nothing left sounding the device is suspended soon after. */
  private ended(voice: Voice): void {
    for (const node of voice.nodes) node.disconnect();
    this.voices.delete(voice);
    if (this.loop === voice) this.loop = null;
    const context = this.context;
    if (!context || this.voices.size > 0 || this.loop !== null) return;
    clearTimeout(this.suspendTimer);
    this.suspendTimer = setTimeout(() => {
      this.suspendTimer = undefined;
      // A purr that started meanwhile (its wake() may have run before this timer was set) keeps the device awake.
      if (this.voices.size === 0 && this.loop === null && this.starting === 0) void context.suspend().catch(() => {});
    }, IDLE_SUSPEND_MS);
  }
}
