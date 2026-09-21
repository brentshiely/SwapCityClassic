// Build-time only: download OpenStreetMap data for the WHOLE city of Minneapolis, MN in ~2 km chunks.
// The game never calls Overpass; tools/bake_city.mjs turns these files into data/city/.
//
//   node tools/fetch_city_osm.mjs              fetch everything (resumable: chunks already saved are skipped)
//   node tools/fetch_city_osm.mjs --list       show the chunk plan and what is missing, fetch nothing
//
// Output (gitignored):  data/raw/city/boundary.json   the city limit relation (with geometry)
//                       data/raw/city/c_{row}_{col}.json   one file per chunk: { chunk, bbox, elements }
// Only the tags the bake reads are kept, so the files stay small.
import { writeFile, readFile, mkdir, rename, access, statfs } from 'node:fs/promises';
import { largestRing } from './lib/city_boundary.mjs';

const OUT = 'data/raw/city';
const SERVERS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const UA = 'SwapCityClassic/1.0 (personal offline game; https://github.com/brentshiely/SwapCityClassic)';
// Twin Cities box the search is limited to (so we never match Minneapolis, Kansas)
const SEARCH = [44.85, -93.4, 45.12, -93.15];
const CHUNK_M = 2000; // chunk size in metres
const MARGIN_M = 120; // chunks within this distance of the city limit are fetched too (roads run 60 m past it)
const PAUSE_MS = 3000;

