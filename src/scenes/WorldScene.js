import Phaser from 'phaser';
import map from '../../data/map.json';
import { buildGround } from '../render/ground.js';
import { BuildingRenderer } from '../render/buildings.js';
import { cameraHeight } from '../render/perspective.js';
import { loadSettings, saveSettings } from '../settings.js';
import { TuningPanel } from '../ui/tuningPanel.js';
import { NavHud } from '../ui/navHud.js';
import { skywayBuildings } from '../world/skyways.js';
import { LookController } from '../earth/lookController.js';
import { attachFreeCamera, startFromHash } from '../camera/freeCamera.js';
import { Car, CAR, PHYSICS_STEP } from '../vehicles/carPhysics.js';
import { CollisionWorld } from '../world/collision.js';
import { CarView } from '../vehicles/carView.js';
import { DriveInput } from '../input/driveInput.js';
import { TrafficSim, pushPlayerOutOfTraffic } from '../traffic/trafficSim.js';
import { TrafficView } from '../traffic/trafficView.js';
import { PedSim } from '../peds/pedSim.js';
import { PedView } from '../peds/pedView.js';
import { findStart } from '../world/start.js';

const STEP = PHYSICS_STEP; // fixed physics step

// The game world. You drive a car; `?free` gives the old free-look camera instead.
export class WorldScene extends Phaser.Scene {
  constructor() {
    super('world');
  }

  create() {
    const params = new URLSearchParams(location.search);
    this.free = params.has('free');
    this.camHeightSetting = Number(params.get('camh')) || 300; // metres at 20 px/m (free-look camera; ?camh=200 to try another)
    this.stopAt = Number(params.get('stop')) || 0; // freeze the sim at this many seconds (for test screenshots)
    this.simTime = 0;
    this.cameras.main.setBackgroundColor(0x14181a);
    this.buildings = new BuildingRenderer(this, map);
    this.skyways = new BuildingRenderer(this, { meta: map.meta, buildings: skywayBuildings(map) }); // a separate layer: it stays on top of Google's picture too
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

    // live settings (press T): the camera, driving and world numbers, remembered in this browser
    this.settings = loadSettings();
    if (Number(params.get('camh'))) this.settings.camHeight = Number(params.get('camh')); // address-bar value wins, like ?cars and ?peds
    this.navHud = new NavHud(map);
    this.tuning = new TuningPanel(this.settings, (st) => { saveSettings(st); this.applySettings(); });
    if (params.has('tune')) this.tuning.show();
    this.start = findStart(map);
    this.car = new Car(this.start.x, this.start.y, this.start.heading);
    this.collision = new CollisionWorld(map);
    this.trafficOn = !params.has('notraffic');
    this.urlCars = Number(params.get('cars')) || null; // address-bar values win over the saved settings
    this.urlPeds = Number(params.get('peds')) || null;
    const seed = Number(params.get('seed')) || Math.floor(Math.random() * 1e6);
    this.traffic = new TrafficSim(map, { count: Number(params.get('cars')) || 16, seed });
    if (this.trafficOn) this.traffic.fill(null, this.car);
    // pedestrians: they stay out of buildings, keep clear of moving cars, and the traffic stops for them
    this.pedsOn = !params.has('nopeds');
    const blocked = (x, y) => this.collision.insideSolid(x, y);
    this.peds = new PedSim(map, this.traffic.signals, { count: Number(params.get('peds')) || 80, seed: seed + 1, blocked });
    this.peds.cars = this.traffic.cars;
    this.traffic.peds = this.pedsOn ? this.peds.peds : null;
    if (this.pedsOn) this.peds.fill(null, this.car);
    this.blockedFn = blocked;
    // which scenery is showing: Google Earth (live, when online) or the offline look
    this.look = new LookController({ scene: this, images: this.info.images, buildingLayer: this.buildings.g, getLook: () => this.settings.look, getStreets: () => this.settings.streets, map, urlLook: params.get('look'), setLook: (v) => this.tuning.set({ look: v }) });
    this.carView = new CarView(this, map.meta.world);
    this.trafficView = new TrafficView(this, this.traffic);
    this.pedView = new PedView(this, this.peds);
    this.input2 = new DriveInput(this);
    this.acc = 0;
    this.applySettings();
    this.camX = this.car.x; this.camY = this.car.y; this.camZoom = this.settings.zoomNear;
    this.applyCamera();
    // keep the same map spot centred if the window is resized
    this.scale.on('resize', () => this.applyCamera());
  }

