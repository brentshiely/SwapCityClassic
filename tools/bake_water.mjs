// Build-time: turn the raw OSM water download (data/raw/city/water/, from tools/fetch_water.mjs) into data/city/water.json:
// water bodies as polygons in the game frame (metres, x right, y DOWN, same `toGame` as the rest of the city data).
//   { meta: { generated, count, areaKm2, source, ... },
//     polygons: [ { id, name, outer: [[x, y], ...], holes: [ [[x, y], ...], ... ] } ] }
// Outer ring: POSITIVE shoelace area (sum of x1*y2 - x2*y1, y down), holes NEGATIVE, no repeated closing point. Draw with canvas
// 'evenodd'; the rings are also the shore walls. Usage: node tools/bake_water.mjs   (npm run bake-water)
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { makeFrame, areaOf, insidePoly } from './lib/bake_common.mjs';

const RAW = 'data/raw/city/water';
const MIN_AREA = 300;      // m2: drop swimming pools and puddles
const BBOX_MARGIN = 150;   // m past the city limit box
const SIMPLIFY = 0.4;      // Douglas-Peucker tolerance, metres
const GAP = 1.0;           // rings whose ends are this close (metres, game frame) are closed
const r2 = (v) => Math.round(v * 100) / 100;

const cfg = JSON.parse(await readFile('data/map_config.json', 'utf8'));
const { toGame } = makeFrame(cfg);
const city = JSON.parse(await readFile('data/city/city.json', 'utf8')).meta;
const box = { minX: city.world.minX - BBOX_MARGIN, minY: city.world.minY - BBOX_MARGIN, maxX: city.world.maxX + BBOX_MARGIN, maxY: city.world.maxY + BBOX_MARGIN };

// ---------- read every chunk, de-duplicate by id ----------
const ways = new Map(), rels = new Map();
const files = (await readdir(RAW)).filter((f) => /^w_\d+_\d+\.json$/.test(f)).sort();
if (!files.length) throw new Error('no chunks in ' + RAW + ' (run npm run fetch-water)');
for (const f of files) {
  for (const el of JSON.parse(await readFile(`${RAW}/${f}`, 'utf8')).elements) {
    if (el.type === 'way') { const o = ways.get(el.id); if (!o || (!o.tags && el.tags)) ways.set(el.id, el); }
    else if (el.type === 'relation') { const o = rels.get(el.id); if (!o || o.members.length < el.members.length) rels.set(el.id, el); }
  }
}
// geometry of every way we know of (tagged ways and relation members), by id, the fullest copy
const geomOf = new Map();
const setGeom = (id, g) => { if (g && (!geomOf.has(id) || geomOf.get(id).length < g.length)) geomOf.set(id, g); };
for (const w of ways.values()) setGeom(w.id, w.geometry);
for (const r of rels.values()) for (const m of r.members) setGeom(m.ref, m.geometry);
console.log(`${files.length} chunks: ${ways.size} ways, ${rels.size} relations`);

const problems = [];
const same = (a, b) => a.lat === b.lat && a.lon === b.lon;
const okPts = (g) => g && g.length > 1 && g.every(Boolean);

// join open ways end to end into rings. segs: [{ id, pts: [{lat,lon}] }] -> { rings: [pts], open: [pts] }
function joinRings(segs) {
  const rings = [], open = [];
  const pool = segs.map((s) => s.pts.slice());
  while (pool.length) {
    let ring = pool.pop();
    const closed = () => ring.length > 3 && same(ring[0], ring.at(-1));
    let grew = true;
    while (grew && !closed()) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const s = pool[i];
        if (same(s[0], ring.at(-1))) ring = ring.concat(s.slice(1));
        else if (same(s.at(-1), ring.at(-1))) ring = ring.concat(s.slice(0, -1).reverse());
        else if (same(s.at(-1), ring[0])) ring = s.concat(ring.slice(1));
        else if (same(s[0], ring[0])) ring = s.slice(1).reverse().concat(ring);
        else continue;
        pool.splice(i, 1); grew = true; break;
      }
    }
    (closed() ? rings : open).push(ring);
  }
  return { rings, open };
}

