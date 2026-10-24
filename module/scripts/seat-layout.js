/**
 * Seat geometry around the tray. Seats are stored in clockwise order (seen from above), so the next seat is the
 * left-hand neighbour: Brinks go to seats[i + 1], virtues to seats[i - 1], vices to seats[i + 1], truths go i → i + 1.
 * Every viewer sits at the bottom of their own screen; the others follow clockwise, i.e. bottom → left → top → right.
 */

export function neighbour(count, seat, step) {
  return (((seat + step) % count) + count) % count;
}

export function leftOf(count, seat) {
  return neighbour(count, seat, 1);
}

export function rightOf(count, seat) {
  return neighbour(count, seat, -1);
}

/**
 * Screen positions for all seats as seen by `viewer`.
 * @returns {{seat: number, x: number, y: number, angle: number, isViewer: boolean}[]} indexed by seat
 */
export function seatPositions({ count, viewer, centerX, centerY, radiusX, radiusY }) {
  return Array.from({ length: count }, (_, seat) => {
    const offset = neighbour(count, seat, -viewer);
    // Screen y points down, so increasing angles run bottom → left → top → right.
    const angle = Math.PI / 2 + (offset * 2 * Math.PI) / count;
    return {
      seat,
      angle,
      x: centerX + Math.cos(angle) * radiusX,
      y: centerY + Math.sin(angle) * radiusY,
      isViewer: offset === 0
    };
  });
}
