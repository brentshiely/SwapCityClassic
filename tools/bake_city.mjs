// Build-time: turn the raw whole-city OpenStreetMap download (data/raw/city/, from tools/fetch_city_osm.mjs) into
//   data/city/city.json            roads + traffic graph + boundary (loaded whole)
//   data/city/tiles/{tx}_{ty}.json buildings, areas, walkways, crossings, skyways per 256 m tile (streamed)
// Format: design/CITY_DATA.md. Same game frame, projection and rules as tools/bake_map.mjs (shared code in tools/lib/bake_common.mjs).
// Usage: node --max-old-space-size=8192 tools/bake_city.mjs        (npm run bake-city)
import { readFile, writeFile, readdir, mkdir, rm, stat } from 'node:fs/promises';
import {
  r1, rpt, key, makeFrame, classifyRoad, roadRecord, clipPolyline, buildGraph, snapSignals, findCrossings, walkwayKind, makeBuilding,
  isSkywayWay, insidePoly, skywaySpans, areaKind, areaOf, components,
} from './lib/bake_common.mjs';
import { largestRing } from './lib/city_boundary.mjs';

const t0 = Date.now();
const RAW = 'data/raw/city';
const OUT = 'data/city';
const TILE = 256;
const ROAD_MARGIN = 60; // roads (and the traffic graph) run this far past the city limit

const cfg = JSON.parse(await readFile('data/map_config.json', 'utf8'));
let lidar = {}, parts = {};
try { parts = JSON.parse(await readFile('data/parts_lidar.json', 'utf8')).parts ?? {}; } catch { /* no stepped-building blocks */ }
try { lidar = JSON.parse(await readFile('data/heights_lidar.json', 'utf8')).buildings ?? {}; } catch { console.log('  (no data/heights_lidar.json: using OSM heights and guesses)'); }
const { toGame } = makeFrame(cfg);

// ---------- the city limit, in game metres ----------
const boundaryRaw = JSON.parse(await readFile(`${RAW}/boundary.json`, 'utf8')).elements;
const ring = largestRing(boundaryRaw)[0];
let boundary = ring.map(([lat, lon]) => toGame({ lat, lon }));
if (boundary.length > 1 && boundary[0][0] === boundary.at(-1)[0] && boundary[0][1] === boundary.at(-1)[1]) boundary.pop();
if (areaOf(boundary) < 0) boundary.reverse(); // wound like the buildings
boundary = boundary.map(rpt);
let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
for (const [x, y] of boundary) { bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y); }

