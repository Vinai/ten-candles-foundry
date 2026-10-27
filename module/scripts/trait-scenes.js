import { burningCandles, isStarted } from "./candle-clock.js";
import { GA_STATE_SETTING, GA_SYSTEM_ID, MODULE_ID } from "./constants.js";
import { SETTINGS } from "./settings.js";

const TRAITS = ["virtue", "vice"];

/** Whether this character already burned a Virtue or Vice in the scene being played. */
export function traitUsedThisScene(actor, state = game.settings.get(GA_SYSTEM_ID, GA_STATE_SETTING)) {
  const burns = game.settings.get(MODULE_ID, SETTINGS.traitBurns);
  const burn = actor && burns?.gameId === state.gameId ? burns.actors?.[actor.id] : null;
  return Boolean(burn) && burn.scene === burningCandles(state);
}

/**
 * "A player may not use both of their Traits in the same scene" (rulebook). The Game Assistant only keeps a second
 * trait out of the same conflict, so the table remembers who burned a Virtue or Vice in which scene: a scene ends when
 * a candle goes out, so the number of candles still burning names it. Until then the other trait cannot be burned,
 * neither on the conflict card nor in the sheet. The GM can still restore a card, and doing so forgets the burn.
 *
 * World setting `traitBurns`: {gameId, actors: {actorId: {scene, kind}}}, written by the active GM.
 */
export class TraitScenes {
  constructor(table) {
    this.table = table;
  }

  start() {
    Hooks.on("updateActor", (actor, changes) => this.onActorUpdate(actor, changes));
  }

  get inCharge() {
    return game.user === game.users.activeGM;
  }

  /** The scene being played: the candles still burning in this game. */
  scene() {
    return burningCandles(this.table.gaState());
  }

  state() {
    const state = game.settings.get(MODULE_ID, SETTINGS.traitBurns);
    const gameId = this.table.gaState().gameId;
    return state?.gameId === gameId ? { gameId, actors: state.actors ?? {} } : { gameId, actors: {} };
  }

  /** In the GM's browser: a Virtue or Vice burned during play is noted with its scene; one restored is forgotten. */
  async onActorUpdate(actor, changes) {
    if (!this.inCharge || actor.type !== "character" || !isStarted(this.table.clock())) return;
    const { actors } = this.state();
    for (const kind of TRAITS) {
      const available = changes.system?.[kind]?.available;
      if (available === false) {
        await this.save({ ...actors, [actor.id]: { scene: this.scene(), kind } });
        return;
      }
      if (available === true && actors[actor.id]?.kind === kind) {
        const { [actor.id]: _restored, ...rest } = actors;
        await this.save(rest);
        return;
      }
    }
  }

  save(actors) {
    return game.settings.set(MODULE_ID, SETTINGS.traitBurns, { gameId: this.table.gaState().gameId, actors });
  }
}
