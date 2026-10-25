import { MODULE_ID, SOCKET } from "./constants.js";
import { leftOf } from "./seat-layout.js";
import { SETTINGS } from "./settings.js";

const MAX_RECORDING_MS = 90_000;
const BITS_PER_SECOND = 48_000;
// Base64 characters per socket message; a full 90 s message needs a handful.
const CHUNK_CHARS = 200_000;
// A full message even from a browser that ignores our bitrate and records at 256 kbps; anything bigger is refused.
const MAX_CHUNKS = Math.ceil(((MAX_RECORDING_MS / 1000) * 256_000 * 4) / 3 / 8 / CHUNK_CHARS);
const FOLDER = "ten-candles-recordings";
// A browser only joins a playback the GM started just now, never one it finds in the settings after a reload.
const PLAYBACK_FRESH_MS = 15_000;
// Each message begins with the recorder's click and this pause.
const CLICK_PAUSE_MS = 750;
// The holder gives up waiting for the GM after this long and may pass again.
const PASS_TIMEOUT_MS = 45_000;
const MIME_TYPES = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"];
const EXTENSIONS = { "audio/webm": "webm", "audio/mp4": "m4a", "audio/ogg": "ogg" };

/**
 * The voice recorder of "How It Begins": once the lights are out the GM switches it on and passes it left, each
 * player leaves a parting message as their character and passes it on until it is back with the GM. The GM can send
 * it round again; whoever has a message may keep it. At the very end the GM plays the messages one by one, in the
 * order they were recorded, in every browser.
 *
 * World setting `recorder`: {gameId, started, holder, recordings: [{userId, path}], playback: {index, at}}. Players
 * cannot upload files, so a recording travels to the active GM over the module socket and the GM's browser stores
 * it. The holder keeps the recording until the GM has stored it and passed the recorder on.
 */
export class Recorder {
  constructor(table) {
    this.table = table;
    this.mode = "idle"; // idle | opening | recording | recorded | sending
    this.blob = null;
    // Bumped whenever this browser's recorder work is called off, so late microphone grants are ignored.
    this.session = 0;
    // GM side: the transfer of the current holder, {id, mime, total, chunks}, by sender.
    this.incoming = new Map();
    this.storing = null;
    // Another holder's red light, as last signalled by them.
    this.light = { holder: null, on: false };
    this.playback = 0;
    this.playing = false;
  }

  start() {
    this.panel = document.createElement("div");
    this.panel.className = "tct-recorder-panel";
    this.panel.addEventListener("click", (event) => this.onClick(event));
    this.table.ownControls.append(this.panel);
    this.lastPlayback = this.state().playback?.at ?? 0;
    this.gameId = this.state().gameId;
    this.note = document.createElement("div");
    this.note.className = "tct-discord-note";
    this.note.hidden = true;
    this.note.addEventListener("click", () => this.note.classList.contains("is-dismissable") && (this.note.hidden = true));
    document.body.append(this.note);
    game.socket.on(SOCKET, (message, senderId) => this.onSocket(message, senderId));
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

  /** This player's message from an earlier round, if any. */
  get kept() {
    return this.recordings.find((recording) => recording.userId === game.user.id) ?? null;
  }

  /** The message the GM plays next, as its index; past the end once all were played. */
  get nextIndex() {
    return (this.state().playback?.index ?? -1) + 1;
  }

  onChange({ instant = false } = {}) {
    const state = this.state();
    // A new game: whatever was going on belongs to the old one.
    if (state.gameId !== this.gameId) {
      this.gameId = state.gameId;
      this.stopPlayback();
      this.incoming.clear();
    }
    const holder = this.holder;
    if (holder !== game.user && this.mode !== "idle") this.reset();
    for (const sender of this.incoming.keys()) if (sender !== holder?.id) this.incoming.delete(sender);
    this.table.stage.setRecorder(this.seatOf(holder), { recording: this.lit(holder), instant });
    this.discord(holder === game.user);
    if (state.playback?.at > this.lastPlayback) {
      this.lastPlayback = state.playback.at;
      const recording = (state.recordings ?? [])[state.playback.index];
      if (recording && Date.now() - state.playback.at < PLAYBACK_FRESH_MS) this.playOne(recording);
    }
    this.render();
  }

  /**
   * Voice runs over Discord: while you hold the recorder you mute yourself there, so nobody hears your message
   * before its time; once you passed it on you unmute again. The second note stays until clicked away.
   */
  discord(holding) {
    if (holding === this.holding) return;
    const first = this.holding === undefined;
    this.holding = holding;
    if (!holding && first) return;
    this.note.textContent = game.i18n.localize(holding ? "TCT.Recorder.Mute" : "TCT.Recorder.Unmute");
    this.note.classList.toggle("is-dismissable", !holding);
    if (!holding) {
      const hint = document.createElement("small");
      hint.textContent = game.i18n.localize("TCT.Recorder.Dismiss");
      this.note.append(hint);
    }
    this.note.hidden = false;
  }

  /** After seats moved, the recorder stays with its holder without crossing the table. */
  refresh() {
    const holder = this.holder;
    this.table.stage.setRecorder(this.seatOf(holder), { recording: this.lit(holder), instant: true });
  }

  seatOf(holder) {
    return holder ? this.table.users.indexOf(holder) : -1;
  }

  /** Whether the red light is on: our own recording, or what the holder last signalled. */
  lit(holder) {
    if (!holder) return false;
    if (holder === game.user) return this.recording;
    return this.light.holder === holder.id && this.light.on;
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
      // Back again with a message from the round before: keep it or record a new one.
      kept: [t("Kept"), button("listen-kept", "Listen") + button("record", "Again") + button("pass", "PassKeep")],
      opening: [t("Opening"), ""],
      recording: [t("Recording", { time: elapsed, max: formatSeconds(MAX_RECORDING_MS) }), button("stop", "Stop")],
      recorded: [t("Recorded"), button("listen", "Listen") + button("record", "Again") + button("pass", "Pass")],
      sending: [t("Sending"), ""]
    };
    const view = this.mode === "idle" && this.kept ? "kept" : this.mode;
    const [text, buttons] = views[view];
    // Only the clock changes while recording; keep the buttons so a click on them is never lost.
    if (this.renderedMode !== view || !this.panel.firstChild) {
      this.panel.innerHTML = `<p class="tct-recorder-text"></p><div class="tct-recorder-buttons">${buttons}</div>`;
      this.renderedMode = view;
    }
    this.panel.querySelector(".tct-recorder-text").textContent = text;
    this.panel.classList.toggle("is-recording", this.recording);
  }