// Region = the city polygon grown by ROAD_MARGIN. Cells of 64 m know if they are wholly inside / wholly outside, so only
// the cells along the limit need real geometry.
class Region {
  constructor(poly, margin) {
    this.poly = poly; this.margin = margin; this.C = 64;
    const n = poly.length;
    this.bands = new Map();  // y band -> edges (for point-in-polygon)
    this.cells = new Map();  // cell -> edges within `margin` of the cell (for distance)
    this.state = new Map();  // cell -> 0 outside, 1 inside, 2 along the limit
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      const e = [a[0], a[1], b[0], b[1]];
      const y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]), x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]);
      for (let k = Math.floor(y0 / this.C); k <= Math.floor(y1 / this.C); k++) (this.bands.get(k) ?? this.bands.set(k, []).get(k)).push(e);
      for (let cx = Math.floor((x0 - margin) / this.C); cx <= Math.floor((x1 + margin) / this.C); cx++) {
        for (let cy = Math.floor((y0 - margin) / this.C); cy <= Math.floor((y1 + margin) / this.C); cy++) (this.cells.get(cx * 100003 + cy) ?? this.cells.set(cx * 100003 + cy, []).get(cx * 100003 + cy)).push(e);
      }
    }
  }
  pip(x, y) {
    let inside = false;
    for (const [ax, ay, bx, by] of this.bands.get(Math.floor(y / this.C)) ?? []) {
      if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
    }
    return inside;
  }
  cellState(cx, cy) {
    const k = cx * 100003 + cy;
    let s = this.state.get(k);
    if (s === undefined) {
      const edges = this.cells.get(k);
      // no boundary edge within margin of the cell: everything in it is inside or outside together
      s = !edges ? (this.pip((cx + 0.5) * this.C, (cy + 0.5) * this.C) ? 1 : 0) : 2;
      this.state.set(k, s);
    }
    return s;
  }
  near(x, y, m) { // is the point within m (<= margin) of the limit?
    for (const [ax, ay, bx, by] of this.cells.get(Math.floor(x / this.C) * 100003 + Math.floor(y / this.C)) ?? []) {
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
      if (Math.hypot(ax + t * dx - x, ay + t * dy - y) <= m) return true;
    }
    return false;
  }
  inPoly(x, y) { const s = this.cellState(Math.floor(x / this.C), Math.floor(y / this.C)); return s === 2 ? this.pip(x, y) : s === 1; }
  inRegion(x, y) {
    const s = this.cellState(Math.floor(x / this.C), Math.floor(y / this.C));
    return s === 2 ? this.pip(x, y) || this.near(x, y, this.margin) : s === 1;
  }
  // the [t0, t1] ranges of segment a-b inside the region
  clip(a, b) {
    const C = this.C;
    let all = -1; // -1 unknown, 0/1 uniform, 2 mixed
    for (let cx = Math.floor(Math.min(a[0], b[0]) / C); cx <= Math.floor(Math.max(a[0], b[0]) / C) && all !== 2; cx++) {
      for (let cy = Math.floor(Math.min(a[1], b[1]) / C); cy <= Math.floor(Math.max(a[1], b[1]) / C); cy++) {
        const s = this.cellState(cx, cy);
        if (s === 2 || (all !== -1 && all !== s)) { all = 2; break; }
        all = s;
      }
    }
    if (all === 1) return [[0, 1]];
    if (all === 0) return [];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(len / 4));
    const at = (t) => this.inRegion(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
    const ranges = [];
    let prev = at(0), start = prev ? 0 : null;
    for (let k = 1; k <= n; k++) {
      const cur = at(k / n);
      if (cur !== prev) {
        let lo = (k - 1) / n, hi = k / n;
        for (let it = 0; it < 22; it++) { const mid = (lo + hi) / 2; if (at(mid) === prev) lo = mid; else hi = mid; }
        if (prev) { ranges.push([start, lo]); start = null; } else start = hi;
      }
      prev = cur;
    }
    if (prev) ranges.push([start, 1]);
    return ranges.filter(([s, e]) => e - s > 1e-9);
  }
}
const region = new Region(boundary, ROAD_MARGIN);
const clip = (a, b) => region.clip(a, b);

// ---------- tiles ----------
const tiles = new Map();
const tileAt = (tx, ty) => {
  const k = `${tx}_${ty}`;
  let t = tiles.get(k);
  if (!t) { t = { tx, ty, buildings: [], areas: [], walkways: [], crossings: [], skyways: [] }; tiles.set(k, t); }
  return t;
};
function addToTiles(list, feature, pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  for (let tx = Math.floor(x0 / TILE); tx <= Math.floor(x1 / TILE); tx++) for (let ty = Math.floor(y0 / TILE); ty <= Math.floor(y1 / TILE); ty++) tileAt(tx, ty)[list].push(feature);
}

// ---------- read the chunks ----------
const files = (await readdir(RAW)).filter((f) => /^c_\d+_\d+\.json$/.test(f)).sort((a, b) => {
  const [ar, ac] = a.match(/\d+/g).map(Number), [br, bc] = b.match(/\d+/g).map(Number);
  return ar - br || ac - bc;
});
if (!files.length) throw new Error('no chunks in ' + RAW + ': run npm run fetch-city first');

const roads = [], graphWays = [], skywayWays = [];
const nodes = [], crossingKeys = new Set();
const seenWay = new Set(), seenNode = new Set();
const stat0 = { chunks: files.length, ways: 0, roadsSeen: 0, buildingsSeen: 0, buildingsOutside: 0, fromLidar: 0, fromHeight: 0, fromLevels: 0, fromDefault: 0, stepped: 0, walkways: 0, areas: 0, badGeometry: 0 };
let buildingCount = 0;
const buildingIds = new Set();

