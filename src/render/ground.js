import { asphaltTile, paverTile, grassTile, waterTile } from './textures.js';
import { computeBarriers } from '../world/barriers.js';
import { polyInfo, pointAt, junctionInfo } from '../world/geometry.js';
import { Grid, bboxOfPoints } from '../world/grid2d.js';

// The ground (sidewalks, roads, curbs, markings, crosswalks) is painted ONCE at load into large
// raster chunks with canvas 2D, then drawn as ordinary images. Nothing here runs per frame.
// World units are metres; 1 metre = PPM texture pixels.
export const PPM = 12;
export const CHUNK = 1024; // pixels; a power of two so the GPU can mipmap it
const MARGIN = 45; // metres of ground painted beyond the playable world
const CURB = 0.4;
const LANE = 3.3;
const SLAB_METRES = 2.5;

const roadWidth = (r) => r.width;
const isService = (r) => r.highway === 'service';

export function makePatterns(ctx) {
  // One texel = one device pixel at PPM, so scale the pattern down by PPM in user space.
  const make = (source) => {
    const p = ctx.createPattern(source, 'repeat');
    p.setTransform(new DOMMatrix().scale(1 / PPM));
    return p;
  };
  return {
    paver: make(paverTile(Math.round(SLAB_METRES * PPM))),
    asphalt: make(asphaltTile(11)),
    lot: make(asphaltTile(23, [58, 66, 70])),
    alley: make(asphaltTile(37, [64, 76, 78])),
    grass: make(grassTile()),
    water: make(waterTile()),
  };
}

// ---------- polyline helpers (metres) ----------
export function pathOf(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
}

function trim(pts, startTrim, endTrim) {
  let out = pts.map((p) => p.slice());
  const cut = (arr, d) => {
    while (d > 0 && arr.length >= 2) {
      const a = arr[0], b = arr[1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len > d) { const t = d / len; arr[0] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; return arr; }
      d -= len; arr.shift();
    }
    return arr;
  };
  out = cut(out, startTrim);
  out = cut(out.reverse(), endTrim).reverse();
  return out.length >= 2 ? out : null;
}

function offset(pts, dist) {
  if (dist === 0) return pts;
  const n = pts.length, res = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    dx /= l; dy /= l;
    res.push([pts[i][0] - dy * dist, pts[i][1] + dx * dist]);
  }
  return res;
}

