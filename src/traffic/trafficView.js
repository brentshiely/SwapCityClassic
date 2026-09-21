import { pointAt, polyInfo } from '../world/geometry.js';
import { TYPES, COLORS } from './trafficSim.js';
import { makeNpcTextures, spriteSize } from './npcSprites.js';

const LAMP = { green: 0x3ddc84, yellow: 0xffd23f, red: 0xff4d3d };

// Draws the traffic: one sprite per car (with shadow and brake lights) and a lamp at the kerb by each
// stop line showing the light's colour. All logic lives in TrafficSim.
export class TrafficView {
  constructor(scene, sim) {
    this.scene = scene;
    this.sim = sim;
    makeNpcTextures(scene, TYPES, COLORS);
    this.sprites = new Map();
    this.g = scene.add.graphics().setDepth(6);
    this.lamps = [];
    for (const { node, approaches } of sim.signals.byNode.values()) {
      for (const de of approaches) {
        // lamp: beside the stop line, on the kerb at the right-hand side of the approach
        const ji = sim.net.jinfo.get(node.id), info = polyInfo(de.pts);
        const p = pointAt(info, Math.max(0, info.len - ji.stopDist - 0.8));
        const off = de.width / 2 + 1.5; // right of the street's centre line, out on the pavement
        this.lamps.push({ de, x: p.x - p.ty * off, y: p.y + p.tx * off });
      }
    }
  }

  update(view) {
    const { sim, scene } = this;
    const seen = new Set();
    for (const c of sim.cars) {
      if (c.dead) continue;
      seen.add(c.id);
      let sp = this.sprites.get(c.id);
      if (!sp) {
        const t = TYPES.find((x) => x.name === c.type), [w, h] = spriteSize(t);
        const ci = Math.max(0, COLORS.indexOf(c.color));
        sp = {
          shadow: scene.add.image(0, 0, `npc_shadow_${c.type}`).setDisplaySize(w, h).setDepth(4),
          body: scene.add.image(0, 0, `npc_${c.type}_${ci}`).setDisplaySize(w, h).setDepth(5),
          brake: scene.add.image(0, 0, `npc_brake_${c.type}`).setDisplaySize(w, h).setDepth(5).setVisible(false),
        };
        this.sprites.set(c.id, sp);
      }
      sp.body.setPosition(c.x, c.y).setRotation(c.heading);
      sp.brake.setPosition(c.x, c.y).setRotation(c.heading).setVisible(c.braking);
      sp.shadow.setPosition(c.x + 0.45, c.y + 0.6).setRotation(c.heading);
    }
    for (const [id, sp] of this.sprites) {
      if (seen.has(id)) continue;
      sp.shadow.destroy(); sp.body.destroy(); sp.brake.destroy();
      this.sprites.delete(id);
    }

    // traffic lights
    const g = this.g;
    g.clear();
    for (const l of this.lamps) {
      if (view && (Math.abs(l.x - view.cx) > view.hw + 5 || Math.abs(l.y - view.cy) > view.hh + 5)) continue;
      const st = sim.signals.state(l.de, sim.t);
      g.fillStyle(0x15181a, 1); g.fillRoundedRect(l.x - 0.85, l.y - 0.85, 1.7, 1.7, 0.35);
      g.fillStyle(LAMP[st], 0.28); g.fillCircle(l.x, l.y, 1.5);
      g.fillStyle(LAMP[st], 1); g.fillCircle(l.x, l.y, 0.5);
    }
  }
}
