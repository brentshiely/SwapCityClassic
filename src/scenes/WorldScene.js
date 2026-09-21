import Phaser from 'phaser';
import map from '../../data/map.json';
import { buildGround } from '../render/ground.js';
import { BuildingRenderer } from '../render/buildings.js';
import { attachFreeCamera, startFromHash } from '../camera/freeCamera.js';
import { Car, CAR, PHYSICS_STEP } from '../vehicles/carPhysics.js';
import { CollisionWorld } from '../world/collision.js';
import { CarView } from '../vehicles/carView.js';
import { DriveInput } from '../input/driveInput.js';
import { findStart } from '../world/start.js';

const STEP = PHYSICS_STEP; // fixed physics step
const ZOOM_NEAR = 20; // px per metre when slow
const ZOOM_FAR = 12; // px per metre at top speed
const LOOKAHEAD = 0.45; // seconds of travel the camera looks ahead

// The game world. You drive a car; `?free` gives the old free-look camera instead.
export class WorldScene extends Phaser.Scene {
  constructor() {
    super('world');
  }

  create() {
    const params = new URLSearchParams(location.search);
    this.free = params.has('free');
    this.stopAt = Number(params.get('stop')) || 0; // freeze the sim at this many seconds (for test screenshots)
    this.simTime = 0;
    this.cameras.main.setBackgroundColor(0x14181a);
    this.buildings = new BuildingRenderer(this, map);
    this.info = buildGround(this, map);
    console.log(`ground painted: ${this.info.barriers} barriers, ${this.info.chunks} chunks, ${(this.info.pixels / 1e6).toFixed(0)} Mpx, ${this.info.ms} ms`);
    this.hud = document.getElementById('hud');
    const cam = this.cameras.main;

    if (this.free) {
      const w = map.meta.world;
      const fit = Math.min(this.scale.width / (w.maxX - w.minX + 40), this.scale.height / (w.maxY - w.minY + 40));
      const h = startFromHash();
      cam.setZoom(Number(h.z) || 16);
      cam.centerOn(Number(h.x) || 0, Number(h.y) || 0);
      attachFreeCamera(this, { fitZoom: fit, minZoom: fit * 0.6, maxZoom: 40 });
      return;
    }

    this.start = findStart(map);
    this.car = new Car(this.start.x, this.start.y, this.start.heading);
    this.collision = new CollisionWorld(map);
    this.carView = new CarView(this, map.meta.world);
    this.input2 = new DriveInput(this);
    this.acc = 0;
    this.camX = this.car.x; this.camY = this.car.y; this.camZoom = ZOOM_NEAR;
    this.applyCamera();
    // keep the same map spot centred if the window is resized
    this.scale.on('resize', () => this.applyCamera());
  }

  applyCamera() {
    const cam = this.cameras.main;
    cam.setZoom(this.camZoom);
    cam.scrollX = this.camX - cam.width / 2;
    cam.scrollY = this.camY - cam.height / 2;
  }

  update(_t, delta) {
    const cam = this.cameras.main;
    if (this.free) {
      const cx = cam.scrollX + cam.width / 2, cy = cam.scrollY + cam.height / 2;
      this.buildings.update(cx, cy, cam.zoom, cam.width, cam.height);
      this.hudText(`${cam.zoom.toFixed(1)} px/m  |  view @ ${cx.toFixed(0)},${cy.toFixed(0)}`, 'two-finger scroll = pan   pinch or + / - = zoom   0 = refit   drag or arrows = pan');
      return;
    }

    const dt = Math.min(delta / 1000, 0.05);
    const car = this.car;
    if (this.input2.resetPressed()) { car.reset(this.start.x, this.start.y, this.start.heading); this.camX = car.x; this.camY = car.y; }

    // fixed-step physics so handling is identical at any frame rate
    if (!this.stopAt || this.simTime < this.stopAt) {
      this.acc += dt;
      while (this.acc >= STEP) {
        car.step(this.input2.read(STEP), STEP);
        this.collision.resolve(car, STEP);
        this.acc -= STEP;
        this.simTime += STEP;
      }
    }
    this.carView.update(car);

    // camera: look ahead in the direction of travel, ease out as the car speeds up
    const k = 1 - Math.exp(-6 * dt);
    this.camX += (car.x + car.vx * LOOKAHEAD - this.camX) * k;
    this.camY += (car.y + car.vy * LOOKAHEAD - this.camY) * k;
    const zoomTarget = Phaser.Math.Linear(ZOOM_NEAR, ZOOM_FAR, Math.min(1, car.speed / CAR.vMax));
    this.camZoom += (zoomTarget - this.camZoom) * (1 - Math.exp(-2.5 * dt));
    this.applyCamera();
    this.buildings.update(this.camX, this.camY, this.camZoom, cam.width, cam.height);

    this.hudText(`${Math.round(car.speed * 3.6)} km/h`, '↑/W gas   ↓/S brake + reverse   ←→/AD steer   Space handbrake   R restart');
  }

  hudText(left, controls) {
    const s = this.buildings.stats;
    this.hud.textContent =
      `${Math.round(this.game.loop.actualFps)} fps  |  ${left}  |  ${s.drawn} buildings in ${s.ms.toFixed(1)} ms\n` +
      `${controls}\n${map.meta.attribution}`;
  }
}
