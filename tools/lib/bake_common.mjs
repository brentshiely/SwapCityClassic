// Shared by tools/bake_map.mjs (downtown box) and tools/bake_city.mjs (whole city): the projection into the game frame and the
// rules that turn OpenStreetMap ways/nodes into game roads, graph, crossings, walkways, buildings, skyways and areas.
// Nothing here reads or writes files. Keep this file's behaviour identical for the downtown bake (data/map.json must not change).

export const r1 = (v) => Math.round(v * 10) / 10;
export const rpt = ([x, y]) => [r1(x), r1(y)];
export const key = (p) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;

// ---------- projection ----------
// Game frame: metres, x right, y DOWN, origin at the centre of the 3x3-block box, rotated so the street grid runs straight.
export function makeFrame(cfg) {
  const { lat: lat0, lon: lon0 } = cfg.origin;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110540;
  const th = (cfg.rotationDegrees * Math.PI) / 180;
  const cos = Math.cos(th), sin = Math.sin(th);
  const B = cfg.box;
  const cx = (B.xMin + B.xMax) / 2, cy = (B.yMin + B.yMax) / 2;
  const toGame = (p) => {
    const x = (p.lon - lon0) * kx, y = (p.lat - lat0) * ky;
    return [x * cos - y * sin - cx, -(x * sin + y * cos - cy)];
  };
  return { toGame, cx, cy, B };
}

// ---------- tag helpers ----------
export const layerOf = (t) => {
  if (t.layer !== undefined && !Number.isNaN(Number(t.layer))) return Number(t.layer);
  if (t.tunnel && t.tunnel !== 'no') return -1;
  if (t.bridge && t.bridge !== 'no') return 1;
  return 0;
};
// Skyways and building interiors are not street level: keep them out of the map entirely.
export const isIndoorOrSkyway = (t) => t.indoor === 'yes' || t.indoor === 'room' || t.indoor === 'corridor' || t.bridge === 'covered' || t.tunnel === 'building_passage' || t.highway === 'corridor' || t.highway === 'elevator';
export const mph = (v) => { const m = /(\d+)/.exec(v ?? ''); return m ? Number(m[1]) : null; };

// ---------- roads (drawn) and traffic graph ----------
const DRIVABLE = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'service']);
const SKIP_SERVICE = new Set(['parking_aisle', 'driveway', 'emergency_access', 'drive-through']);
const DEFAULT_LANES = { motorway: 3, trunk: 3, primary: 3, secondary: 2, tertiary: 2, unclassified: 2, residential: 2, living_street: 1, service: 1 };

// Is this way a drivable road we draw? Returns its parameters, or null.
export function classifyRoad(t) {
  if (!t.highway || !DRIVABLE.has(t.highway.replace(/_link$/, ''))) return null;
  if (isIndoorOrSkyway(t)) return null;
  if (t.highway === 'service' && SKIP_SERVICE.has(t.service)) return null;
  const base = t.highway.replace(/_link$/, '');
  const lanes = Number(t.lanes) || DEFAULT_LANES[base] || 2;
  const width = t.highway === 'service' ? 3.5 : Math.max(6.6, lanes * 3.3);
  const oneway = t.oneway === 'yes' || t.oneway === '1' || t.junction === 'roundabout' || t.junction === 'circular' ? 1 : t.oneway === '-1' ? -1 : 0;
  return { lanes, width, oneway, layer: layerOf(t) };
}
export const roadRecord = (id, t, c, pts) => ({
  id, name: t.name ?? '', highway: t.highway, width: r1(c.width), lanes: c.lanes,
  oneway: c.oneway !== 0, layer: c.layer, tunnel: !!t.tunnel && t.tunnel !== 'no', bridge: !!t.bridge && t.bridge !== 'no',
  points: pts.map(rpt),
});

