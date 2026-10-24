// Seconds of white noise every sound is cut from.
const NOISE_SECONDS = 4;
const SILENT = 0.0001;

/**
 * The few sounds the table makes itself: a match struck, a flame going out, a card burning, the recorder's button.
 * Made on the spot from shaped noise, so there are no sound files to license or load. Quiet enough to sit under
 * the voices.
 */
export class TableSounds {
  /** @param output {() => AudioNode | null} where to play (its context is used), or null while audio is locked */
  constructor(output) {
    this.output = output;
  }

  /** A match scratched along the box, catching and flaring. */
  strike() {
    this.play((at) => {
      // The scratch: a ragged rasp of a few strokes.
      let t = at;
      while (t < at + 0.2) {
        const stroke = 0.01 + Math.random() * 0.03;
        this.burst(t, { duration: stroke, peak: 0.15 + Math.random() * 0.25, type: "bandpass", frequency: 2500 + Math.random() * 2000, q: 1.2 });
        t += stroke * (0.6 + Math.random() * 0.6);
      }
      // The head catching: a soft whoosh that settles into the flame.
      this.burst(at + 0.2, { duration: 0.9, peak: 0.35, attack: 0.05, type: "lowpass", frequency: 1800, q: 0.7, sweepTo: 500 });
      this.crackles(at + 0.22, 0.4, 6, 0.12);
    });
  }

  /** A flame going out: a breath and the wick sizzling. */
  snuff() {
    this.play((at) => {
      this.burst(at, { duration: 0.35, peak: 0.12, attack: 0.04, type: "lowpass", frequency: 700, q: 0.5 });
      this.burst(at + 0.05, { duration: 0.6, peak: 0.07, attack: 0.02, type: "highpass", frequency: 3500, q: 0.7 });
    });
  }

  /** Paper burning in the bowl for `seconds`: a low roar full of crackles. */
  burn(seconds) {
    this.play((at) => {
      this.burst(at, { duration: seconds, peak: 0.22, attack: 0.4, type: "lowpass", frequency: 450, q: 0.6, hold: 0.5 });
      this.crackles(at + 0.1, seconds - 0.3, Math.round(seconds * 14), 0.3);
    });
  }

  /** The recorder's button going down or up. */
  click() {
    this.play((at) => {
      this.burst(at, { duration: 0.012, peak: 0.5, type: "bandpass", frequency: 3200, q: 2 });
      this.burst(at + 0.035, { duration: 0.03, peak: 0.25, type: "bandpass", frequency: 900, q: 3 });
    });
  }

  play(compose) {
    const output = this.output();
    if (!output) return;
    const context = output.context;
    if (context.state === "suspended") context.resume();
    this.destination = output;
    compose(context.currentTime + 0.01);
  }

  /** Short pops at random moments in a span, each its own pitch and loudness. */
  crackles(at, span, count, loudness) {
    for (let i = 0; i < count; i++) {
      this.burst(at + Math.random() * span, {
        duration: 0.004 + Math.random() * 0.02,
        peak: loudness * (0.2 + Math.random() * 0.8),
        type: "bandpass",
        frequency: 1200 + Math.random() * 4500,
        q: 1.5
      });
    }
  }

  /**
   * One stretch of filtered noise: rises over `attack`, stays for `hold` of its length, then dies away.
   * `sweepTo` moves the filter while it sounds.
   */
  burst(at, { duration, peak, attack = 0.002, hold = 0, type, frequency, q = 1, sweepTo }) {
    const context = this.destination.context;
    const source = context.createBufferSource();
    source.buffer = this.noise(context);
    const filter = context.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(frequency, at);
    if (sweepTo) filter.frequency.exponentialRampToValueAtTime(sweepTo, at + duration);
    filter.Q.value = q;
    const gain = context.createGain();
    gain.gain.setValueAtTime(SILENT, at);
    gain.gain.linearRampToValueAtTime(peak, at + attack);
    if (hold) gain.gain.setValueAtTime(peak, at + attack + (duration - attack) * hold);
    gain.gain.exponentialRampToValueAtTime(SILENT, at + duration);
    source.connect(filter).connect(gain).connect(this.destination);
    source.start(at, Math.random() * Math.max(NOISE_SECONDS - duration - 0.05, 0), duration + 0.05);
  }

  noise(context) {
    if (this.noiseBuffer?.sampleRate !== context.sampleRate) {
      const length = NOISE_SECONDS * context.sampleRate;
      this.noiseBuffer = context.createBuffer(1, length, context.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    }
    return this.noiseBuffer;
  }
}