// How far to pull an alley's end back so it stops at the edge of the street it meets.
function endTrim(streets, p) {
  let best = null, bd = 1.5;
  for (const r of streets) {
    for (let i = 0; i < r.points.length - 1; i++) {
      const a = r.points[i], b = r.points[i + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
      const d = Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
      if (d < bd) { bd = d; best = r; }
    }
  }
  return best ? roadWidth(best) / 2 - 0.05 : 0;
}

/**
 * The road surface: curbs, asphalt, alleys, lane lines, crosswalks and stop lines. `ctx` can be a real canvas or the geometry
 * recorder of the Google Earth road overlay (src/earth/roadOverlay.js), so both looks share one description of the streets.
 * `pat.asphalt` / `pat.alley` are fill styles (canvas patterns, or plain names for the recorder).
 */
export function paintRoadLayer(ctx, map, pat, layer = 0) {
  // the roads of one layer: the ground (0), or the deck of a bridge (1, 2, 3) painted by BridgeStreamer
  const roads = map.roads.filter((r) => r.layer === layer);
  const streets = roads.filter((r) => !isService(r));
  ctx.strokeStyle = 'rgba(30,34,30,0.28)';
  for (const r of streets) { ctx.lineWidth = roadWidth(r) + (CURB + 0.35) * 2; pathOf(ctx, r.points); ctx.stroke(); }
  ctx.strokeStyle = '#cfd2c8';
  for (const r of streets) { ctx.lineWidth = roadWidth(r) + CURB * 2; pathOf(ctx, r.points); ctx.stroke(); }
  ctx.strokeStyle = pat.asphalt;
  for (const r of streets) { ctx.lineWidth = roadWidth(r); pathOf(ctx, r.points); ctx.stroke(); }
  // Alleys stop at the street's curb (butt caps) and cut through it, instead of poking into the road.
  ctx.strokeStyle = pat.alley;
  ctx.lineCap = 'butt';
  for (const r of roads.filter(isService)) {
    const pts = trim(r.points, endTrim(streets, r.points[0]), endTrim(streets, r.points[r.points.length - 1]));
    if (!pts) continue;
    ctx.lineWidth = roadWidth(r); pathOf(ctx, pts); ctx.stroke();
  }
  ctx.lineCap = 'round';

  paintMarkings(ctx, map, layer);
  if (layer === 0) paintCrosswalks(ctx, map, pat);
  paintStopLines(ctx, map, layer);
}

// ---------- the painter ----------
function paintChunk(ctx, view, pat, originX, originY, limit) {
  // Metres in, pixels out; patterns stay anchored to world (0,0) so chunks join seamlessly.
  ctx.setTransform(PPM, 0, 0, PPM, -originX * PPM, -originY * PPM);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const box = { x0: originX, y0: originY, x1: originX + CHUNK / PPM, y1: originY + CHUNK / PPM };

  // sidewalk everywhere
  ctx.fillStyle = pat.paver;
  ctx.fillRect(box.x0 - 1, box.y0 - 1, CHUNK / PPM + 2, CHUNK / PPM + 2);

  // parks and parking lots
  for (const a of view.areas) {
    ctx.fillStyle = a.kind === 'parking' ? pat.lot : pat.grass;
    pathOf(ctx, a.points); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 0.25; ctx.stroke();
  }

  paintWater(ctx, view.water, pat);
  paintTunnels(ctx, view);
  paintRoadLayer(ctx, view, pat);
  paintPortals(ctx, view.portals);
  paintLimit(ctx, limit, box);
}

// Rivers and lakes: water with a pale bank line; the car is stopped at the shore (collision.addWater) and bridges cross above.
function paintWater(ctx, water, pat) {
  if (!water?.length) return;
  for (const w of water) {
    ctx.beginPath();
    for (const ring of [w.outer, ...w.holes]) { ctx.moveTo(ring[0][0], ring[0][1]); for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i][0], ring[i][1]); ctx.closePath(); }
    ctx.fillStyle = pat.water; ctx.fill('evenodd');
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(20,52,68,0.55)'; ctx.lineWidth = 1.6; ctx.stroke(); // the shore, dark on the water side
    ctx.strokeStyle = 'rgba(214,220,200,0.75)'; ctx.lineWidth = 0.35; ctx.stroke(); // and a pale bank line
  }
}

// A tunnel seen as a cutaway: the road underground drawn dim on a dark strip, so you can still see where the car is going.
export function paintTunnels(ctx, view) {
  const tunnels = view.roads.filter((r) => r.layer < 0);
  if (!tunnels.length) return;
  ctx.lineCap = 'butt'; ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(10,13,15,0.9)';
  for (const r of tunnels) { ctx.lineWidth = r.width + 4.4; pathOf(ctx, r.points); ctx.stroke(); }
  ctx.strokeStyle = 'rgba(46,54,58,0.95)';
  for (const r of tunnels) { ctx.lineWidth = r.width; pathOf(ctx, r.points); ctx.stroke(); }
  ctx.setLineDash([2.4, 4.2]); ctx.strokeStyle = 'rgba(220,210,140,0.35)'; ctx.lineWidth = 0.16;
  for (const r of tunnels) { pathOf(ctx, r.points); ctx.stroke(); }
  ctx.setLineDash([]); ctx.lineCap = 'round';
}

