import Phaser from 'phaser';
import { Walker, FOOT } from './walker.js';
import { pedTextureKey, makePedShadow, PED_SPRITE_M } from '../peds/pedSprites.js';
import { spriteSize } from '../traffic/npcSprites.js';
import { TYPES, COLORS } from '../traffic/trafficSim.js';

// Everything that is "the player as a person": getting out of the car (E), walking around, getting back in, and swapping into
// another car on the street (E beside it: it's yours now, no drama). The game scene owns the car, the traffic and the crowd;
// this reaches them through the scene.

const PLAYER_LOOK = { clothes: 1, skin: 1, hair: 2 }; // blue jacket
const SCALE = 1.25; // people are drawn a little bigger than life, like the crowd
const ENTER_RANGE = 3.6, SWAP_RANGE = 3.4, SWAP_MAX_SPEED = 11;

export class PlayerController {
  constructor(scene) {
    this.scene = scene;
    this.mode = 'car'; // 'car' | 'foot'
    this.walker = new Walker();
    this.swapped = false; // is the car the player is in (or left parked) one they swapped into?
    const kb = scene.input.keyboard;
    this.keys = kb.addKeys({ e: 'E', shift: 'SHIFT', up: 'UP', down: 'DOWN', left: 'LEFT', right: 'RIGHT', w: 'W', s: 'S', a: 'A', d: 'D' });
    makePedShadow(scene);
    this.shadow = scene.add.image(0, 0, 'ped_shadow').setDisplaySize(0.85 * SCALE, 0.5 * SCALE).setDepth(5.4).setVisible(false);
    this.body = scene.add.image(0, 0, this.frameKey(0)).setDisplaySize(PED_SPRITE_M * SCALE, PED_SPRITE_M * SCALE).setDepth(5.5).setVisible(false);
    this.frame = 0;
    this.prompt = document.getElementById('prompt');
    this.promptText = '';
  }

  frameKey(f) { return pedTextureKey(this.scene, PLAYER_LOOK.clothes, PLAYER_LOOK.skin, f, PLAYER_LOOK.hair); }

  get inCar() { return this.mode === 'car'; }

  /** where the player is (a car or a person), for the camera, the tiles, the traffic and the crowd */
  focus() {
    const c = this.scene.car;
    if (this.mode === 'car') return { x: c.x, y: c.y, vx: c.vx, vy: c.vy, heading: c.heading, layer: c.layer | 0, speed: c.speed };
    const w = this.walker;
    return { x: w.x, y: w.y, vx: w.vx, vy: w.vy, heading: w.heading, layer: w.layer | 0, speed: w.speed };
  }

  // ---------- getting in and out ----------
  say(text) { this.promptText = text; this.promptT = 1.4; }

  toggle() {
    if (this.mode === 'car') this.exitCar(); else this.enterOrSwap();
  }

  exitCar() {
    const s = this.scene, c = s.car, w = this.walker;
    if (c.speed > 4.5) { this.say('Slow down to get out'); return; }
    for (const side of [1, -1]) { // the driver's side first, then the other
      const x = c.x + Math.sin(c.heading) * 1.7 * side, y = c.y - Math.cos(c.heading) * 1.7 * side;
      if (s.collision.insideSolid(x, y) || s.world.inWater(x, y)) continue;
      w.x = x; w.y = y; w.vx = w.vy = 0; w.heading = c.heading + (side > 0 ? -Math.PI / 2 : Math.PI / 2); w.layer = c.layer | 0;
      c.vx = c.vy = 0;
      this.mode = 'foot';
      this.body.setVisible(true); this.shadow.setVisible(true);
      s.traffic.obstacles = [c];
      s.traffic.walkers = [w];
      return;
    }
    this.say('No room to get out');
  }

  enterOrSwap() {
    const s = this.scene, c = s.car, w = this.walker;
    if (Math.hypot(w.x - c.x, w.y - c.y) < ENTER_RANGE) { this.enterCar(); return; }
    let best = null, bd = SWAP_RANGE;
    for (const t of s.traffic.cars) {
      if (t.dead || (t.layer | 0) !== (w.layer | 0)) continue;
      const d = Math.hypot(t.x - w.x, t.y - w.y);
      if (d < bd) { bd = d; best = t; }
    }
    if (!best) { this.say('No car in reach'); return; }
    if (best.v > SWAP_MAX_SPEED) { this.say('It is going too fast'); return; }
    this.swap(best);
  }

  enterCar() {
    if (this.scene.wreck) { this.say('That car is a wreck: swap into another'); return; }
    this.mode = 'car';
    this.body.setVisible(false); this.shadow.setVisible(false);
    this.scene.traffic.obstacles = null; this.scene.traffic.walkers = null;
    this.scene.layers.reset(this.scene.car.layer | 0);
  }

  /** swap into a car on the street: it becomes the player's car; the one they left behind just rejoins the traffic look */
  swap(t) {
    const s = this.scene, car = s.car;
    const tt = TYPES.find((x) => x.name === t.type) ?? TYPES[0], [w, h] = spriteSize(tt);
    car.reset(t.x, t.y, t.heading);
    car.layer = t.layer | 0;
    s.layers.reset(car.layer);
    car.vx = Math.cos(t.heading) * t.v; car.vy = Math.sin(t.heading) * t.v;
    s.carView.setModel({ type: t.type, colorIndex: Math.max(0, COLORS.indexOf(t.color)), size: w, wh: h });
    t.dead = true; // out of the traffic
    this.swapped = true;
    s.damage.reset(); s.wreck = false;
    this.enterCar();
    this.say('Swapped cars');
  }

  // ---------- on foot ----------
  step(dt) {
    const s = this.scene, w = this.walker, k = this.keys;
    const input = {
      x: (k.right.isDown || k.d.isDown ? 1 : 0) - (k.left.isDown || k.a.isDown ? 1 : 0),
      y: (k.down.isDown || k.s.isDown ? 1 : 0) - (k.up.isDown || k.w.isDown ? 1 : 0),
      run: k.shift.isDown,
    };
    // small steps so a runner cannot pass a thin wall
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    for (let i = 0; i < n; i++) {
      w.step(input, dt / n);
      s.collision.resolveCircle(w, FOOT.radius, w.layer);
    }
    w.layer = s.layers.update(w.x, w.y, w.heading);
    const frame = w.speed > 0.3 ? Math.floor(w.dist / 0.55) % 2 : 0;
    if (frame !== this.frame) { this.frame = frame; this.body.setTexture(this.frameKey(frame)); }
    this.body.setPosition(w.x, w.y).setRotation(w.heading);
    this.shadow.setPosition(w.x + 0.15, w.y + 0.2).setRotation(w.heading);
  }

  // ---------- every frame ----------
  update(dt) {
    if (this.mode === 'foot') this.step(dt);
    if (Phaser.Input.Keyboard.JustDown(this.keys.e)) this.toggle();
    // the little hint line
    let text = '';
    if (this.promptT > 0) { this.promptT -= dt; text = this.promptText; }
    else if (this.mode === 'foot') {
      const c = this.scene.car, w = this.walker;
      if (Math.hypot(w.x - c.x, w.y - c.y) < ENTER_RANGE) text = 'E: get in your car';
      else if (this.scene.traffic.cars.some((t) => !t.dead && Math.hypot(t.x - w.x, t.y - w.y) < SWAP_RANGE)) text = 'E: swap into this car';
    }
    if (text !== this.shown) { this.shown = text; this.prompt.textContent = text; this.prompt.style.display = text ? 'block' : 'none'; }
  }
}
