import { pointAt, polyInfo } from '../world/geometry.js';
import { scaleAt } from '../render/perspective.js';
import { layerZ } from '../world/layers.js';
import { PolyGrid } from '../world/spatial.js';
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
    this.lampGrid = new PolyGrid(64); // so a whole city's lamps cost only the ones in view each frame
    for (const { node, approaches } of sim.signals.byNode.values()) {
      for (const de of approaches) {
        // lamp: beside the stop line, on the kerb at the right-hand side of the approach
        const ji = sim.net.jinfo.get(node.id), info = polyInfo(de.pts);
        const p = pointAt(info, Math.max(0, info.len - ji.stopDist - 0.8));
        const off = de.width / 2 + 1.5; // right of the street's centre line, out on the pavement
        const lamp = { de, x: p.x - p.ty * off, y: p.y + p.tx * off };
        this.lamps.push(lamp);
        this.lampGrid.add(lamp, [[lamp.x, lamp.y]]);
      }
    }
  }

  update(view, persp = null) {
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
      // a car on a bridge is above the ground (scaled away from the middle of the screen like a building's roof); one in a tunnel is dimmed
      const layer = c.layer | 0, f = layer > 0 && persp ? scaleAt(persp.H, layerZ(layer)) : 1;
      const px = f === 1 ? c.x : persp.cx + (c.x - persp.cx) * f, py = f === 1 ? c.y : persp.cy + (c.y - persp.cy) * f;
      if (sp.layer !== layer || sp.f !== f) {
        sp.layer = layer; sp.f = f;
        const t = TYPES.find((x) => x.name === c.type), [w, h] = spriteSize(t);
        for (const im of [sp.shadow, sp.body, sp.brake]) im.setDisplaySize(w * f, h * f);
        const d = layer > 0 ? 8 + layer + 0.1 : 4;
        sp.shadow.setDepth(d); sp.body.setDepth(d + 1); sp.brake.setDepth(d + 1);
        for (const im of [sp.body, sp.brake]) { if (layer < 0) im.setTint(0x8d9aa6).setAlpha(0.8); else im.clearTint().setAlpha(1); }
      }
      sp.body.setPosition(px, py).setRotation(c.heading);
      sp.brake.setPosition(px, py).setRotation(c.heading).setVisible(c.braking);
      sp.shadow.setPosition(px + 0.45 * f, py + 0.6 * f).setRotation(c.heading);
    }
    for (const [id, sp] of this.sprites) {
      if (seen.has(id)) continue;
      sp.shadow.destroy(); sp.body.destroy(); sp.brake.destroy();
      this.sprites.delete(id);
    }

    // traffic lights
    const g = this.g;
    g.clear();
    // police lights: red and blue, alternating
    const flash = Math.floor(sim.t * 6) % 2;
    for (const c of sim.cars) {
      if (!c.police || c.dead) continue;
      const cs = Math.cos(c.heading), sn = Math.sin(c.heading);
      for (const side of [-1, 1]) {
        const on = (side > 0) === (flash === 0), x = c.x + cs * 0.2 - sn * 0.45 * side, y = c.y + sn * 0.2 + cs * 0.45 * side;
        g.fillStyle(side > 0 ? 0xff3a2a : 0x3a6bff, on ? 0.35 : 0.08); g.fillCircle(x, y, on ? 2.6 : 1.4);
        g.fillStyle(side > 0 ? 0xff7a6a : 0x7aa0ff, on ? 1 : 0.25); g.fillCircle(x, y, 0.32);
      }
    }
    const drawLamp = (l) => {
      const st = sim.signals.state(l.de, sim.t);
      g.fillStyle(0x15181a, 1); g.fillRoundedRect(l.x - 0.85, l.y - 0.85, 1.7, 1.7, 0.35);
      g.fillStyle(LAMP[st], 0.28); g.fillCircle(l.x, l.y, 1.5);
      g.fillStyle(LAMP[st], 1); g.fillCircle(l.x, l.y, 0.5);
    };
    if (!view) { this.lamps.forEach(drawLamp); return; }
    // the grid query is square around the view's centre; the exact test keeps the old margin
    this.lampGrid.query(view.cx, view.cy, Math.max(view.hw, view.hh) + 5, (l) => {
      if (Math.abs(l.x - view.cx) > view.hw + 5 || Math.abs(l.y - view.cy) > view.hh + 5) return;
      drawLamp(l);
    });
  }
}
