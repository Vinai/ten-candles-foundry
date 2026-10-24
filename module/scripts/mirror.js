import { GA_SYSTEM_ID } from "./constants.js";

// How long a card stays above the bowl after its last change once nothing in the game still needs it.
const LINGER_MS = 20000;

/**
 * The Game Assistant's latest chat card (conflict, Moment, truths, …) lies above the bowl in a pool of light, so
 * nobody needs the chat. It is the real message rendered once more: the Game Assistant wires up its buttons itself.
 */
export class ConflictMirror {
  constructor(table, element) {
    this.table = table;
    this.element = element;
    this.messageId = null;
    this.touchedAt = 0;
  }

  start() {
    // After a reload, bring back whatever the game is still waiting on.
    const state = this.table.gaState();
    this.messageId = game.messages.contents.findLast((m) => gaType(m) && this.pinned(m, state))?.id ?? null;
    Hooks.on("createChatMessage", (message) => this.touch(message));
    Hooks.on("updateChatMessage", (message) => this.update(message));
    Hooks.on("deleteChatMessage", (message) => message.id === this.messageId && this.render());
    // Marks them so the styles keep them out of Foundry's chat pop-ups; the bowl shows them already.
    Hooks.on("renderChatMessageHTML", (message, html) => gaType(message) && html.classList.add("tct-ga-card"));
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

  async render() {
    const message = game.messages.get(this.messageId);
    const show = message && (this.pinned(message, this.table.gaState()) || Date.now() - this.touchedAt < LINGER_MS);
    const token = (this.renderToken = Symbol());
    if (!show) {
      this.element.classList.remove("is-visible");
      return;
    }
    const html = await message.renderHTML();
    if (token !== this.renderToken) return;
    this.element.replaceChildren(html);
    this.element.classList.add("is-visible");
  }
}

function gaType(message) {
  return message.flags?.[GA_SYSTEM_ID]?.type ?? null;
}
