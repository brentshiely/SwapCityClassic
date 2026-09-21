import { computeBarriers } from './barriers.js';
import { CAR } from '../vehicles/carPhysics.js';
import { ALL_LAYERS } from './layers.js';

// Car-versus-world collision. No damage: the car stops or slides along whatever it touches.
//
// The car is approximated by three circles down its length plus four tiny points at its corners
// (so a corner cannot clip a building; inset by their radius so the true corner touches the wall). The world is line segments (building footprints and
// barricades, each with an outward normal) held in a uniform grid, plus the world rectangle.
// Pure maths, no Phaser, so it can be tested in Node.

const CELL = 25; // metres per grid cell
const SOLID_CELL = 64; // metres per cell of the building-polygon index
const BOUNCE = 0.12; // share of the normal speed that bounces back
const SCRAPE = 4; // m/s^2 of friction while sliding along a wall

// A corner point of radius R, centred R/sqrt(2) in from the corner on both axes, passes exactly through the corner.
const CORNER_R = 0.2;
const CORNER_INSET = CORNER_R / Math.SQRT2;
const CIRCLES = [
  { off: -1.3, r: 0.97 },
  { off: 0, r: 0.97 },
  { off: 1.3, r: 0.97 },
  // corners
  ...[-1, 1].flatMap((sx) => [-1, 1].map((sy) => ({ off: (sx * CAR.length) / 2 - sx * CORNER_INSET, side: (sy * CAR.width) / 2 - sy * CORNER_INSET, r: CORNER_R }))),
];

