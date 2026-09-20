// Build-time only: download OpenStreetMap data for a bounding box and save it as raw JSON.
// The game never calls Overpass; it loads the baked file instead.
// Usage: node tools/fetch_osm.mjs <name> <south> <west> <north> <east>
import { writeFile, mkdir } from 'node:fs/promises';

const [name, s, w, n, e] = process.argv.slice(2);
if (!name || [s, w, n, e].some((v) => v === undefined)) {
  console.error('usage: node tools/fetch_osm.mjs <name> <south> <west> <north> <east>');
  process.exit(1);
}

const SERVERS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];
const bbox = `${s},${w},${n},${e}`;
const query = `[out:json][timeout:90];
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
    console.log(`Fetching from ${url} ...`);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': 'SwapCityClassic/0.1 (personal offline game; https://github.com/brentshiely/SwapCityClassic)',
      },
      body: 'data=' + encodeURIComponent(query),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    await mkdir('data/raw', { recursive: true });
    const file = `data/raw/${name}.json`;
    await writeFile(file, JSON.stringify(json));
    const count = (t) => json.elements.filter((x) => x.type === t).length;
    console.log(`Saved ${file}: ${count('way')} ways, ${count('node')} nodes`);
    process.exit(0);
  } catch (err) {
    lastErr = err;
    console.warn(`  failed: ${err.message}`);
  }
}
console.error('All servers failed:', lastErr?.message);
process.exit(1);
