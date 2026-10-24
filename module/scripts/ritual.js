import { MODULE_ID, SOCKET } from "./constants.js";
import { leftOf, rightOf } from "./seat-layout.js";
import { SETTINGS } from "./settings.js";

// Long enough for the slide in stage.js (1.8 s) to land before the cards appear in the recipients' stacks.
const PASS_MS = 2000;

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

const LABELS = {
  virtue: "TCT.Card.Virtue",
  vice: "TCT.Card.Vice",
  moment: "TCT.Card.Moment",
  brink: "TCT.Card.Brink"
};

/**
 * World setting `ritual`: {gameId, step, cards: {writerId: {virtue, vice, moment, brink}}, passing, theyCard}.
 * Players hand what they wrote to the active GM over the module socket; the GM's browser keeps the setting and writes
 * passed cards into the recipients' Game Assistant sheets.
 */
export class Ritual {
  constructor(table) {
    this.table = table;
  }

  start() {
    game.socket.on(SOCKET, (message) => this.onSocket(message));
    this.onChange();
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
        faceDown: !user.isSelf
      }));
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
    // Everyone asked to write gets the card in front of them once per step.
    if (this.step.writes && this.promptedStep !== state.step && this.writers().includes(game.user)) {
      this.promptedStep = state.step;
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
        // Brinks travel face down; only writer and recipient know what they say. Virtues go right, the rest left.
        this.table.stage.slideCard(
          users.indexOf(writer),
          users.indexOf(recipient),
          { label: game.i18n.localize(LABELS[kind]), text: cards[kind], faceDown: kind === "brink" },
          kind === "virtue" ? -1 : 1
        );
      }
    }
  }

  /** Opens the card(s) of the current step for this user; can be reopened to rewrite until they are passed. */
  async write() {
    const step = this.step;
    if (!step.writes || !this.writers().includes(game.user)) return;
    const own = this.state().cards[game.user.id] ?? {};
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
    if (game.user === game.users.activeGM) await this.store(game.user.id, cards);
    else game.socket.emit(SOCKET, { type: "write", writer: game.user.id, cards });
  }

  prompt(kinds, own) {
    const escape = foundry.utils.escapeHTML;
    const name = (user) => escape(user.character?.name || user.name);
    const field = (kind, label) =>
      `<label class="tct-write-field"><span>${escape(game.i18n.localize(label))}</span>` +
      `<input type="text" name="${kind}" value="${escape(own[kind] ?? "")}" autocomplete="off" autofocus></label>`;

    if (kinds.includes("virtue")) {
      return {
        title: game.i18n.localize("TCT.Write.TraitsTitle"),
        hint: game.i18n.format("TCT.Write.TraitsHint", {
          right: name(this.recipient(game.user, "virtue")),
          left: name(this.recipient(game.user, "vice"))
        }),
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

  onSocket(message) {
    if (message?.type !== "write" || game.user !== game.users.activeGM) return;
    if (!game.users.get(message.writer)) return;
    this.store(message.writer, message.cards);
  }

  async store(writerId, cards) {
    const state = this.state();
    const writes = this.step.writes ?? [];
    const accepted = Object.fromEntries(Object.entries(cards).filter(([kind]) => writes.includes(kind)));
    await this.save({ ...state, cards: { ...state.cards, [writerId]: { ...state.cards[writerId], ...accepted } } });
  }

  // GM side --------------------------------------------------------------------------------------------------------

  async next() {
    const state = this.state();
    const step = STEPS[state.step];
    if (!step?.next) return;
    if (state.step === "idle") await this.ensureCharacters();
    if (step.pass) {
      await this.save({ ...state, passing: { at: Date.now() } });
      await new Promise((resolve) => window.setTimeout(resolve, PASS_MS));
    }
    const theyCard = step.writes ? await this.deliver(state, step.writes) : state.theyCard;
    await this.save({ ...this.state(), step: step.next, passing: null, theyCard });
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
        const actor = recipient.character;
        if (!actor) {
          ui.notifications.warn(game.i18n.format("TCT.Warn.NoCharacter", { name: recipient.name }));
          continue;
        }
        await actor.update({ [`system.${kind}.text`]: cards[kind] });
      }
    }
    return theyCard;
  }

  /** Every player needs a sheet to receive cards; create the missing ones, visible to their owner only. */
  async ensureCharacters() {
    for (const user of this.table.users.filter((u) => !u.isGM && !u.character)) {
      const actor = await Actor.implementation.create({
        name: user.name,
        type: "character",
        ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE, [user.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER }
      });
      await user.update({ character: actor.id });
    }
  }
}