export class CollisionWorld {
  /**
   * @param map { meta, roads, graph, buildings? } - buildings may be empty and added later as tiles load (addBuilding / removeBuilding).
   *        If meta.boundary (the city limit polygon) is there, the player cannot leave it: the limit is a wall with the normals pointing in.
   */
  constructor(map) {
    this.segs = [];
    this.grid = new Map();
    this.solidGrid = new Map(); // building polygons by 64 m cell, for the 'is this point inside a building?' questions
    this.byId = new Map(); // building id -> { segs, solid } so a tile's buildings can be taken out again
    this.safe = null;
    this.rescues = 0; // times the safety net had to step in (should stay 0)
    const { barriers, wall } = computeBarriers(map);
    this.wall = wall;
    for (const b of map.buildings ?? []) this.addBuilding(b);
    if (map.meta.boundary) this.addWall(map.meta.boundary);
    for (const b of barriers) {
      const c = Math.cos(b.angle), s = Math.sin(b.angle), hx = b.thickness / 2, hy = b.length / 2;
      // corners in wound order (matching building winding: positive area)
      const pts = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].map(([x, y]) => [b.x + x * c - y * s, b.y + x * s + y * c]);
      this.addPolygon(pts);
    }
  }

  /** a building (or its polygon) becomes solid; the same id twice is ignored */
  addBuilding(b) {
    if (b.type === 'roof' || this.byId.has(b.id)) return; // roof: canopies, drive under them
    const segs = this.addPolygon(b.points, 'building');
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of b.points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const solid = { pts: b.points, x0, x1, y0, y1 };
    for (let i = Math.floor(x0 / SOLID_CELL); i <= Math.floor(x1 / SOLID_CELL); i++) for (let j = Math.floor(y0 / SOLID_CELL); j <= Math.floor(y1 / SOLID_CELL); j++) {
      const k = i * 100000 + j;
      (this.solidGrid.get(k) ?? this.solidGrid.set(k, []).get(k)).push(solid);
    }
    this.byId.set(b.id, { segs, solid });
  }

  removeBuilding(id) {
    const e = this.byId.get(id);
    if (!e) return;
    this.byId.delete(id);
    const gone = new Set(e.segs);
    for (const seg of e.segs) for (const k of seg.cells) {
      const list = this.grid.get(k);
      if (!list) continue;
      const kept = list.filter((q) => !gone.has(q));
      if (kept.length) this.grid.set(k, kept); else this.grid.delete(k);
    }
    const { solid } = e;
    for (let i = Math.floor(solid.x0 / SOLID_CELL); i <= Math.floor(solid.x1 / SOLID_CELL); i++) for (let j = Math.floor(solid.y0 / SOLID_CELL); j <= Math.floor(solid.y1 / SOLID_CELL); j++) {
      const k = i * 100000 + j, list = this.solidGrid.get(k);
      if (!list) continue;
      const kept = list.filter((q) => q !== solid);
      if (kept.length) this.solidGrid.set(k, kept); else this.solidGrid.delete(k);
    }
  }

  /** the city limit: a closed polygon the car must stay INSIDE (each edge pushes toward the middle) */
  addWall(poly, layer = ALL_LAYERS) {
    let area = 0;
    for (let i = 0; i < poly.length; i++) { const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length]; area += x1 * y2 - x2 * y1; }
    const wind = area >= 0 ? 1 : -1;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
      if (len < 0.05) continue;
      // addPolygon's outward normal is (wind*dy, -wind*dx); a wall wants the opposite (into the polygon)
      this.addSegment(a, b, (-wind * dy) / len, (wind * dx) / len, len, layer);
    }
  }

  /** rivers and lakes: the car is stopped at the shore (cars on a bridge over them are on another layer and pass). Islands (holes) keep the car on them. */
  addWater(water) {
    for (const w of water) {
      this.addPolygon(w.outer);
      for (const h of w.holes) this.addWall(h, 0);
    }
  }

  /** side rails of bridges and tunnels: rails = deckRails(roads); a rail's wall faces the road, on that road's own layer */
  addRails(rails) {
    for (const r of rails) {
      for (let i = 0; i < r.pts.length - 1; i++) {
        const a = r.pts[i], b = r.pts[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
        if (len < 0.05) continue;
        // +1 is the right of travel; its wall faces the road (left of the direction), the other side faces right
        this.addSegment(a, b, (r.side * dy) / len, (-r.side * dx) / len, len, r.layer);
      }
    }
  }

  addSegment(a, b, nx, ny, len, layer = 0, kind = 'solid') {
    const seg = { ax: a[0], ay: a[1], bx: b[0], by: b[1], nx, ny, len, layer, kind, cells: [] };
    this.segs.push(seg);
    const x0 = Math.floor(Math.min(a[0], b[0]) / CELL), x1 = Math.floor(Math.max(a[0], b[0]) / CELL);
    const y0 = Math.floor(Math.min(a[1], b[1]) / CELL), y1 = Math.floor(Math.max(a[1], b[1]) / CELL);
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
      const k = gx * 100000 + gy;
      (this.grid.get(k) ?? this.grid.set(k, []).get(k)).push(seg);
      seg.cells.push(k);
    }
    return seg;
  }

  addPolygon(pts, kind = 'solid') {
    // outward normal of an edge is (dy, -dx) for the winding the bake produces (positive area)
    let area = 0;
    for (let i = 0; i < pts.length; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length]; area += x1 * y2 - x2 * y1; }
    const wind = area >= 0 ? 1 : -1, made = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
      if (len < 0.05) continue;
      made.push(this.addSegment(a, b, (wind * dy) / len, (-wind * dx) / len, len, 0, kind));
    }
    return made;
  }

  near(x, y, r) {
    const out = new Set();
    for (let gx = Math.floor((x - r) / CELL); gx <= Math.floor((x + r) / CELL); gx++) {
      for (let gy = Math.floor((y - r) / CELL); gy <= Math.floor((y + r) / CELL); gy++) {
        const list = this.grid.get(gx * 100000 + gy);
        if (list) for (const s of list) out.add(s);
      }
    }
    return out;
  }

  insideSolid(x, y) {
    for (const b of this.solidGrid.get(Math.floor(x / SOLID_CELL) * 100000 + Math.floor(y / SOLID_CELL)) ?? []) {
      if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue;
      let c = false; const p = b.pts;
      for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
        if ((p[i][1] > y) !== (p[j][1] > y) && x < ((p[j][0] - p[i][0]) * (y - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) c = !c;
      }
      if (c) return true;
    }
    return false;
  }

  /**
   * Push a walking person (a circle of radius r at o.x, o.y) out of walls. Returns true if it touched one. Cars use resolve(); this is the
   * same walls (buildings, shore, city limit, rails on the person's own layer) for something on foot.
   */
  resolveCircle(o, r, layer = 0) {
    let hit = false;
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (const seg of this.near(o.x, o.y, r + 0.5)) {
        if (seg.layer !== ALL_LAYERS && seg.layer !== layer) continue;
        const ex = seg.bx - seg.ax, ey = seg.by - seg.ay;
        const t = Math.max(0, Math.min(1, ((o.x - seg.ax) * ex + (o.y - seg.ay) * ey) / (seg.len * seg.len)));
        const dx = o.x - (seg.ax + ex * t), dy = o.y - (seg.ay + ey * t), dist = Math.hypot(dx, dy);
        if (dist >= r) continue;
        let nx, ny, depth;
        if (t > 0 && t < 1) { nx = seg.nx; ny = seg.ny; depth = r - (dx * nx + dy * ny); }
        else { if (dist < 1e-6) { nx = seg.nx; ny = seg.ny; } else { nx = dx / dist; ny = dy / dist; } depth = r - dist; }
        if (depth <= 0) continue;
        o.x += nx * depth; o.y += ny * depth;
        if (o.vx !== undefined) { const vn = o.vx * nx + o.vy * ny; if (vn < 0) { o.vx -= vn * nx; o.vy -= vn * ny; } }
        hit = moved = true;
      }
      if (!moved) break;
    }
    return hit;
  }

  /** Push the car out of anything it overlaps and take away the speed into it. Returns true on contact. */
  resolve(car, dt = 1 / 240) {
    let hit = false, nxSum = 0, nySum = 0;
    const layer = car.layer | 0;
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      const c = Math.cos(car.heading), s = Math.sin(car.heading);
      for (const k of CIRCLES) {
        const cx = car.x + c * k.off - s * (k.side ?? 0), cy = car.y + s * k.off + c * (k.side ?? 0);
        for (const seg of this.near(cx, cy, k.r + 0.5)) {
          if (seg.layer !== ALL_LAYERS && seg.layer !== layer) continue;
          if (car.ghost && seg.kind === 'building') continue; // driving along a street that runs under this building // a wall on another level (a deck above, the street below) is not there for this car
          const ex = seg.bx - seg.ax, ey = seg.by - seg.ay;
          const t = Math.max(0, Math.min(1, ((cx - seg.ax) * ex + (cy - seg.ay) * ey) / (seg.len * seg.len)));
          const qx = seg.ax + ex * t, qy = seg.ay + ey * t;
          const dx = cx - qx, dy = cy - qy;
          const dist = Math.hypot(dx, dy);
          if (dist >= k.r) continue;
          // on an edge face, always push along the edge's outward normal (also fixes a centre that got inside);
          // near a corner point, push away from that corner
          let nx, ny, depth;
          if (t > 0 && t < 1) {
            nx = seg.nx; ny = seg.ny;
            depth = k.r - (dx * nx + dy * ny);
          } else {
            if (dist < 1e-6) { nx = seg.nx; ny = seg.ny; } else { nx = dx / dist; ny = dy / dist; }
            depth = k.r - dist;
          }
          if (depth <= 0) continue;
          this.push(car, nx, ny, depth);
          nxSum += nx; nySum += ny;
          hit = true; moved = true;
        }
      }
      // world wall: stay inside the rectangle (the city limit polygon, if there is one, is in the segment grid above)
      const w = this.wall;
      const cc = Math.cos(car.heading), ss = Math.sin(car.heading);
      for (const k of CIRCLES) {
        const cx = car.x + cc * k.off - ss * (k.side ?? 0), cy = car.y + ss * k.off + cc * (k.side ?? 0);
        if (cx - k.r < w.minX) { this.push(car, 1, 0, w.minX - (cx - k.r)); nxSum += 1; hit = moved = true; }
        if (cx + k.r > w.maxX) { this.push(car, -1, 0, cx + k.r - w.maxX); nxSum -= 1; hit = moved = true; }
        if (cy - k.r < w.minY) { this.push(car, 0, 1, w.minY - (cy - k.r)); nySum += 1; hit = moved = true; }
        if (cy + k.r > w.maxY) { this.push(car, 0, -1, cy + k.r - w.maxY); nySum -= 1; hit = moved = true; }
      }
      if (!moved) break;
    }

    // scrape: friction along the wall, applied once however many circles are touching
    if (hit) {
      const l = Math.hypot(nxSum, nySum);
      if (l > 1e-6) {
        const tx = -nySum / l, ty = nxSum / l, vt = car.vx * tx + car.vy * ty;
        const dv = Math.min(Math.abs(vt), SCRAPE * dt);
        car.vx -= Math.sign(vt) * dv * tx;
        car.vy -= Math.sign(vt) * dv * ty;
      }
    }

    // safety net: if the car's centre is somehow inside a building, go back to the last safe spot
    if (layer === 0 && !car.ghost && this.insideSolid(car.x, car.y)) {
      this.rescues++;
      if (this.safe) { car.x = this.safe.x; car.y = this.safe.y; car.heading = this.safe.h; }
      car.vx = 0; car.vy = 0;
      hit = true;
    } else {
      this.safe = { x: car.x, y: car.y, h: car.heading };
    }
    return hit;
  }

  push(car, nx, ny, depth) {
    car.x += nx * depth;
    car.y += ny * depth;
    const vn = car.vx * nx + car.vy * ny;
    if (vn < 0) {
      car.vx -= (1 + BOUNCE) * vn * nx;
      car.vy -= (1 + BOUNCE) * vn * ny;
    }
  }
}
