import { createClock, isPaused, isStarted, nextDeath, pause, resume, start } from "./candle-clock.js";
import { GA_STATE_SETTING, GA_SYSTEM_ID, MODULE_ID, TOTAL_CANDLES } from "./constants.js";
import { SETTINGS } from "./settings.js";

const TICK_MS = 1000;

/**
 * The GM's side of the table: room lights, the candle clock and the draught, plus burning candles out when their
 * time has come. Only the active GM's browser changes game state.
 */
export class GMControls {
  constructor(table) {
    this.table = table;
    this.panel = document.createElement("div");
    this.panel.className = "tct-gm-panel";
    this.ritualButton = this.button(() => this.nextRitualStep());
    this.lightsButton = this.button(() => this.toggleLights());
    this.pauseButton = this.button(() => this.togglePause());
    this.draughtButton = this.button(() => this.draught(), "TCT.GM.Draught");
    this.draughtButton.dataset.tooltip = game.i18n.localize("TCT.GM.DraughtHint");
    this.status = document.createElement("div");
    this.status.className = "tct-gm-status";
    this.panel.append(this.ritualButton, this.lightsButton, this.pauseButton, this.draughtButton, this.status);
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

  get lightsOut() {
    return game.settings.get(MODULE_ID, SETTINGS.lightsOut);
  }

  async toggleLights() {
    const lightsOut = !this.lightsOut;
    // The candles start burning down the first time the lights go out.
    if (lightsOut && !isStarted(this.table.clock())) await this.saveClock(start(this.table.clock() ?? this.newClock()));
    await game.settings.set(MODULE_ID, SETTINGS.lightsOut, lightsOut);
  }

  async nextRitualStep() {
    this.ritualButton.disabled = true;
    try {
      await this.table.ritual.next();
    } finally {
      this.ritualButton.disabled = false;
      this.render();
    }
  }

  async togglePause() {
    const clock = this.table.clock();
    if (!isStarted(clock)) return;
    await this.saveClock(isPaused(clock) ? resume(clock) : pause(clock));
  }

  async draught() {
    if (!(await this.darkenCandle())) ui.notifications.info(game.i18n.localize("TCT.GM.DraughtWaits"));
  }

  newClock() {
    return { ...createClock(TOTAL_CANDLES), gameId: this.table.gaState().gameId };
  }

  saveClock(clock) {
    return game.settings.set(MODULE_ID, SETTINGS.candleClock, clock);
  }

  tick() {
    this.render();
    if (game.user !== game.users.activeGM) return;
    const clock = this.table.clock();
    if (!isStarted(clock) || isPaused(clock)) return;
    const next = nextDeath(clock, this.table.gaState().litCandles);
    if (next && next.remaining <= 0) this.darkenCandle();
  }

  /**
   * A candle going out on its own ends the scene like a failed conflict: one candle fewer, the dice pool refilled.
   * Waits while a conflict or the truths are under way; the candle keeps guttering until then.
   */
  async darkenCandle() {
    const state = this.table.gaState();
    if (this.darkening || state.stage !== "scene" || state.activeResolution || state.litCandles <= 0) return false;
    this.darkening = true;
    try {
      const litCandles = state.litCandles - 1;
      await game.settings.set(GA_SYSTEM_ID, GA_STATE_SETTING, {
        ...state,
        litCandles,
        bluePoolRemaining: litCandles,
        updatedAt: Date.now()
      });
      return true;
    } finally {
      this.darkening = false;
    }
  }

  render() {
    const clock = this.table.clock();
    const ritual = this.table.ritual;
    this.ritualButton.hidden = !ritual.nextLabel || isStarted(clock);
    this.ritualButton.textContent = ritual.nextLabel ?? "";
    this.lightsButton.textContent = game.i18n.localize(this.lightsOut ? "TCT.GM.LightsOn" : "TCT.GM.LightsOut");
    this.pauseButton.textContent = game.i18n.localize(isPaused(clock) ? "TCT.GM.Resume" : "TCT.GM.Pause");
    this.pauseButton.disabled = !isStarted(clock);
    this.draughtButton.disabled = !isStarted(clock) || this.table.gaState().litCandles <= 0;

    this.status.textContent = this.statusText(clock);
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