  onClick(event) {
    const action = event.target.closest("button")?.dataset.action;
    if (action === "record") this.record();
    else if (action === "stop") this.stop();
    else if (action === "listen") this.listen();
    else if (action === "listen-kept") new Audio(this.kept?.path).play().catch(() => {});
    else if (action === "pass") this.pass();
  }

  get recording() {
    return this.mode === "recording";
  }

  /** Mode to fall back to when something does not work out: whatever was recorded before is still there. */
  get resting() {
    return this.blob ? "recorded" : "idle";
  }

  async record() {
    if (!["idle", "recorded"].includes(this.mode) || this.holder !== game.user) return;
    const session = this.session;
    this.mode = "opening";
    this.render();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (error) {
      if (session !== this.session) return;
      console.warn(`${MODULE_ID} | No microphone`, error);
      ui.notifications.error(game.i18n.localize("TCT.Recorder.NoMicrophone"));
      this.mode = this.resting;
      this.render();
      return;
    }
    // Skipped or reset while the browser asked for the microphone: nobody wants this recording any more.
    if (session !== this.session || this.holder !== game.user) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    let media;
    const parts = [];
    try {
      const mimeType = MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
      media = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: BITS_PER_SECOND });
      media.addEventListener("dataavailable", (event) => event.data.size && parts.push(event.data));
      media.addEventListener("stop", () => {
        stream.getTracks().forEach((track) => track.stop());
        // Passed on or reset meanwhile: this recording is not wanted any more.
        if (this.media !== media) return;
        this.media = null;
        // Only a finished recording replaces the one before.
        if (parts.length) this.blob = new Blob(parts, { type: media.mimeType });
        this.mode = this.resting;
        this.signal();
        this.render();
      });
      media.start(1000);
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      console.warn(`${MODULE_ID} | Could not record`, error);
      ui.notifications.error(game.i18n.localize("TCT.Recorder.NoMicrophone"));
      this.mode = this.resting;
      this.render();
      return;
    }
    this.stream = stream;
    this.media = media;
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

  /**
   * Hands the recorder on, with the message if there is one. The GM's browser stores it and passes the recorder; if
   * that does not happen, the holder still has the recording and can try again.
   */
  async pass() {
    if (!["idle", "recorded"].includes(this.mode)) return;
    const gm = game.users.activeGM;
    if (!gm) {
      ui.notifications.warn(game.i18n.localize("TCT.Recorder.NoGM"));
      return;
    }
    const session = this.session;
    const id = this.blob ? foundry.utils.randomID() : null;
    this.mode = "sending";
    this.transfer = id;
    this.render();
    const to = { recipients: [gm.id] };
    if (this.blob) {
      const data = await blobToBase64(this.blob);
      if (session !== this.session) return;
      const total = Math.ceil(data.length / CHUNK_CHARS);
      for (let index = 0; index < total; index++) {
        const chunk = data.slice(index * CHUNK_CHARS, (index + 1) * CHUNK_CHARS);
        game.socket.emit(SOCKET, { type: "recording", id, index, total, mime: this.blob.type, chunk }, to);
      }
    }
    game.socket.emit(SOCKET, { type: "recorder-pass", id }, to);
    window.clearTimeout(this.passTimer);
    this.passTimer = window.setTimeout(() => this.passFailed(session, id, "PassFailed"), PASS_TIMEOUT_MS);
  }

  /** The pass did not go through; back to the recording, which is still here. */
  passFailed(session, id, message) {
    if (session !== this.session || this.mode !== "sending" || this.transfer !== id) return;
    window.clearTimeout(this.passTimer);
    this.mode = this.resting;
    ui.notifications.error(game.i18n.localize(`TCT.Recorder.${message}`));
    this.render();
  }

  reset() {
    this.session++;
    window.clearInterval(this.ticker);
    window.clearTimeout(this.passTimer);
    const media = this.media;
    this.media = null;
    if (media?.state === "recording") media.stop();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.mode = "idle";
    this.blob = null;
    this.transfer = null;
  }

  /** Everyone sees the recorder's light while it records. */
  signal() {
    game.socket.emit(SOCKET, { type: "recorder-light", on: this.recording });
    this.refresh();
  }

  onSocket(message, senderId) {
    if (message?.type === "recorder-light") {
      // Only the holder's own browser can switch their light.
      if (senderId !== this.state().holder) return;
      this.light = { holder: senderId, on: Boolean(message.on) };
      this.refresh();
      return;
    }
    if (message?.type === "recorder-failed") {
      if (senderId === game.users.activeGM?.id) this.passFailed(this.session, message.id ?? null, "UploadFailed");
      return;
    }
    if (game.user !== game.users.activeGM) return;
    if (message?.type === "recording") this.receiveChunk(senderId, message);
    if (message?.type === "recorder-pass") this.receivePass(senderId, message);
  }

  // GM side --------------------------------------------------------------------------------------------------------

  /** The GM switches the recorder on and passes it to the player on their left. */
  async switchOn() {
    if (game.user !== game.users.activeGM || !(await this.canStore())) return;
    const gm = this.table.users.find((user) => user.isGM);
    await this.save({ ...this.state(), started: true, holder: this.nextHolder(gm)?.id ?? null, recordings: [] });
  }

  /** Round the table once more, e.g. after a message was skipped by mistake. Messages so far are kept. */
  async restart() {
    if (game.user !== game.users.activeGM || !(await this.canStore())) return;
    const gm = this.table.users.find((user) => user.isGM);
    await this.save({ ...this.state(), started: true, holder: this.nextHolder(gm)?.id ?? null, playback: null });
  }

  /**
   * Whether this browser can store recordings at all. Foundry's login expires a day after the browser first opened
   * the page, while the game itself keeps running; better to find out before anyone records.
   */
  async canStore() {
    try {
      await this.upload("probe", game.user.id, btoa(String.fromCharCode(0x1a, 0x45, 0xdf, 0xa3)), "audio/webm", "probe.webm");
      return true;
    } catch (error) {
      console.error(`${MODULE_ID} | Recordings cannot be stored`, error);
      ui.notifications.error(game.i18n.localize("TCT.Recorder.UploadBroken"), { permanent: true });
      return false;
    }
  }

  /** For a player who dropped out or is stuck: the recorder moves on without a message. */
  async skip() {
    if (game.user !== game.users.activeGM) return;
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

  /** Takes a piece of the holder's recording; anything from anyone else, or out of bounds, is dropped. */
  receiveChunk(senderId, { id, index, total, mime, chunk }) {
    if (senderId !== this.state().holder || typeof id !== "string") return;
    if (!Number.isInteger(total) || total < 1 || total > MAX_CHUNKS) return;
    if (!Number.isInteger(index) || index < 0 || index >= total) return;
    if (typeof chunk !== "string" || chunk.length > CHUNK_CHARS || !EXTENSIONS[baseType(mime)]) return;
    let entry = this.incoming.get(senderId);
    // One transfer per holder: a new attempt replaces the old one.
    if (entry?.id !== id) {
      entry = { id, mime: baseType(mime), total, chunks: [] };
      this.incoming.set(senderId, entry);
    }
    if (entry.total !== total || entry.mime !== baseType(mime)) return;
    entry.chunks[index] = chunk;
  }

  /**
   * The holder passes on: with a complete recording, it is stored first; without one (`id` null), the recorder just
   * moves on. Anything incomplete goes back to the holder as failed, who still has the recording.
   */
  async receivePass(senderId, { id }) {
    const state = this.state();
    if (state.holder !== senderId) return;
    if (id === null || id === undefined) {
      await this.passOn(state.gameId, senderId, null);
      return;
    }
    const entry = this.incoming.get(senderId);
    const complete = entry?.id === id && entry.chunks.filter(Boolean).length === entry.total;
    if (!complete) {
      this.reportFailure(senderId, id);
      return;
    }
    // The same pass arriving twice is stored once.
    if (this.storing === id) return;
    this.storing = id;
    try {
      const path = await this.upload(state.gameId, senderId, entry.chunks.join(""), entry.mime);
      this.incoming.delete(senderId);
      await this.passOn(state.gameId, senderId, path);
    } catch (error) {
      console.error(`${MODULE_ID} | Could not store the recording of ${senderId}`, error);
      ui.notifications.error(game.i18n.localize("TCT.Recorder.UploadFailed"));
      this.reportFailure(senderId, id);
    } finally {
      this.storing = null;
    }
  }

  /** Moves the recorder on from `writer`, if nothing else happened meanwhile (a skip, a new game). */
  async passOn(gameId, writer, path) {
    const state = this.state();
    if (state.gameId !== gameId || state.holder !== writer) return;
    // A new message takes the place of the old one; without one, the old one stays.
    const recordings = [...(state.recordings ?? [])];
    if (path) {
      const index = recordings.findIndex((r) => r.userId === writer);
      if (index >= 0) recordings[index] = { userId: writer, path };
      else recordings.push({ userId: writer, path });
    }
    await this.save({ ...state, holder: this.nextHolder(game.users.get(writer))?.id ?? null, recordings });
  }

  reportFailure(writer, id) {
    game.socket.emit(SOCKET, { type: "recorder-failed", id }, { recipients: [writer] });
  }

  async upload(gameId, writer, base64, mime, name = `${gameId}-${writer}-${Date.now()}.${EXTENSIONS[mime]}`) {
    const FilePicker = foundry.applications.apps.FilePicker.implementation;
    const source = globalThis.ForgeVTT?.usingTheForge ? "forgevtt" : "data";
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    name = name.replace(/[^\w.-]/g, "_");
    try {
      await FilePicker.browse(source, FOLDER);
    } catch {
      await FilePicker.createDirectory(source, FOLDER);
    }
    const result = await FilePicker.upload(source, FOLDER, new File([bytes], name, { type: mime }), {}, { notify: false });
    if (!result?.path) throw new Error("Upload returned no path");
    return result.path;
  }

  /** After the last truth the GM plays the messages one by one, in every browser. */
  playNext() {
    const index = this.nextIndex;
    if (game.user !== game.users.activeGM || index >= this.recordings.length) return;
    return this.save({ ...this.state(), playback: { index, at: Date.now() } });
  }

  /** The recorder's click, a breath, then the message; through Foundry's interface volume like the click. */
  async playOne({ path }) {
    this.stopPlayback();
    const run = this.playback;
    this.playing = true;
    this.table.gm?.render();
    try {
      this.table.stage.recorderClick();
      await new Promise((resolve) => window.setTimeout(resolve, CLICK_PAUSE_MS));
      if (run !== this.playback) return;
      await new Promise((resolve) => {
        const audio = (this.audio = new Audio(path));
        this.table.stage.route(audio);
        audio.addEventListener("ended", resolve, { once: true });
        audio.addEventListener("error", resolve, { once: true });
        audio.addEventListener("tct-stop", resolve, { once: true });
        audio.play().catch(resolve);
      });
    } finally {
      if (run === this.playback) {
        this.playing = false;
        this.table.gm?.render();
      }
    }
  }

  stopPlayback() {
    this.playback++;
    const audio = this.audio;
    this.audio = null;
    if (!audio) return;
    audio.pause();
    audio.dispatchEvent(new Event("tct-stop"));
  }
}

function baseType(mime) {
  return String(mime ?? "").split(";")[0].trim();
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
