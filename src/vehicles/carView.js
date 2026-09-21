import { CAR } from './carPhysics.js';

// The car as drawn on screen: a code-drawn top-down sedan, its shadow, brake lights and skid marks.
// Sprite art is a placeholder; real art is a later card. Sprite forward = +x (right).

const TEX_PPM = 24; // sprite texture pixels per metre
const PAD = 6;

function makeCarTexture(scene) {
  const w = Math.round(CAR.length * TEX_PPM), h = Math.round(CAR.width * TEX_PPM);
  const c = document.createElement('canvas');
  c.width = w + PAD * 2; c.height = h + PAD * 2;
  const g = c.getContext('2d');
  g.translate(PAD, PAD);
  const rr = (x, y, ww, hh, r) => { g.beginPath(); g.roundRect(x, y, ww, hh, r); };

  // body
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#d94a3d'); grad.addColorStop(0.5, '#c2302a'); grad.addColorStop(1, '#a12420');
  rr(0, 0, w, h, 11); g.fillStyle = grad; g.fill();
  g.lineWidth = 1.6; g.strokeStyle = '#4a0f0d'; g.stroke();
  // bumpers
  g.fillStyle = 'rgba(30,10,10,0.55)';
  g.fillRect(w - 5, 5, 3, h - 10); g.fillRect(2, 5, 3, h - 10);
  // hood and trunk creases
  g.strokeStyle = 'rgba(0,0,0,0.22)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(w * 0.72, 4); g.lineTo(w * 0.72, h - 4); g.moveTo(w * 0.24, 4); g.lineTo(w * 0.24, h - 4); g.stroke();
  // windshield and rear window
  g.fillStyle = '#1c2b3a';
  g.beginPath(); g.moveTo(w * 0.60, 5); g.lineTo(w * 0.70, 8); g.lineTo(w * 0.70, h - 8); g.lineTo(w * 0.60, h - 5); g.closePath(); g.fill();
  g.beginPath(); g.moveTo(w * 0.30, 6); g.lineTo(w * 0.24, 9); g.lineTo(w * 0.24, h - 9); g.lineTo(w * 0.30, h - 6); g.closePath(); g.fill();
  g.fillStyle = 'rgba(160,200,230,0.35)';
  g.fillRect(w * 0.615, 10, 3, h - 20);
  // roof
  rr(w * 0.31, 5, w * 0.29, h - 10, 6); g.fillStyle = '#b32a24'; g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 1; g.stroke();
  // mirrors
  g.fillStyle = '#7a1c18';
  g.fillRect(w * 0.605, -2, 6, 4); g.fillRect(w * 0.605, h - 2, 6, 4);
  // headlights and tail lights
  g.fillStyle = '#fff2b0';
  g.fillRect(w - 7, 4, 5, 6); g.fillRect(w - 7, h - 10, 5, 6);
  g.fillStyle = '#5a0d0d';
  g.fillRect(2, 4, 4, 6); g.fillRect(2, h - 10, 4, 6);
  scene.textures.addCanvas('car_body', c);

  // brake lights: two bright rear lamps, shown only while braking
  const b = document.createElement('canvas');
  b.width = c.width; b.height = c.height;
  const bg = b.getContext('2d');
  bg.translate(PAD, PAD);
  bg.shadowColor = 'rgba(255,60,40,0.9)'; bg.shadowBlur = 8;
  bg.fillStyle = '#ff3a2a';
  bg.fillRect(2, 4, 4, 6); bg.fillRect(2, h - 10, 4, 6);
  scene.textures.addCanvas('car_brake', b);

  // soft shadow
  const s = document.createElement('canvas');
  s.width = c.width; s.height = c.height;
  const sg = s.getContext('2d');
  sg.translate(PAD, PAD);
  sg.fillStyle = 'rgba(0,0,0,0.38)';
  sg.beginPath(); sg.roundRect(0, 0, w, h, 11); sg.fill();
  scene.textures.addCanvas('car_shadow', s);

  // one tyre-mark stamp
  const k = document.createElement('canvas');
  k.width = 8; k.height = 4;
  const kg = k.getContext('2d');
  kg.fillStyle = 'rgba(12,14,14,0.55)';
  kg.fillRect(0, 0, 8, 4);
  scene.textures.addCanvas('skid', k);
}

const SKID_PPM = 4; // resolution of the skid-mark layer
const SKID_SIZE = 2048;

export class CarView {
  constructor(scene, world) {
    makeCarTexture(scene);
    const size = (CAR.length * TEX_PPM + PAD * 2) / TEX_PPM;
    const wh = (CAR.width * TEX_PPM + PAD * 2) / TEX_PPM;
    this.shadow = scene.add.image(0, 0, 'car_shadow').setDisplaySize(size, wh).setDepth(4);
    this.body = scene.add.image(0, 0, 'car_body').setDisplaySize(size, wh).setDepth(5);
    this.brake = scene.add.image(0, 0, 'car_brake').setDisplaySize(size, wh).setDepth(5).setVisible(false);

    // permanent tyre marks painted into one texture covering the world
    this.world = { minX: world.minX, minY: world.minY }; // where the texture's top-left sits; it moves with the car (see update)
    // Power-of-two size: with mipmapping on, some browsers reject a framebuffer texture of any other size.
    // 2048 px at 4 px/m covers 512 m, more than the 439 x 423 m world, anchored at its top-left corner.
    // Tyre marks are optional: if the browser cannot spare the graphics memory for this texture (for example several copies of the
    // game are open), carry on without them instead of failing to start.
    try {
      this.skids = scene.add.renderTexture(world.minX, world.minY, SKID_SIZE, SKID_SIZE);
      this.skids.setOrigin(0, 0).setScale(1 / SKID_PPM).setDepth(2);
    } catch (err) {
      this.skids = null;
      console.warn('tyre marks disabled (not enough graphics memory):', err?.message ?? err);
    }
    this.stamp = scene.add.image(0, 0, 'skid').setVisible(false);
    this.last = null;
  }

  update(car) {
    const c = Math.cos(car.heading), s = Math.sin(car.heading);
    for (const img of [this.body, this.brake]) img.setPosition(car.x, car.y).setRotation(car.heading);
    // shadow falls toward the lower right in world space
    this.shadow.setPosition(car.x + 0.45, car.y + 0.6).setRotation(car.heading);
    this.brake.setVisible(car.braking);

    // tyre marks from the rear wheels while sliding or handbraking
    // the tyre-mark layer covers a 512 m square; when the car nears its edge it is moved to be centred on the car (old marks go)
    if (this.skids) {
      const w = this.world;
      if (car.x < w.minX + 60 || car.x > w.minX + SKID_SIZE / SKID_PPM - 60 || car.y < w.minY + 60 || car.y > w.minY + SKID_SIZE / SKID_PPM - 60) {
        w.minX = car.x - SKID_SIZE / SKID_PPM / 2; w.minY = car.y - SKID_SIZE / SKID_PPM / 2;
        this.skids.setPosition(w.minX, w.minY); this.skids.clear();
      }
    }
    const sliding = car.handbraking || (Math.abs(car.sideSpeed) > 2.2 && car.speed > 4);
    if (sliding && this.skids) {
      for (const side of [-0.72, 0.72]) {
        const wx = car.x - c * 1.35 - s * side, wy = car.y - s * 1.35 + c * side;
        this.stamp.setRotation(Math.atan2(car.vy, car.vx)).setScale(0.25);
        this.skids.draw(this.stamp, (wx - this.world.minX) * SKID_PPM, (wy - this.world.minY) * SKID_PPM);
      }
    }
  }
}
