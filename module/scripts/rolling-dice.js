import { seeded } from "./random.js";

// How long a die takes from the roller's hand to rest; each die a little different.
const ROLL_MS = 1900;
const ROLL_SPREAD_MS = 500;
// Faces flicker past while a die tumbles, slower and slower.
const FLICKER_MS = 70;
const FADE_MS = 600;

const SKULL =
  '<svg class="tct-skull" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" ' +
  'd="M12 2C7 2 3.5 5.6 3.5 10.2c0 2.7 1.2 4.6 3 5.8V19a1 1 0 0 0 1 1h1.5v-2h1.5v2h3v-2h1.5v2h1.5a1 1 0 0 0 1-1v-3' +
  "c1.8-1.2 3-3.1 3-5.8C20.5 5.6 17 2 12 2Zm-3.6 7.2a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm7.2 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z" +
  'M12 13.6l1.3 2.2h-2.6l1.3-2.2Z"/></svg>';

/** A small black skull in place of a 1, the face that costs the players a die. */
export function skull(label = "1") {
  return `<span class="tct-skull-face" role="img" aria-label="${label}" title="${label}">${SKULL}</span>`;
}

// Which of the nine pip spots are filled for each face, row by row.
const PIPS = {
  2: [2, 6],
  3: [2, 4, 6],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8]
};

/**
 * Dice thrown across the table: from the roller's place onto the tray around the bowl, tumbling and settling on
 * exactly the faces the game rolled. They stay where they fell until cleared.
 */
export class RollingDice {
  constructor(root) {
    this.root = root;
    this.dice = [];
  }

  /**
   * @param from {{x: number, y: number}} where the dice leave the hand
   * @param area {{x: number, y: number, rx: number, ry: number, hole: number}} the ellipse they land in, with a hole
   *   (share of its size) they keep out of, so none ends up in the bowl
   * @param dice {{value: number, kind: "player"|"hope"|"gm"}[]}
   * @param seed {string} the same throw lands the same way in every browser
   * @returns {Promise<void>} once every die is at rest
   */
  roll(from, area, dice, seed) {
    const random = seeded(seed);
    const spots = scatter(area, dice.length, random);
    return Promise.all(
      dice.map((die, i) => {
        const el = document.createElement("div");
        el.className = `tct-roll-die is-${die.kind}`;
        this.root.append(el);
        this.dice.push(el);
        return this.throw(el, die.value, from, spots[i], random);
      })
    ).then(() => {});
  }

  throw(el, value, from, to, random) {
    const duration = ROLL_MS + random() * ROLL_SPREAD_MS;
    const turns = 2 + random() * 3;
    const rest = (random() - 0.5) * 50;
    // Thrown in an arc that lands short, then bounces on along the table and rolls out.
    const at = (t) => ({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
    const frame = (t, lift, angle, offset) => {
      const p = at(t);
      return {
        left: `${p.x}px`,
        top: `${p.y}px`,
        transform: `translate(-50%, -50%) translateY(${-lift}vw) rotate(${angle}deg) scale(${1 + lift * 0.08})`,
        offset
      };
    };
    const spin = 360 * turns;
    const animation = el.animate(
      [
        frame(0, 0, 0, 0),
        frame(0.45, 3.2, spin * 0.45, 0.28),
        frame(0.7, 0, spin * 0.7, 0.5),
        frame(0.82, 0.9, spin * 0.85, 0.66),
        frame(0.93, 0, spin * 0.95, 0.8),
        frame(1, 0, spin + rest, 1)
      ],
      { duration, easing: "cubic-bezier(.25,.6,.35,1)", fill: "forwards" }
    );
    // The faces flicker while it tumbles and slow down, then it shows what was rolled.
    const started = performance.now();
    const flicker = () => {
      const progress = (performance.now() - started) / duration;
      if (progress >= 0.9) return;
      this.face(el, 1 + Math.floor(random() * 6));
      window.setTimeout(flicker, FLICKER_MS / (1 - progress));
    };
    flicker();
    return animation.finished.then(() => this.face(el, value)).catch(() => {});
  }

  face(el, value) {
    if (value === 1) {
      el.innerHTML = SKULL;
      return;
    }
    const filled = PIPS[value] ?? [];
    el.innerHTML = Array.from({ length: 9 }, (_, i) => `<span class="${filled.includes(i) ? "is-pip" : ""}"></span>`).join("");
  }

  /** The dice are picked up again. */
  clear() {
    const dice = this.dice;
    this.dice = [];
    for (const el of dice) {
      el.classList.add("is-gone");
      window.setTimeout(() => el.remove(), FADE_MS);
    }
  }
}

/** Spots in the landing ring, spread out so dice rarely lie on top of each other. */
function scatter({ x, y, rx, ry, hole }, count, random) {
  const spots = [];
  const offset = random() * Math.PI * 2;
  for (let i = 0; i < count; i++) {
    const angle = offset + (i / count) * Math.PI * 2 + (random() - 0.5) * 0.5;
    const radius = hole + (1 - hole) * (0.25 + random() * 0.75);
    spots.push({ x: x + Math.cos(angle) * rx * radius, y: y + Math.sin(angle) * ry * radius });
  }
  return spots;
}
