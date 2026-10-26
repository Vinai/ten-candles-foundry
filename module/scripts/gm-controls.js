import { createClock, isPaused, isStarted, nextDeath, pause, resume, start } from "./candle-clock.js";
import { GA_STATE_SETTING, GA_SYSTEM_ID, MODULE_ID, SOCKET, TOTAL_CANDLES } from "./constants.js";
import { gaType } from "./ga-cards.js";
import { SETTINGS } from "./settings.js";

const TICK_MS = 1000;
// For this long after the module put a candle out, a Game Assistant write that brings it back is undone.
const DARKEN_GUARD_MS = 10_000;
// After a Game Assistant action starts (a roll, a decision on a card), no candle is put out for this long: its own
// write of the whole state, begun before ours, would bring the candle back or ours would drop its new conflict.
const GA_BUSY_MS = 5000;
// Anything of the Game Assistant's that starts such an action in this browser.
const GA_ACTIONS =
  "[data-resolution-action], [data-instant-action], [data-resource-action], .ets-floating-roll, .ets-sheet-roll, " +
  '[data-tool="tencandles-ga-player-roll"]';

/**
 * The GM's side of the table: room lights, the candle clock and the draught, plus burning candles out when their
 * time has come. Only the active GM's browser changes game state; any other GM sees no panel.
 */
export class GMControls {
  constructor(table) {
    this.table = table;
    this.panel = document.createElement("div");
    this.panel.className = "tct-gm-panel";
    this.seatsButton = this.button(() => this.editSeats(), "TCT.GM.Seats");
    this.ritualButton = this.button(() => this.nextRitualStep());
    this.backButton = this.button(() => this.table.ritual.stepBack(), "TCT.GM.StepBack");
    this.backButton.dataset.tooltip = game.i18n.localize("TCT.GM.StepBackHint");
    this.lightsButton = this.button(() => this.toggleLights());
    this.pauseButton = this.button(() => this.togglePause());
    this.draughtButton = this.button(() => this.draught(), "TCT.GM.Draught");
    this.draughtButton.dataset.tooltip = game.i18n.localize("TCT.GM.DraughtHint");
    this.aliveButton = this.button(() => this.table.sayAlive(), "TCT.GM.Alive");
    this.aliveButton.dataset.tooltip = game.i18n.localize("TCT.GM.AliveHint");
    this.recorderButton = this.button(() => this.recorderStep());
    this.playButton = this.button(() => this.table.recorder.playNext());
    this.status = document.createElement("div");
    this.status.className = "tct-gm-status";
    // Conflicts called off before "Licht aus"; their cards stay out of sight.
    this.practice = new Set();
    this.recorderStatus = document.createElement("div");
    this.recorderStatus.className = "tct-gm-status";
    this.panel.append(
      this.seatsButton,
      this.ritualButton,
      this.backButton,
      this.lightsButton,
      this.pauseButton,
      this.draughtButton,
      this.aliveButton,
      this.recorderButton,
      this.playButton,
      this.status,
      this.recorderStatus
    );
  }

