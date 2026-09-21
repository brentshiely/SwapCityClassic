// Build-time only: download the WATER of Minneapolis (rivers, lakes, ponds) from OpenStreetMap in a few big chunks.
// tools/bake_water.mjs turns these files into data/city/water.json. The game never calls Overpass.
//
//   node tools/fetch_water.mjs           fetch everything (resumable: chunks already saved are skipped)
//   node tools/fetch_water.mjs --list    show the chunk plan and what is missing, fetch nothing
//
// Wanted: ways and multipolygon/boundary relations with natural=water, waterway=riverbank, landuse=reservoir|basin.
// NOT wanted: natural=wetland. Nothing else is fetched.
// Output (gitignored, under data/raw/city/): water/w_{row}_{col}.json = { chunk, bbox, timestamp, elements }, `out geom`, tags trimmed.
import { writeFile, readFile, mkdir, rename, access } from 'node:fs/promises';
import { largestRing } from './lib/city_boundary.mjs';

const OUT = 'data/raw/city/water';
const SERVERS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const UA = 'SwapCityClassic/1.0 (personal offline game; https://github.com/brentshiely/SwapCityClassic)';
const MARGIN_M = 200;  // the fetch box is the city limit box grown by this
const ROWS = 3, COLS = 3;
const PAUSE_MS = 3000;
const KEEP = new Set(['name', 'natural', 'water', 'waterway', 'landuse', 'type', 'intermittent', 'leisure', 'boundary', 'salt', 'tunnel', 'wikidata']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (f) => access(f).then(() => true, () => false);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const downUntil = new Map();
async function overpass(query, label) {
  let delay = 15000;
  for (let attempt = 1; ; attempt++) {
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

// the city limit (already downloaded by fetch_city_osm.mjs) gives the box
const boundaryRaw = JSON.parse(await readFile('data/raw/city/boundary.json', 'utf8')).elements;
const ring = largestRing(boundaryRaw)[0];
let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
for (const [la, lo] of ring) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); }
const midLat = (s + n) / 2;
const mLat = MARGIN_M / 110540, mLon = MARGIN_M / (111320 * Math.cos((midLat * Math.PI) / 180));
s -= mLat; n += mLat; w -= mLon; e += mLon;
const dLat = (n - s) / ROWS, dLon = (e - w) / COLS;
const chunks = [];
for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
  chunks.push({ r, c, file: `${OUT}/w_${r}_${c}.json`, bbox: [s + r * dLat, w + c * dLon, s + (r + 1) * dLat, w + (c + 1) * dLon].map((v) => +v.toFixed(6)) });
}
const todo = [];
for (const ch of chunks) if (!(await exists(ch.file))) todo.push(ch);
log(`fetch box ${[s, w, n, e].map((v) => v.toFixed(4)).join(', ')}: ${chunks.length} chunks, ${chunks.length - todo.length} already saved, ${todo.length} to fetch`);
if (process.argv.includes('--list')) process.exit(0);

const query = (bbox) => `[out:json][timeout:240];
(
  way["natural"="water"](${bbox});
  relation["natural"="water"](${bbox});
  way["waterway"="riverbank"](${bbox});
  relation["waterway"="riverbank"](${bbox});
  way["landuse"~"^(reservoir|basin)$"](${bbox});
  relation["landuse"~"^(reservoir|basin)$"](${bbox});
);
out geom;`;

let done = 0;
for (const ch of todo) {
  const label = `chunk ${ch.r}_${ch.c}`;
  const t0 = Date.now();
  const j = await overpass(query(ch.bbox.join(',')), label);
  const elements = [];
  for (const el of j.elements) {
    const o = { type: el.type, id: el.id };
    if (el.tags) { const t = {}; for (const k of Object.keys(el.tags)) if (KEEP.has(k)) t[k] = el.tags[k]; o.tags = t; }
    if (el.type === 'way') {
      if (!el.geometry) continue;
      o.geometry = el.geometry.map((p) => (p ? { lat: p.lat, lon: p.lon } : null));
    } else if (el.type === 'relation') {
      o.members = (el.members ?? []).filter((m) => m.type === 'way').map((m) => ({
        type: 'way', ref: m.ref, role: m.role, geometry: m.geometry ? m.geometry.map((p) => (p ? { lat: p.lat, lon: p.lon } : null)) : null,
      }));
    } else continue;
    elements.push(o);
  }
  await saveJson(ch.file, { chunk: [ch.r, ch.c], bbox: ch.bbox, timestamp: j.osm3s?.timestamp_osm_base, elements });
  done++;
  log(`${label} (${done}/${todo.length}): ${elements.filter((x) => x.type === 'way').length} ways, ${elements.filter((x) => x.type === 'relation').length} relations, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  await sleep(PAUSE_MS);
}
log('all chunks saved');
