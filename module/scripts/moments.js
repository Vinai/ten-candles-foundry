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
 * whether the moment fits: "Passt – würfeln" burns the Moment's card in the bowl and starts the player's conflict roll
 * in their browser (`momentBurnedFor`); "Passt nicht" withdraws the request and the Moment stays in the stack. Once the
 * GM has confirmed the conflict, the GM's browser settles the Moment by its result, through the Game Assistant: success
 * gives the hope die, failure does not.
 *
 * World setting `momentRoll`: {gameId, requestId, actorId, at, resolutionId, result} while a Moment's roll is under
 * way; `result` ("success" or "failure") once its conflict is confirmed, until the Moment is settled by it.
 */
export class Moments {
  constructor(table) {
    this.table = table;
    // Requests the GM turned down. A roll of the Game Assistant under way when that happened brings one back with
    // its next save; it is taken back again. Their cards say so too, for a browser that takes over (`wasRejected`).
    this.rejected = new Set();
    this.reconciling = Promise.resolve();
  }

  start() {
    game.socket.on(SOCKET, (message, senderId) => {
      if (message?.type === "moment-roll") this.rollForMoment(message, senderId);
    });
    document.addEventListener("click", (event) => {
      const button = event.target.closest?.("[data-tct-moment]");
      if (button) this.decide(button.dataset.tctMoment, button.dataset.requestId);
    });
    // Another GM's browser takes over when the active GM leaves.
    Hooks.on("userConnected", () => this.resume());
    this.resume();
  }

