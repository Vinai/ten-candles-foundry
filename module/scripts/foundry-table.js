import { isStarted, nextDeath } from "./candle-clock.js";
import { GA_PAINTING, GA_STATE_HOOK, GA_STATE_SETTING, GA_SYSTEM_ID, MODULE_ID, SOCKET, TOTAL_CANDLES } from "./constants.js";
import { CameraFaces } from "./faces.js";
import { GMControls } from "./gm-controls.js";
import { Ritual } from "./ritual.js";
import { SETTING_CHANGED_HOOK, SETTINGS } from "./settings.js";
import { TableStage } from "./stage.js";

const GUTTER_TICK_MS = 1000;
const X_CARD_COOLDOWN_MS = 5000;
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
    const table = this;
    this.api = {
      setSeatOrder: (names) => this.setSeatOrder(names),
      setLightsOut: (value) => game.settings.set(MODULE_ID, SETTINGS.lightsOut, value),
      get stage() {
        return table.stage;
      }
    };
  }

  async mount() {
    const image = await loadImage(GA_PAINTING);
    await this.adoptPersonalPresentation();
    await this.allowPlayerVideo();
    this.pauseCanvas();
    document.body.classList.add("tct-active");

    this.users = this.seatedUsers();
    this.stage = new TableStage(document.body, image, {
      seats: this.users.map((user) => this.seatData(user)),
      viewer: this.viewerIndex()
    });
    this.applyState(this.gaState(), { instant: true });
    this.applyLights({ instant: true });
    this.faces.start();
    this.stage.start();
    this.mountWriteButton();
    this.stage.addXCard(() => this.touchXCard());
    game.socket.on(SOCKET, (message) => {
      if (message?.type === "xcard") this.showXCard();
    });
    if (game.user.isGM) {
      this.gm = new GMControls(this);
      this.gm.mount();
    }
    this.ritual.start();
    window.setInterval(() => this.applyGutter(), GUTTER_TICK_MS);

    Hooks.on(GA_STATE_HOOK, (state) => {
      this.applyState(state);
      this.gm?.render();
    });
    Hooks.on(SETTING_CHANGED_HOOK, (key) => {
      if (key === SETTINGS.lightsOut) this.applyLights();
      if (key === SETTINGS.seatOrder) this.refreshSeats();
      if (key === SETTINGS.ritual) this.ritual.onChange();
      if ([SETTINGS.lightsOut, SETTINGS.candleClock, SETTINGS.ritual].includes(key)) this.applyState(this.gaState());
      this.gm?.render();
      this.renderWriteButton();
    });
    Hooks.on("updateActor", (actor) => this.refreshActor(actor));
    Hooks.on("updateUser", () => this.refreshSeats());
    Hooks.on("userConnected", () => this.refreshSeats());
    Hooks.on("canvasReady", () => this.pauseCanvas());
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

  /** Connected users plus players with a character (so a dropped connection keeps its seat), clockwise. */
  seatedUsers() {
    const order = game.settings.get(MODULE_ID, SETTINGS.seatOrder);
    const rank = (user) => {
      const index = order.indexOf(user.id);
      return index >= 0 ? index : order.length + (user.isGM ? 0 : 1);
    };
    return game.users
      .filter((user) => user.active || (!user.isGM && user.character))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, game.i18n.lang));
  }

  viewerIndex() {
    return Math.max(this.users.indexOf(game.user), 0);
  }

  seatData(user) {
    return {
      name: user.character?.name || user.name,
      face: this.faces.get(user),
      ...this.cardsOf(user)
    };
  }

  /**
   * The stack in front of a seat: Brink face down at the bottom, unburned traits on top in the chosen order, and on
   * top of everything the cards still being written. Sheet fields still holding the Game Assistant's placeholder
   * have not been written yet.
   */
  cardsOf(user) {
    const system = user.character?.system;
    const pending = [...this.ritual.gmCards(user), ...this.ritual.pendingCards(user)];
    if (!system) return { cards: pending, hope: false };
    const written = (key) => Boolean(system[key].text) && system[key].text !== game.i18n.localize(PLACEHOLDERS[key]);
    const unburned = {
      virtue: system.virtue.available,
      vice: system.vice.available,
      moment: !system.momentAttempted
    };
    const traits = [...system.resourceOrderList]
      .reverse()
      .filter((key) => unburned[key] && written(key))
      .map((key) => ({ label: game.i18n.localize(TRAIT_LABELS[key]), text: system[key].text }));
    const brink = written("brink")
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
    }
    this.faces.sync();
  }

  refreshActor(actor) {
    const index = this.users.findIndex((user) => user.character === actor);
    if (index >= 0) this.stage.updateSeat(index, this.seatData(this.users[index]));
  }

  refreshCards() {
    this.users.forEach((user, index) => this.stage.updateSeat(index, this.seatData(user)));
  }

  /** Lets a writer reopen their card until it is passed. Sits left of their own face, opposite the roll button. */
  mountWriteButton() {
    this.writeButton = document.createElement("button");
    this.writeButton.type = "button";
    this.writeButton.className = "tct-write-button";
    this.writeButton.textContent = game.i18n.localize("TCT.Write.Button");
    this.writeButton.addEventListener("click", () => this.ritual.write());
    document.body.append(this.writeButton);
    this.renderWriteButton();
  }

  renderWriteButton() {
    const state = this.ritual.state();
    this.writeButton.hidden = !this.ritual.step.writes || Boolean(state.passing) || !this.ritual.writers().includes(game.user);
  }

  applyState(state, { instant = false } = {}) {
    const litCount = this.visibleCandles(state);
    const lit = new Set(candleOrder(state.gameId).slice(0, litCount));
    for (let i = 0; i < TOTAL_CANDLES; i++) {
      if (lit.has(i)) this.stage.table.light(i, { instant });
      else this.stage.table.snuff(i, { instant });
    }
    // No dice on the table before the game starts. During the truths the dice wait for the next scene, when the
    // Game Assistant refills the pool.
    if (!isStarted(this.clock())) this.stage.setDice({ player: 0, lost: 0, gm: 0 });
    else {
      const player = state.stage === "scene" ? Math.min(state.bluePoolRemaining, litCount) : litCount;
      this.stage.setDice({ player, lost: litCount - player, gm: TOTAL_CANDLES - litCount });
    }
    this.applyGutter();
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

function loadImage(src) {
  const image = new Image();
  image.src = src;
  return image.decode().then(() => image);
}

/** Which candle goes out first: a fixed shuffle per game, the same in every browser. */
function candleOrder(seed) {
  let a = 2166136261;
  for (const ch of String(seed ?? "")) a = Math.imul(a ^ ch.charCodeAt(0), 16777619);
  const random = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const order = Array.from({ length: TOTAL_CANDLES }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}
