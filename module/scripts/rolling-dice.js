import { seeded } from "./random.js";

// How long a die takes from the roller's hand to rest; each die a little different.
const ROLL_MS = 1900;
const ROLL_SPREAD_MS = 500;
// Share of its flight after which a die first hits the table.
const LANDING = 0.5;
const FADE_MS = 600;
// Dice lie at least this many die widths apart (centre to centre), so none covers another.
const SPACING = 1.5;
// Spots tried for each die; always this many, so every browser draws the same random numbers.
const TRIES = 24;

const SKULL =
  '<svg class="tct-skull" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" ' +
  'd="M12 2C7 2 3.5 5.6 3.5 10.2c0 2.7 1.2 4.6 3 5.8V19a1 1 0 0 0 1 1h1.5v-2h1.5v2h3v-2h1.5v2h1.5a1 1 0 0 0 1-1v-3' +
  "c1.8-1.2 3-3.1 3-5.8C20.5 5.6 17 2 12 2Zm-3.6 7.2a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm7.2 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z" +
  'M12 13.6l1.3 2.2h-2.6l1.3-2.2Z"/></svg>';

/** A small black skull in place of a 1, the face that costs the players a die. Always a 1, never other text. */
export function skull() {
  return `<span class="tct-skull-face" role="img" aria-label="1" title="1">${SKULL}</span>`;
}

// Which of the nine pip spots are filled for each face, row by row.
const PIPS = {
  2: [2, 6],
  3: [2, 4, 6],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8]
};

// How the cube turns to show a face on top (towards the viewer); opposite faces add up to 7.
const SHOW = {
  1: { x: 0, y: 0 },
  2: { x: 0, y: -90 },
  3: { x: -90, y: 0 },
  4: { x: 90, y: 0 },
  5: { x: 0, y: 90 },
  6: { x: 0, y: 180 }
};

/**
 * Dice thrown across the table: from the roller's place onto the tray around the bowl, tumbling as cubes and settling
 * on exactly the faces the game rolled. They stay where they fell until cleared.
 */
export class RollingDice {
  /** @param onLanding {() => void} called as a throw first hits the table */
  constructor(root, onLanding = () => {}) {
    this.root = root;
    this.onLanding = onLanding;
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
    const elements = dice.map((die) => {
      const el = document.createElement("div");
      el.className = `tct-roll-die is-${die.kind}`;
      el.innerHTML = `<div class="tct-die-cube">${[1, 2, 3, 4, 5, 6].map(face).join("")}</div>`;
      this.root.append(el);
      this.dice.push(el);
      return el;
    });
    const size = elements[0]?.offsetWidth ?? 0;
    const spots = scatter(area, dice.length, size * SPACING, random);
    const landing = window.setTimeout(() => this.onLanding(), ROLL_MS * LANDING);
    return Promise.all(dice.map((die, i) => this.throw(elements[i], die.value, from, spots[i], random)))
      .then(() => {})
      .finally(() => window.clearTimeout(landing));
  }

  throw(el, value, from, to, random) {
    const duration = ROLL_MS + random() * ROLL_SPREAD_MS;
    // Whole turns about each axis, then the turn that brings the rolled face up, lying at a slant on the table.
    const show = SHOW[value] ?? SHOW[1];
    const turns = {
      x: 360 * (1 + Math.floor(random() * 2)) + show.x,
      y: 360 * (1 + Math.floor(random() * 2)) + show.y,
      z: (random() - 0.5) * 300
    };
    // Thrown in an arc that lands short, then bounces on along the table and rolls out.
    const at = (t) => ({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
    const path = [
      [0, 0, 0, 0],
      [0.45, 3.2, 0.45, 0.28],
      [0.7, 0, 0.7, LANDING],
      [0.82, 0.9, 0.86, 0.66],
      [0.93, 0, 0.96, 0.8],
      [1, 0, 1, 1]
    ];
    const timing = { duration, easing: "cubic-bezier(.25,.6,.35,1)", fill: "forwards" };
    const flight = el.animate(
      path.map(([t, lift, , offset]) => {
        const p = at(t);
        return {
          left: `${p.x}px`,
          top: `${p.y}px`,
          transform: `translate(-50%, -50%) translateY(${-lift}vw) scale(${1 + lift * 0.08})`,
          offset
        };
      }),
      timing
    );
    const tumble = el.firstElementChild.animate(
      path.map(([, , turned, offset]) => ({
        transform: `rotateZ(${turns.z * turned}deg) rotateX(${turns.x * turned}deg) rotateY(${turns.y * turned}deg)`,
        offset
      })),
      timing
    );
    return Promise.all([flight.finished, tumble.finished]).catch(() => {});
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

/** One side of a die: pips, or the skull for a 1. */
function face(value) {
  const content =
    value === 1
      ? SKULL
      : Array.from({ length: 9 }, (_, i) => `<span class="${PIPS[value].includes(i) ? "is-pip" : ""}"></span>`).join("");
  return `<div class="tct-die-face is-${value}">${content}</div>`;
}

/**
 * Spots in the landing ring, apart enough that no die lies on another. Where the ring is too crowded for that, a die
 * takes the spot furthest from the others.
 */
function scatter({ x, y, rx, ry, hole }, count, gap, random) {
  const spots = [];
  const offset = random() * Math.PI * 2;
  for (let i = 0; i < count; i++) {
    let best = null;
    let bestRoom = -1;
    for (let k = 0; k < TRIES; k++) {
      const angle = offset + ((i + random()) / count) * Math.PI * 2 + (random() - 0.5) * 1.2;
      const radius = hole + (1 - hole) * (0.2 + random() * 0.8);
      const spot = { x: x + Math.cos(angle) * rx * radius, y: y + Math.sin(angle) * ry * radius };
      const room = Math.min(Infinity, ...spots.map((other) => Math.hypot(spot.x - other.x, spot.y - other.y)));
      if (room > bestRoom && bestRoom < gap) {
        best = spot;
        bestRoom = room;
      }
    }
    spots.push(best);
  }
  return spots;
}
