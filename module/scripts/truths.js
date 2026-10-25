import { MODULE_ID } from "./constants.js";
import { SETTINGS } from "./settings.js";

/**
 * Establishing truths, as the rulebook has it: after a candle goes out the GM says "These things are true. The world
 * is dark.", then the table speaks one truth each, clockwise, as many as candles still burn. The player whose failure
 * (or seized narration) put the candle out begins, otherwise the GM. The last truth is "And we are alive.", spoken by
 * all players together. No dice are rolled until then.
 *
 * World setting `truths`: {gameId, candles, first} while the truths are spoken, written by the active GM.
 */
export class Truths {
  constructor(table) {
    this.table = table;
  }

  /** The truths being spoken in this game, or null. */
  current() {
    const state = game.settings.get(MODULE_ID, SETTINGS.truths);
    return state?.gameId && state.gameId === this.table.gaState().gameId && state.candles > 0 ? state : null;
  }

  get active() {
    return Boolean(this.current());
  }

  /** A candle went out and `candles` still burn. */
  begin(candles, first) {
    if (game.user !== game.users.activeGM) return;
    const gameId = this.table.gaState().gameId;
    return game.settings.set(MODULE_ID, SETTINGS.truths, candles > 0 ? { gameId, candles, first: first.id } : {});
  }

  /** "And we are alive." The next scene begins. */
  end() {
    if (game.user !== game.users.activeGM || !this.active) return;
    return game.settings.set(MODULE_ID, SETTINGS.truths, {});
  }

  /** Who speaks which truth: clockwise from the first speaker, the last one spoken by all players. */
  speakers({ candles, first }) {
    const users = this.table.users;
    const start = Math.max(users.findIndex((user) => user.id === first), 0);
    return Array.from({ length: candles - 1 }, (_, i) => users[(start + i) % users.length]);
  }

  /** The card over the bowl: the number of truths for the players, the whole order for the GM. */
  card() {
    const truths = this.current();
    if (!truths) return null;
    const t = (key, data) => foundry.utils.escapeHTML(game.i18n.format(`TCT.Truths.${key}`, data ?? {}));
    const card = document.createElement("article");
    card.className = "tct-truths-card";
    const count = truths.candles === 1 ? t("One") : t("Many", { count: truths.candles });
    if (!game.user.isGM) {
      card.innerHTML = `<h3>${t("Title")}</h3><p class="tct-truths-count">${count}</p>`;
      return card;
    }
    const items = this.speakers(truths).map(
      (user, i) => `<li>${t("Truth", { n: i + 1, name: user.character?.name || user.name })}</li>`
    );
    items.push(`<li class="is-alive">${t("Alive", { n: truths.candles })}</li>`);
    const left = truths.candles === 1 ? t("CandleLeft") : t("CandlesLeft", { count: truths.candles });
    card.innerHTML =
      `<h3>${t("Title")}</h3><p class="tct-truths-left">${left}</p>` +
      `<p class="tct-truths-opening">${t("Opening")}</p><ul class="tct-truths-list">${items.join("")}</ul>`;
    return card;
  }
}
