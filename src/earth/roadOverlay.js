import * as THREE from 'three';
import { paintRoadLayer } from '../render/ground.js';
import { asphaltTile, paverTile, grassTile } from '../render/textures.js';

// Our ground drawn OVER Google's picture (paver sidewalks everywhere, parks and parking lots, then the road surface), so the
// cars and vans photographed on Google's streets and kerbs are covered and only our own traffic and people are on it. Google
// still supplies the buildings, trees and poles: anything taller than the overlay's height wins the depth test. This is an overlay on top of Google's imagery (allowed); nothing is read
// back from Google's tiles.
//
// The road surface is the same description the offline look paints (paintRoadLayer in ground.js): a recording "canvas" catches
// its strokes and rectangles and turns them into triangles, drawn in the same three.js scene as Google's tiles. It sits in the
// depth buffer, so a tower's wall that leans over a street still hides the street behind it.
//
// The plane floats OVERLAY_LIFT metres above the ground, higher than a car roof, so cars (which stand above the ground) are
// covered too. To keep it from sliding sideways as a result of perspective, it is scaled toward the camera by (H - lift) / H
// every frame, which puts every point of it exactly where the same point on the ground would appear.

export const OVERLAY_LIFT = 3.5;
// Anything of Google's picture higher than this above the street (mast arms, signal heads, signs, wires, tree canopies, skyways,
// building walls) is drawn a second time ABOVE the cars and people (earthLayer.js), so traffic passes under it.
export const OVERHEAD_FROM = 3.7;
const PPM = 12, SLAB_METRES = 2.5, MARGIN = 45; // the same as ground.js: a texture pixel is 1/12 m; the ground reaches 45 m past the playable map
// metres covered by one repeat of each texture, as in the offline look
const TEXTURE_METRES = { asphalt: 256 / PPM, alley: 256 / PPM, lot: 256 / PPM, paver: (Math.round(SLAB_METRES * PPM) * 2) / PPM, grass: 128 / PPM };

// ---- a canvas 2D lookalike that records geometry instead of pixels ----
class Recorder {
  /** @param clip optional {x0, y0, x1, y1}: anything entirely outside it is not recorded (a tile builds only its own part of a long street) */
  constructor(clip = null) {
    this.clip = clip;
    this.strokeStyle = '#000'; this.fillStyle = '#000'; this.lineWidth = 1; this.lineCap = 'round'; this.lineJoin = 'round';
    this.dash = []; this.path = []; this.m = [1, 0, 0, 1, 0, 0]; this.stack = [];
    this.batches = new Map(); // key -> { rank, pattern | null, pos: [], col: [] }
  }
  save() { this.stack.push({ m: this.m.slice(), s: this.strokeStyle, f: this.fillStyle, w: this.lineWidth, c: this.lineCap, d: this.dash }); }
  restore() { const t = this.stack.pop(); if (t) { this.m = t.m; this.strokeStyle = t.s; this.fillStyle = t.f; this.lineWidth = t.w; this.lineCap = t.c; this.dash = t.d; } }
  translate(x, y) { const m = this.m; m[4] += m[0] * x + m[2] * y; m[5] += m[1] * x + m[3] * y; }
  rotate(a) {
    const c = Math.cos(a), s = Math.sin(a), [a0, b0, c0, d0] = this.m;
    this.m[0] = a0 * c + c0 * s; this.m[1] = b0 * c + d0 * s; this.m[2] = -a0 * s + c0 * c; this.m[3] = -b0 * s + d0 * c;
  }
  apply(x, y) { const m = this.m; return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
  setLineDash(d) { this.dash = d; }
  beginPath() { this.path = []; this.sub = null; }
  moveTo(x, y) { this.sub = [this.apply(x, y)]; this.path.push(this.sub); }
  lineTo(x, y) { if (!this.sub) this.moveTo(x, y); else this.sub.push(this.apply(x, y)); }
  closePath() {}

  // where a style goes: which draw pass (rank) and which material
  style(v, isStroke) {
    if (typeof v === 'string' && !v.startsWith('#') && !v.startsWith('rgb')) return { rank: isStroke ? 2 : 4, pattern: v }; // 'asphalt' / 'alley'
    const [r, g, b, a] = parseColour(v);
    return { rank: isStroke ? 3 : 5, color: [r, g, b], alpha: a };
  }
  batch(st) {
    const key = st.pattern ? `p${st.rank}${st.pattern}` : `c${st.rank}`;
    let b = this.batches.get(key);
    if (!b) this.batches.set(key, (b = { rank: st.rank, pattern: st.pattern ?? null, pos: [], col: [] }));
    return b;
  }
  tri(b, st, p, q, r) {
    for (const v of [p, q, r]) {
      b.pos.push(v[0], v[1]);
      if (!st.pattern) b.col.push(...over(st.color, st.alpha));
    }
  }
  outside(x0, y0, x1, y1) { const k = this.clip; return !!k && (x1 < k.x0 || x0 > k.x1 || y1 < k.y0 || y0 > k.y1); }
  disc(b, st, c, radius) {
    if (this.outside(c[0] - radius, c[1] - radius, c[0] + radius, c[1] + radius)) return;
    const n = radius > 1 ? 20 : 10;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      this.tri(b, st, c, [c[0] + Math.cos(a0) * radius, c[1] + Math.sin(a0) * radius], [c[0] + Math.cos(a1) * radius, c[1] + Math.sin(a1) * radius]);
    }
  }
  quad(b, st, a, c, half) {
    const dx = c[0] - a[0], dy = c[1] - a[1], l = Math.hypot(dx, dy);
    if (l < 1e-6 || this.outside(Math.min(a[0], c[0]) - half, Math.min(a[1], c[1]) - half, Math.max(a[0], c[0]) + half, Math.max(a[1], c[1]) + half)) return;
    const nx = (-dy / l) * half, ny = (dx / l) * half;
    const p0 = [a[0] + nx, a[1] + ny], p1 = [a[0] - nx, a[1] - ny], p2 = [c[0] - nx, c[1] - ny], p3 = [c[0] + nx, c[1] + ny];
    this.tri(b, st, p0, p1, p2); this.tri(b, st, p0, p2, p3);
  }

