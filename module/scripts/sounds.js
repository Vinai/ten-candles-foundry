import { MODULE_ID } from "./constants.js";

// Recordings in ../sounds/, credited in ../sounds/CREDITS.md.
const FOLDER = new URL("../sounds/", import.meta.url);
const FILES = ["match-strike", "candle-out", "card-burn", "recorder-start", "recorder-stop"];

/**
 * The few sounds the table makes itself: a match struck, a candle going out, a card burning, the recorder's
 * button. Short recordings, fetched once when the table is built and decoded on first use.
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

  /** A card burning in the bowl, about three seconds. */
  burn() {
    this.play("card-burn");
  }

  /** The recorder's button: pressed to record, pressed again to stop. */
  click(recording) {
    this.play(recording ? "recorder-start" : "recorder-stop");
  }

  async play(name) {
    const output = this.output();
    if (!output) return;
    const context = output.context;
    if (context.state === "suspended") context.resume();
    try {
      if (!this.buffers.has(name)) this.buffers.set(name, this.files.get(name).then((data) => context.decodeAudioData(data)));
      const source = context.createBufferSource();
      source.buffer = await this.buffers.get(name);
      source.connect(output);
      source.start();
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