// The concrete mouth of a tunnel: a slab across the road end with the dark opening in it.
export function paintPortals(ctx, portals) {
  for (const p of portals ?? []) {
    ctx.save();
    ctx.translate(p.x, p.y); ctx.rotate(p.angle); // local +x points out of the tunnel
    const W = p.width + 5, T = 3.4;
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(-T + 0.4, -W / 2 + 0.5, T, W); // shadow
    ctx.fillStyle = '#a3a69c'; ctx.fillRect(-T, -W / 2, T, W); // the slab
    ctx.fillStyle = '#12161a'; ctx.fillRect(-T + 0.5, -p.width / 2, T - 0.5, p.width); // the opening
    ctx.fillStyle = '#6f736b'; ctx.fillRect(-T, -W / 2, 0.5, W); // the lip
    ctx.strokeStyle = 'rgba(30,34,30,0.75)'; ctx.lineWidth = 0.14; ctx.strokeRect(-T, -W / 2, T, W);
    ctx.restore();
  }
}

// The edge of the playable world is the city limit: everything outside it is dimmed, a fence runs along it, and a row of striped
// concrete barricades closes every street that leaves the city.
function paintLimit(ctx, { boundary, grid, barriers }, box) {
  if (boundary) {
    const near = grid.query(box.x0 - 4, box.y0 - 4, box.x1 + 4, box.y1 + 4);
    const outsideCorner = [[box.x0, box.y0], [box.x1, box.y0], [box.x1, box.y1], [box.x0, box.y1]].some(([x, y]) => !boundary.contains(x, y));
    if (near.size || outsideCorner) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(box.x0 - 2, box.y0 - 2, box.x1 - box.x0 + 4, box.y1 - box.y0 + 4);
      const p = boundary.points;
      ctx.moveTo(p[0][0], p[0][1]);
      for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
      ctx.closePath();
      ctx.fillStyle = 'rgba(8,12,14,0.4)';
      ctx.fill('evenodd');
      ctx.restore();
    }
    // the fence: a dark rail with posts every 3 m
    if (near.size) {
      ctx.lineCap = 'butt';
      ctx.strokeStyle = '#2b3236'; ctx.lineWidth = 0.22;
      ctx.beginPath();
      for (const [a, b] of near) { ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
      ctx.stroke();
      ctx.fillStyle = '#9aa3a8';
      for (const [a, b] of near) {
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.floor(len / 3));
        for (let k = 0; k <= n; k++) {
          const x = a[0] + ((b[0] - a[0]) * k) / n, y = a[1] + ((b[1] - a[1]) * k) / n;
          if (x > box.x0 - 1 && x < box.x1 + 1 && y > box.y0 - 1 && y < box.y1 + 1) ctx.fillRect(x - 0.18, y - 0.18, 0.36, 0.36);
        }
      }
      ctx.lineCap = 'round';
    }
  }
  for (const b of barriers) {
    if (b.x < box.x0 - 8 || b.x > box.x1 + 8 || b.y < box.y0 - 8 || b.y > box.y1 + 8) continue;
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.angle); // local x = out of the map, local y = across the street
    const T = b.thickness, BL = 2.4, n = Math.ceil(b.length / BL), y0 = -(n * BL) / 2;
    for (let i = 0; i < n; i++) {
      const y = y0 + i * BL + 0.06, h = BL - 0.12;
      ctx.fillStyle = 'rgba(0,0,0,0.32)';
      ctx.fillRect(-T / 2 + 0.3, y + 0.3, T, h);
      ctx.save();
      ctx.beginPath(); ctx.rect(-T / 2, y, T, h); ctx.clip();
      ctx.fillStyle = '#dcded4'; ctx.fillRect(-T / 2, y, T, h);
      ctx.fillStyle = '#e0552f';
      for (let s = -2; s < 8; s++) {
        const yy = y + s * 0.62;
        ctx.beginPath();
        ctx.moveTo(-T / 2, yy); ctx.lineTo(-T / 2, yy + 0.31); ctx.lineTo(T / 2, yy + 0.31 + T); ctx.lineTo(T / 2, yy + T);
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();
      ctx.strokeStyle = 'rgba(30,34,30,0.7)'; ctx.lineWidth = 0.09;
      ctx.strokeRect(-T / 2, y, T, h);
    }
    ctx.restore();
  }
}