for (const f of files) {
  const j = JSON.parse(await readFile(`${RAW}/${f}`, 'utf8'));
  for (const el of j.elements) {
    if (el.type === 'node') {
      if (seenNode.has(el.id)) continue;
      seenNode.add(el.id);
      const h = el.tags?.highway;
      if (h === 'crossing') crossingKeys.add(key(el));
      else if (h === 'traffic_signals' || h === 'stop') nodes.push({ tags: el.tags, lat: el.lat, lon: el.lon });
      continue;
    }
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    if (seenWay.has(el.id)) continue;
    seenWay.add(el.id);
    stat0.ways++;
    const t = el.tags ?? {};
    const g = el.geometry;

    // roads: drawn (clipped to the limit + margin) and, unless service, part of the traffic graph
    const c = classifyRoad(t);
    if (c) {
      stat0.roadsSeen++;
      const pts = g.map(toGame);
      const keys = g.map(key);
      const pieces = clipPolyline(pts, keys, clip);
      for (const pc of pieces) if (pc.pts.length >= 2) roads.push(roadRecord(el.id, t, c, pc.pts));
      if (pieces.length && t.highway !== 'service') graphWays.push({ id: el.id, t, pts, keys, oneway: c.oneway, lanes: c.lanes, layer: c.layer });
    }

    // walkways: kept if any vertex is inside the region
    const wk = walkwayKind(t);
    if (wk) {
      const pts = g.map(toGame);
      if (pts.some(([x, y]) => region.inRegion(x, y))) { addToTiles('walkways', { id: el.id, kind: wk, points: pts.map(rpt) }, pts); stat0.walkways++; }
    }

    // buildings: kept if the footprint is inside the city limit or touches it
    if (t.building) {
      if (g.length < 4) { stat0.badGeometry++; continue; }
      stat0.buildingsSeen++;
      const pts = g.map(toGame);
      pts.pop(); // closing duplicate
      if (pts.length < 3) continue;
      if (!(pts.some(([x, y]) => region.inPoly(x, y)) || pts.some(([x, y]) => region.near(x, y, 1.5)))) { stat0.buildingsOutside++; continue; }
      const { b, src } = makeBuilding(el.id, t, pts, lidar, parts);
      stat0[src === 'lidar' ? 'fromLidar' : src === 'height' ? 'fromHeight' : src === 'levels' ? 'fromLevels' : 'fromDefault']++;
      if (b.parts) stat0.stepped++;
      addToTiles('buildings', b, pts);
      buildingCount++;
      continue;
    }

    // skyways (resolved after every building is known)
    if (isSkywayWay(t)) {
      const pts = g.map(toGame);
      if (pts.some(([x, y]) => region.inPoly(x, y))) skywayWays.push({ id: el.id, pts });
    }

    // ground areas
    const kind = areaKind(t);
    if (kind && g.length >= 4) {
      const pts = g.map(toGame); pts.pop();
      if (pts.some(([x, y]) => region.inRegion(x, y))) { addToTiles('areas', { id: el.id, kind, points: pts.map(rpt) }, pts); stat0.areas++; }
    }
  }
  process.stdout.write(`\r  read ${f} (${roads.length} road pieces, ${buildingCount} buildings)   `);
}
console.log();
seenWay.clear(); seenNode.clear();

// ---------- traffic graph ----------
const { graphNodes, edges } = buildGraph(graphWays, clip);
snapSignals(graphNodes, nodes, toGame);

// ---------- crossings ----------
const crossings = findCrossings(graphWays, crossingKeys, (p) => region.inRegion(p[0], p[1]));
for (const cr of crossings) tileAt(Math.floor(cr.x / TILE), Math.floor(cr.y / TILE)).crossings.push(cr);

// ---------- skyways ----------
const inAnyBuilding = (x, y) => (tiles.get(`${Math.floor(x / TILE)}_${Math.floor(y / TILE)}`)?.buildings ?? []).some((b) => insidePoly(x, y, b.points));
let skywayCount = 0;
for (const sw of skywayWays) for (const s of skywaySpans(sw.id, sw.pts, inAnyBuilding)) { addToTiles('skyways', s, s.points); skywayCount++; }

