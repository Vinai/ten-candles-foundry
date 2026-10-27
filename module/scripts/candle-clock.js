/**
 * Real-time burn-down of the candles, as plain data in a world setting so every browser derives the same picture.
 * The clock starts at "Licht aus" and stops while paused. Each candle burns for 3 to 3.5 hours of clock time and
 * gutters for its last 1 to 2 minutes. Candles die in order of their lifetimes; a candle darkened by a failed
 * conflict is simply the one that would have died next.
 */

const HOUR = 3600 * 1000;
const MINUTE = 60 * 1000;

/** @returns {{startedAt: number|null, pausedAt: number|null, lifetimes: number[], gutters: number[]}} */
export function createClock(count, random = Math.random) {
  const lifetimes = Array.from({ length: count }, () => 3 * HOUR + random() * 0.5 * HOUR).sort((a, b) => a - b);
  const gutters = Array.from({ length: count }, () => MINUTE + random() * MINUTE);
  return { startedAt: null, pausedAt: null, lifetimes, gutters };
}

/**
 * Candles burning on the table, from the Game Assistant's state. A failed conflict darkens one at once, while the
 * Game Assistant only counts it down when the truths are done.
 */
export function burningCandles(state) {
  return state.stage === "ball-of-truths" ? Math.max(state.litCandles - 1, 0) : state.litCandles;
}

export function isStarted(clock) {
  return Boolean(clock?.startedAt);
}

export function isPaused(clock) {
  return Boolean(clock?.pausedAt);
}

/** Milliseconds of burning so far. */
export function elapsed(clock, now = Date.now()) {
  if (!isStarted(clock)) return 0;
  return (clock.pausedAt ?? now) - clock.startedAt;
}

export function start(clock, now = Date.now()) {
  return isStarted(clock) ? clock : { ...clock, startedAt: now, pausedAt: null };
}

export function pause(clock, now = Date.now()) {
  return !isStarted(clock) || isPaused(clock) ? clock : { ...clock, pausedAt: now };
}

export function resume(clock, now = Date.now()) {
  return !isPaused(clock) ? clock : { ...clock, startedAt: clock.startedAt + (now - clock.pausedAt), pausedAt: null };
}

/**
 * State of the next candle to die while `lit` candles burn.
 * @returns {{remaining: number, gutter: number}|null} ms until it dies (≤ 0: overdue) and 0–1 guttering
 */
export function nextDeath(clock, lit, now = Date.now()) {
  if (!isStarted(clock) || lit <= 0) return null;
  const position = clock.lifetimes.length - lit;
  const remaining = clock.lifetimes[position] - elapsed(clock, now);
  const lead = clock.gutters[position];
  return { remaining, gutter: Math.min(Math.max(1 - remaining / lead, 0), 1) };
}
