import { MODULE_ID, SOCKET } from "./constants.js";
import { SETTINGS } from "./settings.js";

/**
 * Characters who have died. Before the last scene a character dies only when their player chooses it, after a failed
 * dire conflict; in the last scene ("The Last Stand") any failed conflict kills, and the Game Assistant says so on
 * its own card. The Game Assistant itself keeps no such state, so the table does: the GM marks the dead by hand, and
 * those the Game Assistant lets die at the last candle count too.
 *
 * The dead stay at the table, their face in black and white like an old television. They no longer roll and no
 * longer speak truths; they still record their final message. A Martyr's hope die (rulebook: "they may grant their
 * hope die to another survivor") is passed on as a note to everyone: the Game Assistant has no way to give a
 * character a second hope die, so the table keeps track of it.
 *
 * World setting `dead`: {gameId, users: {userId: {martyr, hopeTo}}}, written by the active GM.
 */
export class Deaths {
  constructor(table) {
    this.table = table;
    this.announced = new Set();
    this.departures = new Set();
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
    this.table.mirror?.render();
    for (const [userId, entry] of Object.entries(this.state().users)) {
      const key = `${userId}:${entry.hopeTo}`;
      if (!entry.hopeTo || this.announced.has(key)) continue;
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
    const users = {};
    for (const user of players) {
      if (!values[`dead-${user.id}`]) continue;
      const martyr = Boolean(values[`martyr-${user.id}`]);
      users[user.id] = { martyr, hopeTo: martyr ? (dead[user.id]?.hopeTo ?? null) : null };
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
    const users = this.state().users;
    const entry = users[message.userId];
    const heir = game.users.get(message.heir);
    if (!entry?.martyr || entry.hopeTo || !heir || heir.isGM || this.isDead(heir)) return;
    await this.save({ ...users, [message.userId]: { ...entry, hopeTo: heir.id } });
  }

  /**
   * In the GM's browser, with every change of the Game Assistant's state: whoever it lets die at the last candle is
   * dead here too.
   */
  async onGaState(state) {
    if (!this.inCharge) return;
    const resolution = state.lastResolution;
    if (resolution?.status !== "resolved" || !resolution.characterDeparture || this.departures.has(resolution.id)) return;
    this.departures.add(resolution.id);
    const users = this.state().users;
    if (!resolution.playerId || users[resolution.playerId]) return;
    await this.save({ ...users, [resolution.playerId]: { martyr: false, hopeTo: null } });
  }
}