// Tags the bake looks at; everything else is dropped from the saved file.
const KEEP = new Set(['highway', 'name', 'lanes', 'service', 'tunnel', 'bridge', 'layer', 'oneway', 'junction', 'maxspeed', 'indoor', 'footway',
  'building', 'height', 'building:levels', 'building:material', 'building:colour', 'leisure', 'landuse', 'amenity', 'parking']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (f) => access(f).then(() => true, () => false);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const downUntil = new Map();
async function overpass(query, label, maxAttempts = Infinity) {
  let delay = 15000;
  for (let attempt = 1; ; attempt++) {
    if (attempt > maxAttempts) throw new Error('gave up');
    // overpass-api.de is fast when it answers (it often says 504 when busy): try it a few times before the slower backup
    // (a host that refuses connections is skipped for 10 minutes)
    const now = Date.now();
    const usable = SERVERS.filter((u) => (downUntil.get(u) ?? 0) < now);
    const url = usable.length ? (usable.length === 1 || attempt % 4 !== 0 ? usable[0] : usable[1]) : SERVERS[attempt % 2];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': UA },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(330000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!text.trim().startsWith('{')) throw new Error('not JSON: ' + text.slice(0, 80));
      const json = JSON.parse(text);
      if (json.remark && /error|timed out|out of memory/i.test(json.remark)) throw new Error('remark: ' + json.remark.slice(0, 120));
      return json;
    } catch (err) {
      if (err.message === 'fetch failed') downUntil.set(url, Date.now() + 600000);
      log(`  ${label}: attempt ${attempt} on ${new URL(url).host} failed (${err.message}); waiting ${Math.round(delay / 1000)} s`);
      await sleep(delay);
      delay = Math.min(delay * 1.4, 240000);
    }
  }
}

async function saveJson(file, obj) {
  await writeFile(file + '.tmp', JSON.stringify(obj));
  await rename(file + '.tmp', file);
}

await mkdir(OUT, { recursive: true });
const fs = await statfs(OUT);
log(`free disk: ${((fs.bavail * fs.bsize) / 1e9).toFixed(1)} GB`);

// ---------- 1. the city limit ----------
const bfile = `${OUT}/boundary.json`;
if (!(await exists(bfile))) {
  log('fetching the city boundary ...');
  const q = `[out:json][timeout:120];
relation["boundary"="administrative"]["admin_level"="8"]["name"="Minneapolis"](${SEARCH.join(',')});
out geom;`;
  const j = await overpass(q, 'boundary');
  const rels = j.elements.filter((e) => e.type === 'relation');
  if (!rels.length) throw new Error('no Minneapolis boundary relation found');
  await saveJson(bfile, { elements: rels });
  log(`  saved boundary (${rels.length} relation(s): ${rels.map((r) => r.id).join(', ')})`);
  await sleep(PAUSE_MS);
}
const boundaryRaw = JSON.parse(await readFile(bfile, 'utf8')).elements;

const rings = largestRing(boundaryRaw);
const ring = rings[0];
log(`boundary: ${rings.length} ring(s), largest has ${ring.length} points, closed=${ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]}`);

// ---------- 2. the chunk plan ----------
let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
for (const [la, lo] of ring) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); }
const midLat = (s + n) / 2;
const dLat = CHUNK_M / 110540, dLon = CHUNK_M / (111320 * Math.cos((midLat * Math.PI) / 180));
const rows = Math.ceil((n - s) / dLat), cols = Math.ceil((e - w) / dLon);
const mLat = MARGIN_M / 110540, mLon = MARGIN_M / (111320 * Math.cos((midLat * Math.PI) / 180));
const inPoly = (la, lo) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i], [yj, xj] = ring[j];
    if ((yi > la) !== (yj > la) && lo < ((xj - xi) * (la - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
// A chunk is wanted if the city limit (walked in ~50 m steps) enters its bbox grown by the margin, or the chunk is inside the city.
const wanted = (r, c) => {
  const cs = s + r * dLat, cn = cs + dLat, cw = w + c * dLon, ce = cw + dLon;
  if (inPoly((cs + cn) / 2, (cw + ce) / 2)) return true;
  const hit = (la, lo) => la >= cs - mLat && la <= cn + mLat && lo >= cw - mLon && lo <= ce + mLon;
  for (let i = 0; i < ring.length - 1; i++) {
    const [a0, o0] = ring[i], [a1, o1] = ring[i + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot((a1 - a0) * 110540, (o1 - o0) * 78700) / 50));
    for (let k = 0; k <= steps; k++) if (hit(a0 + ((a1 - a0) * k) / steps, o0 + ((o1 - o0) * k) / steps)) return true;
  }
  return false;
};
const chunks = [];
for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (wanted(r, c)) {
  const cs = s + r * dLat, cw = w + c * dLon;
  chunks.push({ r, c, file: `${OUT}/c_${r}_${c}.json`, bbox: [cs - mLat, cw - mLon, cs + dLat + mLat, cw + dLon + mLon].map((v) => +v.toFixed(6)) });
}
const todo = [];
for (const ch of chunks) if (!(await exists(ch.file))) todo.push(ch);
log(`grid ${rows} rows x ${cols} cols, ${chunks.length} chunks wanted, ${chunks.length - todo.length} already saved, ${todo.length} to fetch`);
if (process.argv.includes('--list')) process.exit(0);

// ---------- 3. fetch ----------
const roadTypes = 'motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|pedestrian';
let done = 0;
for (const ch of todo) {
  const query = (bbox) => `[out:json][timeout:240];
(
  way["highway"~"^(${roadTypes})$"](${bbox});
  way["highway"="footway"]["footway"~"^(sidewalk|crossing)$"](${bbox});
  way["highway"]["name"~"skyway",i]["bridge"~"^(covered|yes)$"](${bbox});
  way["building"](${bbox});
  way["leisure"~"^(park|garden|pitch|playground)$"](${bbox});
  way["landuse"~"^(grass|recreation_ground)$"](${bbox});
  way["amenity"="parking"](${bbox});
  node["highway"~"^(crossing|traffic_signals|stop)$"](${bbox});
);
out geom;`;
  const label = `chunk ${ch.r}_${ch.c}`;
  const t0 = Date.now();
  let j;
  try {
    j = await overpass(query(ch.bbox.join(',')), label, 6);
  } catch {
    // the server cannot manage the whole chunk: fetch it as four quarters and merge (ways on a quarter edge repeat; the bake de-duplicates)
    log(`  ${label}: splitting into four`);
    const [bs, bw, bn, be] = ch.bbox, ms = (bs + bn) / 2, mw = (bw + be) / 2;
    j = { elements: [] };
    let q = 0;
    for (const sub of [[bs, bw, ms, mw], [bs, mw, ms, be], [ms, bw, bn, mw], [ms, mw, bn, be]]) {
      const part = await overpass(query(sub.map((v) => +v.toFixed(6)).join(',')), `${label}.${++q}`);
      j.elements.push(...part.elements);
      j.osm3s = part.osm3s;
      await sleep(PAUSE_MS);
    }
  }
  const seenFree = await statfs(OUT);
  const elements = [];
  for (const el of j.elements) {
    const o = { type: el.type, id: el.id };
    if (el.type === 'node') { o.lat = el.lat; o.lon = el.lon; }
    else if (el.geometry) o.geometry = el.geometry.map((p) => (p ? { lat: p.lat, lon: p.lon } : null)).filter(Boolean);
    else continue;
    if (el.tags) { const t = {}; for (const k of Object.keys(el.tags)) if (KEEP.has(k)) t[k] = el.tags[k]; o.tags = t; }
    elements.push(o);
  }
  await saveJson(ch.file, { chunk: [ch.r, ch.c], bbox: ch.bbox, timestamp: j.osm3s?.timestamp_osm_base, elements });
  done++;
  const cnt = (f) => elements.filter(f).length;
  log(`${label} (${done}/${todo.length}): ${cnt((x) => x.tags?.building)} buildings, ${cnt((x) => x.tags?.highway && x.type === 'way')} highways, ${cnt((x) => x.type === 'node')} nodes, ${((Date.now() - t0) / 1000).toFixed(0)} s, free ${((seenFree.bavail * seenFree.bsize) / 1e9).toFixed(1)} GB`);
  if (seenFree.bavail * seenFree.bsize < 3e9) { log('less than 3 GB free, stopping'); process.exit(2); }
  await sleep(PAUSE_MS);
}
log('all chunks saved');
