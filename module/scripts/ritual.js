import { isStarted } from "./candle-clock.js";
import { MODULE_ID, SOCKET } from "./constants.js";
import { leftOf, rightOf } from "./seat-layout.js";
import { SETTINGS } from "./settings.js";

// Long enough for the slide in stage.js (1.8 s) to land before the cards appear in the recipients' stacks.
const PASS_MS = 2000;
// Once passed cards lie in their new stacks, the candles of the step are lit this much later.
const LIGHT_AFTER_PASS_MS = 2000;
// A writer waits this long for the GM to confirm a card before telling the player it did not arrive.
const ACK_TIMEOUT_MS = 8000;
// More than any card holds; keeps a misbehaving client from filling the world setting.
const MAX_CARD_CHARS = 500;

/**
 * Character creation, led by the GM one step at a time. Candles are lit as the table gets through it; the last one
 * is lit by "Licht aus".
 */
const STEPS = {
  idle: { next: "traits", button: "TCT.Ritual.Step.Traits", candles: 0 },
  traits: { next: "concepts", button: "TCT.Ritual.Step.Pass", candles: 0, writes: ["virtue", "vice"], pass: true },
  concepts: { next: "moments", button: "TCT.Ritual.Step.Moments", candles: 3 },
  moments: { next: "momentsDone", button: "TCT.Ritual.Step.MomentsDone", candles: 3, writes: ["moment"] },
  momentsDone: { next: "brinks", button: "TCT.Ritual.Step.Brinks", candles: 6 },
  brinks: { next: "arrange", button: "TCT.Ritual.Step.Pass", candles: 6, writes: ["brink"], pass: true, gmWrites: true },
  arrange: { candles: 9 }
};

// What the GM is reminded of while the players work on their own: strings under TCT.Ritual.<key>, then the button.
const GM_CARDS = {
  concepts: { key: "Concepts", items: ["Name", "Look", "Concept"], then: STEPS.concepts.button },
  arrange: { key: "Arrange", items: ["Order", "Brink", "Moments"], then: "TCT.GM.LightsOut" }
};

const LABELS = {
  virtue: "TCT.Card.Virtue",
  vice: "TCT.Card.Vice",
  moment: "TCT.Card.Moment",
  brink: "TCT.Card.Brink"
};

/**
 * World setting `ritual`: {gameId, step, cards: {writerId: {virtue, vice, moment, brink}}, passing, theyCard}.
 * Players hand what they wrote to the active GM over the module socket; the GM's browser keeps the setting and writes
 * passed cards into the recipients' Game Assistant sheets. The GM handles one change at a time and confirms each card
 * to its writer, who keeps the draft until then.
 *
 * Secrecy: Brinks are hidden from view, not from someone digging in the browser console. Foundry sends every actor
 * and world setting to every player, so the text is in each browser once it is written; only the submissions go to
 * the GM alone.
 */
export class Ritual {
  constructor(table) {
    this.table = table;
    this.queue = Promise.resolve();
    // This browser's last submission, until the GM confirms it: {gameId, step, cards, id}.
    this.draft = null;
  }

  start() {
    game.socket.on(SOCKET, (message, senderId) => this.onSocket(message, senderId));
    this.onChange();
  }

  /** Runs one change of the ritual setting after the other, so no change works from an outdated state. */
  enqueue(change) {
    const run = this.queue.then(change);
    this.queue = run.catch((error) => console.error(`${MODULE_ID} | Ritual`, error));
    return run;
  }

  state() {
    const state = game.settings.get(MODULE_ID, SETTINGS.ritual);
    const gameId = this.table.gaState().gameId;
    if (state?.gameId !== gameId) return { gameId, step: "idle", cards: {}, passing: null, theyCard: null };
    return state;
  }

  save(state) {
    return game.settings.set(MODULE_ID, SETTINGS.ritual, state);
  }

  get step() {
    return STEPS[this.state().step] ?? STEPS.idle;
  }

  /** Candles burning during character creation, before "Licht aus". */
  get candles() {
    return this.step.candles;
  }

  /** Label of the GM's button for the next step, or null when creation is through. */
  get nextLabel() {
    return this.step.next ? game.i18n.localize(this.step.button) : null;
  }

  writers(step = this.step) {
    if (!step.writes) return [];
    return this.table.users.filter((user) => step.gmWrites || !user.isGM);
  }

  /** How many of the writers have written everything this step asks for. */
  get progress() {
    const { cards } = this.state();
    const writers = this.writers();
    const done = writers.filter((user) => this.step.writes.every((kind) => cards[user.id]?.[kind])).length;
    return { done, total: writers.length };
  }

