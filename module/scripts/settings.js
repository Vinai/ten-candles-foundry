import { MODULE_ID } from "./constants.js";

// Called with (key, value) whenever one of our world settings changes, in every browser.
export const SETTING_CHANGED_HOOK = `${MODULE_ID}.settingChanged`;

export const SETTINGS = {
  seatOrder: "seatOrder",
  lightsOut: "lightsOut",
  candleClock: "candleClock",
  ritual: "ritual",
  recorder: "recorder",
  plainTable: "plainTable"
};

export function registerSettings() {
  // User ids clockwise around the table. Empty means: GM first, then players by name.
  game.settings.register(MODULE_ID, SETTINGS.seatOrder, {
    scope: "world",
    config: false,
    type: Array,
    default: [],
    onChange: (value) => Hooks.callAll(SETTING_CHANGED_HOOK, SETTINGS.seatOrder, value)
  });

  // false while the room lights are on (character creation), true once the GM switched them off.
  game.settings.register(MODULE_ID, SETTINGS.lightsOut, {
    scope: "world",
    config: false,
    type: Boolean,
    default: false,
    onChange: (value) => Hooks.callAll(SETTING_CHANGED_HOOK, SETTINGS.lightsOut, value)
  });

  // The real-time burn-down started by the first "Licht aus", see candle-clock.js. Tied to the Game Assistant's game id.
  game.settings.register(MODULE_ID, SETTINGS.candleClock, {
    scope: "world",
    config: false,
    type: Object,
    default: {},
    onChange: (value) => Hooks.callAll(SETTING_CHANGED_HOOK, SETTINGS.candleClock, value)
  });

  // Character creation in progress, see ritual.js. Tied to the Game Assistant's game id.
  game.settings.register(MODULE_ID, SETTINGS.ritual, {
    scope: "world",
    config: false,
    type: Object,
    default: {},
    onChange: (value) => Hooks.callAll(SETTING_CHANGED_HOOK, SETTINGS.ritual, value)
  });

  // The parting messages: who holds the recorder, what was recorded, when it is played. See recorder.js.
  game.settings.register(MODULE_ID, SETTINGS.recorder, {
    scope: "world",
    config: false,
    type: Object,
    default: {},
    onChange: (value) => Hooks.callAll(SETTING_CHANGED_HOOK, SETTINGS.recorder, value)
  });

  // Escape hatch for weak machines or trouble: keep Foundry's own canvas and camera dock.
  game.settings.register(MODULE_ID, SETTINGS.plainTable, {
    name: "TCT.Settings.PlainTable.Name",
    hint: "TCT.Settings.PlainTable.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    requiresReload: true
  });
}
