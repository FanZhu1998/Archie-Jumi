/** Locally synthesized soft purr: no remote audio or microphone access. */
export class PetSound {
  private context: AudioContext | null = null;
  private last = -Infinity;
  async purr(volume: number) {
    if (performance.now() - this.last < 1500) return;
    this.last = performance.now();
    try {
      const context = this.context ??= new AudioContext();
      await context.resume();
      const carrier = context.createOscillator(), modulation = context.createOscillator(), modGain = context.createGain(), gain = context.createGain(), filter = context.createBiquadFilter();
      carrier.type = 'triangle'; carrier.frequency.value = 85;
      modulation.frequency.value = 25; modGain.gain.value = 0.018 * volume;
      modulation.connect(modGain); modGain.connect(gain.gain);
      gain.gain.setValueAtTime(0, context.currentTime); gain.gain.linearRampToValueAtTime(0.035 * volume, context.currentTime + 0.15); gain.gain.linearRampToValueAtTime(0, context.currentTime + 1.4);
      filter.type = 'lowpass'; filter.frequency.value = 240;
      carrier.connect(filter); filter.connect(gain); gain.connect(context.destination);
      carrier.start(); modulation.start(); carrier.stop(context.currentTime + 1.5); modulation.stop(context.currentTime + 1.5);
      carrier.onended = () => { carrier.disconnect(); modulation.disconnect(); modGain.disconnect(); filter.disconnect(); gain.disconnect(); };
    } catch { /* Audio is optional; a muted or unavailable device never blocks interaction. */ }
  }
  stop() { if (this.context) void this.context.suspend(); }
}
