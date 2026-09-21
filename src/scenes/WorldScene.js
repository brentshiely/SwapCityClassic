import Phaser from 'phaser';
import { GroundStreamer } from '../render/ground.js';
import { computeBarriers } from '../world/barriers.js';
import { BuildingRenderer } from '../render/buildings.js';
import { RoofCutter, ROOF_PHOTO } from '../render/roofs.js';
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

  preload() {
    this.load.image(ROOF_PHOTO.key, ROOF_PHOTO.url); // the aerial photo the roofs are cut from (inlined in the build)
  }

  create() {
    const params = new URLSearchParams(location.search);
    this.free = params.has('free');
    this.camHeightSetting = Number(params.get('camh')) || 300; // metres at 20 px/m (free-look camera; ?camh=200 to try another)
    this.stopAt = Number(params.get('stop')) || 0; // freeze the sim at this many seconds (for test screenshots)
    this.simTime = 0;
    this.cameras.main.setBackgroundColor(0x14181a);
    // the city: the road graph is whole, everything else arrives in tiles around the player (see world/world.js)
    this.world = this.registry.get('world');
    const map = this.world; // the parts of the game that only need roads and the graph take the World as their map
    this.roofCutter = new RoofCutter(this);
    this.roofCutter.tileMeta = map.meta.roofPhotos ? { ...map.meta.roofPhotos, tileSize: map.meta.tileSize } : null;
    const inside = (x, y) => this.world.insideCity(x, y);
    this.buildings = new BuildingRenderer(this, { meta: map.meta, buildings: [], inside }, this.roofCutter);
    this.skyways = new BuildingRenderer(this, { meta: map.meta, buildings: [], inside }, null, 12); // a separate layer: it stays on top of Google's picture too
    this.barriers = computeBarriers(map).barriers;
    this.ground = new GroundStreamer(this, map, this.barriers);
    this.hud = document.getElementById('hud');
    const cam = this.cameras.main;

    if (this.free) {
      const w = map.meta.world;
      this.world.update(0, 0);
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
    this.collision = new CollisionWorld({ meta: map.meta, roads: map.roads, graph: map.graph, buildings: [] });
    this.trackTiles();
    this.trafficOn = !params.has('notraffic');
    this.urlCars = Number(params.get('cars')) || null; // address-bar values win over the saved settings
    this.urlPeds = Number(params.get('peds')) || null;
    const seed = Number(params.get('seed')) || Math.floor(Math.random() * 1e6);
    this.traffic = new TrafficSim(map, { count: Number(params.get('cars')) || 16, seed, radius: 450 }); // cars live only near the player
    if (this.trafficOn) this.traffic.fill(null, this.car);
    // pedestrians: they stay out of buildings, keep clear of moving cars, and the traffic stops for them
    this.pedsOn = !params.has('nopeds');
    const blocked = (x, y) => this.collision.insideSolid(x, y);
    this.peds = new PedSim(map, this.traffic.signals, { count: Number(params.get('peds')) || 80, seed: seed + 1, blocked, radius: 350, isLoaded: (x, y) => this.world.isLoaded(x, y) }); // the walking network is built around the player as tiles arrive
    this.peds.cars = this.traffic.cars;
    this.traffic.peds = this.pedsOn ? this.peds.peds : null;
    if (this.pedsOn) this.peds.prime(this.car, { cx: this.car.x, cy: this.car.y, hw: 60, hh: 40 });
    this.blockedFn = blocked;
    // which scenery is showing: Google Earth (live, when online) or the offline look
    this.look = new LookController({ scene: this, images: this.ground, world: this.world, buildingLayer: this.buildings.g, getLook: () => this.settings.look, getStreets: () => this.settings.streets, getOverhead: () => this.settings.overhead, map, hideInGoogle: [this.skyways.g], urlLook: params.get('look'), setLook: (v) => this.tuning.set({ look: v }) });
    this.carView = new CarView(this, { minX: this.car.x - 256, minY: this.car.y - 256 });
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

  /**
   * Buildings and skyways come and go with the tiles. A building can sit in several tiles, so it is counted: it is put in when the
   * first tile with it arrives and taken out when the last tile with it leaves (renderer, collision, everything).
   */
  trackTiles() {
    const refs = new Map(), skyRefs = new Map(), skyIds = new Map();
    const w = this.world;
    w.onLoad.push((tile) => {
      const fresh = [];
      for (const b of tile.buildings) { const n = refs.get(b.id) ?? 0; refs.set(b.id, n + 1); if (!n) fresh.push(b); }
      this.buildings.add(fresh, tile);
      this.peds?.tilesChanged(); // sidewalks that were waiting for building data can be built now
      for (const b of fresh) this.collision.addBuilding(b);
      const sk = tile.skyways.filter((k) => { const n = skyRefs.get(k.id) ?? 0; skyRefs.set(k.id, n + 1); return !n; });
      if (sk.length) { const blocks = skywayBuildings({ skyways: sk }); this.skyways.add(blocks); for (const k of sk) skyIds.set(k.id, blocks.filter((b) => Math.floor(b.id / 10) === k.id).map((b) => b.id)); }
    });
    w.onUnload.push((tile) => {
      const gone = [];
      for (const b of tile.buildings) { const n = (refs.get(b.id) ?? 1) - 1; if (n <= 0) { refs.delete(b.id); gone.push(b.id); } else refs.set(b.id, n); }
      this.buildings.remove(gone);
      this.peds?.tilesChanged();
      for (const id of gone) this.collision.removeBuilding(id);
      for (const k of tile.skyways) { const n = (skyRefs.get(k.id) ?? 1) - 1; if (n <= 0) { skyRefs.delete(k.id); this.skyways.remove(skyIds.get(k.id) ?? []); skyIds.delete(k.id); } else skyRefs.set(k.id, n); }
    });
    // the tiles already loaded before this scene started
    for (const tile of w.tiles.values()) if (tile.announced) for (const f of w.onLoad) f(tile);
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
      this.ground.update(cx, cy, cam.width / (2 * cam.zoom), cam.height / (2 * cam.zoom), 4);
      this.hudText(`${cam.zoom.toFixed(1)} px/m  |  view @ ${cx.toFixed(0)},${cy.toFixed(0)}`, 'two-finger scroll = pan   pinch or + / - = zoom   0 = refit   drag or arrows = pan');
      return;
    }

    const dt = Math.min(delta / 1000, 0.05);
    const car = this.car;
    if (this.input2.resetPressed()) { car.reset(this.start.x, this.start.y, this.start.heading); this.camX = car.x; this.camY = car.y; }

    // tiles around the car; if the one under it has not arrived yet (a slow connection), the car waits rather than driving through buildings
    this.world.update(car.x, car.y);
    const tileReady = this.world.isLoaded(car.x, car.y);

    // fixed-step physics so handling is identical at any frame rate
    if (tileReady && (!this.stopAt || this.simTime < this.stopAt)) {
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
    this.ground.update(this.camX, this.camY, cam.width / (2 * this.camZoom), cam.height / (2 * this.camZoom));
    if (!this.startLogged && this.ground.painted) { this.startLogged = true; console.log(`ground painted: ${this.ground.painted} chunks, ${this.ground.ms.toFixed(0)} ms, ${this.world.tiles.size} tiles`); }
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