// A white stop line across the lanes of every approach to a signalized junction; the traffic stops here for a red light.
// junction widths for the whole graph, computed once (a chunk sees only some of the edges but must use the widest at each junction)
const graphInfo = (map) => (map.graph._ji ??= junctionInfo(map));

function paintStopLines(ctx, map, layer = 0) {
  const ji = graphInfo(map);
  ctx.fillStyle = 'rgba(240,240,232,0.92)';
  for (const e of map.graph.edges) {
    if (e.layer !== layer) continue;
    for (const end of ['to', 'from']) {
      const node = map.graph.nodes[end === 'to' ? e.to : e.from];
      if (!node.signal || node.degree < 3) continue;
      if (end === 'from' && e.oneway) continue; // nobody drives into the 'from' end of a one-way street
      const pts = end === 'to' ? e.points : e.points.slice().reverse();
      const info = polyInfo(pts), p = pointAt(info, info.len - ji.get(node.id).stopDist);
      const width = Math.max(6.6, e.lanes * 3.3);
      const len = e.oneway ? width - 0.6 : width / 2 - 0.4, centre = e.oneway ? 0 : width / 4; // two-way: only the lanes going toward the junction
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(Math.atan2(p.ty, p.tx));
      ctx.fillRect(-0.25, centre - len / 2, 0.5, len);
      ctx.restore();
    }
  }
}

function paintMarkings(ctx, map, layer = 0) {
  // Stop short of junctions so lane lines never run through them.
  const ji = graphInfo(map); // node id -> widest half width meeting there
  const nodeById = map.graph.nodes;
  const clearance = (id) => (nodeById[id].degree >= 3 ? ji.get(id).maxHalf + 2.6 : 0);

  const line = (pts, color, width, dash) => {
    if (!pts || pts.length < 2) return;
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'butt';
    ctx.setLineDash(dash ?? []);
    pathOf(ctx, pts); ctx.stroke();
    ctx.setLineDash([]); ctx.lineCap = 'round';
  };

  for (const e of map.graph.edges) {
    if (e.layer !== layer) continue;
    const pts = trim(e.points, clearance(e.from), clearance(e.to));
    if (!pts) continue;
    const L = e.lanes;
    if (e.oneway) {
      for (let i = 1; i < L; i++) line(offset(pts, (i - L / 2) * LANE), 'rgba(235,235,225,0.9)', 0.16, [2.4, 4.2]);
    } else {
      if (L >= 4) {
        line(offset(pts, -0.22), '#e8b923', 0.14);
        line(offset(pts, 0.22), '#e8b923', 0.14);
      } else {
        line(pts, '#e8b923', 0.2, [3, 3.2]);
      }
      for (let k = 1; k * 2 < L - 1; k++) {
        line(offset(pts, k * LANE), 'rgba(235,235,225,0.9)', 0.16, [2.4, 4.2]);
        line(offset(pts, -k * LANE), 'rgba(235,235,225,0.9)', 0.16, [2.4, 4.2]);
      }
    }
  }
}

function paintCrosswalks(ctx, map, pat) {
  for (const c of map.crossings) {
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate((c.angle * Math.PI) / 180);
    // clean asphalt under the stripes so no lane line runs through the crosswalk
    ctx.fillStyle = pat.asphalt;
    ctx.fillRect(-2.4, -c.width / 2, 4.8, c.width);
    ctx.fillStyle = 'rgba(240,240,232,0.92)';
    // bars run along the road and are spaced across it
    for (let k = -c.width / 2 + 0.9; k <= c.width / 2 - 0.5; k += 1.3) ctx.fillRect(-1.5, k - 0.3, 3, 0.6);
    ctx.restore();
  }
}

/**
 * The ground, painted on demand: 1024 px chunks (85 m at 12 px per metre) are painted the first time the camera comes near them and
 * dropped when it leaves, so the city can be any size. Each chunk sees only the roads, junction edges, crossings and parks that touch it.
 */
