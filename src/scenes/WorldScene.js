import Phaser from 'phaser';
import { GroundStreamer } from '../render/ground.js';
import { BridgeStreamer } from '../render/bridges.js';
import { LayerTracker, deckRails, layerZ } from '../world/layers.js';
import { computeBarriers } from '../world/barriers.js';
import { BuildingRenderer } from '../render/buildings.js';
import { RoofCutter, LeanTable, ROOF_PHOTO } from '../render/roofs.js';
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
import { PlayerController } from '../player/playerController.js';
import { MissionManager, resolveSpot } from '../missions/missions.js';
import { PoliceManager } from '../police/police.js';
import { Sound } from '../audio/sound.js';
import { Radar } from '../ui/radar.js';
import { CarDamage } from '../vehicles/damage.js';
import { CarFx, BLAST_RADIUS } from '../vehicles/carFx.js';

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
    if (map.meta.roofLean) this.roofCutter.lean = new LeanTable(map.meta.roofLean);
    this.roofCutter.tileMeta = map.meta.roofPhotos ? { ...map.meta.roofPhotos, tileSize: map.meta.tileSize } : null;
    const inside = (x, y) => this.world.insideCity(x, y);
    this.buildings = new BuildingRenderer(this, { meta: map.meta, buildings: [], inside }, this.roofCutter);
    this.skyways = new BuildingRenderer(this, { meta: map.meta, buildings: [], inside }, null, 12); // a separate layer: it stays on top of Google's picture too
    this.barriers = computeBarriers(map).barriers;
    this.ground = new GroundStreamer(this, map, this.barriers);
    this.bridges = new BridgeStreamer(this, map); // decks of bridges and overpasses, drawn over the street below
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
    this.collision.addRails(deckRails(map.roads)); // rails along bridges and tunnels keep a car on its deck
    if (map.water.length) this.collision.addWater(map.water);
    this.layers = new LayerTracker(this.world);
    this.trackTiles();
    this.trafficOn = !params.has('notraffic');
    this.urlCars = Number(params.get('cars')) || null; // address-bar values win over the saved settings
    this.urlPeds = Number(params.get('peds')) || null;
    const seed = Number(params.get('seed')) || Math.floor(Math.random() * 1e6);
    this.traffic = new TrafficSim(map, { count: Number(params.get('cars')) || 16, seed, radius: 450 }); // cars live only near the player
    if (this.trafficOn) this.traffic.fill(null, this.car);
    // pedestrians: they stay out of buildings, keep clear of moving cars, and the traffic stops for them
    this.pedsOn = !params.has('nopeds');
    const blocked = (x, y) => this.collision.insideSolid(x, y) || this.world.inWater(x, y);
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
    this.player = new PlayerController(this);
    this.sound = new Sound(); // made in code; starts on the first key or click
    this.keyX = this.input.keyboard.addKey('X'); this.keyN = this.input.keyboard.addKey('N'); this.keyH = this.input.keyboard.addKey('H');
    this.radar = new Radar(this.world);
    this.damage = new CarDamage(); this.fx = new CarFx(this); this.wreck = false;
    this.sprays = ['South 9th Street|-100,170', '2nd Avenue South|130,-60'].map((k) => { const [street, n] = k.split('|'); return resolveSpot(this.world, { street, near: n.split(',').map(Number) }); }).filter(Boolean); // paint shops
    this.police = new PoliceManager(this.traffic); // crimes raise the wanted level; police cars chase (traffic cars with `police` set)
    this.keyM = this.input.keyboard.addKey('M');
    // missions: cash and finished missions are kept in this browser
    this.missions = new MissionManager(this.world, {
      load: () => { try { return JSON.parse(localStorage.getItem('swapcityclassic.missions.v1') ?? 'null'); } catch { return null; } },
      save: (s) => { try { localStorage.setItem('swapcityclassic.missions.v1', JSON.stringify(s)); } catch { /* not remembered: fine */ } },
    });
    this.markers = this.add.graphics().setDepth(3.2); // the mission phone and the target
    this.scoreEl = document.getElementById('score'); this.missionEl = document.getElementById('mission');
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
    this.buildings.work(Infinity); this.skyways.work(Infinity); // the first screen is ready at once
  }

  /** push the settings into the parts of the game that use them */
  applySettings() {
    const st = this.settings;
    Object.assign(CAR, { vMax: st.vMax, accel: st.accel, grip: st.grip, handbrakeGrip: st.handbrakeGrip, turnMax: st.turnMax });
    this.sound?.setVolumes(st.sfx, st.music);
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
    if (this.input2.resetPressed()) { car.reset(this.start.x, this.start.y, this.start.heading); this.layers.reset(0); this.camX = car.x; this.camY = car.y; if (!this.player.inCar) this.player.enterCar(); this.damage.reset(); this.wreck = false; this.carView.setModel(null); this.player.stolen = false; }
    const st = this.settings;
    CAR.vMax = st.vMax * this.damage.power; CAR.accel = st.accel * this.damage.power; CAR.grip = st.grip * this.damage.grip; // a damaged car is weaker
    const inCar = this.player.inCar;
    if (inCar) {
      car.layer = this.layers.update(car.x, car.y, car.heading); // on a bridge, under it, or in a tunnel
      // a street that runs under a building (a garage over a street, a tunnel that ends inside one): while the car is ON that street and its
      // nose is in the building, the building's walls do not stop it
      const nose = { x: car.x + Math.cos(car.heading) * 3, y: car.y + Math.sin(car.heading) * 3 };
      car.ghost = this.layers.onRoad && (this.collision.insideSolid(car.x, car.y) || this.collision.insideSolid(nose.x, nose.y));
    }
    this.player.update(dt); // E (get out / in / take a car), walking, the pistol
    const me = this.player.focus(); // the car, or the person on foot

    // tiles around the player; if the one under them has not arrived yet (a slow connection), they wait rather than walk through buildings
    this.world.update(me.x, me.y);
    const tileReady = this.world.isLoaded(me.x, me.y);

    // fixed-step physics so handling is identical at any frame rate
    let crashLost = 0;
    if (this.player.inCar && tileReady && (!this.stopAt || this.simTime < this.stopAt)) {
      this.acc += dt;
      while (this.acc >= STEP) {
        const before = car.speed;
        this.lastInput = this.input2.read(STEP);
        car.step(this.lastInput, STEP);
        this.collision.resolve(car, STEP);
        crashLost = Math.max(crashLost, before - car.speed);
        if (this.damage.hit(before - car.speed) > 0) this.sound.crashHit(before - car.speed);
        if (this.trafficOn) pushPlayerOutOfTraffic(car, this.traffic.cars);
        this.acc -= STEP;
        this.simTime += STEP;
      }
    }
    this.carView.update(car, { cx: this.camX, cy: this.camY, H: cameraHeight(this.settings.camHeight, this.settings.zoomNear, this.camZoom) });

    // camera: look ahead in the direction of travel, ease out as the car speeds up
    const k = 1 - Math.exp(-6 * dt);
    this.camX += (me.x + me.vx * this.settings.lookahead - this.camX) * k;
    this.camY += (me.y + me.vy * this.settings.lookahead - this.camY) * k;
    const zoomTarget = Phaser.Math.Linear(this.settings.zoomNear, this.settings.zoomFar, Math.min(1, me.speed / Math.min(CAR.vMax, 45))); // fully zoomed out from 45 m/s (100 mph) up
    this.camZoom += (zoomTarget - this.camZoom) * (1 - Math.exp(-2.5 * dt));
    this.applyCamera();
    const H = cameraHeight(this.settings.camHeight, this.settings.zoomNear, this.camZoom);
    this.ground.update(this.camX, this.camY, cam.width / (2 * this.camZoom), cam.height / (2 * this.camZoom));
    if (!this.startLogged && this.ground.painted) { this.startLogged = true; console.log(`ground painted: ${this.ground.painted} chunks, ${this.ground.ms.toFixed(0)} ms, ${this.world.tiles.size} tiles`); }
    this.bridges.update(this.camX, this.camY, cam.width / (2 * this.camZoom), cam.height / (2 * this.camZoom), H);
    this.buildings.update(this.camX, this.camY, this.camZoom, cam.width, cam.height, H);
    this.skyways.update(this.camX, this.camY, this.camZoom, cam.width, cam.height, H);
    this.look.update(this.camX, this.camY, H, this.camZoom, cam.width, cam.height, layerZ(me.layer));

    // traffic: cars spawn only outside what the player can see
    const view = { cx: this.camX, cy: this.camY, hw: cam.width / (2 * this.camZoom), hh: cam.height / (2 * this.camZoom) };
    if (this.trafficOn && (!this.stopAt || this.simTime < this.stopAt)) this.traffic.update(dt, this.player.inCar ? { x: car.x, y: car.y, heading: car.heading, layer: car.layer | 0 } : { x: me.x, y: me.y, heading: me.heading, layer: me.layer, length: 0.7, width: 0.7 }, view);
    this.trafficView.update(view, { cx: this.camX, cy: this.camY, H });
    if (this.pedsOn && (!this.stopAt || this.simTime < this.stopAt)) {
      const touched = this.peds.update(dt, { x: me.x, y: me.y, vx: me.vx, vy: me.vy, heading: me.heading }, view, this.blockedFn);
      if (touched && this.player.inCar) { const k = 0.985 ** touched; car.vx *= k; car.vy *= k; } // a nudge barely slows the car
    }
    this.pedView.update();

    this.navHud.update({ x: me.x, y: me.y, vx: me.vx, vy: me.vy, heading: me.heading });
    if (this.trafficOn) {
      const ev = this.police.update(dt, { x: me.x, y: me.y, vx: me.vx, vy: me.vy, layer: me.layer, inCar: this.player.inCar }, view);
      if (ev === 'busted') this.busted();
    }
    this.updateMissions(dt, me);
    this.updateDamage(dt, me);
    {
      const obj = this.missions.objective(), offer = this.missions.active ? null : this.missions.nextOffer();
      this.radar.update(dt, { x: me.x, y: me.y, heading: me.heading, target: obj?.target ?? null, phone: offer?.spot ?? null, shops: this.sprays, police: this.traffic.cars.filter((c) => c.police && !c.dead) });
    }
    // sound
    const snd = this.sound;
    if (Phaser.Input.Keyboard.JustDown(this.keyX)) snd.toggleMute();
    if (Phaser.Input.Keyboard.JustDown(this.keyN)) { this.settings.music = this.settings.music > 0 ? 0 : 0.35; this.applySettings(); }
    if (Phaser.Input.Keyboard.JustDown(this.keyH) && this.player.inCar) snd.horn();
    const inp = this.lastInput ?? {};
    snd.update({ inCar: this.player.inCar, speed: car.speed, vMax: CAR.vMax, throttle: inp.throttle ?? 0, sideSpeed: car.sideSpeed ?? 0, handbrake: !!inp.handbrake, walkSpeed: this.player.inCar ? 0 : this.player.walker.speed, policeDistance: this.police.nearest, dt });
    this.hudText(`${this.player.inCar ? `${Math.round(car.speed * 2.23694)} mph (${Math.round(car.speed * 3.6)} km/h)` : `on foot, ${this.player.gun.reloading > 0 ? 'reloading' : `${this.player.gun.ammo} rounds`}`}  |  ${this.traffic.cars.length} cars, ${this.peds.peds.length} people  |  ${this.look.label}`, this.player.inCar ? '↑/W gas   ↓/S brake + reverse   ←→/AD steer   Space handbrake   E get out   R restart   T settings   G scenery' : 'WASD/arrows walk   Shift run   Space or click shoot   E get in / take a car   M mission   R restart car');
  }

  /** arrested: a fine, the car and the stars are gone, back to the start */
  busted() { this.respawn('BUSTED!  Fine', 0.2, 100, 'Your car is gone.'); }

  /** killed: a hospital bill, back at the start in a new car */
  wasted() { this.respawn('WASTED!  Hospital bill', 0.1, 50, 'New car at the start.'); }

  respawn(title, share, least, tail) {
    const m = this.missions, fine = Math.min(m.cash, Math.max(least, Math.round(m.cash * share)));
    m.cash -= fine; m.persist(); m.abandon();
    m.message = { text: `${title} $${fine}. ${tail}`, t: 6, bad: true };
    this.police.reset();
    this.car.reset(this.start.x, this.start.y, this.start.heading); this.layers.reset(0);
    this.carView.setModel(null); this.player.stolen = false; this.damage.reset(); this.wreck = false;
    if (!this.player.inCar) this.player.enterCar();
    this.camX = this.car.x; this.camY = this.car.y;
  }

  /** damage: smoke and fire, the blast, the paint shop */
  updateDamage(dt, me) {
    const d = this.damage, car = this.car;
    if (!this.wreck && d.update(dt)) this.explodeCar(me);
    this.carView.setDamage(d.level, this.wreck);
    this.fx.update(dt, car, d, !this.wreck);
    // a paint shop: drive in slowly, pay, and the car is new and the police lose interest
    this.sprayT = (this.sprayT ?? 0) - dt;
    if (this.player.inCar && this.sprayT <= 0 && car.speed < 9) {
      for (const s of this.sprays) {
        if (Math.hypot(car.x - s.x, car.y - s.y) > 6 || !(d.hp < 100 || this.police.wanted.stars > 0)) continue;
        this.sprayT = 6;
        if (this.missions.cash >= 100) {
          this.missions.cash -= 100; this.missions.persist(); d.repair(); this.police.reset();
          this.missions.message = { text: 'Pay \'n\' Spray: as good as new, and nobody knows you.  -$100', t: 4, good: true };
        } else this.missions.message = { text: 'Pay \'n\' Spray costs $100', t: 3, bad: true };
        break;
      }
    }
  }

  explodeCar(me) {
    const car = this.car, R = BLAST_RADIUS;
    this.fx.explode(car.x, car.y);
    this.sound.burst(0.9, 130, 1.0); this.sound.burst(0.8, 320, 0.6, 'sine');
    if (this.pedsOn) for (const p of this.peds.peds) if (!p.dead && Math.hypot(p.x - car.x, p.y - car.y) < R) { this.peds.kill(p); this.player.corpses.push({ x: p.x, y: p.y, heading: p.heading, clothes: p.clothes, skin: p.skin, hair: p.id % 5, t: 0, img: null }); }
    for (const c of this.traffic.cars) if (!c.dead && Math.hypot(c.x - car.x, c.y - car.y) < R) c.dead = true;
    this.wreck = true;
    if (Math.hypot(me.x - car.x, me.y - car.y) < 6.5) this.wasted();
  }

  /** missions: the phone to answer,

  /** missions: the phone to answer, the objective, the target marker, cash */
  updateMissions(dt, me) {
    const m = this.missions, g = this.markers;
    if (Phaser.Input.Keyboard.JustDown(this.keyM)) {
      if (m.active) m.abandon();
      else { const o = m.offerAt(me.x, me.y); if (o) m.start(o, { kills: this.player.kills }); }
    }
    m.update(dt, { x: me.x, y: me.y, inCar: this.player.inCar, stolen: this.player.stolen && this.player.inCar, kills: this.player.kills });
    g.clear();
    const t = this.time.now / 1000, pulse = 1 + 0.12 * Math.sin(t * 5);
    const ring = (x, y, r, color) => { g.lineStyle(0.5, color, 0.95); g.strokeCircle(x, y, r * pulse); g.fillStyle(color, 0.16); g.fillCircle(x, y, r * pulse); };
    for (const s of this.sprays) { g.lineStyle(0.5, 0x5fd48a, 0.9); g.strokeCircle(s.x, s.y, 5.5 * pulse); g.fillStyle(0x5fd48a, 0.14); g.fillCircle(s.x, s.y, 5.5 * pulse); } // paint shops: green
    const offer = m.active ? null : m.nextOffer();
    if (offer) ring(offer.spot.x, offer.spot.y, 3.4, 0xffd84a); // the phone: a yellow ring
    const obj = m.objective();
    if (obj?.target) {
      const st = m.active.steps[m.step];
      ring(obj.target.x, obj.target.y, st.radius ?? 4, 0xff5a9a);
      // an arrow near the player pointing at the target
      const dx = obj.target.x - me.x, dy = obj.target.y - me.y, d = Math.hypot(dx, dy);
      if (d > 14) {
        const a = Math.atan2(dy, dx), ax = me.x + Math.cos(a) * 7, ay = me.y + Math.sin(a) * 7;
        g.fillStyle(0xff5a9a, 0.95);
        g.fillTriangle(ax + Math.cos(a) * 1.6, ay + Math.sin(a) * 1.6, ax + Math.cos(a + 2.5) * 1.1, ay + Math.sin(a + 2.5) * 1.1, ax + Math.cos(a - 2.5) * 1.1, ay + Math.sin(a - 2.5) * 1.1);
      }
    }
    // words
    const el = this.missionEl;
    let html = '', cls = '';
    if (m.message) { html = m.message.text; cls = m.message.good ? 'good' : m.message.bad ? 'bad' : ''; }
    else if (obj) {
      const dist = obj.target ? `${Math.round(Math.hypot(obj.target.x - me.x, obj.target.y - me.y))} m` : '';
      html = `<b>${obj.title}</b> (${obj.step}/${obj.steps}): ${obj.text}${dist ? `  ·  ${dist}` : ''}${obj.timeLeft !== null ? `  ·  ${Math.ceil(obj.timeLeft)} s` : ''}   <small>(M abandons)</small>`;
    } else if (offer && m.offerAt(me.x, me.y)) html = `<b>${offer.title}</b>: ${offer.brief}   <b>Press M to take the job</b>`;
    if (html !== this.missionHtml || cls !== this.missionCls) { this.missionHtml = html; this.missionCls = cls; el.innerHTML = html; el.className = cls; el.style.display = html ? 'block' : 'none'; }
    const cash = `$${m.cash.toLocaleString('en-US')}`, stars = this.police.wanted.stars, hot = this.police.nearest < 70 && this.time.now % 600 < 300;
    const starsKey = `${stars}${hot ? 'h' : ''}`;
    const hp = Math.round(this.damage.hp) + (this.wreck ? 'w' : '');
    if (cash !== this.cashShown || this.killsShown !== this.player.kills || starsKey !== this.starsShown || hp !== this.hpShown) {
      this.cashShown = cash; this.killsShown = this.player.kills; this.starsShown = starsKey; this.hpShown = hp;
      const star = stars ? `<small style="color:${hot ? '#ff6a5a' : '#ffd84a'};font-size:20px;letter-spacing:2px">${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}</small>` : '';
      const carLine = this.wreck ? '<small style="color:#ff6a5a">car destroyed</small>' : this.damage.hp < 100 ? `<small style="color:${this.damage.hp < 25 ? '#ff6a5a' : this.damage.hp < 55 ? '#ffb04a' : '#cfd5d9'}">car ${Math.round(this.damage.hp)}%</small>` : '';
      this.scoreEl.innerHTML = `${cash}${star}${carLine}${this.player.kills ? `<small>${this.player.kills} down</small>` : ''}`;
    }
  }

  hudText(left, controls) {
    const s = this.buildings.stats;
    this.hud.textContent =
      `${Math.round(this.game.loop.actualFps)} fps  |  ${left}  |  ${s.drawn} buildings in ${s.ms.toFixed(1)} ms\n` +
      `${controls}`;
  }
}
