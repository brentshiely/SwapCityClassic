import Phaser from 'phaser';
import { mulberry32 } from './rng.js';
import { scaleAt, lensHeight, hullVisible } from './perspective.js';
import { facadeStyle, drawFacade } from './facades.js';

// Pseudo-3D buildings seen by a camera looking straight down (see perspective.js): each block is drawn from the height it
// starts at to the height it reaches, its top scaled away from the point the camera is above by H / (H - height), and the
// walls facing that point show between its base and its top. Everything is redrawn each frame but only for buildings in view.

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


export class BuildingRenderer {
  /**
   * @param scene the Phaser scene
   * @param map { meta, buildings } (the baked map, or a list of pseudo-buildings such as skyways)
   * @param roofs an optional RoofCutter: roofs get the aerial photo instead of a flat colour
   * @param depth the display depth of this layer (a layer with a higher depth is drawn over one with a lower depth)
   */
  constructor(scene, map, roofs = null, depth = 10) {
    this.scene = scene;
    this.depth = depth;
    this.roofs = roofs;
    this.facades = map.facades !== false; // pseudo-buildings can opt out
    // Every visible building is its own Graphics (walls) with, on top of it, an Image (the photo roof), so far and near buildings
    // keep the painter's order that a single Graphics gave. `g` is the handle the look controller uses to hide the whole layer.
    this.pool = []; this.shown = new Set(); this.on = true;
    this.g = { setVisible: (v) => { this.on = v; if (!v) this.hideAll(); return this.g; } };
    this.scratch = [0, 1, 2, 3].map(() => ({ x: 0, y: 0 }));
    this.stats = { drawn: 0, ms: 0 };
    this.world = map.meta.world;
    this.inside = map.inside ?? null; // (x, y) => inside the playable area? buildings outside are drawn dimmer
    // A stepped building (a low base with towers on it, measured from LiDAR) arrives as blocks, each with the height it
    // starts at and the height it reaches. A plain building is one block from the ground.
    this.buildings = [];
    this.byId = new Map(); // building id -> its blocks, so a tile's buildings can be taken out again
    this.pending = []; // buildings that have arrived but are not prepared yet (preparing cuts their roof photos: a dense tile takes ~100 ms)
    this.add(map.buildings ?? [], null, true);
  }

  /**
   * add buildings (a tile arriving); one that is already here is skipped. They are prepared a few milliseconds per frame
   * (`work`), so a tile arriving at 150 mph does not make a hitch, unless `now` asks for all of them at once (the first screen).
   */
  add(list, tile = null, now = false) {
    for (const b of list) if (!this.byId.has(b.id)) this.pending.push({ b, tile });
    if (now) this.work(Infinity);
  }

  /** prepare pending buildings for up to `ms` milliseconds (at least one) */
  work(ms = 4) {
    const t0 = performance.now();
    while (this.pending.length && (performance.now() - t0 < ms || ms === Infinity)) {
      const { b, tile } = this.pending.shift();
      if (this.byId.has(b.id)) continue;
      this.tile = tile; // the tile they arrived with: its aerial photo is where their roofs are cut from
      const blocks = b.parts ? b.parts.map((part) => this.prepare(b, part)) : [this.prepare(b)];
      this.byId.set(b.id, blocks);
      for (const k of blocks) this.buildings.push(k);
    }
  }

  /** take buildings out (a tile leaving): their roof cut-outs are freed too */
  remove(ids) {
    if (this.pending.length) { const drop = new Set(ids); this.pending = this.pending.filter((p) => !drop.has(p.b.id)); }
    const gone = new Set();
    for (const id of ids) {
      const blocks = this.byId.get(id);
      if (!blocks) continue;
      this.byId.delete(id);
      for (const k of blocks) {
        gone.add(k);
        if (k.img) { this.shown.delete(k.img); k.img.destroy(); k.img = null; }
        if (k.roof) this.scene.textures.remove(k.roof.key);
      }
    }
    if (gone.size) this.buildings = this.buildings.filter((k) => !gone.has(k));
  }