export class GroundStreamer {
  /** @param world a World (roads, graph, tiles); @param barriers the barricades from computeBarriers(world) */
  constructor(scene, world, barriers) {
    this.scene = scene; this.world = world;
    this.size = CHUNK / PPM;
    this.chunks = new Map(); // "i_j" -> { image, key, i, j }
    this.images = []; // for the look controller (hidden while Google shows)
    this.visible = true;
    this.painted = 0; this.ms = 0;
    this.pat = makePatterns(document.createElement('canvas').getContext('2d'));
    // the city limit, as segments by position, plus a point-in-city test
    const b = world.meta.boundary, segGrid = new Grid(128);
    for (let i = 0; i < b.length; i++) { const a = b[i], c = b[(i + 1) % b.length]; segGrid.insert([a, c], Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[0], c[0]), Math.max(a[1], c[1])); }
    this.limit = { boundary: { points: b, contains: (x, y) => world.insideCity(x, y) }, grid: segGrid, barriers };
    // paint queue state
    this.wantedKeys = new Set();
  }

  /**
   * @param x, y the middle of the screen (game metres); hw, hh half the screen size in metres. Paints at most `budget` chunks per call.
   */
  update(x, y, hw, hh, budget = 2) {
    const s = this.size, m = s * 0.6; // paint a little beyond the screen so the edge never shows
    const i0 = Math.floor((x - hw - m) / s), i1 = Math.floor((x + hw + m) / s), j0 = Math.floor((y - hh - m) / s), j1 = Math.floor((y + hh + m) / s);
    const need = [];
    this.wantedKeys.clear();
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = `${i}_${j}`; this.wantedKeys.add(k);
      if (!this.chunks.has(k)) need.push([Math.hypot((i + 0.5) * s - x, (j + 0.5) * s - y), i, j]);
    }
    need.sort((a, b) => a[0] - b[0]);
    let n = 0;
    for (const [, i, j] of need) {
      if (n >= budget) break;
      if (!this.world.isLoadedAround((i + 0.5) * s, (j + 0.5) * s, s)) continue; // its parks and lots are in tiles that have not arrived yet
      this.paint(i, j); n++;
    }
    // let go of chunks well away from the screen (each one is 4 MB of graphics memory)
    for (const [k, c] of this.chunks) {
      if (this.wantedKeys.has(k)) continue;
      if (c.i >= i0 - 1 && c.i <= i1 + 1 && c.j >= j0 - 1 && c.j <= j1 + 1) continue;
      this.scene.textures.remove(c.key); c.image.destroy(); this.chunks.delete(k);
    }
    this.images = [...this.chunks.values()].map((c) => c.image);
  }

  paint(i, j) {
    const t0 = performance.now(), s = this.size, pad = 1 / PPM;
    const originX = i * s, originY = j * s;
    const x0 = originX - 6, y0 = originY - 6, x1 = originX + s + 6, y1 = originY + s + 6;
    const view = this.world.view(x0, y0, x1, y1);
    view.water = this.world.waterIn(x0, y0, x1, y1); view.portals = this.world.portalsIn(x0, y0, x1, y1);
    const c = document.createElement('canvas');
    c.width = c.height = CHUNK;
    paintChunk(c.getContext('2d'), view, this.pat, originX, originY, this.limit);
    const key = `ground_${i}_${j}`;
    if (this.scene.textures.exists(key)) this.scene.textures.remove(key);
    this.scene.textures.addCanvas(key, c);
    const image = this.scene.add.image(originX - pad, originY - pad, key).setOrigin(0, 0).setDisplaySize(s + pad * 2, s + pad * 2).setDepth(0).setVisible(this.visible);
    this.chunks.set(`${i}_${j}`, { image, key, i, j });
    this.painted++; this.ms += performance.now() - t0;
  }

  /** the look controller hides the ground while Google's picture shows */
  setVisible(v) { this.visible = v; for (const c of this.chunks.values()) c.image.setVisible(v); return this; }
}