  stroke() {
    const scale = Math.hypot(this.m[0], this.m[1]);
    const half = (this.lineWidth * scale) / 2;
    const st = this.style(this.strokeStyle, true);
    if (st.alpha !== undefined && st.alpha < 0.4) return; // the soft shadow beside a kerb: only the offline look needs it
    // the dark kerb-and-curb strokes are wider than the asphalt; a light solid colour before the asphalt is the kerb (rank 1)
    if (st.color && this.lineWidth > 3 && !this.dash.length) st.rank = 1;
    const b = this.batch(st);
    const dash = this.dash.map((d) => d * scale);
    for (const sub of this.path) {
      if (sub.length < 2) continue;
      const pieces = dash.length ? dashed(sub, dash) : [sub];
      const round = this.lineCap === 'round' && half > 0.5;
      for (const pts of pieces) {
        for (let i = 0; i < pts.length - 1; i++) this.quad(b, st, pts[i], pts[i + 1], half);
        if (half > 0.5) for (let i = 1; i < pts.length - 1; i++) this.disc(b, st, pts[i], half); // round joins
        if (round) { this.disc(b, st, pts[0], half); this.disc(b, st, pts[pts.length - 1], half); }
      }
    }
  }

  /** triangles straight into a pass (the ground under the roads): tris = [[x, y], [x, y], [x, y], ...] */
  raw(rank, pattern, points) {
    const b = this.batch({ rank, pattern });
    for (const p of points) b.pos.push(p[0], p[1]);
  }

  fillRect(x, y, w, h) {
    const st = this.style(this.fillStyle, false), b = this.batch(st);
    const p = [this.apply(x, y), this.apply(x + w, y), this.apply(x + w, y + h), this.apply(x, y + h)];
    this.tri(b, st, p[0], p[1], p[2]); this.tri(b, st, p[0], p[2], p[3]);
  }
}

const BASE = [72, 94, 96]; // a line with some see-through is shown as if painted on asphalt
const over = ([r, g, b], a = 1) => [(r * a + BASE[0] * (1 - a)) / 255, (g * a + BASE[1] * (1 - a)) / 255, (b * a + BASE[2] * (1 - a)) / 255];

function parseColour(v) {
  if (v[0] === '#') { const n = parseInt(v.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]; }
  const m = v.match(/[\d.]+/g).map(Number);
  return [m[0], m[1], m[2], m[3] ?? 1];
}

/** split a polyline into the "on" pieces of a dash pattern (metres): pattern = [on, off, on, off, ...] */
function dashed(pts, pattern) {
  const out = [];
  let k = 0, left = pattern[0], cur = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let pos = 0;
    while (L - pos > left) {
      pos += left;
      const p = [a[0] + ((b[0] - a[0]) * pos) / L, a[1] + ((b[1] - a[1]) * pos) / L];
      if (k % 2 === 0) { cur.push(p); out.push(cur); cur = null; } else cur = [p];
      k++; left = pattern[k % pattern.length] || 1e-6;
    }
    left -= L - pos;
    if (k % 2 === 0 && cur) cur.push(b);
  }
  if (k % 2 === 0 && cur && cur.length > 1) out.push(cur);
  return out;
}

const makeTextures = () => {
  const tex = (seed, base) => {
    const t = new THREE.CanvasTexture(base ? asphaltTile(seed, base) : asphaltTile(seed));
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  };
  const canvasTex = (c) => { const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; };
  return { asphalt: tex(11), alley: tex(37, [64, 76, 78]), lot: tex(23, [58, 66, 70]), paver: canvasTex(paverTile(Math.round(SLAB_METRES * PPM))), grass: canvasTex(grassTile()) };
};