  prepare(b, part = null) {
    const poly = part ? part.points : b.points;
    const base = part ? part.base : 0, top = part ? part.top : b.height;
    const rand = mulberry32(b.id + (part ? Math.round(part.top) : 0));
    // the look of the walls: a facade style (glass tower, brick/stone with windows, parking deck) chosen from what is known
    const fac = this.facades ? facadeStyle(b, b.height ?? top) : null;
    const base0 = b.pal ?? (top > 60 ? GLASS_TOWER : PALETTE[Math.floor(rand() * PALETTE.length)]);
    const pal = fac ? { roof: base0.roof, wall: fac.wall } : base0;
    const pts = poly.map(([x, y]) => ({ x, y }));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const edges = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], c = pts[(i + 1) % pts.length];
      const dx = c.x - a.x, dy = c.y - a.y, len = Math.hypot(dx, dy);
      if (len < 0.3) continue;
      const nx = dy / len, ny = -dx / len; // outward normal (footprints are wound consistently)
      const facing = Math.cos(Math.atan2(ny, nx) - LIGHT); // 1 = faces the light
      edges.push({ a, b: c, ai: i, bi: (i + 1) % pts.length, len, nx, ny, shade: 0.72 + 0.22 * facing });
    }
    // all blocks of one building are ordered by the building's own position, and lowest first among themselves
    let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
    for (const [x, y] of b.points) { gx0 = Math.min(gx0, x); gy0 = Math.min(gy0, y); gx1 = Math.max(gx1, x); gy1 = Math.max(gy1, y); }
    const w = this.world, mx = (gx0 + gx1) / 2, my = (gy0 + gy1) / 2;
    const outside = this.inside ? !this.inside(mx, my) : (mx < w.minX || mx > w.maxX || my < w.minY || my > w.maxY);
    const roof = this.roofs ? this.roofs.cut(b.id + (part ? `p${Math.round(part.top * 10)}` : ''), pts, top, this.tile) : null;
    return {
      dim: outside ? 0.62 : 1, base, top, pts, edges, bbox: [x0, y0, x1, y1], group: [mx, my], roof, img: null,
      basePts: pts.map(() => ({ x: 0, y: 0 })), roofPts: pts.map(() => ({ x: 0, y: 0 })),
      pal, fac, floors: Math.max(1, Math.round((top - base) / 3.4)),
    };
  }

  hideAll() {
    for (const g of this.pool) g.setVisible(false).clear();
    for (const img of this.shown) img.setVisible(false);
    this.shown = new Set();
  }

  /**
   * @param cx, cy the world point at the middle of the screen (the camera is directly above it)
   * @param H camera height in metres
   */
  update(cx, cy, zoom, viewW, viewH, H) {
    this.work(4);
    const t0 = performance.now();
    if (!this.on) { this.stats.drawn = 0; this.stats.ms = 0; return; }
    const hw = viewW / (2 * zoom), hh = viewH / (2 * zoom);
    const v = { x: cx - hw, y: cy - hh, right: cx + hw, bottom: cy + hh };
    const lens = lensHeight(H);
    this.H = H;
    const inView = [];
    for (const b of this.buildings) {
      if (b.base >= lens) continue; // starts above the lens: never seen
      b.sB = scaleAt(H, b.base); b.sT = scaleAt(H, b.top);
      if (!hullVisible(b.bbox, cx, cy, b.sB, b.sT, v)) continue;
      b.dist = Math.hypot(b.group[0] - cx, b.group[1] - cy);
      inView.push(b);
    }
    // far buildings first, so nearer ones overlap them; within one building the lowest block first, so a tower is drawn over its base
    inView.sort((p, q) => (q.dist - p.dist) || (p.top - q.top));
    const now = new Set();
    inView.forEach((b, i) => {
      const g = this.pool[i] ?? (this.pool[i] = this.scene.add.graphics());
      g.setVisible(true).setDepth(this.depth + i * 0.001).clear();
      this.drawBuilding(g, b, cx, cy, zoom, lens, this.depth + i * 0.001 + 0.0005);
      if (b.img) now.add(b.img);
    });
    for (let i = inView.length; i < this.pool.length; i++) this.pool[i].setVisible(false).clear();
    for (const img of this.shown) if (!now.has(img)) img.setVisible(false);
    this.shown = now;
    this.stats.drawn = inView.length;
    this.stats.ms = performance.now() - t0;
  }

  drawBuilding(g, b, cx, cy, zoom, lens, depth) {
    const k = b.sT - 1, kb = b.sB - 1; // how far the top and the base are pushed out, as a share of the distance from the centre
    const overhead = b.top >= lens; // the top is above the lens: no roof to see, the walls run off the screen
    for (let i = 0; i < b.pts.length; i++) {
      const p = b.pts[i], r = b.roofPts[i], q0 = b.basePts[i];
      r.x = p.x + (p.x - cx) * k; r.y = p.y + (p.y - cy) * k;
      q0.x = p.x + (p.x - cx) * kb; q0.y = p.y + (p.y - cy) * kb; // where the block starts: the roof level of what it stands on
    }
    const { wall, roof } = b.pal;

    // floor: guarantees no gaps between footprint, walls and roof on odd shapes (only for a block that starts at the ground)
    if (b.base === 0) { g.fillStyle(rgb(wall, 0.7 * b.dim), 1); g.fillPoints(b.pts, true); }

    const q = this.scratch;
    for (let i = 0; i < b.edges.length; i++) {
      const e = b.edges[i];
      const mx = (e.a.x + e.b.x) / 2, my = (e.a.y + e.b.y) / 2;
      if (e.nx * (cx - mx) + e.ny * (cy - my) <= 0) continue; // faces away from the camera
      const ba = b.basePts[e.ai], bb = b.basePts[e.bi], ra = b.roofPts[e.ai], rb = b.roofPts[e.bi];
      q[0].x = ba.x; q[0].y = ba.y; q[1].x = bb.x; q[1].y = bb.y; q[2].x = rb.x; q[2].y = rb.y; q[3].x = ra.x; q[3].y = ra.y;
      g.fillStyle(rgb(wall, e.shade * b.dim), 1);
      g.fillPoints(q, true);

      if (b.fac) { drawFacade(g, b.fac, b, e, cx, cy, this.H, zoom, e.shade, b.dim); continue; }
      // window bands, only when the wall is wide enough on screen to show them
      const thickness = Math.hypot(ra.x - ba.x, ra.y - ba.y) * zoom;
      if (thickness > 3 && e.len > 3) {
        const n = Math.min(b.floors, 14);
        g.fillStyle(rgb([18, 30, 42], 1), 0.55);
        for (let f = 0; f < n; f++) {
          const t0 = (f + 0.28) / n, t1 = (f + 0.72) / n;
          q[0].x = ba.x + (ra.x - ba.x) * t0; q[0].y = ba.y + (ra.y - ba.y) * t0;
          q[1].x = bb.x + (rb.x - bb.x) * t0; q[1].y = bb.y + (rb.y - bb.y) * t0;
          q[2].x = bb.x + (rb.x - bb.x) * t1; q[2].y = bb.y + (rb.y - bb.y) * t1;
          q[3].x = ba.x + (ra.x - ba.x) * t1; q[3].y = ba.y + (ra.y - ba.y) * t1;
          g.fillPoints(q, true);
        }
      }
    }

    if (overhead) return;
    g.fillStyle(rgb(roof, b.dim), 1);
    g.fillPoints(b.roofPts, true);
    if (b.roof) {
      // the aerial photo of this roof: the footprint's image, moved and scaled as the roof is (away from the centre by sT)
      const r = b.roof, k1 = b.sT;
      b.img ??= this.scene.add.image(0, 0, r.key).setOrigin(0, 0);
      const t = Math.round(255 * Math.min(1, b.dim));
      b.img.setPosition(r.x0 + (r.x0 - cx) * (k1 - 1), r.y0 + (r.y0 - cy) * (k1 - 1)).setDisplaySize(r.w * k1, r.h * k1)
        .setTint(Phaser.Display.Color.GetColor(t, t, t)).setDepth(depth).setVisible(true);
      return;
    }
    g.lineStyle(0.35, rgb(roof, 0.55 * b.dim), 1);
    g.strokePoints(b.roofPts, true, true);
  }
}
