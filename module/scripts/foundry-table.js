import { nextDeath } from "./candle-clock.js";
import { GA_PAINTING, GA_STATE_HOOK, GA_STATE_SETTING, GA_SYSTEM_ID, MODULE_ID, TOTAL_CANDLES } from "./constants.js";
import { CameraFaces } from "./faces.js";
import { GMControls } from "./gm-controls.js";
import { SETTING_CHANGED_HOOK, SETTINGS } from "./settings.js";
import { TableStage } from "./stage.js";

const GUTTER_TICK_MS = 1000;

/**
 * Glue between Foundry/Game Assistant and the Foundry-independent TableStage: who sits where, their faces and
 * cards, how many candles burn and whether the room lights are on.
 */
export class FoundryTable {
  constructor() {
    this.faces = new CameraFaces();
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
    if (game.user.isGM) {
      this.gm = new GMControls(this);
      this.gm.mount();
    }
    window.setInterval(() => this.applyGutter(), GUTTER_TICK_MS);

    Hooks.on(GA_STATE_HOOK, (state) => {
      this.applyState(state);
      this.gm?.render();
    });
    Hooks.on(SETTING_CHANGED_HOOK, (key) => {
      if (key === SETTINGS.lightsOut) this.applyLights();
      if (key === SETTINGS.seatOrder) this.refreshSeats();
      this.gm?.render();
    });
    Hooks.on("updateActor", (actor) => this.refreshCards(actor));
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
      ...this.cardsOf(user.character)
    };
  }

  /** The stack in front of a player: Brink face down at the bottom, unburned traits on top in the chosen order. */
  cardsOf(actor) {
    const system = actor?.system;
    if (!system) return { cards: [], hope: false };
    const label = {
      virtue: game.i18n.localize("TCT.Card.Virtue"),
      vice: game.i18n.localize("TCT.Card.Vice"),
      moment: game.i18n.localize("TCT.Card.Moment")
    };
    const unburned = {
      virtue: system.virtue.available,
      vice: system.vice.available,
      moment: !system.momentAttempted
    };
    const traits = [...system.resourceOrderList]
      .reverse()
      .filter((key) => unburned[key])
      .map((key) => ({ label: label[key], text: system[key].text }));
    return {
      cards: [{ label: game.i18n.localize("TCT.Card.Brink"), faceDown: true }, ...traits],
      hope: system.hopeDieAvailable
    };
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

  refreshCards(actor) {
    const index = this.users.findIndex((user) => user.character === actor);
    if (index >= 0) this.stage.updateSeat(index, this.seatData(this.users[index]));
  }

  applyState(state, { instant = false } = {}) {
    const litCount = this.burningCandles(state);
    const lit = new Set(candleOrder(state.gameId).slice(0, litCount));
    for (let i = 0; i < TOTAL_CANDLES; i++) {
      if (lit.has(i)) this.stage.table.light(i, { instant });
      else this.stage.table.snuff(i, { instant });
    }
    // During the truths the dice wait for the next scene, when the Game Assistant refills the pool.
    const player = state.stage === "scene" ? state.bluePoolRemaining : litCount;
    this.stage.setDice({ player, lost: litCount - player, gm: TOTAL_CANDLES - litCount });
    this.applyGutter();
  }

  /** The next candle to burn out gutters for its last minute or two, in every browser alike. */
  applyGutter() {
    const state = this.gaState();
    const litCount = this.burningCandles(state);
    const next = candleOrder(state.gameId)[litCount - 1];
    const gutter = nextDeath(this.clock(), litCount)?.gutter ?? 0;
    for (let i = 0; i < TOTAL_CANDLES; i++) this.stage.table.setGutter(i, i === next ? gutter : 0);
  }

  applyLights({ instant = false } = {}) {
    const lightsOut = game.settings.get(MODULE_ID, SETTINGS.lightsOut);
    this.stage.table.setRoomLight(lightsOut ? 0 : 1, { instant });
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