  /**
   * After a reload, or when this browser has just become the active GM's: a roll asked for still waits to start, or
   * a confirmed one to be settled.
   */
  resume() {
    if (!this.inCharge) return;
    const roll = this.rolling();
    if (roll && !roll.resolutionId) window.setTimeout(() => this.giveUpUnstarted(), ROLL_START_MS + 100);
    this.onGaState();
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
    const own = roll?.requestId === requestId;
    if (roll && (choice === "fit" || (own && roll.resolutionId))) return;
    const state = this.table.gaState();
    const request = (state.instantRequests ?? []).find((candidate) => candidate.id === requestId);
    if (!request) return;
    // Its roll has started (a Game Assistant that knows Moment rolls says so before this browser has linked it): the
    // Moment is burned and stays in play.
    const started = request.momentRollResolutionId || state.activeResolution?.momentRequestId === requestId;
    if (choice === "unfit" && started) return;
    if (choice === "unfit") {
      this.rejected.add(requestId);
      if (own) await this.clear(requestId);
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
    const message = { type: "moment-roll", gameId: state.gameId, actorUuid: request.actorUuid, requestId };
    game.socket.emit(SOCKET, message, {
      recipients: [player.id]
    });
    window.setTimeout(() => this.giveUpUnstarted(), ROLL_START_MS + 100);
  }

  /** The roll asked for never started a conflict: the Moment is the GM's to decide again. */
  async giveUpUnstarted() {
    const roll = this.rolling();
    if (!this.inCharge || !roll || roll.resolutionId || Date.now() - (roll.at ?? 0) < ROLL_START_MS) return;
    if (this.table.gaState().activeResolution?.actorId === roll.actorId) return;
    await this.clear(roll.requestId);
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

  /**
   * A request the GM turned down that a roll of the Game Assistant brought back. Only once it is out again: taken
   * back any earlier, the Game Assistant's next save would bring it back once more.
   */
  async withdrawRejected() {
    const request = (this.table.gaState().instantRequests ?? []).find(
      (candidate) => candidate.status === "awaiting" && candidate.activeMessageId && this.wasRejected(candidate.id)
    );
    if (request) await this.withdraw(request.id);
  }

  /** Whether the GM turned this request down: in this browser, or in one before it that marked its cards. */
  wasRejected(requestId) {
    if (this.rejected.has(requestId)) return true;
    return game.messages.contents.some(
      (message) =>
        message.flags?.[GA_SYSTEM_ID]?.instantRequestId === requestId && message.getFlag(MODULE_ID, "momentUnfit")
    );
  }

  /** In the player's browser: the GM confirmed the Moment, so its conflict roll starts as if they had rolled. */
  rollForMoment(message, senderId) {
    if (senderId !== game.users.activeGM?.id || message.gameId !== this.table.gaState().gameId) return;
    // Declared as the Moment's roll, so a Game Assistant that knows Moment rolls opens the Brink for it; one that does
    // not ignores the option.
    game.evilTenCandles?.requestPlayerRoll(message.actorUuid, { momentRequestId: message.requestId ?? null });
  }

  /**
   * In the GM's browser, with every change of the Game Assistant's state: ties the Moment to the conflict rolled for
   * it, and once that conflict is confirmed and the Moment's card is out again, settles the Moment by its result.
   * A conflict called off leaves the Moment open for the GM to decide again.
   *
   * One at a time, each with the state as it is once the withdrawals before it are done: one that had to wait must
   * not decide by a state that has moved on, e.g. clear a Moment the GM has just let roll.
   */
  onGaState() {
    this.reconciling = this.reconciling
      .then(() => this.reconcile())
      .catch((error) => console.error(`${MODULE_ID} | Moments`, error));
    return this.reconciling;
  }

  async reconcile() {
    if (!this.inCharge) return;
    await this.withdrawFromTheDead();
    await this.withdrawRejected();
    if (!this.inCharge) return;
    const state = this.table.gaState();
    let roll = this.rolling();
    if (!roll) return;
    const request = (state.instantRequests ?? []).find((candidate) => candidate.id === roll.requestId);
    if (!request) {
      await this.clear(roll.requestId);
      return;
    }
    if (!roll.resolutionId) {
      // The Moment's roll: the conflict the Game Assistant declared for this request, where it does; else a conflict
      // of this character started after the GM's call.
      const active = state.activeResolution;
      const declared = active?.momentRequestId === roll.requestId;
      const sameActor = active?.actorId === roll.actorId && (active.createdAt ?? 0) >= (roll.at ?? 0);
      if (declared || (!active?.momentRequestId && sameActor)) {
        await game.settings.set(MODULE_ID, SETTINGS.momentRoll, { ...roll, resolutionId: active.id });
      } else await this.giveUpUnstarted();
      return;
    }
    if (!roll.result) {
      const resolution = state.lastResolution;
      if (state.activeResolution || resolution?.id !== roll.resolutionId) return;
      if (resolution.status === "cancelled") {
        await this.clear(roll.requestId);
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
    // Not waited for: the next state changes are looked at meanwhile.
    this.settling = roll.requestId;
    this.settle(roll, request)
      .catch((error) => console.error(`${MODULE_ID} | Moments`, error))
      .finally(() => (this.settling = null));
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
      if (!request) return this.clear(roll.requestId);
      if (request.status !== "awaiting") return;
      const settled = await game.evilTenCandles?.requestAction("resolve-instant", {
        requestId: roll.requestId,
        result: roll.result
      });
      if (settled) return this.clear(roll.requestId);
    }
    ui.notifications.warn(game.i18n.format("TCT.Moment.NotSettled", { name: actorName }));
  }

  /** The roll for this request is over; one asked for meanwhile for another request stays. */
  async clear(requestId) {
    if (!this.inCharge || game.settings.get(MODULE_ID, SETTINGS.momentRoll)?.requestId !== requestId) return;
    await game.settings.set(MODULE_ID, SETTINGS.momentRoll, {});
  }
}

/**
 * Whether this character's Moment is burned for a roll under way: "Once this has been declared, but before rolling
 * dice, burn your Moment. This could open up a Trait or Brink for use in the conflict." (rulebook). From the GM's
 * "Passt – würfeln" until the Moment is settled, the card is off the stack and the one beneath it is on top.
 */
export function momentBurnedFor(actor) {
  const roll = game.settings.get(MODULE_ID, SETTINGS.momentRoll);
  const gameId = game.settings.get(GA_SYSTEM_ID, GA_STATE_SETTING)?.gameId;
  return Boolean(actor && roll?.requestId && roll.gameId === gameId && roll.actorId === actor.id);
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
