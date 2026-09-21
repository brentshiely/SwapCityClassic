import Phaser from 'phaser';
import map from '../../data/map.json';
import { attachFreeCamera, startFromHash } from '../camera/freeCamera.js';

// Debug view of the baked map data: roads, footprints, walkways, crossings and the road graph.
// Same trackpad camera as the world (see camera/freeCamera.js). Keys 1-6 toggle layers.
const LAYERS = [
  ['1', 'areas'], ['2', 'buildings'], ['3', 'roads'], ['4', 'walkways'], ['5', 'graph'], ['6', 'world'],
];

const ROAD_COLOR = { motorway: 0x7a6f9b, primary: 0xc98a3a, secondary: 0x5a7f8f, tertiary: 0x5a7f8f, unclassified: 0x5a7f8f, residential: 0x5a7f8f, living_street: 0x5a7f8f, service: 0x8d979e };
const flat = (pts) => pts.map(([x, y]) => new Phaser.Math.Vector2(x, y));

export class MapDebugScene extends Phaser.Scene {
  constructor() {
    super('map-debug');
  }

  create() {
    this.cameras.main.setBackgroundColor(0x1b1f22);
    this.layers = {};
    for (const [, name] of LAYERS) this.layers[name] = this.add.graphics();
    this.drawAreas(this.layers.areas);
    this.drawBuildings(this.layers.buildings);
    this.drawRoads(this.layers.roads);
    this.drawWalkways(this.layers.walkways);
    this.drawGraph(this.layers.graph);
    this.drawWorld(this.layers.world);

    const cam = this.cameras.main;
    const h = startFromHash();
    const w = map.meta.world;
    this.fit = Math.min(this.scale.width / (w.maxX - w.minX + 40), this.scale.height / (w.maxY - w.minY + 40));
    cam.setZoom(Number(h.z) || this.fit);
    cam.centerOn(Number(h.x) || 0, Number(h.y) || 0);
    attachFreeCamera(this, {
      fitZoom: this.fit,
      onKey: (ev) => {
        const layer = LAYERS[Number(ev.key) - 1];
        if (!layer) return false;
        this.layers[layer[1]].setVisible(!this.layers[layer[1]].visible);
        this.updateHud();
        return true;
      },
    });
    this.hud = document.getElementById('hud');
    this.updateHud();
  }

  updateHud() {
    const g = map.graph;
    const on = LAYERS.map(([k, name]) => `${k} ${name}${this.layers[name].visible ? '' : ' (off)'}`).join('   ');
    this.hud.textContent =
      `${map.meta.name}  |  ${map.roads.length} roads, ${map.buildings.length} buildings, ${g.nodes.length} nodes, ${g.edges.length} edges\n` +
      `${on}\ntwo-finger scroll = pan   pinch or + / - = zoom   0 = refit   drag or arrows = pan\n${map.meta.attribution}`;
  }

  drawAreas(g) {
    for (const a of map.areas) {
      g.fillStyle(a.kind === 'parking' ? 0x2c3238 : 0x2f5a3a, 1);
      g.fillPoints(flat(a.points), true);
    }
  }

  drawBuildings(g) {
    for (const b of map.buildings) {
      // known height (OSM height or levels) is lighter; a guessed default is darker
      const known = b.heightSource !== 'default';
      const t = Phaser.Math.Clamp(b.height / 120, 0, 1);
      const base = known ? [122, 140, 158] : [80, 90, 98];
      const c = Phaser.Display.Color.GetColor(base[0] + t * 70, base[1] + t * 60, base[2] + t * 50);
      g.fillStyle(c, 1);
      g.lineStyle(0.6, 0x1b1f22, 1);
      const pts = flat(b.points);
      g.fillPoints(pts, true);
      g.strokePoints(pts, true, true);
    }
  }

  drawRoads(g) {
    const ordered = [...map.roads].sort((a, b) => a.layer - b.layer);
    for (const r of ordered) {
      const pts = flat(r.points);
      g.lineStyle(r.width, ROAD_COLOR[r.highway.replace(/_link$/, '')] ?? 0x8d979e, r.layer < 0 ? 0.35 : 1);
      g.strokePoints(pts, false, false);
    }
    // crossings: short bars across the road
    g.lineStyle(1.4, 0xf0f0f0, 1);
    for (const c of map.crossings) {
      const a = (c.angle * Math.PI) / 180;
      const dx = Math.cos(a) * 1.2, dy = Math.sin(a) * 1.2, nx = -Math.sin(a) * c.width * 0.5, ny = Math.cos(a) * c.width * 0.5;
      g.lineBetween(c.x - dx - nx, c.y - dy - ny, c.x - dx + nx, c.y - dy + ny);
      g.lineBetween(c.x + dx - nx, c.y + dy - ny, c.x + dx + nx, c.y + dy + ny);
    }
  }

  drawWalkways(g) {
    for (const w of map.walkways) {
      g.lineStyle(w.kind === 'crossing' ? 0.8 : 0.9, w.kind === 'crossing' ? 0xffffff : w.kind === 'pedestrian' ? 0x5fbf8f : 0xb9c0c5, 0.9);
      g.strokePoints(flat(w.points), false, false);
    }
  }

  drawGraph(g) {
    const nodes = map.graph.nodes;
    for (const e of map.graph.edges) {
      g.lineStyle(1.6, e.oneway ? 0xffa53a : 0x4ad0e0, 1);
      g.strokePoints(flat(e.points), false, false);
      if (e.oneway) {
        // arrowhead at the middle of the last segment, pointing along travel
        const p = e.points, a = p[p.length - 2], b = p[p.length - 1];
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        g.fillStyle(0xffa53a, 1);
        g.fillTriangle(mx + Math.cos(ang) * 4, my + Math.sin(ang) * 4, mx + Math.cos(ang + 2.5) * 3.5, my + Math.sin(ang + 2.5) * 3.5, mx + Math.cos(ang - 2.5) * 3.5, my + Math.sin(ang - 2.5) * 3.5);
      }
    }
    for (const n of nodes) {
      if (n.boundary) { g.fillStyle(0xff3fd0, 1); g.fillRect(n.x - 3, n.y - 3, 6, 6); }
      else { g.fillStyle(n.signal ? 0xff4040 : 0xffffff, 1); g.fillCircle(n.x, n.y, n.signal ? 3 : 2); }
    }
  }

  drawWorld(g) {
    const w = map.meta.world, b = map.meta.box;
    g.lineStyle(1.5, 0xe6ac00, 1);
    g.strokeRect(w.minX, w.minY, w.maxX - w.minX, w.maxY - w.minY);
    g.lineStyle(1, 0xe6ac00, 0.5);
    g.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
  }
}
