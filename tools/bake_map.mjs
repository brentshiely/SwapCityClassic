// Build-time: turn the raw OpenStreetMap JSON into one compact game file, data/map.json.
// Usage: node tools/bake_map.mjs
//
// Game frame: metres, x to the right, y DOWN (screen-style), origin at the centre of the
// 3x3-block box, rotated so the street grid runs straight. See data/map_config.json.
import { readFile, writeFile } from 'node:fs/promises';

const cfg = JSON.parse(await readFile('data/map_config.json', 'utf8'));
const raw = JSON.parse(await readFile(cfg.raw, 'utf8'));
// Real building heights measured from USGS LiDAR by tools/lidar_heights.py (optional: falls back to OSM tags, then a guess)
let lidar = {}, parts = {};
try { parts = JSON.parse(await readFile('data/parts_lidar.json', 'utf8')).parts ?? {}; } catch { /* no stepped-building blocks: every building is one prism */ }
try { lidar = JSON.parse(await readFile('data/heights_lidar.json', 'utf8')).buildings ?? {}; } catch { console.log('  (no data/heights_lidar.json: using OSM heights and guesses)'); }

// ---------- projection ----------
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
const key = (p) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;
const r1 = (v) => Math.round(v * 10) / 10;
const rpt = ([x, y]) => [r1(x), r1(y)];

// The playable world is the box plus room for the boundary streets and their sidewalks.
const EDGE_MARGIN = 25;
const halfW = (B.xMax - B.xMin) / 2 + EDGE_MARGIN;
const halfH = (B.yMax - B.yMin) / 2 + EDGE_MARGIN;
const WORLD = { minX: -halfW, minY: -halfH, maxX: halfW, maxY: halfH };
// Scenery beyond the wall (buildings, roads) so the edge of the map does not look cut off.
const SCENERY_MARGIN = 150;
const SCENE = { minX: WORLD.minX - SCENERY_MARGIN, minY: WORLD.minY - SCENERY_MARGIN, maxX: WORLD.maxX + SCENERY_MARGIN, maxY: WORLD.maxY + SCENERY_MARGIN };
const bboxHits = (pts, R) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return x1 >= R.minX && x0 <= R.maxX && y1 >= R.minY && y0 <= R.maxY;
};

// ---------- tag helpers ----------
const layerOf = (t) => {
  if (t.layer !== undefined && !Number.isNaN(Number(t.layer))) return Number(t.layer);
  if (t.tunnel && t.tunnel !== 'no') return -1;
  if (t.bridge && t.bridge !== 'no') return 1;
  return 0;
};
// Skyways and building interiors are not street level: keep them out of the map entirely.
const isIndoorOrSkyway = (t) => t.indoor === 'yes' || t.indoor === 'room' || t.indoor === 'corridor' || t.bridge === 'covered' || t.tunnel === 'building_passage' || t.highway === 'corridor' || t.highway === 'elevator';
const mph = (v) => { const m = /(\d+)/.exec(v ?? ''); return m ? Number(m[1]) : null; };

const ways = raw.elements.filter((e) => e.type === 'way' && e.geometry);
const nodes = raw.elements.filter((e) => e.type === 'node');

// ---------- roads (drawn) and traffic graph ----------
const DRIVABLE = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'service']);
const SKIP_SERVICE = new Set(['parking_aisle', 'driveway', 'emergency_access', 'drive-through']);
const DEFAULT_LANES = { motorway: 3, trunk: 3, primary: 3, secondary: 2, tertiary: 2, unclassified: 2, residential: 2, living_street: 1, service: 1 };

