import { GA_SYSTEM_ID, MODULE_ID } from "./constants.js";
import { FoundryTable } from "./foundry-table.js";
import { registerSettings, SETTINGS } from "./settings.js";

Hooks.once("init", () => {
  registerSettings();
});

Hooks.once("ready", async () => {
  if (game.system.id !== GA_SYSTEM_ID) {
    ui.notifications.warn(game.i18n.localize("TCT.Warn.WrongSystem"));
    return;
  }
  if (game.settings.get(MODULE_ID, SETTINGS.plainTable)) return;

  const table = new FoundryTable();
  game.modules.get(MODULE_ID).api = table.api;
  await table.mount();
});