  /** Traits go round the players only; Brinks go round the whole table, the GM included. */
  recipient(writer, kind) {
    const users = this.table.users;
    if (kind === "moment") return writer;
    if (kind === "brink") return users[leftOf(users.length, users.indexOf(writer))];
    const players = users.filter((user) => !user.isGM);
    const index = players.indexOf(writer);
    return players[kind === "virtue" ? rightOf(players.length, index) : leftOf(players.length, index)];
  }

  /** Which phrase a Brink starts with, from where writer and recipient sit relative to the GM. */
  brinkLabel(recipient) {
    if (recipient.isGM) return "TCT.Card.BrinkOfThem";
    const users = this.table.users;
    const writer = users[rightOf(users.length, users.indexOf(recipient))];
    return writer?.isGM ? "TCT.Card.BrinkByThem" : "TCT.Card.Brink";
  }

  /** Cards written this step and not yet passed lie face down in front of their writer; the writer sees their own. */
  pendingCards(user) {
    const state = this.state();
    const kinds = this.step.writes ?? [];
    if (state.passing) return [];
    return kinds
      .filter((kind) => state.cards[user.id]?.[kind])
      .map((kind) => ({
        label: game.i18n.localize(LABELS[kind]),
        text: state.cards[user.id][kind],
        faceDown: !user.isSelf,
        // Picked up again with a click, until the cards are passed.
        edit: user.isSelf ? () => this.write() : null
      }));
  }

  /**
   * The GM's card over the bowl for the steps the players do on their own: what to ask of them, and what comes next.
   * While they work out their concepts (the rulebook's "Create Concepts") and once the Brinks are passed, while they
   * arrange their stacks, until "Licht aus". Null at any other time, and for players.
   */
  gmCard() {
    const step = this.state().step;
    const card = GM_CARDS[step];
    if (!game.user.isGM || !card || isStarted(this.table.clock())) return null;
    const t = (key, data) => foundry.utils.escapeHTML(game.i18n.format(`TCT.Ritual.${card.key}.${key}`, data ?? {}));
    const element = document.createElement("article");
    element.className = "tct-truths-card";
    const items = card.items.map((key) => `<li>${t(key)}</li>`).join("");
    element.innerHTML =
      `<h3>${t("Title")}</h3><p class="tct-truths-left">${t("Ask")}</p><ul class="tct-truths-list">${items}</ul>` +
      `<p class="tct-truths-opening tct-gm-then">${t("Then", { button: game.i18n.localize(card.then) })}</p>`;
    return element;
  }

  /** The GM keeps the card the player on their right wrote about Them. */
  gmCards(user) {
    const { theyCard } = this.state();
    if (!user.isGM || !theyCard) return [];
    return [{ label: game.i18n.localize("TCT.Card.BrinkOfThem"), text: theyCard, faceDown: !user.isSelf }];
  }

  onChange() {
    const state = this.state();
    if (state.passing && state.passing.at !== this.lastPassAt) {
      this.lastPassAt = state.passing.at;
      this.animatePass(state);
    }
    // Everyone asked to write gets the card in front of them once per step of each game.
    const prompt = `${state.gameId}:${state.step}`;
    if (this.step.writes && this.promptedStep !== prompt && this.writers().includes(game.user)) {
      this.promptedStep = prompt;
      if (!this.step.writes.every((kind) => state.cards[game.user.id]?.[kind])) this.write();
    }
    this.table.refreshCards();
  }

  animatePass(state) {
    const kinds = STEPS[state.step].writes;
    const users = this.table.users;
    for (const [writerId, cards] of Object.entries(state.cards)) {
      const writer = game.users.get(writerId);
      for (const kind of kinds) {
        if (!cards[kind] || !writer) continue;
        const recipient = this.recipient(writer, kind);
        // Brinks travel face down, and every card does for those who neither wrote nor get it (the GM sees all).
        // Virtues go right, the rest left.
        const involved = game.user.isGM || writer.isSelf || recipient.isSelf;
        this.table.stage.slideCard(
          users.indexOf(writer),
          users.indexOf(recipient),
          { label: game.i18n.localize(LABELS[kind]), text: cards[kind], faceDown: kind === "brink" || !involved },
          kind === "virtue" ? -1 : 1
        );
      }
    }
  }

