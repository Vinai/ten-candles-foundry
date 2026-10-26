import { isStarted } from "./candle-clock.js";
import { topCard, unburned } from "./ga-cards.js";

/**
 * The Game Assistant's character sheets at our table. Only the top card of a stack is in play, so only it can be
 * burned or lived, and only once the game has begun with "Licht aus"; from then on the order is fixed. The cards are
 * written in the ritual and passed on, so players cannot change their text in the sheet (the GM still can, to correct
 * one). A sheet makes way for the table when its player rolls, burns a card or lives their Moment, so they see what
 * happens.
 */
export class CharacterSheets {
  constructor(table) {
    this.table = table;
  }

  start() {
    Hooks.on("renderActorSheetV2", (app, element) => this.decorate(app.document, element));
    this.quietPublishedMoment();
  }

  decorate(actor, element) {
    if (actor?.type !== "character") return;
    const system = actor.system;
    const top = topCard(system);
    const locked = isStarted(this.table.clock());
    for (const card of element.querySelectorAll(".etc-resource[data-resource-key]")) {
      const key = card.dataset.resourceKey;
      card.classList.toggle("tct-top", key === top);
      if (unburned(system, key) && key !== top) card.classList.add("tct-below");
      if ((unburned(system, key) && key !== top) || !locked) {
        card.querySelector(".etc-resource-state-action")?.setAttribute("disabled", "");
      }
      const handle = card.querySelector(".etc-resource-drag-handle");
      // "Once stacks are built, they are locked and cannot be changed."
      if (locked) handle?.remove();
      // Players move the whole card, not only its handle; their card texts are read-only, so nothing is in the way.
      else if (handle && !game.user.isGM) {
        card.draggable = true;
        card.classList.add("tct-draggable");
        // A drag source of its own inside the card would compete with it; now it is just where the card is held.
        handle.removeAttribute("draggable");
      }
    }
    if (!game.user.isGM) for (const text of element.querySelectorAll(".etc-resource-text")) text.readOnly = true;
    this.numberStack(actor, element);
  }

  /**
   * The sheet lays the cards out in stack order, row by row with the Brink last; numbered, that order shows: 1 is on
   * top, the Brink at the bottom. Burned cards have left the stack and get no number.
   */
  numberStack(actor, element) {
    for (const old of element.querySelectorAll(".tct-stack-position")) old.remove();
    const inStack = [...element.querySelectorAll(".etc-resource")].filter((card) => {
      const key = card.dataset.resourceKey;
      return !key || unburned(actor.system, key);
    });
    inStack.forEach((card, i) => {
      const n = i + 1;
      const label = i === 0 ? "TCT.Sheet.Top" : n === inStack.length ? "TCT.Sheet.Bottom" : null;
      const badge = document.createElement("span");
      badge.className = "tct-stack-position";
      badge.textContent = label ? game.i18n.format(label, { n }) : String(n);
      badge.dataset.tooltip = game.i18n.localize("TCT.Sheet.PositionHint");
      card.classList.add("tct-numbered");
      card.prepend(badge);
    });
  }

  /** The open sheets of an actor in this browser. */
  openSheets(actor) {
    return [...foundry.applications.instances.values()].filter((app) => app.document === actor && app.rendered);
  }

  /** Draws every open character sheet again, e.g. once the stacks are locked. */
  renderAll() {
    for (const app of foundry.applications.instances.values()) {
      if (app.document?.type === "character" && app.rendered) app.render();
    }
  }

  close(actor) {
    for (const app of this.openSheets(actor)) app.close();
  }

  toggle(actor) {
    const open = this.openSheets(actor);
    if (open.length) open.forEach((app) => app.close());
    else actor.sheet.render({ force: true });
  }

  /**
   * The Moment's card lies over the bowl the moment it is asked for; the Game Assistant's note that it went to the
   * chat would only cover the table.
   */
  quietPublishedMoment() {
    const notifications = ui.notifications;
    const notify = notifications.notify.bind(notifications);
    notifications.notify = (message, ...rest) => {
      if (message === game.i18n.localize("ETC.Instant.PublishedNotification")) return null;
      return notify(message, ...rest);
    };
  }
}
