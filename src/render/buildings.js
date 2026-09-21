import Phaser from 'phaser';
import { mulberry32 } from './rng.js';

// Pseudo-3D buildings, GTA1 style: the roof of each building is pushed away from the point the
// camera is looking at, in proportion to its height, and the walls facing that point show between
// the footprint and the roof. Everything is redrawn each frame but only for buildings in view.

// roof shift, as a fraction of (distance from camera centre x effective height); the settings panel changes it
export const RENDER = { lean: 0.003 };
const LIGHT = Math.atan2(-0.8, -0.6); // light comes from the upper left
const PALETTE = [
  { roof: [139, 144, 150], wall: [104, 110, 116] }, // concrete
  { roof: [154, 107, 88], wall: [122, 79, 64] }, // brick
  { roof: [177, 165, 138], wall: [143, 133, 112] }, // tan
  { roof: [95, 109, 120], wall: [71, 82, 91] }, // slate
  { roof: [108, 139, 138], wall: [78, 105, 104] }, // teal
  { roof: [194, 183, 155], wall: [160, 150, 119] }, // sand
];
const GLASS_TOWER = { roof: [125, 138, 148], wall: [56, 72, 86] };

const rgb = ([r, g, b], k = 1) => Phaser.Display.Color.GetColor(Math.min(255, r * k), Math.min(255, g * k), Math.min(255, b * k));

// Tall buildings lean less than their true height would say, so a tower does not smear across the screen.
const effectiveHeight = (h) => Math.min(h, 40) + Math.max(0, h - 40) * 0.25;

export class BuildingRenderer {
  constructor(scene, map) {
    this.g = scene.add.graphics().setDepth(10);
    this.scratch = [0, 1, 2, 3].map(() => ({ x: 0, y: 0 }));
    this.stats = { drawn: 0, ms: 0 };
    this.world = map.meta.world;
    this.buildings = map.buildings.map((b) => this.prepare(b));
  }

  prepare(b) {
    const rand = mulberry32(b.id);
    const pal = b.height > 60 ? GLASS_TOWER : PALETTE[Math.floor(rand() * PALETTE.length)];
    const pts = b.points.map(([x, y]) => ({ x, y }));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const edges = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], c = pts[(i + 1) % pts.length];
      const dx = c.x - a.x, dy = c.y - a.y, len = Math.hypot(dx, dy);
      if (len < 0.3) continue;
      const nx = dy / len, ny = -dx / len; // outward normal (footprints are wound consistently)
      const facing = Math.cos(Math.atan2(ny, nx) - LIGHT); // 1 = faces the light
      edges.push({ a, b: c, len, nx, ny, shade: 0.72 + 0.22 * facing });
    }
    const w = this.world, mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    const outside = mx < w.minX || mx > w.maxX || my < w.minY || my > w.maxY;
    return {
      dim: outside ? 0.62 : 1, h: b.height, eh: effectiveHeight(b.height), pts, edges, bbox: [x0, y0, x1, y1],
      roofPts: pts.map(() => ({ x: 0, y: 0 })),
      pal, floors: Math.max(1, Math.round(b.height / 3.4)),
    };
  }

  /** cx, cy: the world point at the middle of the screen; the roofs lean away from it. */
  update(cx, cy, zoom, viewW, viewH) {
    const t0 = performance.now();
    const g = this.g;
    g.clear();
    const hw = viewW / (2 * zoom), hh = viewH / (2 * zoom), pad = 60;
    const v = { x: cx - hw, y: cy - hh, right: cx + hw, bottom: cy + hh };
    const inView = [];
    for (const b of this.buildings) {
      const [x0, y0, x1, y1] = b.bbox;
      if (x1 < v.x - pad || x0 > v.right + pad || y1 < v.y - pad || y0 > v.bottom + pad) continue;
      b.dist = Math.hypot((x0 + x1) / 2 - cx, (y0 + y1) / 2 - cy);
      inView.push(b);
    }
    inView.sort((p, q) => q.dist - p.dist); // far first, so nearer buildings overlap them
    for (const b of inView) this.drawBuilding(g, b, cx, cy, zoom);
    this.stats.drawn = inView.length;
    this.stats.ms = performance.now() - t0;
  }

  drawBuilding(g, b, cx, cy, zoom) {
    const k = RENDER.lean * b.eh;
    for (let i = 0; i < b.pts.length; i++) {
      const p = b.pts[i], r = b.roofPts[i];
      r.x = p.x + (p.x - cx) * k;
      r.y = p.y + (p.y - cy) * k;
    }
    const { wall, roof } = b.pal;

    // floor: guarantees no gaps between footprint, walls and roof on odd shapes
    g.fillStyle(rgb(wall, 0.7 * b.dim), 1);
    g.fillPoints(b.pts, true);

    const q = this.scratch;
    for (let i = 0; i < b.edges.length; i++) {
      const e = b.edges[i];
      const mx = (e.a.x + e.b.x) / 2, my = (e.a.y + e.b.y) / 2;
      if (e.nx * (cx - mx) + e.ny * (cy - my) <= 0) continue; // faces away from the camera
      const ai = b.pts.indexOf(e.a), bi = (ai + 1) % b.pts.length;
      const ra = b.roofPts[ai], rb = b.roofPts[bi];
      q[0].x = e.a.x; q[0].y = e.a.y; q[1].x = e.b.x; q[1].y = e.b.y; q[2].x = rb.x; q[2].y = rb.y; q[3].x = ra.x; q[3].y = ra.y;
      g.fillStyle(rgb(wall, e.shade * b.dim), 1);
      g.fillPoints(q, true);

      // window bands, only when the wall is wide enough on screen to show them
      const thickness = Math.hypot(ra.x - e.a.x, ra.y - e.a.y) * zoom;
      if (thickness > 3 && e.len > 3) {
        const n = Math.min(b.floors, 14);
        g.fillStyle(rgb([18, 30, 42], 1), 0.55);
        for (let f = 0; f < n; f++) {
          const t0 = (f + 0.28) / n, t1 = (f + 0.72) / n;
          q[0].x = e.a.x + (ra.x - e.a.x) * t0; q[0].y = e.a.y + (ra.y - e.a.y) * t0;
          q[1].x = e.b.x + (rb.x - e.b.x) * t0; q[1].y = e.b.y + (rb.y - e.b.y) * t0;
          q[2].x = e.b.x + (rb.x - e.b.x) * t1; q[2].y = e.b.y + (rb.y - e.b.y) * t1;
          q[3].x = e.a.x + (ra.x - e.a.x) * t1; q[3].y = e.a.y + (ra.y - e.a.y) * t1;
          g.fillPoints(q, true);
        }
      }
    }

    g.fillStyle(rgb(roof, b.dim), 1);
    g.fillPoints(b.roofPts, true);
    g.lineStyle(0.35, rgb(roof, 0.55 * b.dim), 1);
    g.strokePoints(b.roofPts, true, true);
  }
}
