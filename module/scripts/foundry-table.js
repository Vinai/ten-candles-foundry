import { isStarted, nextDeath } from "./candle-clock.js";
import { GA_PAINTING, GA_STATE_HOOK, GA_STATE_SETTING, GA_SYSTEM_ID, MODULE_ID, SOCKET, TOTAL_CANDLES } from "./constants.js";
import { CameraFaces } from "./faces.js";
import { GMControls } from "./gm-controls.js";
import { ConflictMirror } from "./mirror.js";
import { PlainStage } from "./plain-stage.js";
import { seeded } from "./random.js";
import { Recorder } from "./recorder.js";
import { FADE_MS as DICE_FADE_MS, ROLL_MS } from "./rolling-dice.js";
import { Ritual } from "./ritual.js";
import { SETTING_CHANGED_HOOK, SETTINGS } from "./settings.js";
import { CharacterSheets } from "./sheets.js";
import { TableSounds } from "./sounds.js";
import { TableStage } from "./stage.js";
import { Truths } from "./truths.js";

const GUTTER_TICK_MS = 1000;
const X_CARD_COOLDOWN_MS = 5000;
// A candle goes out: the cards over the bowl fade, the candle dies, its smoke rises a while, then the GM's words.
const CLEAR_MS = 800;
const SMOKE_MS = 3000;
// A card burned for a reroll: the conflict card fades slowly, a pause, the card burns, a pause, then the dice.
const BURN_FADE_MS = 1500;
const BEFORE_BURN_MS = 2400;
const AFTER_BURN_MS = 5000;
// Thrown dice are gone again this long after the first of them came to rest, and the conflict card comes back.
// Before "Licht aus" there is no card, only dice rolled to hear them, and they lie a little longer.
const AFTER_DICE_MS = 3000;
const AFTER_PRACTICE_DICE_MS = 4000;
// At "Licht aus" the dice row appears this long after the click: the match, the last candle catching, a breath.
const DICE_AFTER_LIGHTS_MS = 2000;
// A trait spent during its owner's conflict waits this long for the Game Assistant to say it was for a reroll.
const REROLL_WAIT_MS = 2500;
// The Game Assistant's buttons that ask for a roll, and how long after a click they wait for its dice to come.
const ROLL_BUTTONS = '.ets-floating-roll, .ets-sheet-roll, [data-tool="tencandles-ga-player-roll"]';
const ROLL_CLICK_MS = 1500;
// A failure or seized narration this recent put the candle out; otherwise it burned down or was blown out.
const CAUSE_MS = 15000;
const TRAIT_LABELS = { virtue: "TCT.Card.Virtue", vice: "TCT.Card.Vice", moment: "TCT.Card.Moment" };
const PLACEHOLDERS = {
  virtue: "ETC.Character.VirtuePlaceholder",
  vice: "ETC.Character.VicePlaceholder",
  moment: "ETC.Character.MomentPlaceholder",
  brink: "ETC.Character.BrinkPlaceholder"
};

/**
 * Glue between Foundry/Game Assistant and the Foundry-independent TableStage: who sits where, their faces and
 * cards, how many candles burn and whether the room lights are on.
 */