  /** Opens the card(s) of the current step for this user; can be reopened to rewrite until they are passed. */
  async write() {
    const step = this.step;
    if (!step.writes || !this.writers().includes(game.user)) return;
    const state = this.state();
    const draft = this.draft?.gameId === state.gameId && this.draft.step === state.step ? this.draft.cards : null;
    const own = draft ?? state.cards[game.user.id] ?? {};
    const { title, hint, fields } = this.prompt(step.writes, own);
    const values = await foundry.applications.api.DialogV2.input({
      window: { title },
      content: `<p class="tct-write-hint">${hint}</p>${fields}`,
      ok: { label: game.i18n.localize("TCT.Write.Done") },
      classes: ["tct-write"],
      rejectClose: false
    });
    if (!values) return;
    const cards = Object.fromEntries(step.writes.map((kind) => [kind, String(values[kind] ?? "").trim()]));
    this.submit({ gameId: state.gameId, step: state.step, cards, id: foundry.utils.randomID() });
  }

  /** Hands the cards to the GM. The draft stays until the GM confirms that they are stored. */
  async submit(draft) {
    this.draft = draft;
    const gm = game.users.activeGM;
    if (!gm) {
      ui.notifications.warn(game.i18n.localize("TCT.Write.NoGM"));
      return;
    }
    if (gm === game.user) {
      this.settle(draft.id, await this.store(game.user.id, draft));
      return;
    }
    game.socket.emit(SOCKET, { type: "write", ...draft }, { recipients: [gm.id] });
    window.clearTimeout(this.ackTimer);
    this.ackTimer = window.setTimeout(() => {
      if (this.draft?.id === draft.id) ui.notifications.warn(game.i18n.localize("TCT.Write.NotStored"));
    }, ACK_TIMEOUT_MS);
  }

  /**
   * The GM's answer to a submission: stored, too late because the cards are already on their way, or too long. Only
   * a stored card lets go of the draft.
   */
  settle(id, result) {
    if (this.draft?.id !== id) return;
    window.clearTimeout(this.ackTimer);
    if (result === "long") {
      ui.notifications.warn(game.i18n.format("TCT.Write.TooLong", { max: MAX_CARD_CHARS }));
      return;
    }
    if (result !== "stored") ui.notifications.warn(game.i18n.localize("TCT.Write.TooLate"));
    this.draft = null;
  }

  prompt(kinds, own) {
    const escape = foundry.utils.escapeHTML;
    const name = (user) => escape(user.character?.name || user.name);
    const field = (kind, label) =>
      `<label class="tct-write-field"><span>${escape(game.i18n.localize(label))}</span>` +
      `<input type="text" name="${kind}" value="${escape(own[kind] ?? "")}" maxlength="${MAX_CARD_CHARS}" ` +
      `autocomplete="off" autofocus></label>`;

    if (kinds.includes("virtue")) {
      return {
        title: game.i18n.localize("TCT.Write.TraitsTitle"),
        hint: game.i18n.localize("TCT.Write.TraitsHint"),
        fields: field("virtue", LABELS.virtue) + field("vice", LABELS.vice)
      };
    }
    if (kinds.includes("moment")) {
      return {
        title: game.i18n.localize("TCT.Write.MomentTitle"),
        hint: game.i18n.localize("TCT.Write.MomentHint"),
        fields: field("moment", LABELS.moment)
      };
    }
    const recipient = this.recipient(game.user, "brink");
    const label = this.brinkLabel(recipient);
    const hint = {
      "TCT.Card.Brink": "TCT.Write.BrinkHint",
      "TCT.Card.BrinkByThem": "TCT.Write.BrinkByThemHint",
      "TCT.Card.BrinkOfThem": "TCT.Write.BrinkOfThemHint"
    }[label];
    return {
      title: game.i18n.localize(label),
      hint: game.i18n.format(hint, { name: name(recipient) }),
      fields: field("brink", label)
    };
  }

  onSocket(message, senderId) {
    if (message?.type === "write-ack") {
      this.settle(message.id, message.result);
      return;
    }
    if (message?.type !== "write" || game.user !== game.users.activeGM) return;
    // The server names the sender, so nobody can write in someone else's name.
    this.store(senderId, message).then((result) =>
      game.socket.emit(SOCKET, { type: "write-ack", id: message.id, result }, { recipients: [senderId] })
    );
  }

