import { CandleTable } from "./candle-table.js";
import { RollingDice } from "./rolling-dice.js";
import { seatPositions } from "./seat-layout.js";

// Seats sit on an ellipse this much wider/taller than the tray; card stacks lie just outside the tray's rim.
const SEAT_SPREAD_X = 1.75;
const SEAT_SPREAD_Y = 2.3;
const STACK_SPREAD_X = 1.28;
const STACK_SPREAD_Y = 1.45;
const TOTAL_DICE = 10;
// The dice row hangs this far below the tray; its dice and the stacks are sized in vw (see ten-candles.css).
const DICE_ROW_GAP = 10;
const DIE_VW = 1.1;
const STACK_GAP_VW = 0.4;
const STACK_HALF_VW = 1.65;
const MAX_PEEK_VW = 0.72;
const SLIDE_MS = 1800;
// A passed card fades where it arrives; the recipient's stack shows it from then on.
const ARRIVE_FADE_MS = 400;
const TO_BOWL_MS = 1400;
// Matches the tct-burn and tct-fire animations in ten-candles.css, and the card-burn sound.
const BURN_MS = 10000;
const FLAMES = 7;
const SPARKS = 14;
// The recorder lies beside a seat's cards, a little clockwise of them.
const RECORDER_OFFSET = 0.32;
// Single words fill a card; Moments and Brinks are whole sentences and get smaller writing.
const LONG_TEXT = 14;
// Writing shrinks until it fits its card, but no smaller than this share of its size.
const MIN_FIT = 0.45;

/**
 * The whole table as one full-screen layer: candle canvas, faces around the tray, card stacks and dice.
 * Knows nothing about Foundry; callers hand in face elements (camera videos or placeholders) and game state.
 */
export class TableStage {
  /** @param sounds {TableSounds} the table's sounds, shared with what the table does without pictures */
  constructor(parent, image, { seats, viewer, sounds }) {
    this.sounds = sounds;
    this.root = document.createElement("div");
    this.root.className = "tct-stage";
    const canvas = document.createElement("canvas");
    canvas.className = "tct-table";
    this.root.append(canvas);
    parent.append(this.root);

    this.table = new CandleTable(canvas, image);
    this.table.onFrame = () => this.updateLight();
    this.dice = this.createDice();
    this.rolling = new RollingDice(this.root, (count) => this.sounds.dice(count));
    this.setSeats(seats, viewer);
    this.onResize = () => {
      this.table.resize();
      this.layout();
    };
    window.addEventListener("resize", this.onResize);
    // Cards drawn before the handwriting arrived were measured in another font.
    document.fonts.load('600 1em "Caveat"').then(() => this.root.querySelectorAll(".tct-card-text").forEach(fitText));
  }

  start() {
    this.table.start();
  }

  destroy() {
    this.table.stop();
    window.removeEventListener("resize", this.onResize);
    this.root.remove();
  }

  /**
   * @param seats {{name: string, face: HTMLElement, cards: {label: string, text?: string, faceDown?: boolean,
   *   edit?: () => void}[], hope?: boolean}[]} a card with `edit` can be clicked to rewrite it
   */
  setSeats(seats, viewer) {
    this.seatElements?.forEach(({ seat, stack }) => {
      seat.remove();
      stack.remove();
    });
    this.seats = seats;
    this.viewer = viewer;
    this.seatElements = seats.map((data) => {
      const seat = document.createElement("div");
      seat.className = "tct-seat";
      const face = document.createElement("div");
      face.className = "tct-face";
      face.append(data.face);
      const name = document.createElement("div");
      name.className = "tct-name";
      name.textContent = data.name;
      seat.append(face, name);

      const stack = document.createElement("div");
      stack.className = "tct-seat";
      this.root.append(seat, stack);
      return { seat, stack };
    });
    this.seats.forEach((_, index) => this.renderStack(index));
    this.layout();
  }

  /** Replace one seat's name, cards and hope die without rebuilding the table. */
  updateSeat(index, data) {
    this.seats[index] = data;
    this.seatElements[index].seat.querySelector(".tct-name").textContent = data.name;
    this.renderStack(index);
  }

