import { MODULE_ID, SOCKET } from "./constants.js";
import { SETTINGS } from "./settings.js";

// The Game Assistant is busy for a moment after a conflict; a put-off transfer is tried this often, this far apart.
const RETRY_ATTEMPTS = 5;
const RETRY_MS = 1500;

/**
 * Characters who have died. Before the last scene a character dies only when their player chooses it, after a failed
 * dire conflict; in the last scene ("The Last Stand") any failed conflict kills, and the Game Assistant says so on
 * its own card. The Game Assistant itself keeps no such state, so the table does: the GM marks the dead by hand, and
 * those the Game Assistant lets die at the last candle count too.
 *
 * The dead stay at the table, their face in black and white like an old television. They no longer roll and no
 * longer speak truths; they still record their final message. A Martyr's hope die (rulebook: "they may grant their
 * hope die to another survivor") is passed on by the Game Assistant: through its API where it offers one
 * (`transferHopeDie`, by actor id), else in its own state window, which this opens for the GM with what to transfer to
 * whom.
 *
 * World setting `dead`: {gameId, users: {userId: {martyr, hopeTo, pending}}}, written by the active GM. `pending`: the
 * Game Assistant turned the transfer down (a conflict was still open); it is tried again once the conflict is over,
 * and only then announced.
 */
export class Deaths {
  constructor(table) {
    this.table = table;
    this.announced = new Set();
    this.departures = new Set();
    // Martyrs whose hope die is being passed on in this browser right now.
    this.passing = new Set();
  }

  start() {
    // Hope passed on before this page loaded is not announced again.
    for (const [userId, entry] of Object.entries(this.state().users)) {
      if (entry.hopeTo) this.announced.add(`${userId}:${entry.hopeTo}`);
    }
    game.socket.on(SOCKET, (message, senderId) => {
      if (message?.type === "martyr-choose") this.chooseHeir(message, senderId);
      if (message?.type === "martyr-chosen") this.heirChosen(message, senderId);
    });
  }

  /** A new game: nobody has died in it yet, whatever this browser showed of the last one. */
  newGame() {
    this.announced.clear();
    this.departures.clear();
    this.onChange();
  }

  get inCharge() {
    return game.user === game.users.activeGM;
  }

  state() {
    const state = game.settings.get(MODULE_ID, SETTINGS.dead);
    const gameId = this.table.gaState().gameId;
    return state?.gameId === gameId ? { gameId, users: state.users ?? {} } : { gameId, users: {} };
  }

  save(users) {
    return game.settings.set(MODULE_ID, SETTINGS.dead, { gameId: this.table.gaState().gameId, users });
  }

  isDead(user) {
    return Boolean(user && this.state().users[user.id]);
  }

  /** Everyone's view after a change: the faces, the own roll button, the truths, and hope passed on. */
  onChange() {
    document.body.classList.toggle("tct-dead", this.isDead(game.user));
    ui.controls?.render({ reset: true });
    this.table.refreshCards();
    this.table.sheets.renderAll();
    this.table.mirror?.render();
    for (const [userId, entry] of Object.entries(this.state().users)) {
      const key = `${userId}:${entry.hopeTo}`;
      if (!entry.hopeTo || entry.pending || this.announced.has(key)) continue;
      this.announced.add(key);
      ui.notifications.info(
        game.i18n.format("TCT.Death.HopeGiven", { to: this.nameOf(entry.hopeTo), from: this.nameOf(userId) }),
        { permanent: true }
      );
    }
  }

  nameOf(userId) {
    const user = game.users.get(userId);
    return user?.character?.name || user?.name || "?";
  }

