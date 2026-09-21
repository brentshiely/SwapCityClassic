// Turn the downtown data/map.json into the whole-city format (design/CITY_DATA.md), as a stand-in dataset for developing the tile
// engine before the real city bake exists:  node tools/map_to_city.mjs  ->  data/city_dt/  (city.json + tiles/). The "city limit" is the
// downtown world rectangle.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';

const T = 256;
const map = JSON.parse(await readFile('data/map.json', 'utf8'));
const w = map.meta.world;
const boundary = [[w.minX, w.minY], [w.maxX, w.minY], [w.maxX, w.maxY], [w.minX, w.maxY]]; // positive area (y down, like buildings)
const tiles = new Map();
const bboxOf = (pts) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } return [x0, y0, x1, y1]; };
const put = (kind, item, pts) => {
  const [x0, y0, x1, y1] = bboxOf(pts);
  for (let tx = Math.floor(x0 / T); tx <= Math.floor(x1 / T); tx++) for (let ty = Math.floor(y0 / T); ty <= Math.floor(y1 / T); ty++) {
    const k = `${tx}_${ty}`;
    if (!tiles.has(k)) tiles.set(k, { tx, ty, buildings: [], areas: [], walkways: [], crossings: [], skyways: [] });
    tiles.get(k)[kind].push(item);
  }
};
for (const b of map.buildings) put('buildings', b, b.points);
for (const a of map.areas) put('areas', a, a.points);
for (const k of map.walkways) put('walkways', k, k.points);
for (const c of map.crossings) put('crossings', c, [[c.x, c.y]]);
for (const s of map.skyways ?? []) put('skyways', s, s.points);
const idx = [...tiles.values()];
const city = {
  meta: {
    ...map.meta, tileSize: T, boundary, world: { ...w },
    tiles: { minTx: Math.min(...idx.map((t) => t.tx)), minTy: Math.min(...idx.map((t) => t.ty)), maxTx: Math.max(...idx.map((t) => t.tx)), maxTy: Math.max(...idx.map((t) => t.ty)) },
  },
  roads: map.roads, graph: map.graph,
};
await rm('data/city_dt', { recursive: true, force: true });
await mkdir('data/city_dt/tiles', { recursive: true });
await writeFile('data/city_dt/city.json', JSON.stringify(city));
for (const t of idx) await writeFile(`data/city_dt/tiles/${t.tx}_${t.ty}.json`, JSON.stringify(t));
console.log(`data/city_dt: ${idx.length} tiles, ${map.buildings.length} buildings`);
