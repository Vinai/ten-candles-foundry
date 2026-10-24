import { MODULE_ID, SOCKET } from "./constants.js";
import { leftOf } from "./seat-layout.js";
import { SETTINGS } from "./settings.js";

const MAX_RECORDING_MS = 90_000;
const BITS_PER_SECOND = 48_000;
// Base64 characters per socket message; a full 90 s message needs a handful.
const CHUNK_CHARS = 200_000;
const FOLDER = "ten-candles-recordings";
// A browser only joins a playback the GM started just now, never one it finds in the settings after a reload.
const PLAYBACK_FRESH_MS = 15_000;
const PAUSE_BETWEEN_MS = 1500;
const MIME_TYPES = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"];

/**
 * The voice recorder of "How It Begins": once the lights are out the GM switches it on and passes it left, each
 * player leaves a parting message as their character and passes it on until it is back with the GM. At the very end
 * the GM plays all messages, in the order they were recorded, in every browser.
 *
 * World setting `recorder`: {gameId, started, holder, recordings: [{userId, path}], playback: {at}}. Players cannot
 * upload files, so a recording travels to the active GM over the module socket and the GM's browser stores it.
 */
export class Recorder {
  constructor(table) {
    this.table = table;
    this.mode = "idle"; // idle | recording | recorded | sending
    this.blob = null;
    this.incoming = new Map();
  }

  start() {
    this.panel = document.createElement("div");
    this.panel.className = "tct-recorder-panel";
    this.panel.addEventListener("click", (event) => this.onClick(event));
    document.body.append(this.panel);
    this.lastPlayback = this.state().playback?.at ?? 0;
    game.socket.on(SOCKET, (message) => this.onSocket(message));
    this.onChange({ instant: true });
  }

  state() {
    const state = game.settings.get(MODULE_ID, SETTINGS.recorder);
    const gameId = this.table.gaState().gameId;
    if (state?.gameId !== gameId) return { gameId, started: false, holder: null, recordings: [], playback: null };
    return state;
  }

  save(state) {
    return game.settings.set(MODULE_ID, SETTINGS.recorder, state);
  }

  get holder() {
    return game.users.get(this.state().holder) ?? null;
  }

  /** Not yet switched on by the GM. */
  get unused() {
    return !this.state().started;
  }

  /** Round the table and back with the GM. */
  get finished() {
    const state = this.state();
    return state.started && !state.holder;
  }

  get recordings() {
    return this.state().recordings ?? [];
  }

  onChange({ instant = false } = {}) {
    const state = this.state();
    const holder = this.holder;
    if (holder !== game.user && this.mode !== "idle") this.reset();
    this.table.stage.setRecorder(holder ? this.table.users.indexOf(holder) : -1, { recording: this.recording, instant });
    if (state.playback?.at > this.lastPlayback) {
      this.lastPlayback = state.playback.at;
      if (Date.now() - state.playback.at < PLAYBACK_FRESH_MS) this.playAll(state.recordings ?? []);
    }
    this.render();
  }

  /** After seats moved, the recorder stays with its holder without crossing the table. */
  refresh() {
    const holder = this.holder;
    this.table.stage.setRecorder(holder ? this.table.users.indexOf(holder) : -1, { recording: this.recording, instant: true });
  }

  // Holder ---------------------------------------------------------------------------------------------------------