// Clip a segment to a rectangle: returns [t0, t1] or null.
export function clipSegmentRect(a, b, R) {
  let t0 = 0, t1 = 1;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  for (const [p, q] of [[-dx, a[0] - R.minX], [dx, R.maxX - a[0]], [-dy, a[1] - R.minY], [dy, R.maxY - a[1]]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [t0, t1];
}
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const bkey = (p) => `b:${p[0].toFixed(1)},${p[1].toFixed(1)}`;

// Split a polyline at the edge of the playable region. `clip(a, b)` returns the list of [t0, t1] parameter ranges of the segment
// that lie inside. Each piece carries the vertex keys (the shared-vertex identity, or `b:x,y` for a point cut at the region edge).
export function clipPolyline(pts, keys, clip) {
  const pieces = [];
  let cur = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const ranges = clip(a, b);
    if (!ranges.length) { cur = null; continue; }
    for (const [t0, t1] of ranges) {
      const pa = t0 > 0 ? lerp(a, b, t0) : a, pb = t1 < 1 ? lerp(a, b, t1) : b;
      if (!cur || t0 > 0) {
        cur = { pts: [pa], keys: [t0 > 0 ? bkey(pa) : keys[i]], boundaryStart: t0 > 0 };
        pieces.push(cur);
      }
      cur.pts.push(pb);
      cur.keys.push(t1 < 1 ? bkey(pb) : keys[i + 1]);
      if (t1 < 1) { cur.boundaryEnd = true; cur = null; }
    }
  }
  return pieces;
}

// graphWays: [{ id, t, pts, keys, oneway, lanes, layer }]; clip as for clipPolyline. Returns { graphNodes, edges }.
export function buildGraph(graphWays, clip) {
  const pieces = [];
  for (const gw of graphWays) for (const pc of clipPolyline(gw.pts, gw.keys, clip)) { pc.gw = gw; pieces.push(pc); }

  const usage = new Map();
  for (const pc of pieces) for (const k of pc.keys) usage.set(k, (usage.get(k) ?? 0) + 1);

  const nodeIndex = new Map(); // key -> node
  const graphNodes = [];
  const nodeFor = (k, p) => {
    let n = nodeIndex.get(k);
    if (!n) { n = { id: graphNodes.length, x: r1(p[0]), y: r1(p[1]), signal: false, stop: false, boundary: k.startsWith('b:'), degree: 0 }; nodeIndex.set(k, n); graphNodes.push(n); }
    return n;
  };
  const edges = [];
  for (const pc of pieces) {
    const last = pc.keys.length - 1;
    let start = 0;
    for (let i = 1; i <= last; i++) {
      if (i === last || usage.get(pc.keys[i]) >= 2) {
        let pts = pc.pts.slice(start, i + 1);
        let length = 0;
        for (let j = 0; j < pts.length - 1; j++) length += Math.hypot(pts[j + 1][0] - pts[j][0], pts[j + 1][1] - pts[j][1]);
        let ka = pc.keys[start], kb = pc.keys[i];
        // Drop specks, but keep a short stub that reaches the world edge so that street still gets its exit node.
        if (length > 0.5 || ka.startsWith('b:') || kb.startsWith('b:')) {
          if (pc.gw.oneway === -1) { pts = pts.slice().reverse(); [ka, kb] = [kb, ka]; }
          const a = nodeFor(ka, pts[0]), b = nodeFor(kb, pts[pts.length - 1]);
          a.degree++; b.degree++;
          const t = pc.gw.t;
          edges.push({
            id: edges.length, wayId: pc.gw.id, from: a.id, to: b.id, oneway: pc.gw.oneway !== 0, length: r1(length),
            highway: t.highway, lanes: pc.gw.lanes, layer: pc.gw.layer, name: t.name ?? '', mph: mph(t.maxspeed),
            points: pts.map(rpt),
          });
        }
        start = i;
      }
    }
  }
  return { graphNodes, edges };
}

// Signals and stop signs are mapped on the road near the junction: snap them to the nearest junction node (within 30 m).
// nodes: [{ tags, lat, lon }]. Uses a 30 m grid so it also works for a whole city.
export function snapSignals(graphNodes, nodes, toGame) {
  const CELL = 30;
  const grid = new Map();
  for (const gn of graphNodes) {
    if (gn.boundary || gn.degree < 3) continue;
    const k = `${Math.floor(gn.x / CELL)},${Math.floor(gn.y / CELL)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)).push(gn);
  }
  for (const [tag, field] of [['traffic_signals', 'signal'], ['stop', 'stop']]) {
    for (const n of nodes) {
      if (n.tags?.highway !== tag) continue;
      const g = toGame(n);
      const gx = Math.floor(g[0] / CELL), gy = Math.floor(g[1] / CELL);
      let best = null, bd = 30;
      for (let ix = gx - 1; ix <= gx + 1; ix++) for (let iy = gy - 1; iy <= gy + 1; iy++) {
        for (const gn of grid.get(`${ix},${iy}`) ?? []) {
          const d = Math.hypot(gn.x - g[0], gn.y - g[1]);
          if (d < bd || (d === bd && best && gn.id < best.id)) { bd = d; best = gn; }
        }
      }
      if (best) best[field] = true;
    }
  }
}

// ---------- crossings ----------
// A crossing is a crossing node that sits on a drivable graph way. `keep([x, y])` limits it to the playable area.
export function findCrossings(graphWays, crossingKeys, keep) {
  const crossings = [];
  const seenCross = new Set();
  for (const gw of graphWays) {
    for (let i = 0; i < gw.keys.length; i++) {
      const k = gw.keys[i];
      if (!crossingKeys.has(k) || seenCross.has(k)) continue;
      const p = gw.pts[i];
      if (!keep(p)) continue;
      const a = gw.pts[Math.max(0, i - 1)], b = gw.pts[Math.min(gw.pts.length - 1, i + 1)];
      seenCross.add(k);
      crossings.push({ x: r1(p[0]), y: r1(p[1]), angle: Math.round((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI * 10) / 10, width: r1(Math.max(6.6, gw.lanes * 3.3)) });
    }
  }
  return crossings;
}

// ---------- walkways ----------
export function walkwayKind(t) {
  if (isIndoorOrSkyway(t)) return null;
  let kind = null;
  if (t.highway === 'footway' && t.footway === 'sidewalk') kind = 'sidewalk';
  else if (t.highway === 'footway' && t.footway === 'crossing') kind = 'crossing';
  else if (t.highway === 'pedestrian') kind = 'pedestrian';
  if (!kind || layerOf(t) > 0) return null;
  return kind;
}

// ---------- buildings ----------
export const areaOf = (pts) => { let a = 0; for (let i = 0; i < pts.length; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length]; a += x1 * y2 - x2 * y1; } return a / 2; };
const hash01 = (id) => (Math.imul(id ^ (id >>> 15), 2246822519) >>> 0) / 4294967296;

// pts: the footprint in game metres without the closing duplicate, at least 3 points (this reverses it in place to the standard winding).
// lidar / parts: the height tables by OSM id. Returns { b, src } (src says where the height came from).
export function makeBuilding(id, t, pts, lidar, parts) {
  if (areaOf(pts) < 0) pts.reverse(); // one consistent winding
  const h = parseFloat(t.height), lv = parseFloat(t['building:levels']);
  const li = lidar[String(id)];
  let height, src;
  if (li && li.n >= 4 && li.h >= 3) { height = li.h; src = 'lidar'; }
  else if (li) { height = Math.max(3, li.h); src = 'lidar'; } // a tiny shed or kiosk: measured, but at least 3 m
  else if (Number.isFinite(h) && h > 0) { height = h; src = 'height'; }
  else if (Number.isFinite(lv) && lv > 0) { height = lv * 3.4 + 2; src = 'levels'; }
  else {
    src = 'default';
    const f = hash01(id);
    height = t.building === 'roof' ? 5 : t.building === 'parking' ? 10 + f * 6 : 14 + f * 26;
  }
  const b = { id, name: t.name ?? '', type: t.building, height: r1(height), heightSource: src, points: pts.map(rpt) };
  // what OSM knows about the look of the walls (little: 10 of 134 carry a material), used to pick a facade style
  if (Number.isFinite(lv) && lv > 0) b.levels = lv;
  if (t['building:material']) b.material = t['building:material'];
  if (t['building:colour']) b.colour = t['building:colour'];
  // Stepped buildings (a low base with towers on it) come as blocks: each has a footprint, the height it starts at
  // (the roof of what it stands on) and the height it reaches. The whole-building footprint above stays the collision shape.
  if (parts[String(id)]) {
    b.parts = parts[String(id)].map((p) => {
      const q = p.poly.map(([x, y]) => [x, y]);
      if (areaOf(q) < 0) q.reverse();
      return { points: q.map(rpt), base: p.base, top: p.top };
    });
    b.height = r1(Math.max(...b.parts.map((p) => p.top)));
  }
  return { b, src };
}

// ---------- skyways ----------
// Elevated enclosed walkways between buildings ("Minneapolis Skyway", tagged bridge=covered/yes). Only the stretch that spans
// open ground (street, sidewalk) is kept: anything inside a building footprint is part of the building. The game draws each as a
// block above the street, so cars drive under it.
export const insidePoly = (x, y, poly) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
export const isSkywayWay = (t) => /skyway/i.test(t.name ?? '') && (t.bridge === 'covered' || t.bridge === 'yes') && t.tunnel !== 'yes' && t.highway !== 'steps' && !(Number(t.layer) < 1);

// Walk the way in 0.25 m steps and keep the runs that are outside every building; returns skyway records { id, points }.
export function skywaySpans(id, pts, inAnyBuilding) {
  let run = null;
  const runs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1], len = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(len / 0.25));
    for (let k = (i === 0 ? 0 : 1); k <= n; k++) {
      const x = ax + ((bx - ax) * k) / n, y = ay + ((by - ay) * k) / n;
      if (inAnyBuilding(x, y)) { if (run) { runs.push(run); run = null; } }
      else { (run ??= []).push([x, y]); }
    }
  }
  if (run) runs.push(run);
  const out = [];
  for (const r of runs) {
    // simplify: keep the ends and any real bend
    const keep = [r[0]];
    for (let i = 1; i < r.length - 1; i++) {
      const a = keep[keep.length - 1], b = r[i], c = r[i + 1];
      const cross = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / (Math.hypot(c[0] - a[0], c[1] - a[1]) || 1);
      if (cross > 0.3) keep.push(b);
    }
    keep.push(r[r.length - 1]);
    const length = keep.reduce((acc, p, i) => acc + (i ? Math.hypot(p[0] - keep[i - 1][0], p[1] - keep[i - 1][1]) : 0), 0);
    if (length >= 3) out.push({ id, points: keep.map(rpt) });
  }
  return out;
}

// ---------- ground areas ----------
export function areaKind(t) {
  let kind = null;
  if (/^(park|garden|pitch|playground)$/.test(t.leisure ?? '')) kind = 'park';
  else if (/^(grass|recreation_ground)$/.test(t.landuse ?? '')) kind = 'grass';
  else if (t.amenity === 'parking' && !/^(underground|multi-storey|rooftop|garage)/.test(t.parking ?? '')) kind = 'parking';
  return kind;
}

// ---------- report helper ----------
export function components(nodeCount, edges) {
  const parent = Array.from({ length: nodeCount }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (const e of edges) parent[find(e.from)] = find(e.to);
  const sizes = new Map();
  for (let i = 0; i < nodeCount; i++) { const r = find(i); sizes.set(r, (sizes.get(r) ?? 0) + 1); }
  return [...sizes.values()].sort((a, b) => b - a);
}
