import { createClock, isPaused, isStarted, nextDeath, pause, resume, start } from "./candle-clock.js";
import { GA_STATE_SETTING, GA_SYSTEM_ID, MODULE_ID, TOTAL_CANDLES } from "./constants.js";
import { SETTINGS } from "./settings.js";

const TICK_MS = 1000;
// For this long after the module put a candle out, a Game Assistant write that brings it back is undone.
const DARKEN_GUARD_MS = 10_000;

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
    this.lightsButton = this.button(() => this.toggleLights());
    this.pauseButton = this.button(() => this.togglePause());
    this.draughtButton = this.button(() => this.draught(), "TCT.GM.Draught");
    this.draughtButton.dataset.tooltip = game.i18n.localize("TCT.GM.DraughtHint");
    this.aliveButton = this.button(() => this.table.sayAlive(), "TCT.GM.Alive");
    this.aliveButton.dataset.tooltip = game.i18n.localize("TCT.GM.AliveHint");
    this.recorderButton = this.button(() => this.recorderStep());
    this.playButton = this.button(() => this.table.recorder.play(), "TCT.GM.PlayRecordings");
    this.status = document.createElement("div");
    this.status.className = "tct-gm-status";
    this.recorderStatus = document.createElement("div");
    this.recorderStatus.className = "tct-gm-status";
    this.panel.append(
      this.seatsButton,
      this.ritualButton,
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
      else await recorder.skip();
    } finally {
      this.recorderButton.disabled = false;
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
    const busy = state.stage !== "scene" || state.activeResolution || this.table.truths.active;
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
    const darkened = this.darkened;
    if (!this.inCharge || !darkened || Date.now() > darkened.until) return;
    if (state.gameId !== darkened.gameId || state.stage !== "scene" || state.activeResolution) {
      this.darkened = null;
      return;
    }
    if (state.litCandles > darkened.litCandles) this.writeCandles(state, darkened.litCandles);
  }

  render() {
    this.panel.hidden = !this.inCharge;
    const clock = this.table.clock();
    const ritual = this.table.ritual;
    this.ritualButton.hidden = !ritual.nextLabel || isStarted(clock);
    // Settled during character creation: the cards were passed along this order.
    this.seatsButton.hidden = isStarted(clock);
    this.ritualButton.textContent = ritual.nextLabel ?? "";
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

  /** The recorder goes round once the lights are out; its messages are played after the last candle. */
  renderRecorder(clock) {
    const recorder = this.table.recorder;
    const holder = recorder.holder;
    this.recorderButton.hidden = !isStarted(clock) || recorder.finished;
    this.recorderButton.textContent = game.i18n.localize(recorder.unused ? "TCT.GM.RecorderOn" : "TCT.GM.RecorderSkip");
    this.recorderButton.dataset.tooltip = recorder.unused ? "" : game.i18n.localize("TCT.GM.RecorderSkipHint");
    this.playButton.hidden = !recorder.finished || !recorder.recordings.length || this.table.gaState().litCandles > 0;
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
