import { CandleTable } from "./candle-table.js";
import { seatPositions } from "./seat-layout.js";

// Seats sit on an ellipse this much wider/taller than the tray; card stacks lie just outside the tray's rim.
const SEAT_SPREAD_X = 1.75;
const SEAT_SPREAD_Y = 2.3;
const STACK_SPREAD_X = 1.28;
const STACK_SPREAD_Y = 1.45;
const TOTAL_DICE = 10;

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
      seat.classList.toggle("is-viewer", pos.isViewer);
      // Seats across the table carry their name above the face, away from their cards.
      seat.classList.toggle("is-far", Math.sin(pos.angle) < -0.2);
      seat.style.left = `${pos.x}px`;
      seat.style.top = `${pos.y}px`;
      stack.style.left = `${tray.x + Math.cos(pos.angle) * tray.rx * STACK_SPREAD_X}px`;
      stack.style.top = `${tray.y + Math.sin(pos.angle) * tray.ry * STACK_SPREAD_Y}px`;
    });
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
