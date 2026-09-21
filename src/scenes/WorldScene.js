import Phaser from 'phaser';
import map from '../../data/map.json';
import { buildGround, PPM } from '../render/ground.js';
import { attachFreeCamera, startFromHash } from '../camera/freeCamera.js';

// The game world. For now: the painted ground seen through the free camera.
export class WorldScene extends Phaser.Scene {
  constructor() {
    super('world');
  }

  create() {
    this.cameras.main.setBackgroundColor(0x14181a);
    const info = buildGround(this, map);
    console.log(`ground painted: ${info.chunks} chunks, ${(info.pixels / 1e6).toFixed(0)} Mpx, ${info.ms} ms`);

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
    this.hud.textContent =
      `${Math.round(this.game.loop.actualFps)} fps  |  ${cam.zoom.toFixed(1)} px/m  |  ground ${this.info.chunks} chunks @ ${PPM} px/m, painted in ${this.info.ms} ms\n` +
      `two-finger scroll = pan   pinch or + / - = zoom   0 = refit   drag or arrows = pan\n${map.meta.attribution}`;
  }
}
