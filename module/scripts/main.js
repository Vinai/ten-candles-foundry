export const MODULE_ID = "ten-candles-foundry";

// Integration points of the Ten Candles – Game Assistant system (read-only use, see DESIGN.md).
export const GA_SYSTEM_ID = "tencandles-ga";
export const GA_STATE_SETTING = "collectiveState";
export const GA_STATE_HOOK = `${GA_SYSTEM_ID}.collectiveStateChanged`;

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | init`);
});

Hooks.once("ready", () => {
  if (game.system.id !== GA_SYSTEM_ID) {
    ui.notifications.warn(game.i18n.localize("TCT.Warn.WrongSystem"));
    return;
  }
  console.log(`${MODULE_ID} | ready`, game.settings.get(GA_SYSTEM_ID, GA_STATE_SETTING));
});