  render() {
    const mine = this.holder === game.user;
    this.panel.hidden = !mine;
    if (!mine) return;
    const t = (key, data) => game.i18n.format(`TCT.Recorder.${key}`, data ?? {});
    const button = (action, key) => `<button type="button" data-action="${action}">${t(key)}</button>`;
    const elapsed = this.recording ? formatSeconds(Date.now() - this.startedAt) : "";
    const views = {
      idle: [t("Hint"), button("record", "Record") + button("pass", "PassEmpty")],
      recording: [t("Recording", { time: elapsed, max: formatSeconds(MAX_RECORDING_MS) }), button("stop", "Stop")],
      recorded: [t("Recorded"), button("listen", "Listen") + button("record", "Again") + button("pass", "Pass")],
      sending: [t("Sending"), ""]
    };
    const [text, buttons] = views[this.mode];
    // Only the clock changes while recording; keep the buttons so a click on them is never lost.
    if (this.renderedMode !== this.mode || !this.panel.firstChild) {
      this.panel.innerHTML = `<p class="tct-recorder-text"></p><div class="tct-recorder-buttons">${buttons}</div>`;
      this.renderedMode = this.mode;
    }
    this.panel.querySelector(".tct-recorder-text").textContent = text;
    this.panel.classList.toggle("is-recording", this.recording);
  }

  onClick(event) {
    const action = event.target.closest("button")?.dataset.action;
    if (action === "record") this.record();
    else if (action === "stop") this.stop();
    else if (action === "listen") this.listen();
    else if (action === "pass") this.pass();
  }

  get recording() {
    return this.mode === "recording";
  }

