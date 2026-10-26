import { GA_STATE_SETTING, GA_SYSTEM_ID, MODULE_ID } from "./constants.js";
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
  switch (gaType(message)) {
    case "resolution":
      return decorateConflict(message, html);
    case "ball-of-truths":
      return decorateTruths(html, state);
    case "darkness-progression":
      // The table's own truths card says what remains; this one is the GM's note in the chat.
      if (!game.user.isGM) html.classList.add("tct-hidden");
      return;
  }
}

function decorateConflict(message, html) {
  // A rolled 1 costs a die: a skull instead of the number.
  for (const die of html.querySelectorAll(".ets-die.is-danger")) die.innerHTML = skull();
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