// ---------- rings in the game frame ----------
function toRing(pts) {
  let p = pts.map((q) => toGame(q));
  if (p.length > 1 && Math.hypot(p[0][0] - p.at(-1)[0], p[0][1] - p.at(-1)[1]) < 1e-6) p.pop();
  // remove consecutive duplicates
  p = p.filter((q, i) => i === 0 || q[0] !== p[i - 1][0] || q[1] !== p[i - 1][1]);
  return p;
}
function dp(pts, tol) { // Douglas-Peucker on an open chain, iterative
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let best = -1, bi = -1;
    const [ax, ay] = pts[a], dx = pts[b][0] - ax, dy = pts[b][1] - ay, L = Math.hypot(dx, dy);
    for (let i = a + 1; i < b; i++) {
      const d = L < 1e-9 ? Math.hypot(pts[i][0] - ax, pts[i][1] - ay) : Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / L;
      if (d > best) { best = d; bi = i; }
    }
    if (best > tol) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function simplifyRing(ring, tol) {
  if (ring.length < 8) return ring;
  // split at the point farthest from point 0 so the closing corner is treated like any other
  let fi = 0, fd = -1;
  for (let i = 1; i < ring.length; i++) { const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]); if (d > fd) { fd = d; fi = i; } }
  const a = dp(ring.slice(0, fi + 1), tol), b = dp(ring.slice(fi).concat([ring[0]]), tol);
  const out = a.concat(b.slice(1, -1));
  return out.length >= 3 ? out : ring;
}
const bboxOf = (r) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of r) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return [x0, y0, x1, y1]; };
const outsideBox = (bb) => bb[2] < box.minX || bb[0] > box.maxX || bb[3] < box.minY || bb[1] > box.maxY;

// ---------- assemble ----------
// bodies: { id, name, outers: [ring], inners: [ring], src }
const bodies = [];
const memberOfRel = new Set();
const isWaterTags = (t) => t && (t.natural === 'water' || t.waterway === 'riverbank' || t.landuse === 'reservoir' || t.landuse === 'basin');
for (const r of rels.values()) {
  const t = r.tags ?? {};
  if (!isWaterTags(t)) continue; // relation matched only through a member's tags? (cannot happen with our query, but stay safe)
  const outerSegs = [], innerSegs = [];
  let missing = 0;
  for (const m of r.members) {
    memberOfRel.add(m.ref);
    const g = geomOf.get(m.ref);
    if (!okPts(g)) { missing++; continue; }
    (m.role === 'inner' ? innerSegs : outerSegs).push({ id: m.ref, pts: g });
  }
  if (missing) problems.push(`relation ${r.id} (${t.name ?? ''}): ${missing} member way(s) without complete geometry`);
  const O = joinRings(outerSegs), I = joinRings(innerSegs);
  for (const o of [...O.open, ...I.open]) {
    // an open chain whose ends are almost touching in the game frame: close it, else report
    const a = toGame(o[0]), b = toGame(o.at(-1));
    if (o.length > 3 && Math.hypot(a[0] - b[0], a[1] - b[1]) < GAP) (O.open.includes(o) ? O.rings : I.rings).push(o.concat([o[0]]));
    else problems.push(`relation ${r.id} (${t.name ?? ''}): open chain of ${o.length} points left unclosed (gap ${Math.hypot(a[0] - b[0], a[1] - b[1]).toFixed(1)} m), dropped`);
  }
  bodies.push({ id: r.id, name: t.name ?? '', outers: O.rings.map(toRing), inners: I.rings.map(toRing), src: 'relation' });
}
// tagged ways that are not members of a wanted relation
const loose = [];
for (const w of ways.values()) {
  if (!isWaterTags(w.tags) || memberOfRel.has(w.id) || !okPts(w.geometry)) continue;
  loose.push({ id: w.id, name: w.tags.name ?? '', pts: w.geometry });
}
const closedLoose = loose.filter((w) => w.pts.length > 3 && same(w.pts[0], w.pts.at(-1)));
for (const w of closedLoose) bodies.push({ id: w.id, name: w.name, outers: [toRing(w.pts)], inners: [], src: 'way' });
const openLoose = loose.filter((w) => !closedLoose.includes(w));
if (openLoose.length) {
  const J = joinRings(openLoose);
  for (const r of J.rings) bodies.push({ id: openLoose[0].id, name: '', outers: [toRing(r)], inners: [], src: 'joined ways' });
  if (J.open.length) problems.push(`${J.open.length} open water way chain(s) could not be closed: ways ${openLoose.map((w) => w.id).join(', ')}`);
}

