import { GA_STATE_SETTING, GA_SYSTEM_ID, MODULE_ID, SOCKET } from "./constants.js";
import { SETTINGS } from "./settings.js";

// The Game Assistant is busy for a moment after a conflict; asked again this often, this far apart.
const SETTLE_ATTEMPTS = 10;
const SETTLE_RETRY_MS = 1000;

/**
 * Living a Moment, as the rulebook has it: "When a character is ready to live their Moment, a conflict roll is
 * required. If the roll is successful, hope is inspired. If the roll is unsuccessful, hope is lost."
 *
 * The player asks for it in their sheet; the Game Assistant puts the Moment's card over the bowl. The GM decides
 * whether the moment fits: "Passt – würfeln" starts the player's conflict roll in their browser, "Passt nicht"
 * withdraws the request and the Moment stays in the stack. Once the GM has confirmed the conflict, the GM's browser
 * settles the Moment by its result, through the Game Assistant: success gives the hope die, failure does not.
 *
 * World setting `momentRoll`: {gameId, requestId, actorId, resolutionId} while a Moment's roll is under way.
 */
export class Moments {
  constructor(table) {
    this.table = table;
  }

  start() {
    game.socket.on(SOCKET, (message, senderId) => {
      if (message?.type === "moment-roll") this.rollForMoment(message, senderId);
    });
    document.addEventListener("click", (event) => {
      const button = event.target.closest?.("[data-tct-moment]");
      if (button) this.decide(button.dataset.tctMoment, button.dataset.requestId);
    });
  }

  get inCharge() {
    return game.user === game.users.activeGM;
  }

  /** The Moment whose roll is under way in this game, or null. */
  rolling() {
    const roll = game.settings.get(MODULE_ID, SETTINGS.momentRoll);
    return roll?.requestId && roll.gameId === this.table.gaState().gameId ? roll : null;
  }

  /** The GM's call on a Moment's card: "fit" rolls for it, "unfit" withdraws it. */
  async decide(choice, requestId) {
    if (!this.inCharge || this.rolling()) return;
    const state = this.table.gaState();
    const request = (state.instantRequests ?? []).find((candidate) => candidate.id === requestId);
    if (!request) return;
    if (choice === "unfit") {
      await this.withdraw(state, request);
      return;
    }
    const player = game.users.find((user) => !user.isGM && user.character?.id === request.actorId);
    if (!player?.active) {
      ui.notifications.warn(game.i18n.format("TCT.Moment.PlayerAway", { name: request.actorName }));
      return;
    }
    await game.settings.set(MODULE_ID, SETTINGS.momentRoll, {
      gameId: state.gameId,
      requestId,
      actorId: request.actorId,
      resolutionId: null
    });
    game.socket.emit(SOCKET, { type: "moment-roll", gameId: state.gameId, actorUuid: request.actorUuid }, {
      recipients: [player.id]
    });
  }

  /**
   * The Game Assistant cannot take back a request whose card is out; the GM's browser drops it from the game state,
   * as the Game Assistant does itself when it settles one, and marks its cards so they say what happened.
   */
  async withdraw(state, request) {
    await game.settings.set(GA_SYSTEM_ID, GA_STATE_SETTING, {
      ...state,
      instantRequests: state.instantRequests.filter((candidate) => candidate.id !== request.id),
      updatedAt: Date.now()
    });
    for (const id of request.messageIds ?? []) await game.messages.get(id)?.setFlag(MODULE_ID, "momentUnfit", true);
  }

  /** In the player's browser: the GM confirmed the Moment, so its conflict roll starts as if they had rolled. */
  rollForMoment(message, senderId) {
    if (senderId !== game.users.activeGM?.id || message.gameId !== this.table.gaState().gameId) return;
    game.evilTenCandles?.requestPlayerRoll(message.actorUuid);
  }

