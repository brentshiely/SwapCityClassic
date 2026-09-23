// Build-time: fetch + bake a small, radius-limited area around a city centre as an additional swappable city, on the
// same engine and file format as Minneapolis (design/CITY_DATA.md) but without LiDAR heights or NAIP roof photos
// (Minneapolis-only data sources) -- buildings fall back to their OSM height/levels tags, or a guess.
//
// Usage: node tools/add_city.mjs <slug> "<label>" <lat> <lon> [radiusMiles=1]
//   e.g. node tools/add_city.mjs chicago "Chicago, IL" 41.8836 -87.6270 1
//
// Output (gitignored): data/raw/cities/<slug>.json (raw Overpass, cached/resumable), data/cities/<slug>/{city.json,
// tiles/}, and the city is added to data/cities/manifest.json (read by the splash screen's city menu).
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import {
  r1, rpt, key, makeFrame, classifyRoad, roadRecord, clipSegmentRect, buildGraph, snapSignals, findCrossings,
  walkwayKind, makeBuilding, isSkywayWay, insidePoly, skywaySpans, areaKind, components,
} from './lib/bake_common.mjs';

const [slug, label, latS, lonS, radS] = process.argv.slice(2);
if (!slug || !label || !latS || !lonS) {
  console.error('usage: node tools/add_city.mjs <slug> "<label>" <lat> <lon> [radiusMiles=1]');
  process.exit(1);
}
const lat0 = Number(latS), lon0 = Number(lonS), radiusMiles = Number(radS ?? 1);
const RAW = `data/raw/cities/${slug}.json`;
const OUT = `data/cities/${slug}`;

// ---------- 1. fetch (skip if a cached copy is already on disk) ----------
const UA = 'SwapCityClassic/1.0 (personal offline game; https://github.com/brentshiely/SwapCityClassic)';
const SERVERS = ['https://overpass.kumi.systems/api/interpreter', 'https://overpass-api.de/api/interpreter'];
let raw;
try {
  raw = JSON.parse(await readFile(RAW, 'utf8'));
  console.log(`${slug}: using cached ${RAW}`);
} catch {
  const R_M = radiusMiles * 1609.34 + 300; // fetch a bit past the playable radius so there is real scenery past the boundary wall
  const dLat = R_M / 110540, dLon = R_M / (111320 * Math.cos((lat0 * Math.PI) / 180));
  const bbox = [lat0 - dLat, lon0 - dLon, lat0 + dLat, lon0 + dLon].map((v) => +v.toFixed(6)).join(',');
  const query = `[out:json][timeout:120];
(
  way["highway"](${bbox});
  way["building"](${bbox});
  way["leisure"~"park|garden|pitch|playground"](${bbox});
  way["landuse"~"grass|recreation_ground"](${bbox});
  way["amenity"="parking"](${bbox});
  node["highway"~"crossing|traffic_signals|stop"](${bbox});
);
out geom tags;`;
  let lastErr;
  for (const url of SERVERS) {
    try {
      console.log(`${slug}: fetching from ${url} ...`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': UA },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(150000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      raw = await res.json();
      await mkdir('data/raw/cities', { recursive: true });
      await writeFile(RAW, JSON.stringify(raw));
      break;
    } catch (err) { lastErr = err; console.warn(`  failed: ${err.message}`); }
  }
  if (!raw) throw new Error(`all Overpass servers failed for ${slug}: ${lastErr?.message}`);
  const count = (t) => raw.elements.filter((x) => x.type === t).length;
  console.log(`${slug}: fetched ${count('way')} ways, ${count('node')} nodes`);
}

// ---------- 2. bake (same rules as bake_map.mjs: box = a square of radius radiusMiles around the centre, no rotation) ----------
const R_PLAY = radiusMiles * 1609.34;
const cfg = { name: slug, origin: { lat: lat0, lon: lon0 }, rotationDegrees: 0, box: { xMin: -R_PLAY, xMax: R_PLAY, yMin: -R_PLAY, yMax: R_PLAY } };
const { toGame, B } = makeFrame(cfg);
const EDGE_MARGIN = 25, SCENERY_MARGIN = 150;
const halfW = (B.xMax - B.xMin) / 2 + EDGE_MARGIN, halfH = (B.yMax - B.yMin) / 2 + EDGE_MARGIN;
const WORLD = { minX: -halfW, minY: -halfH, maxX: halfW, maxY: halfH };
const SCENE = { minX: WORLD.minX - SCENERY_MARGIN, minY: WORLD.minY - SCENERY_MARGIN, maxX: WORLD.maxX + SCENERY_MARGIN, maxY: WORLD.maxY + SCENERY_MARGIN };
const bboxHits = (pts, R) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return x1 >= R.minX && x0 <= R.maxX && y1 >= R.minY && y0 <= R.maxY;
};