export class FoundryTable {
  constructor() {
    this.faces = new CameraFaces();
    this.ritual = new Ritual(this);
    this.recorder = new Recorder(this);
    this.truths = new Truths(this);
    this.sheets = new CharacterSheets(this);
    // Foundry's interface channel, so each player's interface volume applies. Silent until their first click.
    this.sounds = new TableSounds(() => (game.audio.locked ? null : game.audio.interface?.gainNode ?? null));
    // A conflict or Moment request already seen, so a sheet only makes way for a new one.
    this.seenRequests = new Set();
    // Per actor, the traits last seen unburned, to notice the moment one is spent.
    this.unburned = new Map();
    // Traits spent for a reroll that still lie on their stack until their turn to burn, by "actorId:key".
    this.rerollBurns = new Map();
    // What the table shows happens one thing after the other: dice, a burning card, a candle going out.
    this.beats = Promise.resolve();
    // Bumped by a new game: whatever the table still meant to show of the old one is dropped.
    this.generation = 0;
    this.rerollTimers = new Set();
    // Rolls of the Game Assistant's conflicts already thrown on this table, by "resolutionId:historyIndex".
    this.thrown = new Set();
    // Throws waiting, rolling or lying on the table; meanwhile nobody here asks for another roll.
    this.diceOut = 0;
    this.rollClickedAt = 0;
    const table = this;
    this.api = {
      setSeatOrder: (names) => this.setSeatOrder(names),
      setLightsOut: (value) => game.settings.set(MODULE_ID, SETTINGS.lightsOut, value),
      // For trying the recordings out before the last candle is dark: plays the next one.
      playRecordings: () => this.recorder.playNext(),
      get stage() {
        return table.stage;
      }
    };
  }

  /**
   * @param plain {boolean} the player's plain table: Foundry's own scene and camera dock instead of the drawn table.
   *   Writing, the recorder, the X-card and the GM's controls work all the same.
   */
  async mount({ plain = false } = {}) {
    this.plain = plain;
    this.gameId = this.gaState().gameId;
    await this.allowPlayerVideo();
    this.users = this.seatedUsers();
    if (plain) {
      this.stage = new PlainStage();
    } else {
      const image = await loadImage(GA_PAINTING);
      await this.adoptPersonalPresentation();
      this.pauseCanvas();
      document.body.classList.add("tct-active");
      this.stage = new TableStage(document.body, image, {
        seats: this.users.map((user) => this.seatData(user)),
        viewer: this.viewerIndex(),
        sounds: this.sounds
      });
    }
    this.applyState(this.gaState(), { instant: true });
    this.applyLights({ instant: true });
    if (!plain) this.faces.start();
    this.stage.start();
    this.mountOwnControls();
    this.stage.addXCard(() => this.touchXCard());
    if (!plain) {
      this.mirror = new ConflictMirror(this, this.stage.addMirror());
      this.mirror.start();
    }
    // Rolls from before this page loaded are not thrown again.
    this.observeRolls(this.gaState(), { replay: false });
    document.addEventListener("click", (event) => this.oneRollAtATime(event), true);
    this.sheets.start();
    this.makeWayFor(this.gaState(), { initial: true });
    this.applyTruths();
    game.socket.on(SOCKET, (message, senderId) => {
      // Anyone may touch the X-card; the cue for the last truth is the active GM's alone.
      if (message?.type === "xcard") this.showXCard();
      if (message?.type === "alive" && senderId === game.users.activeGM?.id && message.gameId === this.gameId) {
        this.showAlive();
      }
      if (message?.type === "no-roll") this.noRoll(message, senderId);
    });
    // The Game Assistant's roll tool in the scene controls (on a plain table) is gone while the truths are spoken.
    Hooks.on("getSceneControlButtons", (controls) => {
      const tool = controls.tokens?.tools?.["tencandles-ga-player-roll"];
      if (tool && this.truths.active) tool.visible = false;
    });
    if (game.user.isGM) {
      this.gm = new GMControls(this);
      this.gm.mount();
    }
    this.ritual.start();
    this.recorder.start();
    window.setInterval(() => this.applyGutter(), GUTTER_TICK_MS);

    Hooks.on(GA_STATE_HOOK, (state) => {
      if (state.gameId !== this.gameId) this.newGame(state);
      this.observeRolls(state);
      this.makeWayFor(state);
      this.applyState(state);
      this.mirror?.render();
      this.gm?.onGaState(state);
      this.gm?.render();
    });
    Hooks.on(SETTING_CHANGED_HOOK, (key) => {
      if (key === SETTINGS.lightsOut) this.applyLights();
      if (key === SETTINGS.seatOrder) this.refreshSeats();
      if (key === SETTINGS.ritual) this.ritual.onChange();
      // The GM's reminders over the bowl follow the ritual and go at "Licht aus".
      if (key === SETTINGS.ritual || key === SETTINGS.candleClock) this.mirror?.render();
      if (key === SETTINGS.recorder) this.recorder.onChange();
      if (key === SETTINGS.truths) this.applyTruths();
      // The stacks are locked from "Licht aus"; Foundry's pause follows the clock.
      if (key === SETTINGS.candleClock) {
        this.sheets.renderAll();
        this.gm?.syncPause();
      }
      if ([SETTINGS.lightsOut, SETTINGS.candleClock, SETTINGS.ritual].includes(key)) this.applyState(this.gaState());
      this.gm?.render();
      this.renderWriteButton();
    });
    Hooks.on("updateActor", (actor) => this.refreshActor(actor));
    Hooks.on("updateUser", () => this.refreshSeats());
    Hooks.on("userConnected", () => this.refreshSeats());
    if (!plain) Hooks.on("canvasReady", () => this.pauseCanvas());
  }