/** the meshes for the ground in one box: `view` is what World.view(box) returns */
function buildBoxGroup(view, box, textures) {
  const rec = new Recorder({ x0: box.x0 - 4, y0: box.y0 - 4, x1: box.x1 + 4, y1: box.y1 + 4 });
  // the ground under the roads: paver sidewalk everywhere in the box (a hair over, so neighbouring boxes never leave a seam), then parks and parking lots
  const e = 0.15, x0 = box.x0 - e, y0 = box.y0 - e, x1 = box.x1 + e, y1 = box.y1 + e;
  rec.raw(0, 'paver', [[x0, y0], [x1, y0], [x1, y1], [x0, y0], [x1, y1], [x0, y1]]);
  for (const a of view.areas) {
    const contour = a.points.map(([x, y]) => new THREE.Vector2(x, y));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    rec.raw(0.5, a.kind === 'parking' ? 'lot' : 'grass', tris.flat().map((i) => a.points[i]));
  }
  paintRoadLayer(rec, view, { asphalt: 'asphalt', alley: 'alley' });

  const group = new THREE.Group();
  for (const b of [...rec.batches.values()].sort((p, q) => p.rank - q.rank)) {
    const n = b.pos.length / 2, position = new Float32Array(n * 3), uv = b.pattern ? new Float32Array(n * 2) : null;
    for (let i = 0; i < n; i++) {
      position[i * 3] = b.pos[i * 2]; position[i * 3 + 1] = 0; position[i * 3 + 2] = b.pos[i * 2 + 1]; // game (x, y) -> scene (x, 0, z)
      if (uv) { const m = TEXTURE_METRES[b.pattern]; uv[i * 2] = b.pos[i * 2] / m; uv[i * 2 + 1] = b.pos[i * 2 + 1] / m; }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    if (uv) g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    else g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(b.col.map((c) => Math.pow(c, 2.2))), 3)); // vertex colours are sRGB-looking numbers; three wants linear
    const mat = new THREE.MeshBasicMaterial({
      side: THREE.DoubleSide, map: b.pattern ? textures[b.pattern] : null, vertexColors: !b.pattern,
      polygonOffset: true, polygonOffsetFactor: -b.rank, polygonOffsetUnits: -b.rank * 4, // later passes win over earlier ones on the same plane
    });
    if (!b.pattern) mat.color.set(0xffffff);
    const mesh = new THREE.Mesh(g, mat);
    mesh.renderOrder = b.rank; mesh.frustumCulled = false;
    group.add(mesh);
  }
  group.userData.triangles = [...rec.batches.values()].reduce((s, b) => s + b.pos.length / 6, 0);
  return group;
}

/**
 * The overlay for the whole city: one group of meshes per loaded 256 m tile, added as tiles arrive and removed as they go (sync).
 * All the groups move together (update), so the ground lands where the ground point would appear.
 */
export class RoadOverlay {
  constructor(world) {
    this.world = world;
    this.textures = makeTextures();
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    this.tiles = new Map(); // tile key -> THREE.Group
    this.lift = OVERLAY_LIFT;
    this.triangles = 0;
  }

  setLift(v) { this.lift = v; }

  /** build the tiles that have arrived (a few per call), drop the ones that left */
  sync(budget = 3) {
    const w = this.world;
    for (const [k, g] of this.tiles) {
      if (w.tiles.has(k)) continue;
      this.group.remove(g);
      g.traverse((o) => { if (o.geometry) { o.geometry.dispose(); o.material.dispose(); } });
      this.tiles.delete(k);
    }
    let n = 0;
    for (const [k, tile] of w.tiles) {
      if (this.tiles.has(k)) continue;
      if (n++ >= budget) break;
      const T = w.T, box = { x0: tile.tx * T, y0: tile.ty * T, x1: (tile.tx + 1) * T, y1: (tile.ty + 1) * T };
      const g = buildBoxGroup(w.view(box.x0 - 8, box.y0 - 8, box.x1 + 8, box.y1 + 8), box, this.textures);
      this.tiles.set(k, g);
      this.group.add(g);
    }
    this.triangles = [...this.tiles.values()].reduce((s, g) => s + g.userData.triangles, 0);
  }

  /** put the plane `lift` above the ground, scaled toward the camera so it lands where the ground point would */
  update(camX, camZ, H) {
    const s = Math.max(0.5, (H - this.lift) / H);
    this.group.matrix.set(s, 0, 0, camX * (1 - s), 0, 1, 0, this.lift, 0, 0, s, camZ * (1 - s), 0, 0, 0, 1);
    this.group.matrixWorldNeedsUpdate = true;
  }
}
