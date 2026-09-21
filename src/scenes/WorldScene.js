import Phaser from 'phaser';
import map from '../../data/map.json';
import { buildGround } from '../render/ground.js';
import { BuildingRenderer } from '../render/buildings.js';
import { attachFreeCamera, startFromHash } from '../camera/freeCamera.js';

// The game world. For now: the painted ground and pseudo-3D buildings seen through the free camera.
export class WorldScene extends Phaser.Scene {
  constructor() {
    super('world');
  }

  create() {
    this.cameras.main.setBackgroundColor(0x14181a);
    this.buildings = new BuildingRenderer(this, map);
    const info = buildGround(this, map);
    console.log(`ground painted: ${info.barriers} barriers, ${info.chunks} chunks, ${(info.pixels / 1e6).toFixed(0)} Mpx, ${info.ms} ms`);

    const w = map.meta.world;
    const fit = Math.min(this.scale.width / (w.maxX - w.minX + 40), this.scale.height / (w.maxY - w.minY + 40));
    const h = startFromHash();
    const cam = this.cameras.main;
    // Camera zoom equals screen pixels per metre; the start view is a GTA1-like tight street view.
    cam.setZoom(Number(h.z) || 16);
    cam.centerOn(Number(h.x) || 0, Number(h.y) || 0);
    attachFreeCamera(this, { fitZoom: fit, minZoom: fit * 0.6, maxZoom: 40 });

    this.hud = document.getElementById('hud');
    this.info = info;
  }

  update() {
    const cam = this.cameras.main;
    this.buildings.update(cam);
    const s = this.buildings.stats;
    this.hud.textContent =
      `${Math.round(this.game.loop.actualFps)} fps  |  ${cam.zoom.toFixed(1)} px/m  |  ${s.drawn} buildings drawn in ${s.ms.toFixed(1)} ms  |  ${this.info.barriers} street barriers  |  view ${cam.width}x${cam.height} @ ${cam.midPoint.x.toFixed(0)},${cam.midPoint.y.toFixed(0)}\n` +
      `two-finger scroll = pan   pinch or + / - = zoom   0 = refit   drag or arrows = pan\n${map.meta.attribution}`;
  }
}