  /**
   * The Game Assistant started a new game: the ritual, recorder and clock of the old one are left behind (they are
   * tied to its id), the last words go and the room lights come back on for character creation.
   */
  newGame(state) {
    this.gameId = state.gameId;
    this.generation++;
    this.rerollTimers.forEach((timer) => window.clearTimeout(timer));
    this.rerollTimers.clear();
    this.rerollBurns.clear();
    this.snuffing = false;
    this.stage.clearDice();
    this.mirror?.releaseAll();
    this.stage.clearPhrase();
    this.finalWords = false;
    // No clock in the new game yet, so Foundry is not paused either.
    this.gm?.syncPause();
    this.applyTruths();
    this.ritual.onChange();
    this.recorder.onChange();
    this.renderWriteButton();
    if (game.user === game.users.activeGM && game.settings.get(MODULE_ID, SETTINGS.lightsOut)) {
      game.settings.set(MODULE_ID, SETTINGS.lightsOut, false);
    }
  }

  /** Our overlay replaces the Game Assistant's official canvas, so it switches to its personal presentation. */
  async adoptPersonalPresentation() {
    const state = this.gaState();
    if (game.user !== game.users.activeGM || state.presentationMode === "personal") return;
    await game.evilTenCandles?.state.setPresentationMode("personal");
  }

  /** Faces are the table: Foundry only lets trusted players broadcast video by default, this world lets everyone. */
  async allowPlayerVideo() {
    if (game.user !== game.users.activeGM) return;
    const permissions = foundry.utils.deepClone(game.settings.get("core", "permissions"));
    const roles = permissions.BROADCAST_VIDEO ?? [];
    if (roles.includes(CONST.USER_ROLES.PLAYER)) return;
    permissions.BROADCAST_VIDEO = [...roles, CONST.USER_ROLES.PLAYER].sort();
    await game.settings.set("core", "permissions", permissions);
  }

  /** Nothing of the canvas is visible under the table, so stop it rendering instead of just covering it. */
  pauseCanvas() {
    document.body.classList.add("tct-no-canvas");
    canvas?.app?.ticker.stop();
  }

  gaState() {
    return game.settings.get(GA_SYSTEM_ID, GA_STATE_SETTING);
  }

  /**
   * Candles burning on the table. A failed conflict darkens one at once, while the Game Assistant only counts it
   * down when the truths are done.
   */
  burningCandles(state = this.gaState()) {
    return state.stage === "ball-of-truths" ? Math.max(state.litCandles - 1, 0) : state.litCandles;
  }

  /** Candles on the table: lit step by step during character creation, then burning down from "Licht aus". */
  visibleCandles(state = this.gaState()) {
    const burning = this.burningCandles(state);
    return isStarted(this.clock()) ? burning : Math.min(burning, this.ritual.candles);
  }