const ways = raw.elements.filter((e) => e.type === 'way' && e.geometry);
const nodes = raw.elements.filter((e) => e.type === 'node');

const roads = [], graphWays = [];
for (const w of ways) {
  const t = w.tags ?? {};
  const c = classifyRoad(t);
  if (!c) continue;
  const pts = w.geometry.map(toGame);
  if (!bboxHits(pts, SCENE)) continue;
  roads.push(roadRecord(w.id, t, c, pts));
  if (t.highway !== 'service') graphWays.push({ id: w.id, t, pts, keys: w.geometry.map(key), oneway: c.oneway, lanes: c.lanes, layer: c.layer });
}
const { graphNodes, edges } = buildGraph(graphWays, (a, b) => { const c = clipSegmentRect(a, b, WORLD); return c ? [c] : []; });
snapSignals(graphNodes, nodes, toGame);

const crossingKeys = new Set(nodes.filter((n) => n.tags?.highway === 'crossing').map(key));
const crossings = findCrossings(graphWays, crossingKeys, (p) => !(p[0] < WORLD.minX - 20 || p[0] > WORLD.maxX + 20 || p[1] < WORLD.minY - 20 || p[1] > WORLD.maxY + 20));

const walkways = [];
for (const w of ways) {
  const t = w.tags ?? {};
  const kind = walkwayKind(t);
  if (!kind) continue;
  const pts = w.geometry.map(toGame);
  if (!bboxHits(pts, SCENE)) continue;
  walkways.push({ id: w.id, kind, points: pts.map(rpt) });
}

const buildings = [];
let fromHeight = 0, fromLevels = 0, fromDefault = 0;
for (const w of ways) {
  const t = w.tags ?? {};
  if (!t.building || w.geometry.length < 4) continue;
  let pts = w.geometry.map(toGame);
  pts.pop();
  if (pts.length < 3 || !bboxHits(pts, SCENE)) continue;
  const { b, src } = makeBuilding(w.id, t, pts, {}, {}); // no LiDAR/NAIP outside Minneapolis: OSM height/levels tags or a guess
  if (src === 'height') fromHeight++; else if (src === 'levels') fromLevels++; else fromDefault++;
  buildings.push(b);
}

const inAnyBuilding = (x, y) => buildings.some((b) => insidePoly(x, y, b.points));
const skyways = [];
for (const w of ways) {
  const t = w.tags ?? {};
  if (!isSkywayWay(t)) continue;
  const pts = w.geometry.map(toGame);
  if (!bboxHits(pts, WORLD)) continue;
  skyways.push(...skywaySpans(w.id, pts, inAnyBuilding));
}

const areas = [];
for (const w of ways) {
  const t = w.tags ?? {};
  const kind = areaKind(t);
  if (!kind || t.building || w.geometry.length < 4) continue;
  const pts = w.geometry.map(toGame); pts.pop();
  if (!bboxHits(pts, SCENE)) continue;
  areas.push({ id: w.id, kind, points: pts.map(rpt) });
}