  /** push the settings into the parts of the game that use them */
  applySettings() {
    const st = this.settings;
    Object.assign(CAR, { vMax: st.vMax, accel: st.accel, grip: st.grip, handbrakeGrip: st.handbrakeGrip, turnMax: st.turnMax });
    this.traffic.count = this.urlCars ?? st.cars;
    this.peds.count = this.urlPeds ?? st.peds;
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
      const Hf = cameraHeight(this.camHeightSetting, 20, cam.zoom);
      this.buildings.update(cx, cy, cam.zoom, cam.width, cam.height, Hf);
      this.skyways.update(cx, cy, cam.zoom, cam.width, cam.height, Hf);
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
        if (this.trafficOn) pushPlayerOutOfTraffic(car, this.traffic.cars);
        this.acc -= STEP;
        this.simTime += STEP;
      }
    }
    this.carView.update(car);

    // camera: look ahead in the direction of travel, ease out as the car speeds up
    const k = 1 - Math.exp(-6 * dt);
    this.camX += (car.x + car.vx * this.settings.lookahead - this.camX) * k;
    this.camY += (car.y + car.vy * this.settings.lookahead - this.camY) * k;
    const zoomTarget = Phaser.Math.Linear(this.settings.zoomNear, this.settings.zoomFar, Math.min(1, car.speed / CAR.vMax));
    this.camZoom += (zoomTarget - this.camZoom) * (1 - Math.exp(-2.5 * dt));
    this.applyCamera();
    const H = cameraHeight(this.settings.camHeight, this.settings.zoomNear, this.camZoom);
    this.buildings.update(this.camX, this.camY, this.camZoom, cam.width, cam.height, H);
    this.skyways.update(this.camX, this.camY, this.camZoom, cam.width, cam.height, H);
    this.look.update(this.camX, this.camY, H, this.camZoom, cam.width, cam.height);

    // traffic: cars spawn only outside what the player can see
    const view = { cx: this.camX, cy: this.camY, hw: cam.width / (2 * this.camZoom), hh: cam.height / (2 * this.camZoom) };
    if (this.trafficOn && (!this.stopAt || this.simTime < this.stopAt)) this.traffic.update(dt, { x: car.x, y: car.y, heading: car.heading }, view);
    this.trafficView.update(view);
    if (this.pedsOn && (!this.stopAt || this.simTime < this.stopAt)) {
      const touched = this.peds.update(dt, { x: car.x, y: car.y, vx: car.vx, vy: car.vy, heading: car.heading }, view, this.blockedFn);
      if (touched) { const k = 0.985 ** touched; car.vx *= k; car.vy *= k; } // a nudge barely slows the car
    }
    this.pedView.update();

    this.navHud.update({ x: car.x, y: car.y, vx: car.vx, vy: car.vy, heading: car.heading });
    this.hudText(`${Math.round(car.speed * 3.6)} km/h  |  ${this.traffic.cars.length} cars, ${this.peds.peds.length} people  |  ${this.look.label}`, '↑/W gas   ↓/S brake + reverse   ←→/AD steer   Space handbrake   R restart   T settings   G scenery');
  }

  hudText(left, controls) {
    const s = this.buildings.stats;
    this.hud.textContent =
      `${Math.round(this.game.loop.actualFps)} fps  |  ${left}  |  ${s.drawn} buildings in ${s.ms.toFixed(1)} ms\n` +
      `${controls}`;
  }
}
