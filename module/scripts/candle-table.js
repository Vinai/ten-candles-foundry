/**
 * Renders the candle table into a plain 2D canvas: the tray painting, the bowl, ten animated tealight flames and
 * the light they cast. Deliberately independent of Foundry so it can run as a full-screen overlay (and be tried
 * outside Foundry). All positions are in painting pixels; the painting is fitted into the canvas and zoomed out.
 */

// Wick tips and bowl centre measured on the Game Assistant tray painting (3840×2160), clockwise from the top.
// `sink` is how far the flame base sits below the tip; the back candles' wicks are foreshortened and shorter.
export const PAINTING = {
  width: 3840,
  height: 2160,
  focus: { x: 1940, y: 1010 },
  tray: { x: 1930, y: 1057, rx: 625, ry: 285 },
  wicks: [
    { x: 1958, y: 748, sink: 18 }, { x: 2205, y: 778, sink: 30 }, { x: 2365, y: 874, sink: 30 },
    { x: 2347, y: 986, sink: 30 }, { x: 2165, y: 1071, sink: 30 }, { x: 1933, y: 1118, sink: 30 },
    { x: 1690, y: 1076, sink: 30 }, { x: 1510, y: 981, sink: 30 }, { x: 1515, y: 858, sink: 30 },
    { x: 1700, y: 804, sink: 14 }
  ],
  bowl: { x: 1940, y: 965, rx: 150, ry: 58, depth: 62 }
};

const FLAME_HEIGHT = 78;
const GLOW_RADIUS = 1100;
const NEAR_GLOW_RADIUS = 260;
const LIGHT_MAP_SCALE = 0.25;
const FRAME_MS = 1000 / 30;
const LIGHT_UP_MS = 1400;
const SNUFF_MS = 700;
const SMOKE_MS = 7000;

// Room light before "Licht aus" and the residual darkness after it.
const ROOM_LIT = { r: 0.75, g: 0.62, b: 0.5 };
const ROOM_DARK = { r: 0.035, g: 0.04, b: 0.05 };

export class CandleTable {
  constructor(canvas, image, { zoom = 0.8, maxPixelRatio = 1.5 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.image = image;
    this.zoom = zoom;
    this.maxPixelRatio = maxPixelRatio;
    this.roomLight = 1;
    this.roomLightTarget = 1;
    this.candles = PAINTING.wicks.map((wick, index) => ({
      index,
      wick,
      state: "unlit", // unlit | lighting | lit | snuffing
      since: 0,
      gutter: 0,
      phase: Array.from({ length: 4 }, () => Math.random() * Math.PI * 2),
      dip: 0,
      level: 0
    }));
    this.smoke = [];
    this.lightMap = document.createElement("canvas");
    this.base = document.createElement("canvas");
    this.frame = this.frame.bind(this);
    this.lastFrame = 0;
    this.resize();
  }

  start() {
    this.running = true;
    requestAnimationFrame(this.frame);
  }

  stop() {
    this.running = false;
  }

  light(index) {
    const candle = this.candles[index];
    if (candle.state === "lit" || candle.state === "lighting") return;
    Object.assign(candle, { state: "lighting", since: performance.now(), gutter: 0 });
  }

  snuff(index) {
    const candle = this.candles[index];
    if (candle.state === "unlit" || candle.state === "snuffing") return;
    Object.assign(candle, { state: "snuffing", since: performance.now(), snuffFrom: candle.level });
  }

  /** 0 = steady, 1 = about to drown in its own wax. */
  setGutter(index, amount) {
    this.candles[index].gutter = Math.min(Math.max(amount, 0), 1);
  }

  /** 1 = room lights on, 0 = only candles. Fades smoothly. */
  setRoomLight(value) {
    this.roomLightTarget = value;
  }

  /** 0–1 brightness for things around the table (faces, cards): room light or what the candles give. */
  get lightLevel() {
    const candles = this.candles.reduce((sum, c) => sum + Math.max(c.level, 0), 0) / this.candles.length;
    return Math.max(this.roomLight, candles > 0.005 ? 0.15 + 0.85 * candles : 0);
  }

  /** The tray's centre and radii in CSS pixels, for placing seats around it. */
  get trayOnScreen() {
    const ratio = this.canvas.width / this.canvas.clientWidth;
    const c = this.toScreen(PAINTING.tray);
    return {
      x: c.x / ratio,
      y: c.y / ratio,
      rx: (PAINTING.tray.rx * this.scale) / ratio,
      ry: (PAINTING.tray.ry * this.scale) / ratio
    };
  }

  get litCount() {
    return this.candles.filter((c) => c.state === "lit" || c.state === "lighting").length;
  }

  resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio);
    const width = Math.round(this.canvas.clientWidth * ratio);
    const height = Math.round(this.canvas.clientHeight * ratio);
    this.canvas.width = width;
    this.canvas.height = height;