// ---------- polygons: holes assigned to the outer that contains them ----------
let polys = [];
for (const b of bodies) {
  const outers = b.outers.filter((r) => r.length >= 3).map((r) => (areaOf(r) < 0 ? r.slice().reverse() : r));
  const inners = b.inners.filter((r) => r.length >= 3).map((r) => (areaOf(r) > 0 ? r.slice().reverse() : r));
  const P = outers.map((o) => ({ id: b.id, name: b.name, outer: o, holes: [], src: b.src, area: areaOf(o), bb: bboxOf(o) }));
  for (const h of inners) {
    const p = h[0];
    const cand = P.filter((q) => q.bb[0] <= p[0] && q.bb[2] >= p[0] && q.bb[1] <= p[1] && q.bb[3] >= p[1] && insidePoly(p[0], p[1], q.outer)).sort((a, c) => a.area - c.area)[0];
    if (cand) cand.holes.push(h);
    else problems.push(`${b.src} ${b.id} (${b.name}): an inner ring lies in no outer ring, dropped`);
  }
  polys.push(...P);
}
// closed way that is also the same outline as a relation outer (tagged way + relation not linked by membership): drop the way
const outlineKey = (r) => { const bb = bboxOf(r); return [...bb.map((v) => Math.round(v / 2)), Math.round(Math.abs(areaOf(r)) / 20)].join(','); };
const relKeys = new Set(polys.filter((p) => p.src === 'relation').map((p) => outlineKey(p.outer)));
const before = polys.length;
polys = polys.filter((p) => p.src === 'relation' || !relKeys.has(outlineKey(p.outer)));
const dupDropped = before - polys.length;
// same way listed twice (two ids can not be, but same outline in two ways): keep the first
const seen = new Set();
let dup2 = 0;
polys = polys.filter((p) => { const k = outlineKey(p.outer); if (seen.has(k)) { dup2++; return false; } seen.add(k); return true; });

// ---------- filter, cull, simplify ----------
// Sutherland-Hodgman against the box (rings only ever cross the box edge for the long river polygons that run out of the city)
function clipRing(ring) {
  let pts = ring;
  const edges = [[0, -1, box.minX], [0, 1, box.maxX], [1, -1, box.minY], [1, 1, box.maxY]]; // axis, sign, value: keep sign*(c - value) <= 0
  for (const [ax, sg, val] of edges) {
    const res = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length], b = pts[i];
      const ina = sg * (a[ax] - val) <= 0, inb = sg * (b[ax] - val) <= 0;
      if (ina !== inb) { const t = (val - a[ax]) / (b[ax] - a[ax]); const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; q[ax] = val; res.push(q); }
      if (inb) res.push(b);
    }
    pts = res;
    if (!pts.length) break;
  }
  return pts;
}
const crossesBox = (bb) => bb[0] < box.minX || bb[1] < box.minY || bb[2] > box.maxX || bb[3] > box.maxY;
let tooSmall = 0, culled = 0, clipped = 0;
const out = [];
for (const p of polys) {
  if (!outsideBox(p.bb) && crossesBox(p.bb)) {
    const outer = clipRing(p.outer);
    if (outer.length >= 3) {
      p.holes = p.holes.map((h) => (crossesBox(bboxOf(h)) ? clipRing(h) : h)).filter((h) => h.length >= 3);
      p.outer = outer; p.area = areaOf(outer); p.bb = bboxOf(outer); clipped++;
      problems.push(`polygon ${p.id} (${p.name}) ran past the bbox+${BBOX_MARGIN} m edge: clipped to it`);
    }
  }
  const net = Math.abs(p.area) - p.holes.reduce((s, h) => s + Math.abs(areaOf(h)), 0);
  if (net < MIN_AREA) { tooSmall++; continue; }
  if (outsideBox(p.bb)) { culled++; continue; }
  const outer = simplifyRing(p.outer, SIMPLIFY).map(([x, y]) => [r2(x), r2(y)]);
  const holes = p.holes.map((h) => simplifyRing(h, SIMPLIFY).map(([x, y]) => [r2(x), r2(y)])).filter((h) => h.length >= 3 && Math.abs(areaOf(h)) >= 5);
  if (outer.length < 3) continue;
  out.push({ id: p.id, name: p.name, outer, holes, src: p.src });
}
out.sort((a, b) => Math.abs(areaOf(b.outer)) - Math.abs(areaOf(a.outer)));