const roads = [];
const graphWays = [];
for (const w of ways) {
  const t = w.tags ?? {};
  if (!t.highway || !DRIVABLE.has(t.highway.replace(/_link$/, ''))) continue;
  if (isIndoorOrSkyway(t)) continue;
  if (t.highway === 'service' && SKIP_SERVICE.has(t.service)) continue;
  const pts = w.geometry.map(toGame);
  if (!bboxHits(pts, SCENE)) continue;
  const base = t.highway.replace(/_link$/, '');
  const lanes = Number(t.lanes) || DEFAULT_LANES[base] || 2;
  const width = t.highway === 'service' ? 3.5 : Math.max(6.6, lanes * 3.3);
  const oneway = t.oneway === 'yes' || t.oneway === '1' || t.junction === 'roundabout' || t.junction === 'circular' ? 1 : t.oneway === '-1' ? -1 : 0;
  const layer = layerOf(t);
  roads.push({
    id: w.id, name: t.name ?? '', highway: t.highway, width: r1(width), lanes,
    oneway: oneway !== 0, layer, tunnel: !!t.tunnel && t.tunnel !== 'no', bridge: !!t.bridge && t.bridge !== 'no',
    points: pts.map(rpt),
  });
  if (t.highway !== 'service') graphWays.push({ w, pts, oneway, lanes, layer, t });
}

// Split each graph way at the world boundary, then at every shared vertex.
function clipSegment(a, b, R) {
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

const pieces = [];
for (const gw of graphWays) {
  const keys = gw.w.geometry.map(key);
  let cur = null;
  for (let i = 0; i < gw.pts.length - 1; i++) {
    const a = gw.pts[i], b = gw.pts[i + 1];
    const c = clipSegment(a, b, WORLD);
    if (!c) { cur = null; continue; }
    const [t0, t1] = c;
    const pa = t0 > 0 ? lerp(a, b, t0) : a, pb = t1 < 1 ? lerp(a, b, t1) : b;
    if (!cur || t0 > 0) {
      cur = { gw, pts: [pa], keys: [t0 > 0 ? bkey(pa) : keys[i]], boundaryStart: t0 > 0 };
      pieces.push(cur);
    }
    cur.pts.push(pb);
    cur.keys.push(t1 < 1 ? bkey(pb) : keys[i + 1]);
    if (t1 < 1) { cur.boundaryEnd = true; cur = null; }
  }
}

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
          id: edges.length, wayId: pc.gw.w.id, from: a.id, to: b.id, oneway: pc.gw.oneway !== 0, length: r1(length),
          highway: t.highway, lanes: pc.gw.lanes, layer: pc.gw.layer, name: t.name ?? '', mph: mph(t.maxspeed),
          points: pts.map(rpt),
        });
      }
      start = i;
    }
  }
}

// Signals and stop signs are mapped on the road near the junction: snap them to the nearest junction node.
for (const [tag, field] of [['traffic_signals', 'signal'], ['stop', 'stop']]) {
  for (const n of nodes) {
    if (n.tags?.highway !== tag) continue;
    const g = toGame(n);
    let best = null, bd = 30;
    for (const gn of graphNodes) {
      if (gn.boundary || gn.degree < 3) continue;
      const d = Math.hypot(gn.x - g[0], gn.y - g[1]);
      if (d < bd) { bd = d; best = gn; }
    }
    if (best) best[field] = true;
  }
}

