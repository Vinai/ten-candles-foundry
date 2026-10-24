export const MODULE_ID = "ten-candles-foundry";
export const SOCKET = `module.${MODULE_ID}`;

// Integration points of the Ten Candles – Game Assistant system (read-only use, see DESIGN.md).
export const GA_SYSTEM_ID = "tencandles-ga";
export const GA_STATE_SETTING = "collectiveState";
export const GA_STATE_HOOK = `${GA_SYSTEM_ID}.collectiveStateChanged`;
export const GA_PAINTING = `systems/${GA_SYSTEM_ID}/assets/scene/background.webp`;

export const TOTAL_CANDLES = 10;