  async record() {
    this.blob = null;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (error) {
      console.warn(`${MODULE_ID} | No microphone`, error);
      ui.notifications.error(game.i18n.localize("TCT.Recorder.NoMicrophone"));
      return;
    }
    const mimeType = MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
    const parts = [];
    const stream = this.stream;
    const media = (this.media = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: BITS_PER_SECOND }));
    media.addEventListener("dataavailable", (event) => event.data.size && parts.push(event.data));
    media.addEventListener("stop", () => {
      stream.getTracks().forEach((track) => track.stop());
      // Passed on or reset meanwhile: this recording is not wanted any more.
      if (this.media !== media) return;
      this.blob = new Blob(parts, { type: media.mimeType });
      this.mode = "recorded";
      this.signal();
      this.render();
    });
    media.start(1000);
    this.startedAt = Date.now();
    this.mode = "recording";
    this.signal();
    this.ticker = window.setInterval(() => {
      if (Date.now() - this.startedAt >= MAX_RECORDING_MS) this.stop();
      else this.render();
    }, 250);
    this.render();
  }

  stop() {
    window.clearInterval(this.ticker);
    if (this.media?.state === "recording") this.media.stop();
  }

  listen() {
    if (!this.blob) return;
    const url = URL.createObjectURL(this.blob);
    const audio = new Audio(url);
    audio.addEventListener("ended", () => URL.revokeObjectURL(url), { once: true });
    audio.play();
  }

  /** Hands the recorder on, with the message if there is one; the GM's browser keeps it and passes the recorder. */
  async pass() {
    if (!game.users.activeGM) {
      ui.notifications.warn(game.i18n.localize("TCT.Recorder.NoGM"));
      return;
    }
    this.mode = "sending";
    this.render();
    const id = this.blob ? foundry.utils.randomID() : null;
    if (this.blob) {
      const data = await blobToBase64(this.blob);
      const total = Math.ceil(data.length / CHUNK_CHARS);
      for (let index = 0; index < total; index++) {
        const chunk = data.slice(index * CHUNK_CHARS, (index + 1) * CHUNK_CHARS);
        game.socket.emit(SOCKET, { type: "recording", writer: game.user.id, id, index, total, mime: this.blob.type, chunk });
      }
    }
    game.socket.emit(SOCKET, { type: "recorder-pass", writer: game.user.id, id });
  }

  reset() {
    window.clearInterval(this.ticker);
    const media = this.media;
    this.media = null;
    if (media?.state === "recording") media.stop();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.mode = "idle";
    this.blob = null;
  }

  /** Everyone sees the recorder's light while it records. */
  signal() {
    game.socket.emit(SOCKET, { type: "recorder-light", on: this.recording });
    this.refresh();
  }

  onSocket(message) {
    if (message?.type === "recorder-light") {
      this.table.stage.setRecorder(this.holder ? this.table.users.indexOf(this.holder) : -1, {
        recording: Boolean(message.on),
        instant: true
      });
      return;
    }
    if (message?.type === "recorder-failed" && message.writer === game.user.id && this.mode === "sending") {
      this.mode = "recorded";
      ui.notifications.error(game.i18n.localize("TCT.Recorder.UploadFailed"));
      this.render();
      return;
    }
    if (game.user !== game.users.activeGM) return;
    if (message?.type === "recording") this.receiveChunk(message);
    if (message?.type === "recorder-pass") this.receivePass(message);
  }

  // GM side --------------------------------------------------------------------------------------------------------

  /** The GM switches the recorder on and passes it to the player on their left. */
  async switchOn() {
    const gm = this.table.users.find((user) => user.isGM);
    await this.save({ ...this.state(), started: true, holder: this.nextHolder(gm)?.id ?? null, recordings: [] });
  }

  /** For a player who dropped out or is stuck: the recorder moves on without a message. */
  async skip() {
    const holder = this.holder;
    if (holder) await this.save({ ...this.state(), holder: this.nextHolder(holder)?.id ?? null });
  }

  /** The next player on the left, or null once the recorder is back with the GM. */
  nextHolder(from) {
    const users = this.table.users;
    let seat = users.indexOf(from);
    for (let step = 0; step < users.length; step++) {
      seat = leftOf(users.length, Math.max(seat, 0));
      const user = users[seat];
      if (user.isGM) return null;
      if (user !== from) return user;
    }
    return null;
  }

  receiveChunk({ writer, id, index, total, mime, chunk }) {
    const entry = this.incoming.get(id) ?? { writer, mime, total, chunks: [] };
    entry.chunks[index] = chunk;
    this.incoming.set(id, entry);
  }

  async receivePass({ writer, id }) {
    const state = this.state();
    if (state.holder !== writer) return;
    let recordings = state.recordings ?? [];
    const entry = id && this.incoming.get(id);
    this.incoming.delete(id);
    if (entry && entry.chunks.filter(Boolean).length === entry.total) {
      try {
        const path = await this.upload(writer, entry.chunks.join(""), entry.mime);
        recordings = [...recordings.filter((r) => r.userId !== writer), { userId: writer, path }];
      } catch (error) {
        console.error(`${MODULE_ID} | Could not store the recording of ${writer}`, error);
        ui.notifications.error(game.i18n.localize("TCT.Recorder.UploadFailed"));
        game.socket.emit(SOCKET, { type: "recorder-failed", writer });
        return;
      }
    }
    const holder = game.users.get(writer);
    await this.save({ ...this.state(), holder: this.nextHolder(holder)?.id ?? null, recordings });
  }

  async upload(writer, base64, mime) {
    const FilePicker = foundry.applications.apps.FilePicker.implementation;
    const source = globalThis.ForgeVTT?.usingTheForge ? "forgevtt" : "data";
    const type = mime.split(";")[0];
    const extension = type === "audio/mp4" ? "m4a" : "webm";
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const name = `${this.state().gameId}-${writer}-${Date.now()}.${extension}`.replace(/[^\w.-]/g, "_");
    try {
      await FilePicker.browse(source, FOLDER);
    } catch {
      await FilePicker.createDirectory(source, FOLDER);
    }
    const result = await FilePicker.upload(source, FOLDER, new File([bytes], name, { type }), {}, { notify: false });
    if (!result?.path) throw new Error("Upload returned no path");
    return result.path;
  }

  /** After the last truth: every browser plays the messages, one after the other. */
  play() {
    return this.save({ ...this.state(), playback: { at: Date.now() } });
  }

  async playAll(recordings) {
    for (const { path } of recordings) {
      await new Promise((resolve) => {
        const audio = new Audio(path);
        audio.addEventListener("ended", resolve, { once: true });
        audio.addEventListener("error", resolve, { once: true });
        audio.play().catch(resolve);
      });
      await new Promise((resolve) => window.setTimeout(resolve, PAUSE_BETWEEN_MS));
    }
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result).split(",")[1] ?? ""));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(blob);
  });
}

function formatSeconds(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