// ---------- 3. write straight to the tile-based city format (the format design/CITY_DATA.md describes) ----------
const T = 256;
const boundary = [[WORLD.minX, WORLD.minY], [WORLD.maxX, WORLD.minY], [WORLD.maxX, WORLD.maxY], [WORLD.minX, WORLD.maxY]];
const tiles = new Map();
const bboxOf = (pts) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
};
const put = (kind, item, pts) => {
  const [x0, y0, x1, y1] = bboxOf(pts);
  for (let tx = Math.floor(x0 / T); tx <= Math.floor(x1 / T); tx++) for (let ty = Math.floor(y0 / T); ty <= Math.floor(y1 / T); ty++) {
    const k = `${tx}_${ty}`;
    if (!tiles.has(k)) tiles.set(k, { tx, ty, buildings: [], areas: [], walkways: [], crossings: [], skyways: [] });
    tiles.get(k)[kind].push(item);
  }
};
for (const b of buildings) put('buildings', b, b.points);
for (const a of areas) put('areas', a, a.points);
for (const k2 of walkways) put('walkways', k2, k2.points);
for (const c of crossings) put('crossings', c, [[c.x, c.y]]);
for (const s of skyways) put('skyways', s, s.points);
const idx = [...tiles.values()];
const city = {
  meta: {
    name: slug, label, generated: new Date().toISOString(), attribution: '© OpenStreetMap contributors (ODbL)',
    frame: 'metres, x right, y down, origin at the city centre, no rotation', rotationDegrees: 0, origin: { lat: lat0, lon: lon0 },
    radiusMiles, tileSize: T, world: { minX: r1(WORLD.minX), minY: r1(WORLD.minY), maxX: r1(WORLD.maxX), maxY: r1(WORLD.maxY) },
    boundary,
    tiles: { minTx: Math.min(...idx.map((t) => t.tx)), minTy: Math.min(...idx.map((t) => t.ty)), maxTx: Math.max(...idx.map((t) => t.tx)), maxTy: Math.max(...idx.map((t) => t.ty)) },
  },
  roads,
  graph: { nodes: graphNodes.map(({ id, x, y, signal, stop, boundary: bd, degree }) => ({ id, x, y, signal, stop, boundary: bd, degree })), edges },
};
await rm(OUT, { recursive: true, force: true });
await mkdir(`${OUT}/tiles`, { recursive: true });
await writeFile(`${OUT}/city.json`, JSON.stringify(city));
for (const t of idx) await writeFile(`${OUT}/tiles/${t.tx}_${t.ty}.json`, JSON.stringify(t));

// ---------- 4. update the manifest the splash screen's city menu reads ----------
await mkdir('data/cities', { recursive: true });
let manifest = [];
try { manifest = JSON.parse(await readFile('data/cities/manifest.json', 'utf8')); } catch { /* first extra city */ }
manifest = manifest.filter((c) => c.slug !== slug);
manifest.push({ slug, label, lat: lat0, lon: lon0, radiusMiles });
manifest.sort((a, b) => a.label.localeCompare(b.label));
await writeFile('data/cities/manifest.json', JSON.stringify(manifest, null, 2));

// ---------- report ----------
console.log(`${slug}: wrote ${OUT}/city.json, ${idx.length} tiles`);
console.log(`  world ${(WORLD.maxX - WORLD.minX).toFixed(0)} x ${(WORLD.maxY - WORLD.minY).toFixed(0)} m`);
console.log(`  roads ${roads.length}, walkways ${walkways.length}, crossings ${crossings.length}, areas ${areas.length}, buildings ${buildings.length} (height: OSM ${fromHeight}, levels ${fromLevels}, guessed ${fromDefault}), skyways ${skyways.length}`);
const comps = components(graphNodes.length, edges);
console.log(`  graph nodes ${graphNodes.length}, edges ${edges.length}, connected pieces ${comps.length} (sizes ${comps.slice(0, 6).join(', ')}${comps.length > 6 ? ', ...' : ''})`);
