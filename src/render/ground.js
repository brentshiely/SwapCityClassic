import { asphaltTile, paverTile, grassTile } from './textures.js';
import { computeBarriers } from '../world/barriers.js';

// The ground (sidewalks, roads, curbs, markings, crosswalks) is painted ONCE at load into large
// raster chunks with canvas 2D, then drawn as ordinary images. Nothing here runs per frame.
// World units are metres; 1 metre = PPM texture pixels.
export const PPM = 12;
const CHUNK = 1024; // pixels; a power of two so the GPU can mipmap it
const MARGIN = 45; // metres of ground painted beyond the playable world
const CURB = 0.4;
const LANE = 3.3;
const SLAB_METRES = 2.5;

const roadWidth = (r) => r.width;
const isService = (r) => r.highway === 'service';

function makePatterns(ctx) {
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
  };
}

// ---------- polyline helpers (metres) ----------
function pathOf(ctx, pts) {
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

// ---------- the painter ----------
function paintChunk(ctx, map, pat, originX, originY, edge) {
  // Metres in, pixels out; patterns stay anchored to world (0,0) so chunks join seamlessly.
  ctx.setTransform(PPM, 0, 0, PPM, -originX * PPM, -originY * PPM);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const view = { x0: originX, y0: originY, x1: originX + CHUNK / PPM, y1: originY + CHUNK / PPM };

  // sidewalk everywhere
  ctx.fillStyle = pat.paver;
  ctx.fillRect(view.x0 - 1, view.y0 - 1, CHUNK / PPM + 2, CHUNK / PPM + 2);

  // parks and parking lots
  for (const a of map.areas) {
    ctx.fillStyle = a.kind === 'parking' ? pat.lot : pat.grass;
    pathOf(ctx, a.points); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 0.25; ctx.stroke();
  }

  // roads at street level or above, lowest layer first (tunnels are not painted on the surface)
  const roads = map.roads.filter((r) => r.layer >= 0).sort((a, b) => a.layer - b.layer);
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

  paintMarkings(ctx, map);
  paintCrosswalks(ctx, map, pat);
  paintEdge(ctx, map, edge);
}

// The edge of the playable world: dim everything outside, a fence along it, and striped
// concrete barricades across every street that leaves the map.
function paintEdge(ctx, map, { barriers }) {
  const w = map.meta.world;
  ctx.beginPath();
  ctx.rect(w.minX - 500, w.minY - 500, w.maxX - w.minX + 1000, w.maxY - w.minY + 1000);
  ctx.rect(w.minX, w.minY, w.maxX - w.minX, w.maxY - w.minY);
  ctx.fillStyle = 'rgba(8,12,14,0.4)';
  ctx.fill('evenodd');

  // fence: a dark rail with posts every 3 m
  ctx.lineCap = 'butt';
  ctx.strokeStyle = '#2b3236'; ctx.lineWidth = 0.22;
  ctx.strokeRect(w.minX, w.minY, w.maxX - w.minX, w.maxY - w.minY);
  ctx.fillStyle = '#9aa3a8';
  for (let x = w.minX; x <= w.maxX; x += 3) { ctx.fillRect(x - 0.18, w.minY - 0.18, 0.36, 0.36); ctx.fillRect(x - 0.18, w.maxY - 0.18, 0.36, 0.36); }
  for (let y = w.minY; y <= w.maxY; y += 3) { ctx.fillRect(w.minX - 0.18, y - 0.18, 0.36, 0.36); ctx.fillRect(w.maxX - 0.18, y - 0.18, 0.36, 0.36); }
  ctx.lineCap = 'round';

  for (const b of barriers) {
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

function paintMarkings(ctx, map) {
  // Stop short of junctions so lane lines never run through them.
  const half = new Map(); // node id -> widest half width meeting there
  for (const e of map.graph.edges) {
    const hw = Math.max(6.6, e.lanes * LANE) / 2;
    for (const id of [e.from, e.to]) half.set(id, Math.max(half.get(id) ?? 0, hw));
  }
  const nodeById = map.graph.nodes;
  const clearance = (id) => (nodeById[id].degree >= 3 ? half.get(id) + 2.6 : 0);

  const line = (pts, color, width, dash) => {
    if (!pts || pts.length < 2) return;
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'butt';
    ctx.setLineDash(dash ?? []);
    pathOf(ctx, pts); ctx.stroke();
    ctx.setLineDash([]); ctx.lineCap = 'round';
  };

  for (const e of map.graph.edges) {
    if (e.layer < 0) continue;
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

/** Paint the ground into chunk images added to `scene`. Returns timing info for the log. */
export function buildGround(scene, map) {
  const t0 = performance.now();
  const w = map.meta.world;
  const minX = Math.floor((w.minX - MARGIN) * PPM) / PPM, minY = Math.floor((w.minY - MARGIN) * PPM) / PPM;
  const maxX = w.maxX + MARGIN, maxY = w.maxY + MARGIN;
  const cols = Math.ceil(((maxX - minX) * PPM) / CHUNK), rows = Math.ceil(((maxY - minY) * PPM) / CHUNK);

  const edge = computeBarriers(map);
  const probe = document.createElement('canvas').getContext('2d');
  const pat = makePatterns(probe);
  const size = CHUNK / PPM, pad = 1 / PPM; // a hair of overlap hides seams between chunks

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const originX = minX + i * size, originY = minY + j * size;
      const c = document.createElement('canvas');
      c.width = c.height = CHUNK;
      paintChunk(c.getContext('2d'), map, pat, originX, originY, edge);
      const key = `ground_${i}_${j}`;
      scene.textures.addCanvas(key, c);
      scene.add.image(originX - pad, originY - pad, key).setOrigin(0, 0).setDisplaySize(size + pad * 2, size + pad * 2).setDepth(0);
    }
  }
  return { barriers: edge.barriers.length, chunks: cols * rows, ms: Math.round(performance.now() - t0), pixels: cols * rows * CHUNK * CHUNK };
}