  /** The GM's dialog: who has died, and who of them as a Martyr. Unticking brings someone back (a slip). */
  async edit() {
    if (!this.inCharge) return;
    const escape = foundry.utils.escapeHTML;
    const t = (key) => escape(game.i18n.localize(`TCT.Death.${key}`));
    const dead = this.state().users;
    const players = this.table.users.filter((user) => !user.isGM);
    const row = (user) =>
      `<li><span>${escape(this.nameOf(user.id))}</span>` +
      `<label><input type="checkbox" name="dead-${user.id}" ${dead[user.id] ? "checked" : ""}> ${t("Dead")}</label>` +
      `<label><input type="checkbox" name="martyr-${user.id}" ${dead[user.id]?.martyr ? "checked" : ""}> ${t("Martyr")}</label></li>`;
    const values = await foundry.applications.api.DialogV2.input({
      window: { title: game.i18n.localize("TCT.Death.Title") },
      position: { width: 460 },
      classes: ["tct-deaths"],
      content: `<p>${t("Hint")}</p><ul class="tct-death-list">${players.map(row).join("")}</ul>`,
      ok: { label: game.i18n.localize("TCT.Death.Save") },
      rejectClose: false
    });
    if (!values || !this.inCharge) return;
    // Read again: a death at the last candle or a Martyr's choice may have come in while the dialog was open. Only
    // the rows the GM changed count; an untouched one keeps whatever happened meanwhile.
    const users = { ...this.state().users };
    for (const user of players) {
      const died = Boolean(values[`dead-${user.id}`]);
      const martyr = Boolean(values[`martyr-${user.id}`]);
      if (died === Boolean(dead[user.id]) && martyr === Boolean(dead[user.id]?.martyr)) continue;
      if (!died) {
        delete users[user.id];
        continue;
      }
      users[user.id] = { martyr, hopeTo: martyr ? (users[user.id]?.hopeTo ?? null) : null };
    }
    await this.save(users);
    for (const [userId, entry] of Object.entries(users)) {
      if (entry.martyr && !entry.hopeTo && !dead[userId]?.martyr) this.askForHeir(userId);
    }
  }

  /**
   * A Martyr with a hope die chooses who carries it on. Their own browser asks them; the GM's, if they are not
   * there.
   */
  askForHeir(userId) {
    const user = game.users.get(userId);
    if (!user?.character?.system.hopeDieAvailable) return;
    const message = { type: "martyr-choose", gameId: this.state().gameId, userId };
    if (user.active) game.socket.emit(SOCKET, message, { recipients: [userId] });
    else this.chooseHeir(message, game.user.id);
  }

  /** In the Martyr's browser (or the GM's in their stead): who gets the hope die. */
  async chooseHeir(message, senderId) {
    if (senderId !== game.users.activeGM?.id || message.gameId !== this.state().gameId) return;
    const escape = foundry.utils.escapeHTML;
    const living = this.table.users.filter((user) => !user.isGM && user.id !== message.userId && !this.isDead(user));
    if (!living.length) return;
    const options = living
      .map((user, i) => `<label><input type="radio" name="heir" value="${user.id}" ${i ? "" : "checked"}> ${escape(this.nameOf(user.id))}</label>`)
      .join("");
    const values = await foundry.applications.api.DialogV2.input({
      window: { title: game.i18n.localize("TCT.Death.HeirTitle") },
      content: `<p>${escape(game.i18n.format("TCT.Death.HeirHint", { name: this.nameOf(message.userId) }))}</p>` +
        `<div class="tct-heirs">${options}</div>`,
      ok: { label: game.i18n.localize("TCT.Death.HeirChoose") },
      rejectClose: false
    });
    if (!values?.heir) return;
    const reply = { type: "martyr-chosen", gameId: message.gameId, userId: message.userId, heir: values.heir };
    if (game.user === game.users.activeGM) this.heirChosen(reply, game.user.id);
    else game.socket.emit(SOCKET, reply, { recipients: [game.users.activeGM.id] });
  }

