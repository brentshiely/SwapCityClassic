// Check data/city/water.json against data/city/city.json: which roads run through water, and are they bridges/tunnels?
//   node tools/check_water.mjs      prints the report, writes /tmp/sc/water_report.json (used by tools/plot_water.py)
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { insidePoly } from './lib/bake_common.mjs';

const W = JSON.parse(await readFile('data/city/water.json', 'utf8')).polygons;
const city = JSON.parse(await readFile('data/city/city.json', 'utf8'));
const inWater = (x, y) => {
  for (const p of W) {
    if (x < p.bb[0] || x > p.bb[2] || y < p.bb[1] || y > p.bb[3]) continue;
    let n = insidePoly(x, y, p.outer) ? 1 : 0;
    if (n) for (const h of p.holes) if (insidePoly(x, y, h)) n = 0;
    if (n) return p;
  }
  return null;
};
for (const p of W) { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of p.outer) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } p.bb = [x0, y0, x1, y1]; }

// edge grid
const C = 64, grid = new Map();
const rings = [];
for (const p of W) { rings.push([p, p.outer]); for (const h of p.holes) rings.push([p, h]); }
for (const [p, r] of rings) for (let i = 0; i < r.length; i++) {
  const a = r[i], b = r[(i + 1) % r.length];
  const seen = new Set();
  const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 16));
  for (let k = 0; k <= n; k++) { const x = a[0] + ((b[0] - a[0]) * k) / n, y = a[1] + ((b[1] - a[1]) * k) / n; const key = Math.floor(x / C) * 100003 + Math.floor(y / C); if (!seen.has(key)) { seen.add(key); (grid.get(key) ?? grid.set(key, []).get(key)).push([a, b, p]); } }
}
const cross = (a, b, c, d) => {
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
};
const hits = [];
for (const rd of city.roads) {
  const pts = rd.points;
  let touch = false;
  outer: for (let i = 0; i < pts.length - 1 && !touch; i++) {
    const a = pts[i], b = pts[i + 1];
    for (let cx = Math.floor(Math.min(a[0], b[0]) / C); cx <= Math.floor(Math.max(a[0], b[0]) / C); cx++)
      for (let cy = Math.floor(Math.min(a[1], b[1]) / C); cy <= Math.floor(Math.max(a[1], b[1]) / C); cy++)
        for (const [c, d] of grid.get(cx * 100003 + cy) ?? []) if (cross(a, b, c, d)) { touch = true; break outer; }
  }
  if (!touch && !inWater(pts[0][0], pts[0][1])) continue;
  // metres inside water, 1 m samples
  let inside = 0, total = 0; let water = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(L));
    for (let k = 0; k < n; k++) { const t = (k + 0.5) / n; const p = inWater(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t); total += L / n; if (p) { inside += L / n; water = p; } }
  }
  if (inside < 1) continue; // grazes the shore
  hits.push({ id: rd.id, name: rd.name, highway: rd.highway, layer: rd.layer, bridge: rd.bridge, tunnel: rd.tunnel, insideM: +inside.toFixed(1), lengthM: +total.toFixed(1), water: water?.name || water?.id, at: rd.points[Math.floor(rd.points.length / 2)] });
}
const ok = hits.filter((h) => h.bridge || h.tunnel || h.layer !== 0);
const bad = hits.filter((h) => !(h.bridge || h.tunnel || h.layer !== 0));
console.log(`${hits.length} road pieces cross or lie in water (>= 1 m): ${ok.length} bridges/tunnels (layer != 0, bridge or tunnel), ${bad.length} plain roads`);
console.log('plain roads in water:');
for (const h of bad.sort((a, b) => b.insideM - a.insideM)) console.log(`  ${String(h.id).padStart(10)} ${h.name.padEnd(28)} ${h.highway.padEnd(12)} ${h.insideM} m of ${h.lengthM} m in ${h.water}  at ${h.at}`);
console.log('bridges/tunnels (' + ok.length + '):');
for (const h of ok) console.log(`  ${String(h.id).padStart(10)} ${h.name.padEnd(28)} ${h.highway.padEnd(12)} layer ${h.layer}${h.bridge ? ' bridge' : ''}${h.tunnel ? ' tunnel' : ''} ${h.insideM} m in ${h.water}`);
await mkdir('/tmp/sc', { recursive: true });
await writeFile('/tmp/sc/water_report.json', JSON.stringify({ ok, bad }));
