import { pedTextureKey, makePedShadow, PED_SPRITE_M } from './pedSprites.js';

const PED_SCALE = 1.25; // a little bigger than life so people read clearly at driving zoom, like GTA1's

// Draws the pedestrians: one sprite (plus a small shadow) per person, alternating two walking frames.
export class PedView {
  constructor(scene, sim) {
    this.scene = scene;
    this.sim = sim;
    this.sprites = new Map();
    makePedShadow(scene);
  }

  update() {
    const seen = new Set();
    for (const p of this.sim.peds) {
      if (p.dead) continue;
      seen.add(p.id);
      let sp = this.sprites.get(p.id);
      if (!sp) {
        const hair = p.id % 5;
        sp = {
          shadow: this.scene.add.image(0, 0, 'ped_shadow').setDisplaySize(0.85 * PED_SCALE, 0.5 * PED_SCALE).setDepth(3.9),
          body: this.scene.add.image(0, 0, pedTextureKey(this.scene, p.clothes, p.skin, 0, hair)).setDisplaySize(PED_SPRITE_M * PED_SCALE, PED_SPRITE_M * PED_SCALE).setDepth(4.6),
          frame: 0, hair,
        };
        this.sprites.set(p.id, sp);
      }
      // walking: swap frame every half metre travelled; standing: feet together
      const frame = p.v > 0.2 ? Math.floor(p.dist / 0.5) % 2 : 0;
      if (frame !== sp.frame) { sp.frame = frame; sp.body.setTexture(pedTextureKey(this.scene, p.clothes, p.skin, frame, sp.hair)); }
      sp.body.setPosition(p.x, p.y).setRotation(p.heading);
      sp.shadow.setPosition(p.x + 0.15, p.y + 0.2).setRotation(p.heading);
    }
    for (const [id, sp] of this.sprites) {
      if (seen.has(id)) continue;
      sp.body.destroy(); sp.shadow.destroy();
      this.sprites.delete(id);
    }
  }
}
