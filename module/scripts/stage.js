import { CandleTable } from "./candle-table.js";
import { seatPositions } from "./seat-layout.js";

// Seats sit on an ellipse this much wider/taller than the tray; card stacks lie just outside the tray's rim.
const SEAT_SPREAD_X = 1.75;
const SEAT_SPREAD_Y = 2.3;
const STACK_SPREAD_X = 1.28;
const STACK_SPREAD_Y = 1.45;
const TOTAL_DICE = 10;
const SLIDE_MS = 1800;
const TO_BOWL_MS = 1400;
// Matches the tct-burn animation in ten-candles.css.
const BURN_MS = 2400;
// Single words fill a card; Moments and Brinks are whole sentences and get smaller writing.
const LONG_TEXT = 14;

/**
 * The whole table as one full-screen layer: candle canvas, faces around the tray, card stacks and dice.
 * Knows nothing about Foundry; callers hand in face elements (camera videos or placeholders) and game state.
 */
export class TableStage {
  constructor(parent, image, { seats, viewer }) {
    this.root = document.createElement("div");
    this.root.className = "tct-stage";
    const canvas = document.createElement("canvas");
    canvas.className = "tct-table";
    this.root.append(canvas);
    parent.append(this.root);

    this.table = new CandleTable(canvas, image);
    this.table.onFrame = () => this.updateLight();
    this.dice = this.createDice();
    this.setSeats(seats, viewer);
    this.onResize = () => {
      this.table.resize();
      this.layout();
    };
    window.addEventListener("resize", this.onResize);
  }

  start() {
    this.table.start();
  }

  destroy() {
    this.table.stop();
    window.removeEventListener("resize", this.onResize);
    this.root.remove();
  }

  /** @param seats {{name: string, face: HTMLElement, cards: {label: string, text?: string, faceDown?: boolean}[], hope?: boolean}[]} */
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
      pile.append(el);
    });
    if (data.hope) {
      const die = document.createElement("div");
      die.className = "tct-hope-die";
      pile.append(die);
    }
    stack.replaceChildren(pile);
  }

  /**
   * A card travels round the table, along the ring of stacks, from one seat to another.
   * @param direction {1|-1} 1 passes to the left (clockwise), -1 to the right
   * @returns {Promise<void>} resolves once it has arrived (and is gone again; the recipient's stack shows it then)
   */
  slideCard(from, to, { label, text, faceDown = false }, direction = 1) {
    const card = this.flyingCard({ label, text, faceDown });

    const count = this.seats.length;
    const seatsAway = direction > 0 ? (((to - from) % count) + count) % count : -((((from - to) % count) + count) % count);
    const startAngle = this.seatElements[from].angle;
    const sweep = (seatsAway * 2 * Math.PI) / count;
    const tray = this.table.trayOnScreen;
    const keyframes = Array.from({ length: 25 }, (_, i) => {
      const angle = startAngle + (sweep * i) / 24;
      const x = tray.x + Math.cos(angle) * tray.rx * STACK_SPREAD_X;
      const y = tray.y + Math.sin(angle) * tray.ry * STACK_SPREAD_Y;
      return { left: `${x}px`, top: `${y}px` };
    });
    const animation = card.animate(keyframes, { duration: SLIDE_MS, easing: "ease-in-out", fill: "forwards" });
    return animation.finished.then(() => card.remove());
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
    this.table.flareBowl();
    await new Promise((resolve) => window.setTimeout(resolve, BURN_MS));
    card.remove();
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
    return card;
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
      stack.style.left = `${tray.x + Math.cos(pos.angle) * tray.rx * STACK_SPREAD_X}px`;
      stack.style.top = `${tray.y + Math.sin(pos.angle) * tray.ry * STACK_SPREAD_Y}px`;
    });
    if (this.xCard) {
      const bowl = this.table.bowlOnScreen;
      this.xCard.style.left = `${bowl.x + bowl.rx * 1.55}px`;
      this.xCard.style.top = `${bowl.y - bowl.ry * 0.2}px`;
    }
    if (this.mirror) {
      const bowl = this.table.bowlOnScreen;
      this.mirror.style.left = `${bowl.x}px`;
      this.mirror.style.top = `${bowl.y}px`;
    }
    this.dice.style.left = `${tray.x}px`;
    this.dice.style.top = `${tray.y + tray.ry + 10}px`;
  }

  updateLight() {
    const level = this.table.lightLevel.toFixed(3);
    if (level !== this.lastLight) {
      this.root.style.setProperty("--tct-light", level);
      this.lastLight = level;
    }
  }
}
