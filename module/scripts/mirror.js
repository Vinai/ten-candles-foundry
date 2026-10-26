import { gaType, isPractice } from "./ga-cards.js";

// How long a card stays above the bowl after its last change once nothing in the game still needs it.
const LINGER_MS = 20000;
// Cards of a conflict and its truths go as soon as the game is done with them; the table shows what follows.
const NO_LINGER = new Set(["resolution", "ball-of-truths", "darkness-progression"]);
// What the game waits on most: an open conflict before a Moment to decide, before the truths.
const PRECEDENCE = ["resolution", "instant", "ball-of-truths"];

/**
 * The Game Assistant's latest chat card (conflict, Moment, truths, …) lies above the bowl in a pool of light, so
 * nobody needs the chat. It is the real message rendered once more: the Game Assistant wires up its buttons itself.
 * While the players work out their concepts, the GM finds what to ask of them there. While the truths are spoken,
 * the table's own truths card lies there instead (the GM keeps the Game Assistant's card while it still has a button
 * to press). The table can hold it back while dice roll or a card burns.
 */
export class ConflictMirror {
  constructor(table, element) {
    this.table = table;
    this.element = element;
    this.messageId = null;
    this.touchedAt = 0;
    this.holds = new Set();
  }

  start() {
    // After a reload, bring back whatever the game is still waiting on.
    this.messageId = this.waitedOn(this.table.gaState())?.id ?? null;
    Hooks.on("createChatMessage", (message) => this.touch(message));
    Hooks.on("updateChatMessage", (message) => this.update(message));
    Hooks.on("deleteChatMessage", (message) => message.id === this.messageId && this.render());
    this.render();
  }

  /**
   * Keeps the bowl clear until the hold is released; several can hold at once. `slow` lets the card fade out the
   * slow way. @returns the hold, to release it with
   */
  hold({ slow = false } = {}) {
    const hold = Symbol("hold");
    this.holds.add(hold);
    this.element.classList.toggle("is-slow", slow);
    this.render();
    return hold;
  }

  release(hold) {
    this.holds.delete(hold);
    if (!this.holds.size) this.element.classList.remove("is-slow");
    this.render();
  }

  /** A new game: nothing of the old one holds the bowl any more. */
  releaseAll() {
    this.holds.clear();
    this.element.classList.remove("is-slow");
    this.render();
  }

  touch(message) {
    if (!gaType(message) || !message.visible) return;
    // A card the game is waiting on stays, e.g. the truths over the late update of the conflict that failed.
    const state = this.table.gaState();
    const current = game.messages.get(this.messageId);
    if (current && current !== message && this.pinned(current, state) && !this.pinned(message, state)) return;
    this.messageId = message.id;
    this.touchedAt = Date.now();
    this.render();
    window.clearTimeout(this.lingerTimer);
    this.lingerTimer = window.setTimeout(() => this.render(), LINGER_MS + 100);
  }

  /**
   * The Game Assistant keeps updating its cards, e.g. the last conflict's candle count when a candle burns out.
   * That keeps a card up while it is showing, but does not bring back one that has gone.
   */
  update(message) {
    const showing = message.id === this.messageId && this.element.classList.contains("is-visible");
    if (showing || this.pinned(message, this.table.gaState())) this.touch(message);
  }

  /** Whether the game is still waiting on this card, however long ago it changed. */
  pinned(message, state) {
    switch (gaType(message)) {
      case "resolution":
        return Boolean(state.activeResolution) && state.activeResolution.chatMessageId === message.id;
      case "ball-of-truths":
        return state.stage === "ball-of-truths";
      case "instant":
        return (state.instantRequests ?? []).some((request) => request.messageIds?.includes(message.id));
      default:
        return false;
    }
  }

  /** The card the game still waits on most, if any. */
  waitedOn(state) {
    const waiting = game.messages.contents.filter((m) => gaType(m) && m.visible && this.pinned(m, state));
    const rank = (message) => PRECEDENCE.indexOf(gaType(message));
    return waiting.sort((a, b) => rank(a) - rank(b))[0] ?? null;
  }

  /** What lies over the bowl right now: a rendered element, or null for nothing. */
  async content() {
    const concepts = this.table.ritual.conceptsCard();
    if (concepts) return concepts;
    const state = this.table.gaState();
    let message = game.messages.get(this.messageId);
    // Once this card is settled, another one may still be waiting, e.g. an earlier Moment.
    if (!message || !this.pinned(message, state)) {
      const waiting = this.waitedOn(state);
      if (waiting) {
        message = waiting;
        this.messageId = waiting.id;
      }
    }
    if (message && isPractice(message, state)) message = null;
    const pinned = message && this.pinned(message, state);
    // The GM presses the Game Assistant's button before the truths; everyone else sees the table's truths card.
    if (this.table.truths.active && !(game.user.isGM && pinned && gaType(message) === "ball-of-truths")) {
      return this.table.truths.card();
    }
    const recent = message && !NO_LINGER.has(gaType(message)) && Date.now() - this.touchedAt < LINGER_MS;
    if (!pinned && !recent) return null;
    return message.renderHTML();
  }

  async render() {
    const token = (this.renderToken = Symbol());
    const html = this.holds.size ? null : await this.content();
    if (token !== this.renderToken) return;
    if (!html) {
      this.element.classList.remove("is-visible");
      return;
    }
    this.element.replaceChildren(html);
    this.element.classList.add("is-visible");
  }
}
