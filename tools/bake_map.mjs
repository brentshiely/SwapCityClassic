// Build-time: turn the raw OpenStreetMap JSON into one compact game file, data/map.json.
// Usage: node tools/bake_map.mjs
//
// Game frame: metres, x to the right, y DOWN (screen-style), origin at the centre of the
// 3x3-block box, rotated so the street grid runs straight. See data/map_config.json.
import { readFile, writeFile } from 'node:fs/promises';
import { r1, rpt, key, makeFrame, classifyRoad, roadRecord, clipSegmentRect, buildGraph, snapSignals, findCrossings, walkwayKind, makeBuilding, isSkywayWay, insidePoly, skywaySpans, areaKind, components } from './lib/bake_common.mjs';

const cfg = JSON.parse(await readFile('data/map_config.json', 'utf8'));
const raw = JSON.parse(await readFile(cfg.raw, 'utf8'));
// Real building heights measured from USGS LiDAR by tools/lidar_heights.py (optional: falls back to OSM tags, then a guess)
let lidar = {}, parts = {};
try { parts = JSON.parse(await readFile('data/parts_lidar.json', 'utf8')).parts ?? {}; } catch { /* no stepped-building blocks: every building is one prism */ }
try { lidar = JSON.parse(await readFile('data/heights_lidar.json', 'utf8')).buildings ?? {}; } catch { console.log('  (no data/heights_lidar.json: using OSM heights and guesses)'); }

// ---------- projection ----------
const { toGame, cx, cy, B } = makeFrame(cfg);

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

const ways = raw.elements.filter((e) => e.type === 'way' && e.geometry);
const nodes = raw.elements.filter((e) => e.type === 'node');

// ---------- roads (drawn) and traffic graph ----------
const roads = [];
const graphWays = [];
for (const w of ways) {
  const t = w.tags ?? {};
  const c = classifyRoad(t);
  if (!c) continue;
  const pts = w.geometry.map(toGame);
  if (!bboxHits(pts, SCENE)) continue;
  roads.push(roadRecord(w.id, t, c, pts));
  if (t.highway !== 'service') graphWays.push({ id: w.id, t, pts, keys: w.geometry.map(key), oneway: c.oneway, lanes: c.lanes, layer: c.layer });
}

// Split each graph way at the world boundary, then at every shared vertex.
const { graphNodes, edges } = buildGraph(graphWays, (a, b) => { const c = clipSegmentRect(a, b, WORLD); return c ? [c] : []; });
snapSignals(graphNodes, nodes, toGame);

// ---------- crossings ----------
const crossingKeys = new Set(nodes.filter((n) => n.tags?.highway === 'crossing').map(key));
const crossings = findCrossings(graphWays, crossingKeys, (p) => !(p[0] < WORLD.minX - 20 || p[0] > WORLD.maxX + 20 || p[1] < WORLD.minY - 20 || p[1] > WORLD.maxY + 20));

// ---------- walkways ----------
const walkways = [];
for (const w of ways) {
  const t = w.tags ?? {};
  const kind = walkwayKind(t);
  if (!kind) continue;
  const pts = w.geometry.map(toGame);
  if (!bboxHits(pts, SCENE)) continue;
  walkways.push({ id: w.id, kind, points: pts.map(rpt) });
}

// ---------- buildings ----------
const buildings = [];
let stepped = 0, fromLidar = 0, fromHeight = 0, fromLevels = 0, fromDefault = 0;
for (const w of ways) {
  const t = w.tags ?? {};
  if (!t.building || w.geometry.length < 4) continue;
  let pts = w.geometry.map(toGame);
  pts.pop(); // closing duplicate
  if (pts.length < 3 || !bboxHits(pts, SCENE)) continue;
  const { b, src } = makeBuilding(w.id, t, pts, lidar, parts);
  if (src === 'lidar') fromLidar++; else if (src === 'height') fromHeight++; else if (src === 'levels') fromLevels++; else fromDefault++;
  if (b.parts) stepped++;
  buildings.push(b);
}

// ---------- skyways ----------
// See skywaySpans: only the stretch over open ground is kept.
const inAnyBuilding = (x, y) => buildings.some((b) => insidePoly(x, y, b.points));
const skyways = [];
for (const w of ways) {
  const t = w.tags ?? {};
  if (!isSkywayWay(t)) continue;
  const pts = w.geometry.map(toGame);
  if (!bboxHits(pts, WORLD)) continue;
  skyways.push(...skywaySpans(w.id, pts, inAnyBuilding));
}

// ---------- ground areas ----------
const areas = [];
for (const w of ways) {
  const t = w.tags ?? {};
  const kind = areaKind(t);
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
const comps = components(graphNodes.length, edges);
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
