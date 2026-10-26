import { MODULE_ID } from "./constants.js";

// Recordings in ../sounds/, credited in ../sounds/CREDITS.md.
const FOLDER = new URL("../sounds/", import.meta.url);
const FILES = ["match-strike", "candle-out", "card-burn", "dice-single", "dice-pair", "recorder-start", "recorder-stop"];
// A handful of dice sounds like this many pairs at most; more would only be louder.
const MAX_DICE_LAYERS = 5;
// The pairs of a handful land within this long of each other.
const DICE_SPREAD_S = 0.18;

/**
 * The few sounds the table makes itself: a match struck, a candle going out, a card burning, dice rolling, the
 * recorder's button. Short recordings, fetched once when the table is built and decoded on first use.
 */
export class TableSounds {
  /** @param output {() => AudioNode | null} where to play (its context is used), or null while audio is locked */
  constructor(output) {
    this.output = output;
    this.files = new Map(FILES.map((name) => [name, fetchFile(name)]));
    this.buffers = new Map();
  }

  /** A match struck and a candle catching. */
  strike() {
    this.play("match-strike");
  }

  /** A candle going out. */
  snuff() {
    this.play("candle-out");
  }

  /** A card burning in the bowl, from catching to embers: ten seconds. */
  burn() {
    this.play("card-burn");
  }

  /**
   * Dice hitting the table and rolling out, as many as were thrown: one die alone, otherwise a pair for every two,
   * each a little earlier or later and higher or lower, so a handful clatters instead of echoing.
   */
  dice(count) {
    if (count <= 1) {
      this.play("dice-single");
      return;
    }
    const layers = Math.min(Math.ceil(count / 2), MAX_DICE_LAYERS);
    for (let i = 0; i < layers; i++) {
      this.play("dice-pair", {
        delay: i && Math.random() * DICE_SPREAD_S,
        rate: i ? 0.9 + Math.random() * 0.2 : 1,
        // Somewhat louder the more dice, without the pairs adding up to a roar.
        gain: layers ** -0.35
      });
    }
  }

  /** The recorder's button: pressed to record, pressed again to stop. */
  click(recording) {
    this.play(recording ? "recorder-start" : "recorder-stop");
  }

  /** @param options {{delay?: number, rate?: number, gain?: number}} seconds from now, playback speed, volume */
  async play(name, { delay = 0, rate = 1, gain = 1 } = {}) {
    const output = this.output();
    if (!output) return;
    const context = output.context;
    if (context.state === "suspended") context.resume();
    try {
      if (!this.buffers.has(name)) this.buffers.set(name, this.files.get(name).then((data) => context.decodeAudioData(data)));
      const source = context.createBufferSource();
      source.buffer = await this.buffers.get(name);
      source.playbackRate.value = rate;
      const volume = context.createGain();
      volume.gain.value = gain;
      source.connect(volume).connect(output);
      source.start(context.currentTime + delay);
    } catch (error) {
      // A sound that cannot be played is no reason to disturb the table.
      this.buffers.delete(name);
      this.files.set(name, fetchFile(name));
      console.warn(`${MODULE_ID} | Sound ${name} failed`, error);
    }
  }
}

/** The file's bytes; decodeAudioData takes over (detaches) the buffer, so each file is decoded once. */
function fetchFile(name) {
  const promise = fetch(new URL(`${name}.wav`, FOLDER)).then((response) => {
    if (!response.ok) throw new Error(`${response.status} ${response.url}`);
    return response.arrayBuffer();
  });
  promise.catch(() => {});
  return promise;
}