// ---------- self-intersection check (segments of every ring, grid accelerated) ----------
function segX(a, b, c, d) { // proper crossing of segments ab and cd
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function crossings(p) {
  const rings = [p.outer, ...p.holes];
  const segs = [];
  rings.forEach((r, ri) => r.forEach((a, i) => segs.push({ ri, i, a, b: r[(i + 1) % r.length], n: r.length })));
  const C = 50, grid = new Map();
  segs.forEach((s, k) => {
    const x0 = Math.floor(Math.min(s.a[0], s.b[0]) / C), x1 = Math.floor(Math.max(s.a[0], s.b[0]) / C);
    const y0 = Math.floor(Math.min(s.a[1], s.b[1]) / C), y1 = Math.floor(Math.max(s.a[1], s.b[1]) / C);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const key = x * 100003 + y; (grid.get(key) ?? grid.set(key, []).get(key)).push(k); }
  });
  const found = new Set(), pts = [];
  for (const list of grid.values()) for (let u = 0; u < list.length; u++) for (let v = u + 1; v < list.length; v++) {
    const s = segs[list[u]], t = segs[list[v]];
    if (s.ri === t.ri) { const dI = Math.abs(s.i - t.i); if (dI <= 1 || dI === s.n - 1) continue; }
    const key = list[u] < list[v] ? `${list[u]},${list[v]}` : `${list[v]},${list[u]}`;
    if (found.has(key)) continue;
    if (segX(s.a, s.b, t.a, t.b)) { found.add(key); pts.push([r2((s.a[0] + s.b[0]) / 2), r2((s.a[1] + s.b[1]) / 2)]); }
  }
  return pts;
}
const bad = [];
for (const p of out) { const c = crossings(p); if (c.length) bad.push({ id: p.id, name: p.name, n: c.length, at: c.slice(0, 3) }); }

// ---------- write ----------
const polygons = out.map(({ id, name, outer, holes }) => ({ id, name, outer, holes }));
const total = polygons.reduce((s, p) => s + areaOf(p.outer) + p.holes.reduce((q, h) => q + areaOf(h), 0), 0); // holes are negative
const meta = { generated: new Date().toISOString(), count: polygons.length, areaKm2: +(total / 1e6).toFixed(3), source: '(c) OpenStreetMap contributors (ODbL)',
  frame: 'game metres, x right, y down; outer rings positive shoelace area, holes negative, no repeated closing point', minAreaM2: MIN_AREA, simplifyM: SIMPLIFY };
await writeFile('data/city/water.json', JSON.stringify({ meta, polygons }));

console.log(`${polygons.length} polygons, ${meta.areaKm2} km2 (dropped: ${tooSmall} under ${MIN_AREA} m2, ${culled} outside the box, ${clipped} clipped to it, ${dupDropped + dup2} duplicates)`);
for (const p of polygons.slice(0, 40)) console.log(`  ${String(p.id).padStart(10)}  ${(areaOf(p.outer) / 1e6 + p.holes.reduce((s, h) => s + areaOf(h) / 1e6, 0)).toFixed(3).padStart(7)} km2  ${p.outer.length} pts  ${p.holes.length} holes  ${p.name}`);
console.log(`self-intersecting polygons: ${bad.length}`);
for (const b of bad) console.log(`  ${b.id} (${b.name}): ${b.n} crossing(s), e.g. ${JSON.stringify(b.at)}`);
for (const pr of problems) console.log('problem: ' + pr);