  mount() {
    document.body.append(this.panel);
    // The Game Assistant's actions all run in this browser: players' requests arrive over its socket, the GM's own
    // start with a click.
    game.socket.on(`system.${GA_SYSTEM_ID}`, (data) => data?.type === "request" && this.gaBusy());
    document.addEventListener("click", (event) => event.target.closest?.(GA_ACTIONS) && this.gaBusy(), true);
    Hooks.on("pauseGame", (paused) => this.followFoundryPause(paused));
    Hooks.on("createChatMessage", (message) => this.markPractice(message));
    this.syncPause();
    this.render();
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  button(onClick, label) {
    const button = document.createElement("button");
    button.type = "button";
    if (label) button.textContent = game.i18n.localize(label);
    button.addEventListener("click", onClick);
    return button;
  }

  /** Only one browser may change the game: the active GM's. */
  get inCharge() {
    return game.user === game.users.activeGM;
  }

  get lightsOut() {
    return game.settings.get(MODULE_ID, SETTINGS.lightsOut);
  }

  async toggleLights() {
    if (!this.inCharge) return;
    const lightsOut = !this.lightsOut;
    // The candles start burning down the first time the lights go out.
    if (lightsOut && !isStarted(this.table.clock())) await this.saveClock(start(this.table.clock() ?? this.newClock()));
    await game.settings.set(MODULE_ID, SETTINGS.lightsOut, lightsOut);
  }

  async nextRitualStep() {
    if (!this.inCharge) return;
    this.ritualButton.disabled = true;
    try {
      await this.table.ritual.next();
    } finally {
      this.ritualButton.disabled = false;
      this.render();
    }
  }

  /**
   * Who sits where, clockwise as at a real table: the GM first, then whoever sits on their left, and so on. Card
   * passing and the recorder follow this order.
   */
  async editSeats() {
    const escape = foundry.utils.escapeHTML;
    const t = (key) => escape(game.i18n.localize(`TCT.Seats.${key}`));
    const row = (user) =>
      `<li data-user-id="${user.id}"><span>${escape(user.character?.name || user.name)}` +
      (user.character ? ` <small>(${escape(user.name)})</small>` : "") +
      `</span><button type="button" data-move="-1" data-tooltip="${t("Up")}">↑</button>` +
      `<button type="button" data-move="1" data-tooltip="${t("Down")}">↓</button></li>`;
    const others = this.table.users.filter((user) => user !== game.user);
    const order = await foundry.applications.api.DialogV2.wait({
      window: { title: game.i18n.localize("TCT.Seats.Title") },
      position: { width: 420 },
      classes: ["tct-seats"],
      content:
        `<p>${t("Hint")}</p><ol class="tct-seat-order">` +
        `<li class="is-gm"><span>${escape(game.user.name)} <small>(${t("You")})</small></span></li>` +
        others.map(row).join("") +
        `</ol>`,
      buttons: [
        {
          action: "save",
          label: game.i18n.localize("TCT.Seats.Save"),
          default: true,
          callback: (event, button) => [...button.form.querySelectorAll("li[data-user-id]")].map((li) => li.dataset.userId)
        }
      ],
      render: (event, dialog) => {
        dialog.element.querySelector(".tct-seat-order").addEventListener("click", (click) => {
          const button = click.target.closest("[data-move]");
          if (!button) return;
          const li = button.closest("li");
          const target = button.dataset.move === "-1" ? li.previousElementSibling : li.nextElementSibling;
          // The GM stays on top: the list starts at their seat.
          if (!target || target.classList.contains("is-gm")) return;
          if (button.dataset.move === "-1") target.before(li);
          else target.after(li);
        });
      }
    });
    if (order && this.inCharge) await game.settings.set(MODULE_ID, SETTINGS.seatOrder, [game.user.id, ...order]);
  }

  /** Switches the recorder on, or moves it past a player who cannot record. */
  async recorderStep() {
    const recorder = this.table.recorder;
    this.recorderButton.disabled = true;
    try {
      if (recorder.unused) await recorder.switchOn();
      else if (recorder.finished) await recorder.restart();
      else await recorder.skip();
    } finally {
      this.recorderButton.disabled = false;
    }
  }

  /**
   * Foundry's own pause goes with the candle clock: paused exactly while the clock is, never before "Licht aus".
   * Without that, a player on the plain table would see "Game paused" during character creation.
   */
  syncPause() {
    if (!this.inCharge) return;
    const clock = this.table.clock();
    const paused = isStarted(clock) && isPaused(clock);
    if (game.paused !== paused) game.togglePause(paused, { broadcast: true });
  }

  /** The GM paused Foundry itself (space bar): the candle clock follows. */
  followFoundryPause(paused) {
    if (!this.inCharge) return;
    const clock = this.table.clock();
    if (!isStarted(clock)) {
      if (paused) game.togglePause(false, { broadcast: true });
    } else if (paused !== isPaused(clock)) {
      this.saveClock(paused ? pause(clock) : resume(clock));
    }
  }

  async togglePause() {
    if (!this.inCharge) return;
    const clock = this.table.clock();
    if (!isStarted(clock)) return;
    await this.saveClock(isPaused(clock) ? resume(clock) : pause(clock));
  }

  /** Only between conflicts and truths; during them the GM is told so and presses again afterwards. */
  async draught() {
    if (!this.inCharge) return;
    if (!(await this.darkenCandle())) ui.notifications.info(game.i18n.localize("TCT.GM.DraughtBlocked"));
  }

  newClock() {
    return { ...createClock(TOTAL_CANDLES), gameId: this.table.gaState().gameId };
  }

  saveClock(clock) {
    return game.settings.set(MODULE_ID, SETTINGS.candleClock, clock);
  }

  tick() {
    this.render();
    if (!this.inCharge) return;
    const clock = this.table.clock();
    if (!isStarted(clock) || isPaused(clock)) return;
    const next = nextDeath(clock, this.table.gaState().litCandles);
    if (next && next.remaining <= 0) this.darkenCandle();
  }

  /**
   * A candle going out on its own ends the scene like a failed conflict: one candle fewer, the dice pool refilled.
   * Waits while a conflict or the truths are under way (until "Und wir leben."); the candle keeps guttering until then.
   */
  async darkenCandle() {
    const state = this.table.gaState();
    const busy =
      state.stage !== "scene" || state.activeResolution || this.table.truths.active || Date.now() < this.gaBusyUntil;
    if (!this.inCharge || this.darkening || busy || state.litCandles <= 0) return false;
    this.darkening = true;
    try {
      const litCandles = state.litCandles - 1;
      this.darkened = { gameId: state.gameId, litCandles, until: Date.now() + DARKEN_GUARD_MS };
      await this.writeCandles(state, litCandles);
      return true;
    } finally {
      this.darkening = false;
    }
  }

  writeCandles(state, litCandles) {
    return game.settings.set(GA_SYSTEM_ID, GA_STATE_SETTING, {
      ...state,
      litCandles,
      bluePoolRemaining: litCandles,
      updatedAt: Date.now()
    });
  }

  /**
   * The Game Assistant replaces its whole state with each change. One that started from the state before our candle
   * went out brings the candle back; put it out again, keeping the rest of that change.
   */
  onGaState(state) {
    if (!this.inCharge) return;
    this.refuseRollDuringTruths(state);
    this.callOffPracticeRoll(state);
    const darkened = this.darkened;
    if (!darkened || Date.now() > darkened.until) return;
    if (state.gameId !== darkened.gameId || state.stage !== "scene") {
      this.darkened = null;
      return;
    }
    if (state.litCandles <= darkened.litCandles) return;
    // A conflict that began from the old state brought the candle back with it: it keeps its dice, the candle stays out.
    if (state.activeResolution) {
      game.settings.set(GA_SYSTEM_ID, GA_STATE_SETTING, {
        ...state,
        litCandles: darkened.litCandles,
        bluePoolRemaining: Math.min(state.bluePoolRemaining, darkened.litCandles),
        updatedAt: Date.now()
      });
    } else this.writeCandles(state, darkened.litCandles);
  }

  /** The Game Assistant is about to change its state; keep the candles still meanwhile. */
  gaBusy() {
    this.gaBusyUntil = Date.now() + GA_BUSY_MS;
  }

  /**
   * Nobody rolls while the truths are spoken. The roll buttons are hidden, but a conflict can still be asked for
   * (e.g. from the scene controls on a plain table); the GM's browser calls it off and tells the player.
   */
  refuseRollDuringTruths(state) {
    const resolution = state.activeResolution;
    if (!resolution || !this.table.truths.active || this.refused === resolution.id) return;
    this.refused = resolution.id;
    game.evilTenCandles?.cancelActiveResolution();
    const message = { type: "no-roll", gameId: state.gameId };
    game.socket.emit(SOCKET, message, { recipients: [resolution.playerId] });
    if (resolution.playerId === game.user.id) this.table.noRoll(message, game.user.id);
  }

  /**
   * Before "Licht aus" players roll only to try the dice, e.g. whether they hear them. The dice roll across the table,
   * then the conflict is called off before it has any consequence. The Game Assistant may write its card only after.
   */
  callOffPracticeRoll(state) {
    const resolution = state.activeResolution;
    if (!resolution || isStarted(this.table.clock()) || this.practice.has(resolution.id)) return;
    this.practice.add(resolution.id);
    game.evilTenCandles?.cancelActiveResolution();
    game.messages.forEach((message) => this.markPractice(message));
  }

  markPractice(message) {
    if (!this.inCharge || gaType(message) !== "resolution" || message.getFlag(MODULE_ID, "practice")) return;
    if (this.practice.has(message.flags[GA_SYSTEM_ID].resolutionId)) message.setFlag(MODULE_ID, "practice", true);
  }

  render() {
    this.panel.hidden = !this.inCharge;
    const clock = this.table.clock();
    const ritual = this.table.ritual;
    this.ritualButton.hidden = !ritual.nextLabel || isStarted(clock);
    // Settled during character creation: the cards were passed along this order.
    this.seatsButton.hidden = isStarted(clock);
    this.ritualButton.textContent = ritual.nextLabel ?? "";
    this.backButton.hidden = isStarted(clock) || ritual.state().step === "idle";
    this.lightsButton.textContent = game.i18n.localize(this.lightsOut ? "TCT.GM.LightsOn" : "TCT.GM.LightsOut");
    this.pauseButton.textContent = game.i18n.localize(isPaused(clock) ? "TCT.GM.Resume" : "TCT.GM.Pause");
    this.pauseButton.disabled = !isStarted(clock);
    this.draughtButton.disabled = !isStarted(clock) || this.table.gaState().litCandles <= 0;
    // At the very end nobody is left to answer.
    this.aliveButton.hidden = !isStarted(clock) || this.table.burningCandles() <= 0;
    // Lit up while the truths are being spoken: they end with this button.
    this.aliveButton.classList.toggle("is-urgent", this.table.truths.active);

    this.status.textContent = this.statusText(clock);
    this.renderRecorder(clock);
  }

  /**
   * The recorder goes round once the lights are out, and again if the GM restarts it; its messages are played one
   * by one after the last candle, each with its own click.
   */
  renderRecorder(clock) {
    const recorder = this.table.recorder;
    const holder = recorder.holder;
    const step = recorder.unused ? "On" : recorder.finished ? "Restart" : "Skip";
    // Once the last candle is out, only a round still under way can be moved on; nothing new is recorded.
    const over = this.table.gaState().litCandles <= 0;
    this.recorderButton.hidden = !isStarted(clock) || (over && step !== "Skip");
    this.recorderButton.textContent = game.i18n.localize(`TCT.GM.Recorder${step}`);
    this.recorderButton.dataset.tooltip = step === "On" ? "" : game.i18n.localize(`TCT.GM.Recorder${step}Hint`);
    const recordings = recorder.recordings;
    const next = recorder.nextIndex;
    this.playButton.hidden =
      !recorder.finished || next >= recordings.length || this.table.gaState().litCandles > 0 || holder !== null;
    this.playButton.disabled = recorder.playing;
    const speaker = game.users.get(recordings[next]?.userId);
    this.playButton.textContent = game.i18n.format("TCT.GM.PlayNext", {
      name: speaker?.character?.name || speaker?.name || "?",
      n: next + 1,
      total: recordings.length
    });
    this.recorderStatus.textContent = holder
      ? game.i18n.format("TCT.GM.RecorderWith", { name: holder.character?.name || holder.name })
      : recorder.finished
        ? game.i18n.format("TCT.GM.RecorderDone", { count: recorder.recordings.length })
        : "";
  }

  statusText(clock) {
    const ritual = this.table.ritual;
    if (!isStarted(clock)) {
      if (ritual.step.writes) return game.i18n.format("TCT.Ritual.Written", ritual.progress);
      return game.i18n.localize("TCT.GM.ClockWaiting");
    }
    const next = nextDeath(clock, this.table.burningCandles());
    if (!next) return "";
    const key = isPaused(clock) ? "TCT.GM.NextCandlePaused" : "TCT.GM.NextCandle";
    return game.i18n.format(key, { time: formatDuration(next.remaining) });
  }
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}
