import { isStarted } from "./candle-clock.js";
import { topCard, unburned } from "./ga-cards.js";

/**
 * The Game Assistant's character sheets at our table. Only the top card of a stack is in play, so only it can be
 * burned or lived; the order is fixed once the lights are out. A sheet makes way for the table when its player
 * rolls, burns a card or lives their Moment, so they see what happens.
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
      if (unburned(system, key) && key !== top) {
        card.classList.add("tct-below");
        card.querySelector(".etc-resource-state-action")?.setAttribute("disabled", "");
      }
      // "Once stacks are built, they are locked and cannot be changed."
      if (locked) card.querySelector(".etc-resource-drag-handle")?.remove();
    }
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