  /** The candle clock of the current game, or null before the first "Licht aus". */
  clock() {
    const clock = game.settings.get(MODULE_ID, SETTINGS.candleClock);
    return clock?.gameId && clock.gameId === this.gaState().gameId ? clock : null;
  }

  /**
   * Connected users plus players with a character in this game (so a dropped connection keeps its seat), clockwise.
   * A character left over from an earlier game seats nobody who is not there.
   */
  seatedUsers() {
    const order = game.settings.get(MODULE_ID, SETTINGS.seatOrder);
    const rank = (user) => {
      const index = order.indexOf(user.id);
      return index >= 0 ? index : order.length + (user.isGM ? 0 : 1);
    };
    const gameId = this.gaState().gameId;
    return game.users
      .filter((user) => user.active || (!user.isGM && user.character?.getFlag(MODULE_ID, "gameId") === gameId))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, game.i18n.lang));
  }

  viewerIndex() {
    return Math.max(this.users.indexOf(game.user), 0);
  }

  seatData(user) {
    return {
      name: user.character?.name || user.name,
      face: this.plain ? null : this.faces.get(user),
      ...this.cardsOf(user)
    };
  }

  /**
   * The stack in front of a seat: Brink face down at the bottom, unburned traits on top in the chosen order, and on
   * top of everything the cards still being written. Players see only their own stack, the GM sees every one; the
   * hope die is there for all to see.
   */
  cardsOf(user) {
    const system = user.character?.system;
    const own = game.user.isGM || user.isSelf;
    const pending = own ? [...this.ritual.gmCards(user), ...this.ritual.pendingCards(user)] : [];
    if (!system) return { cards: pending, hope: false };
    const unburned = unburnedTraits(system);
    this.unburned.set(user.character.id, unburned);
    if (!own) return { cards: [], hope: system.hopeDieAvailable };
    const waiting = (key) => this.rerollBurns.get(`${user.character.id}:${key}`);
    const traits = [...system.resourceOrderList]
      .reverse()
      .filter((key) => key in unburned || waiting(key))
      .map((key) => waiting(key) ?? traitCard(key, unburned[key]));
    const brink = written(system, "brink")
      ? [{ label: game.i18n.localize(this.ritual.brinkLabel(user)), text: system.brink.text, faceDown: true }]
      : [];
    return { cards: [...brink, ...traits, ...pending], hope: system.hopeDieAvailable };
  }

  refreshSeats() {
    const users = this.seatedUsers();
    const same = users.length === this.users.length && users.every((user, i) => user === this.users[i]);
    this.users = users;
    if (same) {
      users.forEach((user, index) => this.stage.updateSeat(index, this.seatData(user)));
    } else {
      this.stage.setSeats(users.map((user) => this.seatData(user)), this.viewerIndex());
      this.recorder.refresh();
    }
    this.faces.sync();
  }

  refreshActor(actor) {
    const index = this.seatOf(actor);
    if (index < 0) return;
    // Spent, not erased: the sheet still has the text, it is just no longer available.
    const before = this.unburned.get(actor.id) ?? {};
    const now = unburnedTraits(actor.system);
    const resolution = this.gaState().activeResolution;
    for (const key of Object.keys(before)) {
      if (key in now || !written(actor.system, key)) continue;
      // The sheet makes way, so the burning can be seen.
      this.sheets.close(actor);
      const card = traitCard(key, actor.system[key].text);
      if (resolution?.actorId === actor.id && key !== "moment") this.awaitReroll(actor, key, card);
      else this.beat(() => this.stage.burnCard(this.seatOf(actor), card));
    }
    this.stage.updateSeat(index, this.seatData(this.users[index]));
    // The conflict card offers only the top card for a reroll; burned or reordered, that may be another one now.
    const message = game.messages.get(resolution?.chatMessageId);
    if (resolution?.actorId === actor.id && message) {
      this.mirror?.render();
      ui.chat?.updateMessage(message);
    }
  }

  /**
   * A trait spent during its owner's conflict is most likely burned for a reroll; it stays on the stack until the
   * conflict gets to it. Burned from the sheet instead, nothing claims it and it burns after a moment.
   */
  awaitReroll(actor, key, card) {
    const id = `${actor.id}:${key}`;
    this.rerollBurns.set(id, card);
    const timer = window.setTimeout(() => {
      this.rerollTimers.delete(timer);
      if (!this.rerollBurns.has(id)) return;
      this.takeRerollBurn(actor.id, key);
      this.beat(() => this.stage.burnCard(this.seatOf(actor), card));
    }, REROLL_WAIT_MS);
    this.rerollTimers.add(timer);
  }

  refreshCards() {
    this.users.forEach((user, index) => this.stage.updateSeat(index, this.seatData(user)));
  }

  /**
   * Left of your own face, opposite the roll button: your character sheet, the card you are writing and the recorder
   * when you hold it, one above the other.
   */
  mountOwnControls() {
    this.ownControls = document.createElement("div");
    this.ownControls.className = "tct-own-controls";
    document.body.append(this.ownControls);
    const button = (className, label, onClick) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = className;
      el.textContent = game.i18n.localize(label);
      el.addEventListener("click", onClick);
      this.ownControls.append(el);
      return el;
    };
    this.sheetButton = button("tct-sheet-button", "TCT.Sheet.Button", () => game.user.character && this.sheets.toggle(game.user.character));
    this.writeButton = button("tct-write-button", "TCT.Write.Button", () => this.ritual.write());
    this.renderWriteButton();
  }

  /** A sheet makes way for the table when its character starts a conflict or asks for their Moment. */
  makeWayFor(state, { initial = false } = {}) {
    const requests = [state.activeResolution, ...(state.instantRequests ?? [])].filter(Boolean);
    for (const request of requests) {
      if (this.seenRequests.has(request.id)) continue;
      this.seenRequests.add(request.id);
      const actor = game.actors.get(request.actorId);
      if (actor && !initial) this.sheets.close(actor);
    }
  }

  renderWriteButton() {
    this.sheetButton.hidden = !game.user.character;
    const state = this.ritual.state();
    const writes = this.ritual.step.writes;
    this.writeButton.hidden = !writes || Boolean(state.passing) || !this.ritual.writers().includes(game.user);
    // Once written, the same button opens the card again to change it.
    const written = writes?.some((kind) => state.cards[game.user.id]?.[kind]);
    this.writeButton.textContent = game.i18n.localize(written ? "TCT.Write.EditButton" : "TCT.Write.Button");
  }

  applyState(state, { instant = false } = {}) {
    const litCount = this.visibleCandles(state);
    if (!instant && isStarted(this.clock()) && litCount < this.litCount) {
      // The table takes its time over a candle going out; see candleOut.
      if (!this.snuffing) this.candleOut(state);
    } else if (!this.snuffing) {
      // The game's last words stay until a new game lights candles again.
      if (litCount > 0 && this.finalWords) {
        this.stage.clearPhrase();
        this.finalWords = false;
      }
      this.litCount = litCount;
      this.stage.setCandles(new Set(candleOrder(state.gameId).slice(0, litCount)), { instant });
      this.applyEnd();
    }
    this.applyDice(state, { instant });
    this.applyGutter();
  }

  /**
   * The dice row: none before the game starts; at "Licht aus" it appears once the last candle has caught. During the
   * truths the dice wait for the next scene, when the Game Assistant refills the pool.
   */
  applyDice(state, { instant = false } = {}) {
    if (!isStarted(this.clock())) {
      window.clearTimeout(this.diceTimer);
      this.diceTimer = null;
      this.diceShown = false;
      this.stage.setDice({ player: 0, lost: 0, gm: 0 });
      return;
    }
    if (!this.diceShown && !instant) {
      this.diceTimer ??= window.setTimeout(() => {
        this.diceTimer = null;
        this.diceShown = true;
        this.applyDice(this.gaState());
      }, DICE_AFTER_LIGHTS_MS);
      return;
    }
    this.diceShown = true;
    const lit = this.visibleCandles(state);
    const player = state.stage === "scene" ? Math.min(state.bluePoolRemaining, lit) : lit;
    this.stage.setDice({ player, lost: lit - player, gm: TOTAL_CANDLES - lit });
  }

  /**
   * A candle goes out, by a failed conflict, seized narration, burning down or a draught. The cards over the bowl
   * fade, the candle dies, its smoke rises, the GM's words follow, and only then the truths card. The active GM
   * starts the truths.
   */
  candleOut(state) {
    this.snuffing = true;
    const candles = this.visibleCandles(state);
    if (candles > 0) this.truths.begin(candles, this.firstSpeaker(state));
    this.beat(
      async (current) => {
        try {
          await wait(CLEAR_MS);
          if (!current()) return;
          this.snuffing = false;
          const now = this.gaState();
          this.litCount = this.visibleCandles(now);
          this.stage.setCandles(new Set(candleOrder(now.gameId).slice(0, this.litCount)));
          this.applyEnd();
          this.applyGutter();
          if (this.litCount === 0) return;
          await wait(SMOKE_MS);
          if (!current()) return;
          await this.stage.showPhrase([game.i18n.localize("TCT.Phrase.True"), game.i18n.localize("TCT.Phrase.Dark")]);
        } finally {
          if (current()) this.snuffing = false;
        }
      },
      { hold: true }
    );
  }

  /** Who speaks the first truth: whoever's failure or seized narration put the candle out, otherwise the GM. */
  firstSpeaker(state) {
    const last = state.lastResolution;
    const recent = last && Date.now() - (last.updatedAt ?? 0) < CAUSE_MS;
    const byPlayer = recent && (state.stage === "ball-of-truths" || last.narrationSeized);
    return (byPlayer && game.users.get(last.playerId)) || this.users.find((user) => user.isGM) || game.user;
  }

  /** While the truths are spoken nobody rolls; the GM's "Und wir leben." ends them. */
  applyTruths() {
    document.body.classList.toggle("tct-truths", this.truths.active);
    ui.controls?.render({ reset: true });
    this.mirror?.render();
    this.gm?.render();
  }

  /**
   * Queues something the table shows, after whatever it is showing now. `show` gets a check whether it is still
   * wanted: a new game drops it, also halfway. With `hold` the bowl stays clear from now, not only from its turn, so
   * nothing new pops up over it meanwhile; `slow` lets the card there fade the slow way.
   */
  beat(show, { hold = false, slow = false } = {}) {
    const generation = this.generation;
    const current = () => generation === this.generation;
    const holding = hold ? this.mirror?.hold({ slow }) : null;
    const run = this.beats
      .then(() => (current() ? show(current) : undefined))
      .finally(() => holding && this.mirror?.release(holding));
    this.beats = run.catch((error) => console.error(`${MODULE_ID} | Table`, error));
    return run;
  }

  /**
   * New rolls in the Game Assistant's current conflict are thrown across the table, and the conflict card waits for
   * them. Its history says what was rolled: the player's pool with the hope die, the GM's pool, a reroll of the 1s
   * for a burned trait, or the whole pool again for the Brink.
   */
  observeRolls(state, { replay = true } = {}) {
    for (const resolution of [state.activeResolution, state.lastResolution]) {
      const history = resolution?.history ?? [];
      history.forEach((entry, index) => {
        const key = `${resolution.id}:${index}`;
        if (this.thrown.has(key)) return;
        this.thrown.add(key);
        // A roll during the truths is called off; it is not thrown either.
        const live = replay && resolution === state.activeResolution && !this.truths.active;
        if (live) this.throwEntry(resolution, entry, history[index + 1], key);
      });
    }
  }

  throwEntry(resolution, entry, next, seed) {
    const player = this.users.findIndex((user) => user.id === resolution.playerId);
    const dice = (values, kind) => (values ?? []).map((value) => ({ value, kind }));
    switch (entry.type) {
      case "player-roll": {
        const hope = next?.type === "hope-roll" ? [{ value: next.result, kind: "hope" }] : [];
        return this.throwDice(player, [...dice(entry.results, "player"), ...hope], seed);
      }
      case "gm-roll":
        return this.throwDice(this.users.findIndex((user) => user.isGM), dice(entry.results, "gm"), seed);
      case "limit":
        return this.throwDice(player, dice(entry.results, "player"), seed);
      case "virtue":
      case "vice":
        return this.burnForReroll(resolution, entry.type, dice(entry.results, "player"), seed);
    }
  }

  /**
   * One throw at a time: a roll button does nothing while dice are in the air or on the table, or a conflict is open,
   * nor right after a click, before its dice have come.
   */
  oneRollAtATime(event) {
    if (!event.target.closest?.(ROLL_BUTTONS)) return;
    const busy = this.diceOut > 0 || this.gaState().activeResolution || Date.now() - this.rollClickedAt < ROLL_CLICK_MS;
    if (!busy) {
      this.rollClickedAt = Date.now();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  /** Counts a throw from when it is queued until its dice are picked up again. */
  diceThrown(run) {
    this.diceOut++;
    run.finally(() => this.diceOut--).catch(() => {});
    return run;
  }

  /** Throws the dice and lets them lie, so they have faded out the set time after the first of them came to rest. */
  async rollAndRest(seat, dice, seed, current) {
    const thrown = performance.now();
    await this.stage.rollDice(seat, dice, seed);
    const rest = isStarted(this.clock()) ? AFTER_DICE_MS : AFTER_PRACTICE_DICE_MS;
    const fadeFrom = thrown + ROLL_MS + rest - DICE_FADE_MS;
    if (current()) await wait(Math.max(fadeFrom - performance.now(), 0));
  }

  throwDice(seat, dice, seed) {
    if (!dice.length) return;
    return this.diceThrown(this.beat(
      async (current) => {
        try {
          await this.rollAndRest(seat, dice, seed, current);
        } finally {
          this.stage.clearDice();
        }
      },
      { hold: true }
    ));
  }

  /** A trait burned for a reroll: the conflict card fades, the card burns in the bowl, then the 1s are rolled again. */
  burnForReroll(resolution, key, dice, seed) {
    const actor = game.actors.get(resolution.actorId);
    const card = this.takeRerollBurn(actor?.id, key) ?? traitCard(key, actor?.system[key]?.text ?? "");
    return this.diceThrown(this.beat(
      async (current) => {
        try {
          await wait(BURN_FADE_MS + BEFORE_BURN_MS);
          if (!current()) return;
          await this.stage.burnCard(this.seatOf(actor), card);
          await wait(AFTER_BURN_MS);
          if (!current()) return;
          await this.rollAndRest(this.seatOf(actor), dice, seed, current);
        } finally {
          this.stage.clearDice();
        }
      },
      { hold: true, slow: true }
    ));
  }

  /** The card leaves its stack only when it is its turn to burn. */
  takeRerollBurn(actorId, key) {
    const id = `${actorId}:${key}`;
    const card = this.rerollBurns.get(id) ?? null;
    this.rerollBurns.delete(id);
    const actor = game.actors.get(actorId);
    if (card && actor) this.refreshSeatOf(actor);
    return card;
  }

  seatOf(actor) {
    return this.users.findIndex((user) => user.character === actor);
  }

  refreshSeatOf(actor) {
    const index = this.seatOf(actor);
    if (index >= 0) this.stage.updateSeat(index, this.seatData(this.users[index]));
  }

  /** The next candle to burn out gutters for its last minute or two, in every browser alike. */
  applyGutter() {
    const state = this.gaState();
    const litCount = this.visibleCandles(state);
    const next = candleOrder(state.gameId)[litCount - 1];
    const gutter = nextDeath(this.clock(), litCount)?.gutter ?? 0;
    for (let i = 0; i < TOTAL_CANDLES; i++) this.stage.table.setGutter(i, i === next ? gutter : 0);
  }

  applyLights({ instant = false } = {}) {
    const lightsOut = game.settings.get(MODULE_ID, SETTINGS.lightsOut);
    this.stage.table.setRoomLight(lightsOut ? 0 : 1, { instant });
    this.applyEnd();
  }

  /**
   * After the last candle: true black, faces and all, with only the last words left, until the lights come on.
   * The GM keeps a faint panel for the recordings.
   */
  applyEnd() {
    const end = isStarted(this.clock()) && this.litCount === 0 && game.settings.get(MODULE_ID, SETTINGS.lightsOut);
    // A plain table has no black to fade into; the last words still come.
    document.body.classList.toggle("tct-the-end", end && !this.plain);
    // Joined or reloaded in the dark: the words are already there.
    if (end && !this.finalWords) this.showFinalWords();
  }

  /** The last candle is out: the GM's words, this time without anyone left to answer. They stay. */
  showFinalWords() {
    this.finalWords = true;
    this.stage.showPhrase([game.i18n.localize("TCT.Phrase.True"), game.i18n.localize("TCT.Phrase.Dark")], {
      final: true
    });
  }

  /** The GM's cue for the last truth, spoken by all players together; the truths are over. */
  sayAlive() {
    this.truths.end();
    game.socket.emit(SOCKET, { type: "alive", gameId: this.gameId });
    this.showAlive();
  }

  /** The GM called off a roll during the truths. */
  noRoll(message, senderId) {
    if (senderId !== game.users.activeGM?.id || message.gameId !== this.gameId) return;
    ui.notifications.warn(game.i18n.localize("TCT.Truths.NoRoll"));
  }

  showAlive() {
    // The game's last words are not replaced.
    if (this.finalWords) return;
    this.stage.showPhrase([game.i18n.localize("TCT.Phrase.Alive")]);
  }

  /** Anyone may touch the X-card; everyone sees that it happened, nobody sees who. */
  touchXCard() {
    if (Date.now() - (this.lastXCard ?? 0) < X_CARD_COOLDOWN_MS) return;
    game.socket.emit(SOCKET, { type: "xcard" });
    this.showXCard();
  }

  showXCard() {
    this.lastXCard = Date.now();
    this.stage.flashX();
    ui.notifications.warn(game.i18n.localize("TCT.XCard.Touched"));
  }

  /** @param names {string[]} user or character names, clockwise */
  async setSeatOrder(names) {
    const ids = names.map((name) => {
      const user = game.users.find((u) => u.name === name || u.character?.name === name);
      if (!user) throw new Error(`${MODULE_ID} | Unknown user: ${name}`);
      return user.id;
    });
    await game.settings.set(MODULE_ID, SETTINGS.seatOrder, ids);
  }
}

/** Sheet fields still holding the Game Assistant's placeholder have not been written yet. */
function written(system, key) {
  return Boolean(system[key].text) && system[key].text !== game.i18n.localize(PLACEHOLDERS[key]);
}

/** Virtue, Vice and Moment that are written and not yet burned, by key. */
function unburnedTraits(system) {
  const unburned = { virtue: system.virtue.available, vice: system.vice.available, moment: !system.momentAttempted };
  return Object.fromEntries(
    Object.keys(TRAIT_LABELS)
      .filter((key) => unburned[key] && written(system, key))
      .map((key) => [key, system[key].text])
  );
}

function traitCard(key, text) {
  return { label: game.i18n.localize(TRAIT_LABELS[key]), text };
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function loadImage(src) {
  const image = new Image();
  image.src = src;
  return image.decode().then(() => image);
}

/** Which candle goes out first: a fixed shuffle per game, the same in every browser. */
function candleOrder(seed) {
  const random = seeded(seed);
  const order = Array.from({ length: TOTAL_CANDLES }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}