  renderStack(index) {
    const data = this.seats[index];
    const { stack } = this.seatElements[index];
    const pile = document.createElement("div");
    pile.className = "tct-stack";
    data.cards.forEach((card, depth) => {
      const el = document.createElement("div");
      el.className = "tct-card" + (card.faceDown ? " is-face-down" : "");
      // Cards further down the stack peek out slightly up and to the left.
      const peek = (data.cards.length - 1 - depth) * 0.18;
      el.style.transform = `translate(${-peek}vw, ${-peek}vw) rotate(${(depth % 2 ? -1 : 1) * 1.5}deg)`;
      if (!card.faceDown && depth === data.cards.length - 1) {
        el.innerHTML = `<span class="tct-card-label"></span><span class="tct-card-text"></span>`;
        el.querySelector(".tct-card-label").textContent = card.label;
        el.querySelector(".tct-card-text").textContent = card.text ?? "";
        el.classList.toggle("is-long", (card.text ?? "").length > LONG_TEXT);
      }
      if (card.edit) {
        el.classList.add("is-editable");
        el.dataset.tooltip = game.i18n.localize("TCT.Write.EditHint");
        el.addEventListener("click", card.edit);
      }
      pile.append(el);
    });
    if (data.hope) {
      const die = document.createElement("div");
      die.className = "tct-hope-die";
      pile.append(die);
    }
    stack.replaceChildren(pile);
    stack.querySelectorAll(".tct-card-text").forEach(fitText);
  }