// ---------- crossings ----------
const crossingKeys = new Set(nodes.filter((n) => n.tags?.highway === 'crossing').map(key));
const crossings = [];
const seenCross = new Set();
for (const gw of graphWays) {
  const g = gw.w.geometry;
  for (let i = 0; i < g.length; i++) {
    const k = key(g[i]);
    if (!crossingKeys.has(k) || seenCross.has(k)) continue;
    const p = gw.pts[i];
    if (p[0] < WORLD.minX - 20 || p[0] > WORLD.maxX + 20 || p[1] < WORLD.minY - 20 || p[1] > WORLD.maxY + 20) continue;
    const a = gw.pts[Math.max(0, i - 1)], b = gw.pts[Math.min(gw.pts.length - 1, i + 1)];
    seenCross.add(k);
    crossings.push({ x: r1(p[0]), y: r1(p[1]), angle: Math.round((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI * 10) / 10, width: r1(Math.max(6.6, gw.lanes * 3.3)) });
  }
}

// ---------- walkways ----------
const walkways = [];
for (const w of ways) {
  const t = w.tags ?? {};
  if (isIndoorOrSkyway(t)) continue;
  let kind = null;
  if (t.highway === 'footway' && t.footway === 'sidewalk') kind = 'sidewalk';
  else if (t.highway === 'footway' && t.footway === 'crossing') kind = 'crossing';
  else if (t.highway === 'pedestrian') kind = 'pedestrian';
  if (!kind || layerOf(t) > 0) continue;
  const pts = w.geometry.map(toGame);
  if (!bboxHits(pts, SCENE)) continue;
  walkways.push({ id: w.id, kind, points: pts.map(rpt) });
}

// ---------- buildings ----------
const areaOf = (pts) => { let a = 0; for (let i = 0; i < pts.length; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length]; a += x1 * y2 - x2 * y1; } return a / 2; };
const hash01 = (id) => (Math.imul(id ^ (id >>> 15), 2246822519) >>> 0) / 4294967296;
const buildings = [];
let stepped = 0, fromLidar = 0, fromHeight = 0, fromLevels = 0, fromDefault = 0;
for (const w of ways) {
  const t = w.tags ?? {};
  if (!t.building || w.geometry.length < 4) continue;
  let pts = w.geometry.map(toGame);
  pts.pop(); // closing duplicate
  if (pts.length < 3 || !bboxHits(pts, SCENE)) continue;
  if (areaOf(pts) < 0) pts.reverse(); // one consistent winding
  const h = parseFloat(t.height), lv = parseFloat(t['building:levels']);
  const li = lidar[String(w.id)];
  let height, src;
  if (li && li.n >= 4 && li.h >= 3) { height = li.h; src = 'lidar'; fromLidar++; }
  else if (li) { height = Math.max(3, li.h); src = 'lidar'; fromLidar++; } // a tiny shed or kiosk: measured, but at least 3 m
  else if (Number.isFinite(h) && h > 0) { height = h; src = 'height'; fromHeight++; }
  else if (Number.isFinite(lv) && lv > 0) { height = lv * 3.4 + 2; src = 'levels'; fromLevels++; }
  else {
    src = 'default'; fromDefault++;
    const f = hash01(w.id);
    height = t.building === 'roof' ? 5 : t.building === 'parking' ? 10 + f * 6 : 14 + f * 26;
  }
  const b = { id: w.id, name: t.name ?? '', type: t.building, height: r1(height), heightSource: src, points: pts.map(rpt) };
  // what OSM knows about the look of the walls (little: 10 of 134 carry a material), used to pick a facade style
  if (Number.isFinite(lv) && lv > 0) b.levels = lv;
  if (t['building:material']) b.material = t['building:material'];
  if (t['building:colour']) b.colour = t['building:colour'];
  // Stepped buildings (a low base with towers on it) come as blocks: each has a footprint, the height it starts at
  // (the roof of what it stands on) and the height it reaches. The whole-building footprint above stays the collision shape.
  if (parts[String(w.id)]) {
    b.parts = parts[String(w.id)].map((p) => {
      const q = p.poly.map(([x, y]) => [x, y]);
      if (areaOf(q) < 0) q.reverse();
      return { points: q.map(rpt), base: p.base, top: p.top };
    });
    b.height = r1(Math.max(...b.parts.map((p) => p.top)));
    stepped++;
  }
  buildings.push(b);
}

// ---------- skyways ----------
// Elevated enclosed walkways between buildings ("Minneapolis Skyway", tagged bridge=covered/yes). Only the stretch that spans
// open ground (street, sidewalk) is kept: anything inside a building footprint is part of the building. The game draws each as a
// block above the street, so cars drive under it.
const insidePoly = (x, y, poly) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const inAnyBuilding = (x, y) => buildings.some((b) => insidePoly(x, y, b.points));
const skyways = [];
for (const w of ways) {
  const t = w.tags ?? {};
  if (!/skyway/i.test(t.name ?? '') || !(t.bridge === 'covered' || t.bridge === 'yes') || t.tunnel === 'yes') continue;
  if (t.highway === 'steps' || Number(t.layer) < 1) continue;
  const pts = w.geometry.map(toGame);
  if (!bboxHits(pts, WORLD)) continue;
  // walk the way in 0.25 m steps and keep the runs that are outside every building
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
    if (length >= 3) skyways.push({ id: w.id, points: keep.map(rpt) });
  }
}

