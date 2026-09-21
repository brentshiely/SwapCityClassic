import Phaser from 'phaser';
import { Walker, FOOT } from './walker.js';
import { Pistol, hitscan, PISTOL } from './weapon.js';
import { pedTextureKey, makePedShadow, PED_SPRITE_M } from '../peds/pedSprites.js';
import { spriteSize } from '../traffic/npcSprites.js';
import { TYPES, COLORS } from '../traffic/trafficSim.js';

// Everything that is "the player as a person": getting out of the car (E), walking, getting back in, taking somebody else's car (E beside
// it: its driver is pulled out and runs), and the pistol (Space or click). The game scene owns the car, the traffic and the crowd;
// this reaches them through the scene.

const PLAYER_LOOK = { clothes: 1, skin: 1, hair: 2 }; // blue jacket
const SCALE = 1.25; // people are drawn a little bigger than life, like the crowd
const ENTER_RANGE = 3.6, JACK_RANGE = 3.4, JACK_MAX_SPEED = 11;

export class PlayerController {
  constructor(scene) {
    this.scene = scene;
    this.mode = 'car'; // 'car' | 'foot'
    this.walker = new Walker();
    this.gun = new Pistol();
    this.kills = 0;
    this.stolen = false; // is the car the player is in (or left parked) one they took?
    this.corpses = [];
    this.tracers = [];
    this.aimT = 99; // seconds since the mouse moved
    const kb = scene.input.keyboard;
    this.keys = kb.addKeys({ e: 'E', shift: 'SHIFT', space: 'SPACE', up: 'UP', down: 'DOWN', left: 'LEFT', right: 'RIGHT', w: 'W', s: 'S', a: 'A', d: 'D' });
    this.mouseDown = false;
    scene.input.on('pointerdown', () => { this.mouseDown = true; });
    scene.input.on('pointerup', () => { this.mouseDown = false; });
    scene.input.on('pointermove', () => { this.aimT = 0; });
    makePedShadow(scene);
    this.shadow = scene.add.image(0, 0, 'ped_shadow').setDisplaySize(0.85 * SCALE, 0.5 * SCALE).setDepth(5.4).setVisible(false);
    this.body = scene.add.image(0, 0, this.frameKey(0)).setDisplaySize(PED_SPRITE_M * SCALE, PED_SPRITE_M * SCALE).setDepth(5.5).setVisible(false);
    this.frame = 0;
    this.fx = scene.add.graphics().setDepth(6.2); // muzzle flash and tracers
    this.blood = scene.add.graphics().setDepth(3.6);
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
    if (this.mode === 'car') this.exitCar(); else this.enterOrJack();
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

  enterOrJack() {
    const s = this.scene, c = s.car, w = this.walker;
    if (Math.hypot(w.x - c.x, w.y - c.y) < ENTER_RANGE) { this.enterCar(); return; }
    let best = null, bd = JACK_RANGE;
    for (const t of s.traffic.cars) {
      if (t.dead || (t.layer | 0) !== (w.layer | 0)) continue;
      const d = Math.hypot(t.x - w.x, t.y - w.y);
      if (d < bd) { bd = d; best = t; }
    }
    if (!best) { this.say('No car in reach'); return; }
    if (best.v > JACK_MAX_SPEED) { this.say('It is going too fast'); return; }
    this.jack(best);
  }

  enterCar() {
    if (this.scene.wreck) { this.say('That car is a wreck: take another'); return; }
    this.mode = 'car';
    this.body.setVisible(false); this.shadow.setVisible(false);
    this.scene.traffic.obstacles = null; this.scene.traffic.walkers = null;
    this.scene.layers.reset(this.scene.car.layer | 0);
  }

  /** take a traffic car: its driver is pulled out and runs, the player is in it; the car they left is gone */
  jack(t) {
    const s = this.scene, car = s.car;
    const tt = TYPES.find((x) => x.name === t.type) ?? TYPES[0], [w, h] = spriteSize(tt);
    car.reset(t.x, t.y, t.heading);
    car.layer = t.layer | 0;
    s.layers.reset(car.layer);
    car.vx = Math.cos(t.heading) * t.v; car.vy = Math.sin(t.heading) * t.v;
    s.carView.setModel({ type: t.type, colorIndex: Math.max(0, COLORS.indexOf(t.color)), size: w, wh: h });
    t.dead = true; // out of the traffic
    if (s.pedsOn) {
      const side = 1.6, dx = Math.sin(t.heading) * side, dy = -Math.cos(t.heading) * side;
      s.peds.spawnLoose(t.x + dx, t.y + dy, this.walker.x, this.walker.y);
      s.peds.alarm(t.x, t.y, 14);
    }
    this.stolen = true;
    s.damage.reset(); s.wreck = false;
    s.police?.wanted.add('jack');
    this.enterCar();
    this.say('Got a new car');
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
    // aim with the mouse once it has been moved; otherwise the way the person is facing
    this.aimT += dt;
    const p = s.input.activePointer;
    let aim = w.heading;
    if (this.aimT < 5) { p.updateWorldPoint(s.cameras.main); aim = Math.atan2(p.worldY - w.y, p.worldX - w.x); }
    this.aim = aim;
    if (input.x || input.y) { /* facing follows the walking direction unless aiming */ }
    const facing = this.aimT < 5 ? aim : w.heading;
    this.body.setPosition(w.x, w.y).setRotation(facing);
    this.shadow.setPosition(w.x + 0.15, w.y + 0.2).setRotation(facing);
    if ((k.space.isDown || this.mouseDown) && this.gun.ready()) this.shoot(aim);
  }

  shoot(angle) {
    const s = this.scene, w = this.walker;
    this.gun.fire();
    const mx = w.x + Math.cos(angle) * 0.55, my = w.y + Math.sin(angle) * 0.55;
    const targets = s.pedsOn ? s.peds.peds.filter((p) => !p.dead && Math.abs(p.x - w.x) < PISTOL.range && Math.abs(p.y - w.y) < PISTOL.range) : [];
    const r = hitscan(mx, my, angle, (x, y) => s.collision.insideSolid(x, y), targets);
    this.tracers.push({ x0: mx, y0: my, x1: r.x, y1: r.y, t: 0.09 });
    s.police?.wanted.add('shot');
    s.sound?.shot();
    if (s.pedsOn) s.peds.alarm(w.x, w.y, 24);
    if (r.target) {
      const p = r.target;
      s.peds.kill(p);
      this.kills++;
      s.police?.wanted.add('kill');
      s.sound?.scream();
      this.corpses.push({ x: p.x, y: p.y, heading: p.heading, clothes: p.clothes, skin: p.skin, hair: p.id % 5, t: 0, img: null });
    }
  }

  // ---------- every frame ----------
  update(dt) {
    this.gun.update(dt);
    if (this.mode === 'foot') this.step(dt);
    if (Phaser.Input.Keyboard.JustDown(this.keys.e)) this.toggle();
    this.drawEffects(dt);
    // the little hint line
    let text = '';
    if (this.promptT > 0) { this.promptT -= dt; text = this.promptText; }
    else if (this.mode === 'foot') {
      const c = this.scene.car, w = this.walker;
      if (Math.hypot(w.x - c.x, w.y - c.y) < ENTER_RANGE) text = 'E: get in your car';
      else if (this.scene.traffic.cars.some((t) => !t.dead && Math.hypot(t.x - w.x, t.y - w.y) < JACK_RANGE)) text = 'E: take this car';
    }
    if (text !== this.shown) { this.shown = text; this.prompt.textContent = text; this.prompt.style.display = text ? 'block' : 'none'; }
  }

  drawEffects(dt) {
    const g = this.fx;
    g.clear();
    for (const t of this.tracers) {
      t.t -= dt;
      g.lineStyle(0.12, 0xffe9a0, Math.max(0, t.t / 0.09)); g.lineBetween(t.x0, t.y0, t.x1, t.y1);
      if (t.t > 0.05) { g.fillStyle(0xfff4c2, 0.9); g.fillCircle(t.x0, t.y0, 0.32); }
    }
    this.tracers = this.tracers.filter((t) => t.t > 0);
    // bodies and blood
    const b = this.blood;
    b.clear();
    for (const c of this.corpses) {
      c.t += dt;
      const fade = Math.max(0, 1 - Math.max(0, c.t - 20) / 20);
      b.fillStyle(0x6a0f10, 0.55 * fade); b.fillEllipse(c.x, c.y, 1.7, 1.3); b.fillStyle(0x8a1a1a, 0.4 * fade); b.fillEllipse(c.x + 0.25, c.y - 0.15, 0.9, 0.7);
      if (c.t < 14) {
        if (!c.img) c.img = this.scene.add.image(c.x, c.y, pedTextureKey(this.scene, c.clothes, c.skin, 0, c.hair)).setDisplaySize(PED_SPRITE_M * SCALE, PED_SPRITE_M * SCALE).setDepth(3.7).setRotation(c.heading).setTint(0xb0a0a0);
        c.img.setAlpha(Math.min(1, (14 - c.t) / 3));
      } else if (c.img) { c.img.destroy(); c.img = null; }
    }
    this.corpses = this.corpses.filter((c) => c.t < 40);
  }
}