    const fit = Math.min(width / PAINTING.width, height / PAINTING.height);
    this.scale = fit / this.zoom;
    this.offsetX = width / 2 - PAINTING.focus.x * this.scale;
    this.offsetY = height / 2 - PAINTING.focus.y * this.scale;

    this.lightMap.width = Math.ceil(width * LIGHT_MAP_SCALE);
    this.lightMap.height = Math.ceil(height * LIGHT_MAP_SCALE);
    this.renderBase(width, height);
  }

  toScreen({ x, y }) {
    return { x: this.offsetX + x * this.scale, y: this.offsetY + y * this.scale };
  }

  /** Painting plus bowl, brightened once so the light map can darken it per frame without losing texture. */
  renderBase(width, height) {
    this.base.width = width;
    this.base.height = height;
    const ctx = this.base.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);
    // Mostly grey: the painting's teal would otherwise turn warm candlelight green.
    ctx.filter = "brightness(2.6) saturate(0.15)";
    ctx.drawImage(
      this.image,
      this.offsetX,
      this.offsetY,
      PAINTING.width * this.scale,
      PAINTING.height * this.scale
    );
    ctx.filter = "none";
    this.drawBowl(ctx);

    // Fade the painting's hard edges into the surrounding black.
    const centre = this.toScreen(PAINTING.focus);
    const vignette = ctx.createRadialGradient(
      centre.x, centre.y, 700 * this.scale,
      centre.x, centre.y, 1500 * this.scale
    );
    vignette.addColorStop(0, "rgba(0,0,0,0)");
    vignette.addColorStop(1, "rgba(0,0,0,1)");
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, width, height);
  }

  drawBowl(ctx) {
    const { x, y, rx, ry, depth } = PAINTING.bowl;
    const c = this.toScreen({ x, y });
    const s = this.scale;
    const w = rx * s;
    const h = ry * s;
    const d = depth * s;

    // Contact shadow on the tray.
    const shadow = ctx.createRadialGradient(c.x, c.y + d, w * 0.2, c.x, c.y + d, w * 1.3);
    shadow.addColorStop(0, "rgba(0,0,0,0.7)");
    shadow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = shadow;
    ctx.beginPath();
    ctx.ellipse(c.x, c.y + d, w * 1.3, h * 1.3, 0, 0, Math.PI * 2);
    ctx.fill();

    // Outer wall: from the rim's front edge down to a narrower foot.
    const wall = ctx.createLinearGradient(c.x - w, 0, c.x + w, 0);
    wall.addColorStop(0, "#1a1c1c");
    wall.addColorStop(0.45, "#4a4d4b");
    wall.addColorStop(1, "#141515");
    ctx.fillStyle = wall;
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, w, h, 0, 0, Math.PI);
    ctx.lineTo(c.x - w * 0.62, c.y + d);
    ctx.ellipse(c.x, c.y + d, w * 0.62, h * 0.55, 0, Math.PI, 0, true);
    ctx.closePath();
    ctx.fill();

    // Inner hollow with a little ash.
    const inner = ctx.createRadialGradient(c.x, c.y + h * 0.3, 0, c.x, c.y, w);
    inner.addColorStop(0, "#2b2927");
    inner.addColorStop(0.7, "#121212");
    inner.addColorStop(1, "#090909");
    ctx.fillStyle = inner;
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, w * 0.93, h * 0.86, 0, 0, Math.PI * 2);
    ctx.fill();

    // Rim highlight.
    ctx.strokeStyle = "rgba(150,150,140,0.55)";
    ctx.lineWidth = Math.max(1, 5 * s);
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, w * 0.965, h * 0.93, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  frame(now) {
    if (!this.running) return;
    requestAnimationFrame(this.frame);
    if (now - this.lastFrame < FRAME_MS) return;
    const dt = Math.min(now - this.lastFrame, 100);
    this.lastFrame = now;

    this.roomLight += (this.roomLightTarget - this.roomLight) * Math.min(1, dt / 900);
    for (const candle of this.candles) this.update(candle, now, dt);
    this.updateSmoke(dt);
    this.draw(now);
    this.onFrame?.(this);
  }

  update(candle, now, dt) {
    const t = now / 1000;
    const p = candle.phase;
    // Layered sines give a soft, never-repeating flicker; guttering adds deep, random dips.
    const flicker = 0.06 * Math.sin(t * 7.3 + p[0]) + 0.04 * Math.sin(t * 13.1 + p[1]) + 0.03 * Math.sin(t * 23.7 + p[2]);
    if (candle.gutter > 0 && Math.random() < candle.gutter * dt / 900) candle.dip = 0.4 + Math.random() * 0.5 * candle.gutter;
    candle.dip *= Math.pow(0.5, dt / 250);
    const steady = 1 - 0.35 * candle.gutter + flicker * (1 + 2.5 * candle.gutter) - candle.dip;

    const age = now - candle.since;
    switch (candle.state) {
      case "unlit":
        candle.level = 0;
        break;
      case "lighting": {
        const k = Math.min(age / LIGHT_UP_MS, 1);
        // A match flare that settles into a calm flame.
        candle.level = steady * (k + 0.35 * Math.sin(k * Math.PI));
        if (k === 1) candle.state = "lit";
        break;
      }
      case "lit":
        candle.level = steady;
        break;
      case "snuffing": {
        const k = Math.min(age / SNUFF_MS, 1);
        candle.level = candle.snuffFrom * (1 - k) * (1 - k);
        if (k === 1) {
          candle.state = "unlit";
          candle.level = 0;
          this.spawnSmoke(candle);
        }
        break;
      }
    }
    candle.sway = 0.07 * Math.sin(t * 2.1 + p[3]) + 0.05 * Math.sin(t * 5.3 + p[1]) * (1 + candle.gutter);
  }

  spawnSmoke(candle) {
    this.smoke.push({ x: candle.wick.x, y: candle.wick.y, age: 0, seed: Math.random() * 10 });
  }

  updateSmoke(dt) {
    for (const wisp of this.smoke) wisp.age += dt;
    this.smoke = this.smoke.filter((wisp) => wisp.age < SMOKE_MS);
  }

  draw(now) {
    const { ctx, canvas } = this;
    const lit = this.candles.filter((c) => c.level > 0.01);

    this.drawLightMap(lit);

    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(this.base, 0, 0);
    ctx.globalCompositeOperation = "multiply";
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.lightMap, 0, 0, canvas.width, canvas.height);

    ctx.globalCompositeOperation = "source-over";
    this.drawSmoke(now);

    ctx.globalCompositeOperation = "lighter";
    for (const candle of lit) this.drawFlame(candle);
    ctx.globalCompositeOperation = "source-over";
  }

  drawLightMap(lit) {
    const lm = this.lightMap;
    const ctx = lm.getContext("2d");
    const k = this.roomLight;
    const mix = (a, b) => Math.round(255 * (b + (a - b) * k));
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = `rgb(${mix(ROOM_LIT.r, ROOM_DARK.r)},${mix(ROOM_LIT.g, ROOM_DARK.g)},${mix(ROOM_LIT.b, ROOM_DARK.b)})`;
    ctx.fillRect(0, 0, lm.width, lm.height);

    ctx.globalCompositeOperation = "lighter";
    const s = this.scale * LIGHT_MAP_SCALE;
    for (const candle of lit) {
      const x = (this.offsetX + candle.wick.x * this.scale) * LIGHT_MAP_SCALE;
      const y = (this.offsetY + (candle.wick.y + candle.wick.sink - 45) * this.scale) * LIGHT_MAP_SCALE;
      const level = Math.max(candle.level, 0);
      this.glow(ctx, x, y, GLOW_RADIUS * s, `rgba(255,150,70,${0.42 * level})`);
      this.glow(ctx, x, y, NEAR_GLOW_RADIUS * s, `rgba(255,205,140,${0.55 * level})`);
    }
  }

  glow(ctx, x, y, radius, colour) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
    g.addColorStop(0, colour);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }

  drawFlame(candle) {
    const { ctx } = this;
    const level = Math.max(candle.level, 0);
    const base = this.toScreen({ x: candle.wick.x, y: candle.wick.y + candle.wick.sink });
    const h = FLAME_HEIGHT * this.scale * (0.35 + 0.65 * Math.min(level, 1.3));
    const w = h * 0.36;
    const tipX = base.x + candle.sway * h;
    const tipY = base.y - h;

    // Halo around the flame itself.
    this.glow(ctx, base.x, base.y - h * 0.45, h * 1.6, `rgba(255,160,70,${0.18 * level})`);

    const body = (scale, stops) => {
      const g = ctx.createRadialGradient(base.x, base.y - h * 0.22 * scale, 0, base.x, base.y - h * 0.3 * scale, h * 0.75 * scale);
      for (const [offset, colour] of stops) g.addColorStop(offset, colour);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(base.x, base.y + h * 0.08 * scale);
      ctx.bezierCurveTo(
        base.x - w * scale, base.y + h * 0.02 * scale,
        base.x - w * 0.8 * scale + candle.sway * h * 0.3, base.y - h * 0.5 * scale,
        tipX * scale + base.x * (1 - scale), base.y - h * scale
      );
      ctx.bezierCurveTo(
        base.x + w * 0.8 * scale + candle.sway * h * 0.3, base.y - h * 0.5 * scale,
        base.x + w * scale, base.y + h * 0.02 * scale,
        base.x, base.y + h * 0.08 * scale
      );
      ctx.fill();
    };

    // Translucent enough that the painted wick shows through the lower flame.
    body(1, [
      [0, `rgba(255,225,170,${0.55 * level})`],
      [0.45, `rgba(255,150,55,${0.45 * level})`],
      [1, "rgba(160,40,0,0)"]
    ]);
    body(0.55, [
      [0, `rgba(255,250,235,${0.6 * level})`],
      [0.6, `rgba(255,225,150,${0.45 * level})`],
      [1, "rgba(255,180,80,0)"]
    ]);

    // The faint blue root of a real flame.
    ctx.fillStyle = `rgba(80,110,255,${0.25 * level})`;
    ctx.beginPath();
    ctx.ellipse(base.x, base.y + h * 0.02, w * 0.45, h * 0.07, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  drawSmoke() {
    const { ctx } = this;
    for (const wisp of this.smoke) {
      const k = wisp.age / SMOKE_MS;
      // Soft overlapping puffs along a rising, widening curl read as one continuous wisp.
      const steps = 28;
      for (let i = 0; i < steps; i++) {
        const rise = (wisp.age / 1000) * 45 - i * 6;
        if (rise < 0) continue;
        const x = wisp.x + Math.sin(rise / 35 + wisp.seed) * (4 + rise * 0.15);
        const p = this.toScreen({ x, y: wisp.y - rise });
        const alpha = 0.07 * (1 - k) * (1 - i / steps);
        this.glow(ctx, p.x, p.y, (7 + rise * 0.09) * this.scale, `rgba(175,175,175,${alpha})`);
      }

      // The wick keeps glowing for a moment after the flame is gone.
      const ember = 1 - wisp.age / 3000;
      if (ember > 0) {
        const p = this.toScreen(wisp);
        ctx.globalCompositeOperation = "lighter";
        this.glow(ctx, p.x, p.y + 4 * this.scale, 6 * this.scale, `rgba(255,80,20,${0.8 * ember})`);
        ctx.globalCompositeOperation = "source-over";
      }
    }
  }
}