  /**
   * In the GM's browser, with every change of the Game Assistant's state: ties the Moment to the conflict rolled for
   * it, and once that conflict is confirmed and the Moment's card is out again, settles the Moment by its result.
   * A conflict called off leaves the Moment open for the GM to decide again.
   */
  async onGaState(state) {
    if (!this.inCharge) return;
    const roll = this.rolling();
    if (!roll) return;
    const request = (state.instantRequests ?? []).find((candidate) => candidate.id === roll.requestId);
    if (!request) {
      await this.clear();
      return;
    }
    if (!roll.resolutionId) {
      if (state.activeResolution?.actorId === roll.actorId) {
        await game.settings.set(MODULE_ID, SETTINGS.momentRoll, { ...roll, resolutionId: state.activeResolution.id });
      }
      return;
    }
    const resolution = state.lastResolution;
    if (state.activeResolution || resolution?.id !== roll.resolutionId) return;
    if (resolution.status === "cancelled") {
      await this.clear();
      return;
    }
    // Only once the Moment's new card is out: settled any earlier, the Game Assistant would post it as withdrawn.
    if (resolution.status !== "resolved" || request.status !== "awaiting" || !request.activeMessageId) return;
    if (this.settling === roll.requestId) return;
    this.settling = roll.requestId;
    try {
      await this.settle(roll, resolution.finalSuccess ? "success" : "failure");
    } finally {
      this.settling = null;
    }
  }

  /**
   * Settles the Moment through the Game Assistant. It turns the request down while it is still finishing the
   * conflict ("Ein Spielübergang läuft bereits"), so this asks again a few times until the Moment is settled.
   */
  async settle(roll, result) {
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
      await new Promise((resolve) => window.setTimeout(resolve, SETTLE_RETRY_MS));
      const request = (this.table.gaState().instantRequests ?? []).find((candidate) => candidate.id === roll.requestId);
      if (!request) break;
      if (await game.evilTenCandles?.requestAction("resolve-instant", { requestId: roll.requestId, result })) break;
    }
    await this.clear();
  }

  clear() {
    return game.settings.set(MODULE_ID, SETTINGS.momentRoll, {});
  }
}

/**
 * A Moment's card as this viewer should see it: the GM gets "Passt – würfeln" and "Passt nicht" instead of the Game
 * Assistant's "fulfilled?" buttons, players only the question; while its roll is under way, the card says that the
 * dice decide. A withdrawn Moment says so.
 */
export function decorateMomentCard(message, html, state) {
  const requestId = message.flags?.[GA_SYSTEM_ID]?.instantRequestId;
  const actions = html.querySelector("[data-instant-actions]");
  const question = html.querySelector(".etc-instant-chat-card > .ets-design2-card__body");
  const t = (key) => foundry.utils.escapeHTML(game.i18n.localize(`TCT.Moment.${key}`));
  if (message.getFlag(MODULE_ID, "momentUnfit")) {
    actions?.remove();
    question?.remove();
    html.querySelector(".etc-instant-chat-status")?.remove();
    html.querySelector(".etc-instant-chat-card")?.insertAdjacentHTML(
      "beforeend",
      `<p class="ets-design2-card__body tct-moment-note">${t("Unfit")}</p>`
    );
    return;
  }
  if (!actions) return;
  const roll = game.settings.get(MODULE_ID, SETTINGS.momentRoll);
  const rolling = roll?.requestId === requestId && roll.gameId === state.gameId;
  if (question) question.textContent = game.i18n.localize(rolling ? "TCT.Moment.Rolling" : "TCT.Moment.Question");
  if (rolling || !game.user.isGM) {
    actions.remove();
    return;
  }
  const button = (choice, icon, label) =>
    `<button type="button" class="ets-design2-action is-instant-${choice === "fit" ? "success" : "failure"}" ` +
    `data-tct-moment="${choice}" data-request-id="${foundry.utils.escapeHTML(requestId ?? "")}">` +
    `<i class="fa-solid ${icon}" aria-hidden="true"></i><span>${t(label)}</span></button>`;
  actions.removeAttribute("data-instant-actions");
  actions.innerHTML = button("fit", "fa-dice", "Fit") + button("unfit", "fa-xmark", "NotFit");
}
