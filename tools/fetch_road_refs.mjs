// Build-time only: the route numbers of Minneapolis's main roads. OpenStreetMap often gives a freeway carriageway no `name`, only a
// `ref` ("I 394", "US 52", "MN 55") and, on ramps, `destination:ref` / `destination`; the earlier city download kept only names, so
// freeways showed as "Unnamed street". This fetches just those tags (a small query) into data/raw/city/road_refs.json { wayId: {ref, dref, dest} }
// which tools/lib/bake_common.mjs uses to name roads. The game never calls Overpass.  Run: node tools/fetch_road_refs.mjs
import { writeFile, mkdir } from 'node:fs/promises';

const BBOX = '44.8902,-93.3291,45.0512,-93.1939'; // south, west, north, east: the city limit box (data/raw/lidar/plan.json city_bbox_lonlat)
const SERVERS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const UA = 'SwapCityClassic/1.0 (personal offline game; https://github.com/brentshiely/SwapCityClassic)';
const CLASS = '^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary)$';
const query = `[out:json][timeout:180];(way["highway"~"${CLASS}"]["ref"](${BBOX});way["highway"~"${CLASS}"]["destination:ref"](${BBOX});way["highway"~"${CLASS}"]["destination"](${BBOX}););out tags;`;

let data = null;
for (let attempt = 1; attempt <= 12 && !data; attempt++) {
  const url = SERVERS[attempt % 2];
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA }, body: 'data=' + encodeURIComponent(query), signal: AbortSignal.timeout(200000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (e) { console.log(`attempt ${attempt} (${url}): ${e.message}`); await new Promise((r) => setTimeout(r, 15000 * attempt)); }
}
if (!data) throw new Error('Overpass would not answer');
const out = {};
for (const e of data.elements) {
  const t = e.tags ?? {};
  out[e.id] = { ref: t.ref ?? '', dref: t['destination:ref'] ?? '', dest: t.destination ?? '', name: t.name ?? '' };
}
await mkdir('data/raw/city', { recursive: true });
await writeFile('data/raw/city/road_refs.json', JSON.stringify(out));
console.log(`${Object.keys(out).length} ways with a route number or destination saved to data/raw/city/road_refs.json`);