  /** In the GM's browser: the Martyr (or the GM for them) has chosen. */
  async heirChosen(message, senderId) {
    if (!this.inCharge || message.gameId !== this.state().gameId) return;
    if (senderId !== message.userId && senderId !== game.user.id) return;
    const entry = this.state().users[message.userId];
    const heir = game.users.get(message.heir);
    if (!entry?.martyr || entry.hopeTo || !heir || heir.isGM || this.isDead(heir)) return;
    const giver = game.users.get(message.userId)?.character;
    // Without both characters there is no die to pass on; a second answer while the first is being handled is dropped.
    if (!giver || !heir.character || this.passing.has(message.userId)) return;
    this.passing.add(message.userId);
    try {
      const api = Boolean(game.evilTenCandles?.transferHopeDie);
      const passed = await this.transfer(giver, heir.character);
      // Without the API the GM passes it on in the state window, straight away.
      if (!api) this.instruct(giver, heir.character);
      // Read again after the transfer: the GM may have changed the list meanwhile.
      const users = this.state().users;
      if (!users[message.userId] || users[message.userId].hopeTo) return;
      const pending = api && !passed;
      await this.save({ ...users, [message.userId]: { ...users[message.userId], hopeTo: heir.id, pending } });
    } finally {
      this.passing.delete(message.userId);
    }
  }

  /** The GM passes the hope die on in the Game Assistant's state window; this opens it and says what to do. */
  instruct(giver, receiver) {
    game.evilTenCandles?.openStateControl?.();
    ui.notifications.info(
      game.i18n.format("TCT.Death.TransferInStateControl", { from: giver.name, to: receiver.name }),
      { permanent: true }
    );
  }

  /**
   * In the GM's browser: a transfer the Game Assistant turned down while a conflict was open is tried again once no
   * conflict is open. Turned down again, the GM passes it on in the state window.
   */
  async retryPending(state) {
    if (state.activeResolution) return;
    for (const [userId, entry] of Object.entries(this.state().users)) {
      if (!entry.pending || this.passing.has(userId)) continue;
      const giver = game.users.get(userId)?.character;
      const receiver = game.users.get(entry.hopeTo)?.character;
      this.passing.add(userId);
      try {
        let passed = false;
        for (let attempt = 0; attempt < RETRY_ATTEMPTS && !passed && giver && receiver; attempt++) {
          await new Promise((resolve) => window.setTimeout(resolve, RETRY_MS));
          // A new conflict meanwhile: tried again once that one is over.
          if (!this.inCharge || this.table.gaState().activeResolution || !this.state().users[userId]?.pending) return;
          passed = await this.transfer(giver, receiver);
        }
        if (!passed && giver && receiver) this.instruct(giver, receiver);
        const users = this.state().users;
        if (!users[userId]?.pending) continue;
        await this.save({ ...users, [userId]: { ...users[userId], pending: false } });
      } finally {
        this.passing.delete(userId);
      }
    }
  }

  /** The hope die passed on through the Game Assistant's API, where it has one; whether that worked. */
  async transfer(giver, receiver) {
    if (!game.evilTenCandles?.transferHopeDie) return false;
    try {
      await game.evilTenCandles.transferHopeDie(giver.id, receiver.id);
      return true;
    } catch (error) {
      console.warn(`${MODULE_ID} | The hope die could not be passed on`, error);
      return false;
    }
  }

  /**
   * In the GM's browser, with every change of the Game Assistant's state: whoever it lets die at the last candle is
   * dead here too.
   */
  async onGaState(state) {
    if (!this.inCharge) return;
    await this.retryPending(state);
    const resolution = state.lastResolution;
    if (resolution?.status !== "resolved" || !resolution.characterDeparture || this.departures.has(resolution.id)) return;
    this.departures.add(resolution.id);
    const player = this.table.playerOf(resolution);
    const users = this.state().users;
    if (!player || player.isGM || users[player.id]) return;
    await this.save({ ...users, [player.id]: { martyr: false, hopeTo: null } });
  }
}
