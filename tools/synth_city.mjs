// A large SYNTHETIC road network in the same schema as data/map.json's `roads` and `graph` (see design/CITY_DATA.md), for
// tests and benchmarks of the traffic and navigation at city scale. Not used by the game.
// A rotated grid of streets (nx x ny blocks) with bends and shape points, some one-way streets, wider arterials, about 10%
// signalized junctions, boundary nodes where the streets leave the grid, and street names.
// Defaults (100 x 100 blocks of 110 m) give ~30,000 graph nodes and ~40,000 graph edges over an 11 km square, like Minneapolis.
// Run `node tools/synth_city.mjs` to print the size and how long it takes to make.
import { pathToFileURL } from 'node:url';
import { mulberry32 } from '../src/render/rng.js';

const r1 = (v) => Math.round(v * 10) / 10;

export function synthCity({ nx = 100, ny = 100, block = 110, rotation = 30, seed = 1, jitter = 6, wayBlocks = 2, oneWayEvery = 6, arterialEvery = 10 } = {}) {
  const rand = mulberry32(seed);
  const rot = (rotation * Math.PI) / 180, cs = Math.cos(rot), sn = Math.sin(rot);
  const put = (x, y) => [r1(x * cs - y * sn), r1(x * sn + y * cs)]; // the game turns its maps by rotationDegrees; so does this one

  // intersections on a jittered grid; grid[i][j] is a node id, i along x (columns), j along y (rows)
  const nodes = [], edges = [], roads = [];
  const addNode = (x, y, boundary = false) => { const [px, py] = put(x, y); nodes.push({ id: nodes.length, x: px, y: py, signal: false, stop: false, boundary, degree: 0 }); return nodes.length - 1; };
  const grid = [];
  const gx = (i) => (i - nx / 2) * block, gy = (j) => (j - ny / 2) * block;
  for (let i = 0; i <= nx; i++) { grid.push([]); for (let j = 0; j <= ny; j++) grid[i].push(addNode(gx(i) + (rand() - 0.5) * 2 * jitter, gy(j) + (rand() - 0.5) * 2 * jitter)); }

  // one street line: a row (j fixed) or a column (i fixed), from the boundary before its first intersection to the boundary after its last
  const arterial = (k) => k % arterialEvery === 0;
  const oneWayDir = (k) => (k % oneWayEvery === 3 && !arterial(k) ? (Math.floor(k / oneWayEvery) % 2 ? -1 : 1) : 0);
  const line = (k, isRow) => {
    const n = isRow ? nx : ny;
    const at = (t) => (isRow ? [gx(t), gy(k)] : [gx(k), gy(t)]);
    const stub = (t) => { const [x, y] = at(t); return addNode(x, y, true); };
    // line points in travel order along +t: stub, intersections, stub (bends in each block come from a jittered midpoint)
    const seq = [{ id: stub(-0.55), t: -0.55 }];
    for (let t = 0; t <= n; t++) seq.push({ id: isRow ? grid[t][k] : grid[k][t], t });
    seq.push({ id: stub(n + 0.55), t: n + 0.55 });
    const dir = oneWayDir(k), art = arterial(k);
    const name = isRow ? `${k + 1}th Street` : `${k + 1}th Avenue`;
    const lanes = art ? 4 : 2, mph = art ? 30 : 25, highway = art ? 'secondary' : dir ? 'tertiary' : 'residential';
    // every block segment is cut in two with a bent middle node, like OSM data cut at every shape join
    const pts = [];
    const nodeIds = [];
    for (let s = 0; s < seq.length - 1; s++) {
      const a = seq[s], b = seq[s + 1];
      if (s === 0 || s === seq.length - 2) { nodeIds.push(a.id); pts.push([nodes[a.id].x, nodes[a.id].y]); continue; }
      const pa = nodes[a.id], pb = nodes[b.id];
      const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2, l = Math.hypot(pb.x - pa.x, pb.y - pa.y) || 1;
      const bend = (rand() - 0.5) * 6, mid = nodes.length;
      nodes.push({ id: mid, x: r1(mx - ((pb.y - pa.y) / l) * bend), y: r1(my + ((pb.x - pa.x) / l) * bend), signal: false, stop: false, boundary: false, degree: 0 });
      nodeIds.push(a.id, mid); pts.push([pa.x, pa.y], [nodes[mid].x, nodes[mid].y]);
    }
    nodeIds.push(seq[seq.length - 1].id); pts.push([nodes[seq[seq.length - 1].id].x, nodes[seq[seq.length - 1].id].y]);
    // ways of `wayBlocks` blocks: each becomes one road (wide polyline) and its pieces become graph edges
    const perBlock = 2; // segments per block (two pieces)
    const wayId = 1e6 + (isRow ? 0 : 5e5) + k * 100;
    const total = nodeIds.length - 1; // segments between consecutive node ids
    let w = 0;
    for (let a = 0; a < total; w++) {
      // the first way carries the leading stub too, so the boundary stays attached
      const step = wayBlocks * perBlock + (a === 0 ? 1 : 0);
      const b = Math.min(total, a + step);
      const idx = []; for (let q = a; q <= b; q++) idx.push(q);
      const rd = { id: wayId + w, name, highway, width: Math.max(6.6, lanes * 3.3), lanes, oneway: !!dir, layer: 0, tunnel: false, bridge: false, points: idx.map((q) => pts[q]) };
      roads.push(rd);
      for (let q = a; q < b; q++) {
        const fwd = dir >= 0, from = fwd ? nodeIds[q] : nodeIds[q + 1], to = fwd ? nodeIds[q + 1] : nodeIds[q];
        const p = [pts[q], pts[q + 1]]; if (!fwd) p.reverse();
        let len = 0; for (let m = 1; m < p.length; m++) len += Math.hypot(p[m][0] - p[m - 1][0], p[m][1] - p[m - 1][1]);
        edges.push({ id: edges.length, wayId: rd.id, from, to, oneway: !!dir, length: r1(len), highway, lanes, layer: 0, name, mph, points: p });
      }
      a = b;
    }
    if (dir < 0) for (const rd of roads.slice(-w)) rd.points.reverse();
  };
  for (let k = 0; k <= ny; k++) line(k, true);
  for (let k = 0; k <= nx; k++) line(k, false);

  for (const e of edges) { nodes[e.from].degree++; nodes[e.to].degree++; }
  // signals at roughly 10% of the junctions: mostly where an arterial crosses something
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= ny; j++) {
    const n = nodes[grid[i][j]];
    if (n.degree >= 3 && rand() < (arterial(i) || arterial(j) ? 0.35 : 0.03)) n.signal = true;
  }

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) { x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x); y0 = Math.min(y0, n.y); y1 = Math.max(y1, n.y); }
  const meta = { name: 'synthetic-city', rotationDegrees: rotation, tileSize: 256, world: { minX: x0, minY: y0, maxX: x1, maxY: y1 } };
  // `synth` is extra (not part of the schema): the intersection ids, for tests that want to drive a route
  return { meta, roads, graph: { nodes, edges }, synth: { nx, ny, block, grid } };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const t0 = performance.now();
  const c = synthCity();
  const g = c.graph;
  console.log(`synthetic city: ${g.nodes.length} nodes, ${g.edges.length} edges, ${c.roads.length} roads, ${g.nodes.filter((n) => n.signal).length} signalized, ` +
    `${g.nodes.filter((n) => n.boundary).length} boundary, ${g.edges.filter((e) => e.oneway).length} one-way edges, made in ${(performance.now() - t0).toFixed(0)} ms`);
}