  /**
   * A card travels round the table, along the ring of stacks, from one seat to another.
   * @param direction {1|-1} 1 passes to the left (clockwise), -1 to the right
   * @returns {Promise<void>} resolves once it has arrived (and is gone again; the recipient's stack shows it then)
   */
  slideCard(from, to, { label, text, faceDown = false }, direction = 1) {
    const card = this.flyingCard({ label, text, faceDown });
    const stackAt = (seat) => {
      const { stack } = this.seatElements[seat];
      return { x: parseFloat(stack.style.left), y: parseFloat(stack.style.top) };
    };
    return this.travel(card, from, to, direction, 0, { start: stackAt(from), end: stackAt(to) })
      .finished.then(() => card.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ARRIVE_FADE_MS, fill: "forwards" }).finished)
      .then(() => card.remove());
  }

  /**
   * Moves an element along the ring of stacks from one seat to another. With `ends`, it leaves and arrives exactly
   * there, e.g. at your own stack, which lies below the dice row rather than on the ring. @returns {Animation}
   */
  travel(element, from, to, direction = 1, offset = 0, ends = null) {
    const count = this.seats.length;
    const seatsAway = direction > 0 ? (((to - from) % count) + count) % count : -((((from - to) % count) + count) % count);
    const startAngle = this.seatElements[from].angle + offset;
    const sweep = (seatsAway * 2 * Math.PI) / count;
    const first = this.ringPoint(startAngle);
    const last = this.ringPoint(startAngle + sweep);
    // How far the ends lie off the ring; the path bends over from the one to the other.
    const startOff = ends ? { x: ends.start.x - first.x, y: ends.start.y - first.y } : { x: 0, y: 0 };
    const endOff = ends ? { x: ends.end.x - last.x, y: ends.end.y - last.y } : { x: 0, y: 0 };
    const keyframes = Array.from({ length: 25 }, (_, i) => {
      const t = i / 24;
      const { x, y } = this.ringPoint(startAngle + sweep * t);
      return {
        left: `${x + startOff.x * (1 - t) + endOff.x * t}px`,
        top: `${y + startOff.y * (1 - t) + endOff.y * t}px`
      };
    });
    return element.animate(keyframes, { duration: SLIDE_MS, easing: "ease-in-out", fill: "forwards" });
  }

  /** A point on the ring the card stacks lie on. */
  ringPoint(angle) {
    const tray = this.table.trayOnScreen;
    return { x: tray.x + Math.cos(angle) * tray.rx * STACK_SPREAD_X, y: tray.y + Math.sin(angle) * tray.ry * STACK_SPREAD_Y };
  }

  /**
   * The voice recorder in front of `seat`, or put away (null). Travels round the table when it changes hands.
   * Its light is on while it records.
   */
  setRecorder(seat, { recording = false, instant = false } = {}) {
    if (!this.recorder) {
      this.recorder = document.createElement("div");
      this.recorder.className = "tct-recorder";
      this.recorder.innerHTML = `<span class="tct-recorder-grille"></span><span class="tct-recorder-led"></span>`;
      this.root.append(this.recorder);
    }
    if (this.recorder.classList.contains("is-recording") !== recording) this.sounds.click(recording);
    this.recorder.classList.toggle("is-recording", recording);
    const from = this.recorderSeat ?? null;
    this.recorderSeat = seat >= 0 ? seat : null;
    this.recorder.hidden = this.recorderSeat === null;
    if (instant || from === null || this.recorderSeat === null || from === this.recorderSeat) {
      this.placeRecorder();
      return;
    }
    this.recorderTrip?.cancel();
    const trip = (this.recorderTrip = this.travel(this.recorder, from, this.recorderSeat, 1, RECORDER_OFFSET));
    trip.finished
      .then(() => {
        this.placeRecorder();
        trip.cancel();
      })
      .catch(() => {});
  }

  placeRecorder() {
    if (!this.recorder || !this.seatElements[this.recorderSeat]) return;
    const { x, y } = this.ringPoint(this.seatElements[this.recorderSeat].angle + RECORDER_OFFSET);
    this.recorder.style.left = `${x}px`;
    this.recorder.style.top = `${y}px`;
  }

  /**
   * A trait is spent: its card is held up, dropped into the bowl and burns there.
   * @returns {Promise<void>} resolves once only ash is left
   */
  async burnCard(seat, { label, text }) {
    const card = this.flyingCard({ label, text });
    const { stack } = this.seatElements[seat];
    const bowl = this.table.bowlOnScreen;
    const from = { left: stack.style.left, top: stack.style.top };
    const lift = { left: stack.style.left, top: `${parseFloat(stack.style.top) - 30}px` };
    const into = { left: `${bowl.x}px`, top: `${bowl.y - bowl.ry * 0.15}px` };
    const flight = card.animate(
      [
        { ...from, transform: "translate(-50%, -50%) rotate(-4deg) scale(1)" },
        { ...lift, transform: "translate(-50%, -50%) rotate(-2deg) scale(1.25)", offset: 0.3 },
        // Lands lying flat in the bowl.
        { ...into, transform: "translate(-50%, -50%) perspective(20vw) rotateX(55deg) rotate(8deg) scale(0.75)" }
      ],
      { duration: TO_BOWL_MS, easing: "ease-in-out", fill: "forwards" }
    );
    await flight.finished;
    card.classList.add("is-burning");
    const fire = this.fire(into);
    this.table.flareBowl();
    this.sounds.burn();
    await new Promise((resolve) => window.setTimeout(resolve, BURN_MS));
    card.remove();
    fire.remove();
  }

  /** Flames licking up from the card, sparks and smoke rising: each tongue with its own size and rhythm. */
  fire(at) {
    const fire = document.createElement("div");
    fire.className = "tct-fire";
    fire.style.left = at.left;
    fire.style.top = at.top;
    const part = (className, props) => {
      const el = document.createElement("span");
      el.className = className;
      for (const [name, value] of Object.entries(props)) el.style.setProperty(name, value);
      fire.append(el);
    };
    for (let i = 0; i < FLAMES; i++) {
      part("tct-flame", {
        "--x": `${(i / (FLAMES - 1) - 0.5) * 2.8 + (Math.random() - 0.5) * 0.5}vw`,
        "--size": (0.6 + Math.random() * 0.7 - Math.abs(i / (FLAMES - 1) - 0.5) * 0.5).toFixed(2),
        "--speed": `${(0.35 + Math.random() * 0.35).toFixed(2)}s`,
        "--delay": `${(-Math.random()).toFixed(2)}s`
      });
    }
    for (let i = 0; i < SPARKS; i++) {
      part("tct-spark", {
        "--x": `${(Math.random() - 0.5) * 2.8}vw`,
        "--drift": `${(Math.random() - 0.5) * 3}vw`,
        "--speed": `${(1.2 + Math.random() * 1.4).toFixed(2)}s`,
        "--delay": `${(Math.random() * 8).toFixed(2)}s`
      });
    }
    for (let i = 0; i < 3; i++) part("tct-smoke", { "--delay": `${2 + i * 2.5}s`, "--x": `${(i - 1) * 1.2}vw` });
    this.root.append(fire);
    return fire;
  }

  /**
   * Dice thrown from a seat onto the middle of the tray (the bowl too), landing on the given faces.
   * @param dice {{value: number, kind: "player"|"hope"|"gm"}[]}
   * @returns {Promise<void>} once they are at rest
   */
  rollDice(seat, dice, seed) {
    const bowl = this.table.bowlOnScreen;
    const tray = this.table.trayOnScreen;
    const from = this.seatElements[seat] ? this.ringPoint(this.seatElements[seat].angle) : { x: tray.x, y: tray.y + tray.ry };
    const rx = tray.rx * 0.75;
    const ry = tray.ry * 0.72;
    return this.rolling.roll(from, { x: bowl.x, y: bowl.y, rx, ry }, dice, seed);
  }

  clearDice() {
    this.rolling.clear();
  }

  flyingCard({ label, text, faceDown = false }) {
    const card = document.createElement("div");
    card.className = "tct-card tct-flying" + (faceDown ? " is-face-down" : "");
    if (!faceDown) {
      card.innerHTML = `<span class="tct-card-label"></span><span class="tct-card-text"></span>`;
      card.querySelector(".tct-card-label").textContent = label;
      card.querySelector(".tct-card-text").textContent = text ?? "";
      card.classList.toggle("is-long", (text ?? "").length > LONG_TEXT);
    }
    this.root.append(card);
    card.querySelectorAll(".tct-card-text").forEach(fitText);
    return card;
  }

  /**
   * Lights and puts out candles to match `lit` (a set of candle indices). One match is struck for all candles lit
   * together; a candle going out is heard. `instant` does it silently, e.g. when a page loads mid-game.
   */
  setCandles(lit, { instant = false } = {}) {
    let struck = false;
    let snuffed = false;
    this.table.candles.forEach((_, index) => {
      if (lit.has(index)) struck = this.table.light(index, { instant }) || struck;
      else snuffed = this.table.snuff(index, { instant }) || snuffed;
    });
    if (instant) return;
    if (struck) this.sounds.strike();
    if (snuffed) this.sounds.snuff();
  }

  /** A card lying by the bowl that anyone can touch. */
  addXCard(onClick) {
    this.xCard = document.createElement("button");
    this.xCard.type = "button";
    this.xCard.className = "tct-xcard";
    this.xCard.textContent = "X";
    this.xCard.addEventListener("click", onClick);
    this.root.append(this.xCard);
    this.layout();
  }

  /** The place above the bowl where the current conflict lies in a pool of light. */
  addMirror() {
    this.mirror = document.createElement("div");
    this.mirror.className = "tct-mirror";
    this.root.append(this.mirror);
    this.layout();
    return this.mirror;
  }

  /**
   * Ritual words over the table, line by line: they rise out of the dark, linger and sink back. `final` words stay
   * until `clearPhrase`. A new phrase replaces the one showing.
   * @returns {Promise<void>} once the words have sunk back (or were replaced); at once for final words
   */
  showPhrase(lines, { delay = 0, final = false } = {}) {
    this.clearPhrase();
    const done = new Promise((resolve) => (this.phraseDone = resolve));
    if (final) this.phraseDone();
    const phrase = (this.phrase = document.createElement("div"));
    phrase.className = "tct-phrase" + (final ? " is-final" : "");
    phrase.append(
      ...lines.map((line) => {
        const span = document.createElement("span");
        span.textContent = line;
        return span;
      })
    );
    phrase.addEventListener("animationend", (event) => {
      if (event.target !== phrase || final) return;
      phrase.remove();
      this.phraseDone?.();
    });
    this.phraseTimer = window.setTimeout(() => this.root.append(phrase), delay);
    return done;
  }

  clearPhrase() {
    window.clearTimeout(this.phraseTimer);
    this.phrase?.remove();
    this.phrase = null;
    this.phraseDone?.();
  }

  /** Big, brief and nameless: someone touched the X-card. */
  flashX() {
    const flash = document.createElement("div");
    flash.className = "tct-xflash";
    flash.textContent = "X";
    this.root.append(flash);
    flash.addEventListener("animationend", () => flash.remove(), { once: true });
  }

  createDice() {
    const row = document.createElement("div");
    row.className = "tct-dice";
    this.root.append(row);
    return row;
  }

  /** Player pool (blue), dice lost to 1s this scene (dim blue), GM pool (red). */
  setDice({ player, lost, gm }) {
    const die = (kind) => {
      const el = document.createElement("div");
      el.className = `tct-die is-${kind}`;
      return el;
    };
    const gap = document.createElement("div");
    gap.className = "tct-dice-gap";
    this.dice.replaceChildren(
      ...Array.from({ length: player }, () => die("player")),
      ...Array.from({ length: lost }, () => die("lost")),
      gap,
      ...Array.from({ length: Math.min(gm, TOTAL_DICE) }, () => die("gm"))
    );
  }

  layout() {
    const tray = this.table.trayOnScreen;
    const positions = seatPositions({
      count: this.seats.length,
      viewer: this.viewer,
      centerX: tray.x,
      centerY: tray.y,
      radiusX: tray.rx * SEAT_SPREAD_X,
      radiusY: tray.ry * SEAT_SPREAD_Y
    });
    positions.forEach((pos, index) => {
      const { seat, stack } = this.seatElements[index];
      this.seatElements[index].angle = pos.angle;
      seat.classList.toggle("is-viewer", pos.isViewer);
      // Seats across the table carry their name above the face, away from their cards.
      seat.classList.toggle("is-far", Math.sin(pos.angle) < -0.2);
      seat.style.left = `${pos.x}px`;
      seat.style.top = `${pos.y}px`;
      const point = this.ringPoint(pos.angle);
      stack.style.left = `${point.x}px`;
      // Your own stack lies below the dice row, however many cards it holds.
      stack.style.top = `${pos.isViewer ? Math.max(point.y, this.belowDice(tray)) : point.y}px`;
    });
    this.placeRecorder();
    if (this.xCard) {
      // Beside the card over the bowl, never under it.
      const bowl = this.table.bowlOnScreen;
      const mirrorHalf = Math.min(Math.max(280, window.innerWidth * 0.21), 380) / 2;
      this.xCard.style.left = `${bowl.x + Math.max(bowl.rx * 1.55, mirrorHalf + 0.025 * window.innerWidth)}px`;
      this.xCard.style.top = `${bowl.y - bowl.ry * 0.2}px`;
    }
    if (this.mirror) {
      const bowl = this.table.bowlOnScreen;
      this.mirror.style.left = `${bowl.x}px`;
      this.mirror.style.top = `${bowl.y}px`;
    }
    this.dice.style.left = `${tray.x}px`;
    this.dice.style.top = `${tray.y + tray.ry + DICE_ROW_GAP}px`;
  }

  /** Where a stack's centre must be to clear the dice row under the tray, even with all cards fanned out. */
  belowDice(tray) {
    const vw = window.innerWidth / 100;
    return tray.y + tray.ry + DICE_ROW_GAP + (DIE_VW + STACK_GAP_VW + STACK_HALF_VW + MAX_PEEK_VW) * vw;
  }

  updateLight() {
    const level = this.table.lightLevel.toFixed(3);
    if (level !== this.lastLight) {
      this.root.style.setProperty("--tct-light", level);
      this.lastLight = level;
    }
  }
}

/** Shrinks a card's writing step by step until nothing sticks out. Sizes stay relative to the screen width. */
function fitText(text) {
  const overflows = () => text.scrollHeight > text.clientHeight + 1 || text.scrollWidth > text.clientWidth + 1;
  for (let fit = 1; fit >= MIN_FIT; fit -= 0.05) {
    text.style.setProperty("--tct-fit", fit.toFixed(2));
    if (!overflows()) return;
  }
}
