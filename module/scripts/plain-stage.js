/**
 * Stands in for TableStage on a plain table: nothing is drawn, Foundry's scene and camera dock stay. What the table
 * would show only as a picture is left out; the ritual words come as notifications, and the X-card is a small button.
 */
export class PlainStage {
  constructor() {
    this.table = { setGutter() {}, setRoomLight() {} };
  }

  start() {}
  setSeats() {}
  updateSeat() {}
  slideCard() {}
  setRecorder() {}
  setCandles() {}
  setDice() {}
  clearPhrase() {}
  flashX() {}

  burnCard() {
    return Promise.resolve();
  }

  rollDice() {
    return Promise.resolve();
  }

  clearDice() {}
  recorderClick() {}
  route() {}

  showPhrase(lines) {
    ui.notifications.info(lines.join(" "));
    return Promise.resolve();
  }

  addXCard(onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tct-xcard is-plain";
    button.textContent = "X";
    button.addEventListener("click", onClick);
    document.body.append(button);
  }
}