  /**
   * Keeps a writer's cards, if they belong to this game and step and the cards are not already being passed. A
   * player who joined after the characters were made gets one now, so their cards can reach them.
   * @returns {Promise<"stored"|"late"|"long">}
   */
  store(writerId, { gameId, step, cards }) {
    return this.enqueue(async () => {
      const state = this.state();
      const writes = STEPS[state.step]?.writes ?? [];
      const writer = game.users.get(writerId);
      if (gameId !== state.gameId || step !== state.step || state.passing || !this.writers().includes(writer)) {
        return "late";
      }
      const accepted = Object.fromEntries(
        Object.entries(cards ?? {}).filter(([kind, text]) => writes.includes(kind) && typeof text === "string")
      );
      if (Object.values(accepted).some((text) => text.length > MAX_CARD_CHARS)) return "long";
      if (!writer.isGM) await this.ensureCharacter(writer);
      await this.save({ ...state, cards: { ...state.cards, [writerId]: { ...state.cards[writerId], ...accepted } } });
      return "stored";
    });
  }

  // GM side --------------------------------------------------------------------------------------------------------

  /**
   * The GM's next step. Cards are frozen while they travel; what arrives is exactly what was stored. A new game
   * started meanwhile ends it: the old step must not carry over into the new game's ritual.
   */
  next() {
    return this.enqueue(async () => {
      const state = this.state();
      const step = STEPS[state.step];
      if (!step?.next) return;
      const unchanged = () => {
        const now = this.state();
        return now.gameId === state.gameId && now.step === state.step;
      };
      if (state.step === "idle") await this.prepareCharacters();
      if (step.pass) {
        await this.save({ ...state, passing: { at: Date.now() } });
        await new Promise((resolve) => window.setTimeout(resolve, PASS_MS));
        if (!unchanged()) return;
      }
      const theyCard = step.writes ? await this.deliver(this.state(), step.writes) : state.theyCard;
      if (!unchanged()) return;
      if (step.pass) {
        // The cards settle in their stacks first, the GM's card about Them too; then the candles are lit.
        await this.save({ ...this.state(), theyCard });
        await new Promise((resolve) => window.setTimeout(resolve, LIGHT_AFTER_PASS_MS));
        if (!unchanged()) return;
      }
      await this.save({ ...this.state(), step: step.next, passing: null, theyCard });
    });
  }

  /**
   * The GM's way back to the previous step, e.g. to pass the cards again after a mistake. Everything written is kept;
   * what that step delivered leaves the sheets again, so the next pass looks like the first.
   */
  stepBack() {
    return this.enqueue(async () => {
      const state = this.state();
      const previous = Object.keys(STEPS).find((key) => STEPS[key].next === state.step);
      if (!previous || state.passing) return;
      const kinds = STEPS[previous].writes ?? [];
      if (kinds.length) {
        for (const user of this.table.users.filter((u) => !u.isGM && u.character)) {
          await user.character.update(Object.fromEntries(kinds.map((kind) => [`system.${kind}.text`, ""])));
        }
      }
      await this.save({ ...state, step: previous, theyCard: kinds.includes("brink") ? null : state.theyCard });
    });
  }

  /** Writes the step's cards into the recipients' sheets. @returns the card about Them, if the GM received it */
  async deliver(state, kinds) {
    let theyCard = state.theyCard;
    for (const [writerId, cards] of Object.entries(state.cards)) {
      const writer = game.users.get(writerId);
      for (const kind of kinds) {
        if (!cards[kind] || !writer) continue;
        const recipient = this.recipient(writer, kind);
        if (recipient.isGM) {
          theyCard = cards[kind];
          continue;
        }
        const actor = await this.ensureCharacter(recipient);
        await actor.update({ [`system.${kind}.text`]: cards[kind] });
      }
    }
    return theyCard;
  }

  /**
   * Every player at the table needs a sheet to receive cards; create the missing ones, visible to their owner only. A
   * new ritual makes new characters, so existing sheets start blank again: nothing burned, no Moment lived, the default
   * order.
   */
  async prepareCharacters() {
    for (const user of this.table.users.filter((u) => !u.isGM && u.active)) await this.ensureCharacter(user, true);
  }

  /**
   * A player's character in this game, made now if they have none (e.g. they joined after the ritual began). One left
   * over from an earlier game starts blank, like at the start of the ritual. Marked with the game, so the player keeps
   * their seat while their connection is gone.
   */
  async ensureCharacter(user, blank = false) {
    const gameId = this.state().gameId;
    const actor = user.character;
    if (actor && !blank && actor.getFlag(MODULE_ID, "gameId") === gameId) return actor;
    if (actor) {
      await actor.update({ system: actor.system.schema.getInitialValue(), [`flags.${MODULE_ID}.gameId`]: gameId });
      return actor;
    }
    const created = await Actor.implementation.create({
      name: user.name,
      type: "character",
      ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE, [user.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER },
      flags: { [MODULE_ID]: { gameId } }
    });
    await user.update({ character: created.id });
    return created;
  }
}
