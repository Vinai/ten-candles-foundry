import { isStarted } from "./candle-clock.js";
import { GA_STATE_SETTING, GA_SYSTEM_ID, MODULE_ID } from "./constants.js";
import { decorateMomentCard } from "./moments.js";
import { skull } from "./rolling-dice.js";
import { SETTINGS } from "./settings.js";

/**
 * The Game Assistant's cards and sheets as each person at our table should see them. Its markup is changed only in
 * the rendered copy in this browser; the stored messages and its files stay as they are.
 */

const TRAITS = ["virtue", "vice", "moment"];

export function gaType(message) {
  return message.flags?.[GA_SYSTEM_ID]?.type ?? null;
}

/**
 * A roll before "Licht aus" only tries the dice, e.g. whether everyone hears them: the GM calls the conflict off and
 * nobody sees its card. Marked by the GM; until then, every conflict card before "Licht aus" counts as one.
 */
export function isPractice(message, state) {
  if (gaType(message) !== "resolution") return false;
  if (message.getFlag(MODULE_ID, "practice")) return true;
  const clock = game.settings.get(MODULE_ID, SETTINGS.candleClock);
  return !(clock?.gameId === state.gameId && isStarted(clock));
}

/** Whether a trait card is still in the stack: not burned, or for the Moment, not yet lived. */
export function unburned(system, key) {
  if (key === "moment") return !system.momentAttempted;
  return Boolean(system[key]?.available);
}

/**
 * The card on top of a character's stack, the only one in play (rulebook: "only the top card of each stack is
 * active"). The order is the one the player arranged; null once only the Brink is left.
 */
export function topCard(system) {
  return [...(system?.resourceOrderList ?? [])].find((key) => TRAITS.includes(key) && unburned(system, key)) ?? null;
}

/**
 * @param message {ChatMessage}
 * @param html {HTMLElement} the rendered message, changed in place
 * @param state {object} the Game Assistant's collective state
 */
export function decorateCard(message, html, state) {
  if (isPractice(message, state)) {
    html.classList.add("tct-hidden");
    return;
  }
  switch (gaType(message)) {
    case "resolution":
      return decorateConflict(message, html);
    case "ball-of-truths":
      return decorateTruths(html, state);
    case "character-departure":
      // A death in the last scene is the player's to narrate, not a farewell text picked at random; candles and dice
      // are on the table already.
      html.querySelector(".ets-departure-card__message")?.remove();
      html.querySelector(".ets-collective-state-band")?.remove();
      return;
    case "instant":
      return decorateMomentCard(message, html, state);
    case "darkness-progression":
      // The table's own truths card says what remains; this one is the GM's note in the chat.
      if (!game.user.isGM) html.classList.add("tct-hidden");
      return;
  }
}

function decorateConflict(message, html) {
  // Candles and dice are on the table already; the card has no room to spare over the bowl.
  html.querySelector(".ets-collective-state-band")?.remove();
  // A rolled 1 costs a die: a skull instead of the number.
  for (const die of html.querySelectorAll(".ets-die.is-danger")) die.innerHTML = skull();
  // "… muss den Konflikt noch bestätigen." and "Das Ergebnis bleibt vorläufig …" say what everyone knows and make the
  // card too tall.
  html.querySelector(":is(.is-provisional-failure, .is-provisional-success) .ets-conflict-result__note")?.remove();
  // Until the GM rolls, players see the GM's dice still to come as question marks, where the GM sees the roll button.
  const waiting = game.user.isGM ? null : html.querySelector(".ets-conflict-gm-reserved-space .is-sizer");
  if (waiting) {
    waiting.classList.add("tct-gm-dice-waiting");
    for (const die of waiting.children) die.textContent = "?";
  }
  gmNarratesOnTies(html);
  // Only the card on top of the stack can be burned for a reroll.
  const actor = game.actors.get(message.speaker?.actor);
  if (!actor) return;
  const top = topCard(actor.system);
  for (const [key, selector] of [
    ["virtue", ".ets-conflict-resource-action.is-virtue"],
    ["vice", ".ets-conflict-resource-action.is-vice"]
  ]) {
    if (key !== top) html.querySelector(selector)?.remove();
  }
  const actions = html.querySelector(".ets-conflict-resource-actions");
  if (actions && !actions.querySelector("button")) {
    actions.remove();
    html.querySelector(".ets-conflict-player-row")?.classList.remove("has-actions");
  }
  // A failure is only provisional while the player can still reroll: 1s and an unused top card, or the Brink.
  const failure = html.querySelector(".is-provisional-failure .ets-conflict-result__heading strong");
  if (failure && !html.querySelector(".ets-conflict-resource-action:not([disabled])")) {
    failure.textContent = game.i18n.localize("TCT.Conflict.Failure");
  }
}

/**
 * "When determining the winner of narration rights, ties always break in favor of the GM" (rulebook). The Game
 * Assistant gives ties to the player; counted from the dice on the card, a tie names the GM here. A narration the
 * player seized stays theirs.
 */
function gmNarratesOnTies(html) {
  const sixes = (selector) => [...html.querySelectorAll(selector)].filter((die) => die.textContent.trim() === "6").length;
  const player = sixes(".ets-conflict-pool.is-player .ets-die");
  const gm = sixes(".ets-conflict-pool.is-gm .ets-dice-row:not(.is-sizer) .ets-die");
  if (gm !== player) return;
  const provisional = html.querySelector(".is-provisional-success .ets-conflict-result__main");
  if (provisional) provisional.textContent = game.i18n.localize("ETC.Chat.ProvisionalGMNarrates");
  const final = html.querySelector(".ets-conflict-result.is-success.is-final");
  if (final && !final.querySelector(".ets-conflict-result__note")) {
    final.querySelector(".ets-conflict-result__main").textContent = game.i18n.localize("ETC.Chat.FinalGMNarrates");
  }
}

/**
 * Players learn only how many truths are to be spoken. The GM gets the instruction and the button, with the candles
 * and dice of the coming scene: the candle is already out on the table.
 */
function decorateTruths(html, state) {
  if (!game.user.isGM) {
    html.querySelector(".ets-collective-state-band")?.remove();
    html.querySelector(".ets-design2-card__body")?.remove();
    html.querySelector(".ets-design2-card__header p")?.remove();
    return;
  }
  const card = html.querySelector(".ets-ball-card");
  if (!card || card.classList.contains("is-completed") || state.stage !== "ball-of-truths") return;
  const next = Math.max(state.litCandles - 1, 0);
  for (const value of html.querySelectorAll(".ets-collective-state-band strong")) value.textContent = String(next);
}

/**
 * Every Game Assistant card, in the chat and over the bowl, as this viewer should see it. Registered before the chat
 * log is first drawn, so cards from before a reload are covered too.
 */
export function decorateCards() {
  Hooks.on("renderChatMessageHTML", (message, html) => {
    if (!gaType(message)) return;
    // Marks them so the styles keep them out of Foundry's chat pop-ups; the bowl shows them already.
    if (!game.settings.get(MODULE_ID, SETTINGS.plainTable)) html.classList.add("tct-ga-card");
    decorateCard(message, html, game.settings.get(GA_SYSTEM_ID, GA_STATE_SETTING));
  });
}
