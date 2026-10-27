import { GA_STATE_SETTING, GA_SYSTEM_ID, MODULE_ID, SOCKET } from "./constants.js";
import { SETTINGS } from "./settings.js";

// The Game Assistant is busy for a moment after a conflict; asked again this often, this far apart.
const SETTLE_ATTEMPTS = 10;
const SETTLE_RETRY_MS = 1000;
// A roll the GM asked for that has not started a conflict by then (refused, or the player reloaded) is given up.
const ROLL_START_MS = 15_000;

/**
 * Living a Moment, as the rulebook has it: "When a character is ready to live their Moment, a conflict roll is
 * required. If the roll is successful, hope is inspired. If the roll is unsuccessful, hope is lost."
 *
 * The player asks for it in their sheet; the Game Assistant puts the Moment's card over the bowl. The GM decides
 * whether the moment fits: "Passt – würfeln" starts the player's conflict roll in their browser, "Passt nicht"
 * withdraws the request and the Moment stays in the stack. Once the GM has confirmed the conflict, the GM's browser
 * settles the Moment by its result, through the Game Assistant: success gives the hope die, failure does not.
 *
 * World setting `momentRoll`: {gameId, requestId, actorId, at, resolutionId, result} while a Moment's roll is under
 * way; `result` ("success" or "failure") once its conflict is confirmed, until the Moment is settled by it.
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
    // After a reload of the GM's browser: a roll asked for still waits to start, or a confirmed one to be settled.
    const roll = this.rolling();
    if (roll && !roll.resolutionId) window.setTimeout(() => this.giveUpUnstarted(), ROLL_START_MS + 100);
    this.onGaState(this.table.gaState());
  }

  get inCharge() {
    return game.user === game.users.activeGM;
  }

  /** The Moment whose roll is under way in this game, or null. */
  rolling() {
    const roll = game.settings.get(MODULE_ID, SETTINGS.momentRoll);
    return roll?.requestId && roll.gameId === this.table.gaState().gameId ? roll : null;
  }

  /**
   * The GM's call on a Moment's card: "fit" rolls for it, "unfit" withdraws it. "Unfit" still works while the roll
   * asked for has not started; "fit" only when a roll can start now: in a scene, with dice, no other conflict open.
   */
  async decide(choice, requestId) {
    if (!this.inCharge) return;
    const roll = this.rolling();
    if (roll && (choice === "fit" || roll.resolutionId)) return;
    const state = this.table.gaState();
    const request = (state.instantRequests ?? []).find((candidate) => candidate.id === requestId);
    if (!request) return;
    if (choice === "unfit") {
      if (roll) await this.clear();
      if (this.inCharge) await this.withdraw(requestId);
      return;
    }
    if (state.stage !== "scene" || state.activeResolution || !(state.bluePoolRemaining > 0)) {
      ui.notifications.warn(game.i18n.localize("TCT.Moment.NotNow"));
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
      at: Date.now(),
      resolutionId: null
    });
    game.socket.emit(SOCKET, { type: "moment-roll", gameId: state.gameId, actorUuid: request.actorUuid }, {
      recipients: [player.id]
    });
    window.setTimeout(() => this.giveUpUnstarted(), ROLL_START_MS + 100);
  }

  /** The roll asked for never started a conflict: the Moment is the GM's to decide again. */
  async giveUpUnstarted() {
    const roll = this.rolling();
    if (!this.inCharge || !roll || roll.resolutionId || Date.now() - (roll.at ?? 0) < ROLL_START_MS) return;
    if (this.table.gaState().activeResolution?.actorId === roll.actorId) return;
    await this.clear();
    ui.notifications.warn(game.i18n.localize("TCT.Moment.RollDidNotStart"));
  }

  /**
   * The Game Assistant cannot take back a request whose card is out; the GM's browser drops it from the game state,
   * as the Game Assistant does itself when it settles one, and marks its cards so they say what happened.
   */
  async withdraw(requestId) {
    // Read just before writing, so that nothing the game did meanwhile is undone.
    const state = this.table.gaState();
    const request = (state.instantRequests ?? []).find((candidate) => candidate.id === requestId);
    if (!request) return;
    await game.settings.set(GA_SYSTEM_ID, GA_STATE_SETTING, {
      ...state,
      instantRequests: state.instantRequests.filter((candidate) => candidate.id !== request.id),
      updatedAt: Date.now()
    });
    for (const id of request.messageIds ?? []) await game.messages.get(id)?.setFlag(MODULE_ID, "momentUnfit", true);
  }

  /**
   * The dead live no Moment: a request of theirs (sent before their sheet knew) is taken back with its card. Only once
   * the Game Assistant has published it; taken back any earlier, its own next save would bring it back.
   */
  async withdrawFromTheDead() {
    const state = this.table.gaState();
    const request = (state.instantRequests ?? []).find((candidate) => {
      const owner = game.users.find((user) => !user.isGM && user.character?.id === candidate.actorId);
      return this.table.deaths.isDead(owner);
    });
    if (!request || request.status !== "awaiting" || !request.activeMessageId || this.withdrawing) return;
    this.withdrawing = true;
    try {
      await game.settings.set(GA_SYSTEM_ID, GA_STATE_SETTING, {
        ...state,
        instantRequests: state.instantRequests.filter((candidate) => candidate.id !== request.id),
        updatedAt: Date.now()
      });
      for (const id of request.messageIds ?? []) await game.messages.get(id)?.delete();
    } finally {
      this.withdrawing = false;
    }
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
    await this.withdrawFromTheDead();
    let roll = this.rolling();
    if (!roll) return;
    const request = (state.instantRequests ?? []).find((candidate) => candidate.id === roll.requestId);
    if (!request) {
      await this.clear();
      return;
    }
    if (!roll.resolutionId) {
      // Only a conflict of this character started after the GM's call is the Moment's roll.
      const active = state.activeResolution;
      if (active?.actorId === roll.actorId && (active.createdAt ?? 0) >= (roll.at ?? 0)) {
        await game.settings.set(MODULE_ID, SETTINGS.momentRoll, { ...roll, resolutionId: active.id });
      } else await this.giveUpUnstarted();
      return;
    }
    if (!roll.result) {
      const resolution = state.lastResolution;
      if (state.activeResolution || resolution?.id !== roll.resolutionId) return;
      if (resolution.status === "cancelled") {
        await this.clear();
        return;
      }
      if (resolution.status !== "resolved") return;
      // Kept, so the Moment is settled by it even after the next conflict has replaced it in the game state.
      roll = { ...roll, result: resolution.finalSuccess ? "success" : "failure" };
      await game.settings.set(MODULE_ID, SETTINGS.momentRoll, roll);
    }
    // Only once the Moment's new card is out: settled any earlier, the Game Assistant would post it as withdrawn.
    if (state.activeResolution || request.status !== "awaiting" || !request.activeMessageId) return;
    if (this.settling === roll.requestId) return;
    this.settling = roll.requestId;
    try {
      await this.settle(roll, request);
    } finally {
      this.settling = null;
    }
  }

  /**
   * Settles the Moment through the Game Assistant. It turns the request down while it is still finishing the
   * conflict ("Ein Spielübergang läuft bereits"), so this asks again a few times until the Moment is settled. Held
   * back by a new conflict, or still turned down after that, the result is kept and the next change of the game
   * state tries again.
   */
  async settle(roll, { actorName }) {
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
      await new Promise((resolve) => window.setTimeout(resolve, SETTLE_RETRY_MS));
      if (!this.inCharge || this.rolling()?.requestId !== roll.requestId) return;
      const request = (this.table.gaState().instantRequests ?? []).find((candidate) => candidate.id === roll.requestId);
      if (!request) return this.clear();
      if (request.status !== "awaiting") return;
      const settled = await game.evilTenCandles?.requestAction("resolve-instant", {
        requestId: roll.requestId,
        result: roll.result
      });
      if (settled) return this.clear();
    }
    ui.notifications.warn(game.i18n.format("TCT.Moment.NotSettled", { name: actorName }));
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
  // Until the roll has started, the GM can still take the call back.
  if (!game.user.isGM || (rolling && roll.resolutionId)) {
    actions.remove();
    return;
  }
  const button = (choice, icon, label) =>
    `<button type="button" class="ets-design2-action is-instant-${choice === "fit" ? "success" : "failure"}" ` +
    `data-tct-moment="${choice}" data-request-id="${foundry.utils.escapeHTML(requestId ?? "")}">` +
    `<i class="fa-solid ${icon}" aria-hidden="true"></i><span>${t(label)}</span></button>`;
  actions.removeAttribute("data-instant-actions");
  actions.innerHTML = (rolling ? "" : button("fit", "fa-dice", "Fit")) + button("unfit", "fa-xmark", "NotFit");
}
