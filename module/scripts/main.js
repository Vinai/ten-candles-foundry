import { GA_SYSTEM_ID, MODULE_ID } from "./constants.js";
import { FoundryTable } from "./foundry-table.js";
import { decorateCards } from "./ga-cards.js";
import { registerSettings, SETTINGS } from "./settings.js";

Hooks.once("init", () => {
  registerSettings();
  if (game.system.id !== GA_SYSTEM_ID) return;
  decorateCards();
  // Foundry asks a player without a character to pick one as the game loads; the ritual makes and assigns it.
  Hooks.on("renderUserConfig", (app) => {
    if (!game.ready && app.document === game.user) app.close({ animate: false });
  });
});

Hooks.once("ready", async () => {
  if (game.system.id !== GA_SYSTEM_ID) {
    ui.notifications.warn(game.i18n.localize("TCT.Warn.WrongSystem"));
    return;
  }
  const table = new FoundryTable();
  game.modules.get(MODULE_ID).api = table.api;
  await table.mount({ plain: game.settings.get(MODULE_ID, SETTINGS.plainTable) });
});