// ---------- ground areas ----------
const areas = [];
for (const w of ways) {
  const t = w.tags ?? {};
  let kind = null;
  if (/^(park|garden|pitch|playground)$/.test(t.leisure ?? '')) kind = 'park';
  else if (/^(grass|recreation_ground)$/.test(t.landuse ?? '')) kind = 'grass';
  else if (t.amenity === 'parking' && !/^(underground|multi-storey|rooftop|garage)/.test(t.parking ?? '')) kind = 'parking';
  if (!kind || t.building || w.geometry.length < 4) continue;
  const pts = w.geometry.map(toGame); pts.pop();
  if (!bboxHits(pts, SCENE)) continue;
  areas.push({ id: w.id, kind, points: pts.map(rpt) });
}

// ---------- write ----------
const map = {
  meta: {
    name: cfg.name,
    generated: new Date().toISOString(),
    source: cfg.raw,
    attribution: '© OpenStreetMap contributors (ODbL)',
    frame: 'metres, x right, y down, origin at the centre of the 3x3-block box, rotated so streets run straight',
    rotationDegrees: cfg.rotationDegrees,
    origin: cfg.origin,
    box: { minX: r1(B.xMin - cx), minY: r1(-(B.yMax - cy)), maxX: r1(B.xMax - cx), maxY: r1(-(B.yMin - cy)) },
    world: { minX: r1(WORLD.minX), minY: r1(WORLD.minY), maxX: r1(WORLD.maxX), maxY: r1(WORLD.maxY) },
  },
  roads, walkways, crossings, buildings, areas, skyways,
  graph: { nodes: graphNodes.map(({ id, x, y, signal, stop, boundary, degree }) => ({ id, x, y, signal, stop, boundary, degree })), edges },
};
await writeFile('data/map.json', JSON.stringify(map));

// ---------- report ----------
const comps = (() => {
  const parent = graphNodes.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const e of edges) parent[find(e.from)] = find(e.to);
  const sizes = new Map();
  for (let i = 0; i < parent.length; i++) sizes.set(find(i), (sizes.get(find(i)) ?? 0) + 1);
  return [...sizes.values()].sort((a, b) => b - a);
})();
const kb = Math.round(JSON.stringify(map).length / 1024);
console.log(`Wrote data/map.json (${kb} KB)`);
console.log(`  world ${(WORLD.maxX - WORLD.minX).toFixed(0)} x ${(WORLD.maxY - WORLD.minY).toFixed(0)} m`);
console.log(`  roads ${roads.length}, walkways ${walkways.length}, crossings ${crossings.length}, areas ${areas.length}`);
console.log(`  skyways over open ground: ${skyways.length} spans (${skyways.map((k) => k.points.length).join(',')} points)`);
console.log(`  stepped buildings drawn as blocks: ${stepped}`);
console.log(`  buildings ${buildings.length} (height from LiDAR ${fromLidar}, OSM height ${fromHeight}, levels ${fromLevels}, guessed ${fromDefault})`);
console.log(`  graph nodes ${graphNodes.length} (signals ${graphNodes.filter((n) => n.signal).length}, stops ${graphNodes.filter((n) => n.stop).length}, boundary ${graphNodes.filter((n) => n.boundary).length}), edges ${edges.length}`);
console.log(`  connected pieces of the road graph: ${comps.length} (sizes ${comps.slice(0, 6).join(', ')}${comps.length > 6 ? ', ...' : ''})`);
const layers = {};
for (const e of edges) layers[e.layer] = (layers[e.layer] ?? 0) + 1;
console.log(`  edges by layer: ${JSON.stringify(layers)}; one-way edges ${edges.filter((e) => e.oneway).length}/${edges.length}`);