// ---------- write ----------
let minTx = Infinity, minTy = Infinity, maxTx = -Infinity, maxTy = -Infinity;
const world = { minX: r1(bx0), minY: r1(by0), maxX: r1(bx1), maxY: r1(by1) };
const meta = {
  name: 'minneapolis',
  origin: cfg.origin,
  rotationDegrees: cfg.rotationDegrees,
  tileSize: TILE,
  generated: new Date().toISOString(),
  attribution: '© OpenStreetMap contributors (ODbL)',
  source: `${RAW}/ (Overpass, ${files.length} chunks)`,
  frame: 'metres, x right, y down, origin at the centre of the downtown 3x3-block box, rotated so streets run straight',
  roadMargin: ROAD_MARGIN,
  world,
  tiles: { minTx: Math.floor(world.minX / TILE), minTy: Math.floor(world.minY / TILE), maxTx: Math.floor(world.maxX / TILE), maxTy: Math.floor(world.maxY / TILE) },
  boundary,
};
const city = {
  meta, roads,
  graph: { nodes: graphNodes.map(({ id, x, y, signal, stop, boundary, degree }) => ({ id, x, y, signal, stop, boundary, degree })), edges },
};
await mkdir(OUT, { recursive: true });
await rm(`${OUT}/tiles`, { recursive: true, force: true });
await mkdir(`${OUT}/tiles`, { recursive: true });
const cityStr = JSON.stringify(city);
if (/NaN|Infinity/.test(cityStr)) throw new Error('non-finite number in city.json');
await writeFile(`${OUT}/city.json`, cityStr);
let tileBytes = 0, biggest = 0, dupEntries = 0;
for (const tile of tiles.values()) {
  const s = JSON.stringify(tile);
  if (s.includes('null')) { /* a null could only come from NaN in a coordinate */ if (/[\[,]null[\],]/.test(s)) throw new Error(`NaN in tile ${tile.tx}_${tile.ty}`); }
  await writeFile(`${OUT}/tiles/${tile.tx}_${tile.ty}.json`, s);
  tileBytes += s.length; biggest = Math.max(biggest, s.length);
  dupEntries += tile.buildings.length;
  minTx = Math.min(minTx, tile.tx); maxTx = Math.max(maxTx, tile.tx); minTy = Math.min(minTy, tile.ty); maxTy = Math.max(maxTy, tile.ty);
}

// ---------- report ----------
const comps = components(graphNodes.length, edges);
const layers = {};
for (const e of edges) layers[e.layer] = (layers[e.layer] ?? 0) + 1;
const mb = (n) => (n / 1e6).toFixed(1) + ' MB';
console.log(`Wrote ${OUT}/city.json (${mb(cityStr.length)}) and ${tiles.size} tiles (${mb(tileBytes)} total, biggest ${(biggest / 1024).toFixed(0)} KB)`);
console.log(`  city limit ${boundary.length} points, world ${(bx1 - bx0).toFixed(0)} x ${(by1 - by0).toFixed(0)} m, tile bounds x ${meta.tiles.minTx}..${meta.tiles.maxTx} y ${meta.tiles.minTy}..${meta.tiles.maxTy}, non-empty tiles x ${minTx}..${maxTx} y ${minTy}..${maxTy}`);
console.log(`  ${stat0.ways} unique ways read from ${files.length} chunks`);
console.log(`  roads ${roads.length} pieces (${stat0.roadsSeen} drivable ways seen), walkways ${stat0.walkways}, crossings ${crossings.length}, areas ${stat0.areas}, skyways ${skywayCount}`);
console.log(`  buildings ${buildingCount} kept of ${stat0.buildingsSeen} (${stat0.buildingsOutside} wholly outside the limit dropped); tile entries ${dupEntries}`);
console.log(`  heights: LiDAR ${stat0.fromLidar}, OSM height ${stat0.fromHeight}, levels ${stat0.fromLevels}, guessed ${stat0.fromDefault}; stepped ${stat0.stepped}`);
console.log(`  graph nodes ${graphNodes.length} (signals ${graphNodes.filter((n) => n.signal).length}, stops ${graphNodes.filter((n) => n.stop).length}, boundary ${graphNodes.filter((n) => n.boundary).length}), edges ${edges.length}`);
console.log(`  connected pieces of the road graph: ${comps.length} (sizes ${comps.slice(0, 8).join(', ')}${comps.length > 8 ? ', ...' : ''})`);
console.log(`  edges by layer: ${JSON.stringify(layers)}; one-way edges ${edges.filter((e) => e.oneway).length}/${edges.length}`);
console.log(`  bake time ${((Date.now() - t0) / 1000).toFixed(1)} s`);
