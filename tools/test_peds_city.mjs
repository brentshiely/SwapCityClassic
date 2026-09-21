// Whole-city pedestrian checks: the incremental network and the local PedSim on a synthetic 60 x 60 block grid (6 km square),
// with buildings that come and go by 256 m tile. Run: node tools/test_peds_city.mjs
import { PedNetwork, buildPedNetwork } from '../src/peds/pedNetwork.js';
import { PedSim } from '../src/peds/pedSim.js';
import { buildNetwork } from '../src/traffic/network.js';
import { Signals } from '../src/traffic/signals.js';
import { mulberry32 } from '../src/render/rng.js';
import { pointAt } from '../src/world/geometry.js';

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };
const T = 256, B = 100; // tile size, block size

// ---------- a synthetic city ----------
// N x N blocks. Streets are 2 lanes, every 10th an avenue of 4. Outer junctions are boundary nodes (degree 1, people walk off there).
// One 600 m street (no junctions along it). Each street has a building strip on both sides, its wall at a random distance from
// the centre line, so the sidewalks have to shift in towards the kerb for some, and a few strips leave no room at all.
function makeCity(N, seed = 4, { longEdge = true } = {}) {
  const rnd = mulberry32(seed), gx = (i) => (i - N / 2) * B;
  const key = (i, j) => j * (N + 1) + i;
  const cut = new Set(), edges = [];
  const jL = Math.round(N * 0.75);
  const addEdge = (i0, j0, i1, j1, lanes, name) => {
    const x0 = gx(i0), y0 = gx(j0), x1 = gx(i1), y1 = gx(j1);
    edges.push({ id: edges.length, wayId: edges.length, from: key(i0, j0), to: key(i1, j1), oneway: edges.length % 5 === 0, length: Math.hypot(x1 - x0, y1 - y0),
      highway: 'residential', lanes, layer: 0, name: name, mph: 25, points: [[x0, y0], [(x0 + x1) / 2, (y0 + y1) / 2], [x1, y1]] });
  };
  for (let j = 1; j < N; j++) for (let i = 0; i < N; i++) {
    if (longEdge && N >= 40 && j === jL && i >= 20 && i < 26) { if (i === 20) addEdge(20, j, 26, j, 2, `Long ${j}`); continue; }
    addEdge(i, j, i + 1, j, j % 10 === 0 ? 4 : 2, `H${j}`);
  }
  for (let i = 1; i < N; i++) for (let j = 0; j < N; j++) {
    if (longEdge && N >= 40 && i >= 21 && i <= 25 && (j === jL - 1 || j === jL)) continue;
    addEdge(i, j, i, j + 1, i % 10 === 0 ? 4 : 2, `V${i}`);
  }
  const deg = new Map();
  for (const e of edges) for (const k of [e.from, e.to]) deg.set(k, (deg.get(k) ?? 0) + 1);
  const nodes = [...deg.keys()].sort((a, b) => a - b).map((k) => {
    const i = k % (N + 1), j = Math.floor(k / (N + 1));
    return { id: k, x: gx(i), y: gx(j), signal: i > 0 && i < N && j > 0 && j < N && (i * 7 + j * 13) % 6 === 0, stop: false, boundary: i === 0 || i === N || j === 0 || j === N, degree: deg.get(k) };
  });
  // buildings: per street, per 100 m, both sides
  const rects = [];
  for (const e of edges) {
    const horiz = e.points[0][1] === e.points[2][1], half = Math.max(6.6, e.lanes * 3.3) / 2;
    const [ax, ay] = e.points[0], len = e.length;
    for (let c = 0; c * B + 78 <= len; c++) for (const side of [1, -1]) {
      const w = rnd() < 0.01 ? half + 0.8 : half + 1.5 + rnd() * 2.0, s0 = c * B + 22, s1 = c * B + 78;
      const a = side * w, b = side * (w + 15);
      rects.push(horiz ? [ax + s0, ay + Math.min(a, b), ax + s1, ay + Math.max(a, b)] : [ax + Math.min(a, b), ay + s0, ax + Math.max(a, b), ay + s1]);
    }
  }
  const tiles = new Map();
  for (const r of rects) for (let tx = Math.floor(r[0] / T); tx <= Math.floor(r[2] / T); tx++) for (let ty = Math.floor(r[1] / T); ty <= Math.floor(r[3] / T); ty++) {
    const k = `${tx},${ty}`; if (!tiles.has(k)) tiles.set(k, []); tiles.get(k).push(r);
  }
  const map = { graph: { nodes, edges } };
  const hit = (x, y, list) => { for (const r of list ?? []) if (x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]) return true; return false; };
  return {
    map, N, rects, tiles,
    blockedAll: (x, y) => hit(x, y, tiles.get(`${Math.floor(x / T)},${Math.floor(y / T)}`)),
    /** buildings only where the tile is in `loaded` (a Set of 'tx,ty'); elsewhere there is simply no data, so nothing blocks */
    blockedIn: (loaded) => (x, y) => { const k = `${Math.floor(x / T)},${Math.floor(y / T)}`; return loaded.has(k) && hit(x, y, tiles.get(k)); },
    isLoadedIn: (loaded) => (x, y) => loaded.has(`${Math.floor(x / T)},${Math.floor(y / T)}`),
  };
}
const allTiles = (city, ext = 60) => { const s = new Set(); for (let tx = -ext; tx <= ext; tx++) for (let ty = -ext; ty <= ext; ty++) s.add(`${tx},${ty}`); return s; };

const r3 = (v) => Math.round(v * 1000);
const ekey = (e) => `${e.type}|${r3(e.a.x)},${r3(e.a.y)}|${r3(e.b.x)},${r3(e.b.y)}|${e.info.pts.length}|${r3(e.len)}|${e.blocked ? 1 : 0}`;
const multiset = (edges) => { const m = new Map(); for (const e of edges) { const k = ekey(e); m.set(k, (m.get(k) ?? 0) + 1); } return m; };
const sameSet = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
/** the pieces the one-shot network holds for the built graph nodes only */
const expectedFor = (full, net) => {
  const ids = new Set([...net.builtSet].map((i) => net.gn[i].id)), ge = full.ge;
  return full.edges.filter((e) => e.type === 'corner' ? ids.has(e.at) : e.type === 'cross' ? ids.has(e.nodeId) : ids.has(ge[e.gedge].from) || ids.has(ge[e.gedge].to));
};
const noDuplicateNodes = (net) => new Set(net.nodes.map((n) => `${r3(n.x)},${r3(n.y)}`)).size === net.nodes.length && new Set(net.nodes.map((n) => n.id)).size === net.nodes.length;
const frontiersRight = (net) => net.edges.every((e) => e.type !== 'walk' || (e.a.frontier === !net.built[net.fromI[e.gedge]] && e.b.frontier === !net.built[net.toI[e.gedge]]));
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;

console.log('building the synthetic 60 x 60 block city ...');
const city = makeCity(60);
const { nodes: gn, edges: ge } = city.map.graph;
console.log(`      ${gn.length} junctions, ${ge.length} streets, ${city.rects.length} buildings, ${city.tiles.size} tiles`);
const t0 = process.hrtime.bigint();
const signals = new Signals(buildNetwork(city.map));
console.log(`      ${signals.byNode.size} signalized junctions (${ms(t0).toFixed(0)} ms to set up)`);
const ALL = allTiles(city), everything = { blocked: city.blockedAll, isLoaded: city.isLoadedIn(ALL) };

// ---- 1. the one-shot build (the old code path) still holds together
const tFull = process.hrtime.bigint();
const full = buildPedNetwork(city.map, signals, city.blockedAll);
const fullMs = ms(tFull);
check('the one-shot build (no radius) gives the whole city network', full.nodes.length === 4 * ge.length && full.edges.every((e) => e.type !== 'walk' || e.gedge >= 0), `${full.nodes.length} nodes, ${full.edges.length} edges in ${fullMs.toFixed(0)} ms`);
check('one-shot: no duplicate nodes, nothing left at the frontier', noDuplicateNodes(full) && full.nodes.every((n) => !n.frontier), '');
const cutCount = full.edges.filter((e) => e.type === 'walk' && e.blocked).length;
console.log(`      ${cutCount} sidewalks blocked outright, ${full.edges.filter((e) => e.type === 'cross').length} crosswalks`);

// ---- 2. incremental build of a region equals the one-shot pieces for that region
{
  const net = new PedNetwork(city.map, signals, everything);
  const t = process.hrtime.bigint();
  const n1 = net.ensureNear(0, 0, 600);
  const dt = ms(t);
  check('a region built incrementally holds exactly the one-shot pieces for its junctions', n1 > 100 && sameSet(multiset(net.edges), multiset(expectedFor(full, net))), `${n1} junctions, ${net.edges.length} edges, ${dt.toFixed(0)} ms`);
  check('every junction within the radius was built (and none is further than the radius)', gn.every((n, i) => (Math.hypot(n.x, n.y) <= 600) === !!net.built[i]), '');
  check('no duplicate nodes; frontier flags match which junctions exist', noDuplicateNodes(net) && frontiersRight(net), `${net.nodes.length} nodes`);
  const v = net.version, ne = net.edges.length, nn = net.nodes.length;
  const again = net.ensureNear(0, 0, 600) + net.ensureNear(30, -20, 550) + net.ensureNear(-100, 100, 400);
  check('asking for the same area again builds nothing and duplicates nothing', again === 0 && net.version === v && net.edges.length === ne && net.nodes.length === nn, `${again} built`);
  // walk outwards in steps: the union is again the one-shot pieces of the built junctions
  for (let x = 0; x <= 2400; x += 200) net.ensureNear(x, x / 4, 500);
  check('many overlapping requests still give exactly the one-shot pieces, once each', sameSet(multiset(net.edges), multiset(expectedFor(full, net))) && noDuplicateNodes(net) && frontiersRight(net), `${net.builtSet.size} junctions, ${net.edges.length} edges`);
  // a request that reaches the whole city completes it
  net.ensureNear(0, 0, 9000);
  check('building the whole city incrementally equals the one-shot network', net.builtSet.size === gn.length && sameSet(multiset(net.edges), multiset(full.edges)) && net.nodes.length === full.nodes.length && net.nodes.every((n) => !n.frontier), `${net.edges.length} edges`);
}

// ---- 3. the cost of one call is bounded by the budget
{
  const net = new PedNetwork(city.map, signals, everything);
  let worst = 0, total = 0, calls = 0, over = 0;
  for (let k = 0; k < 400; k++) {
    const t = process.hrtime.bigint(), n = net.ensureNear(-300 + k * 1.5, 800, 350, 5), d = ms(t);
    if (n > 5) over++;
    worst = Math.max(worst, d); total += d; calls++;
  }
  const builtHere = net.builtSet.size;
  const t = process.hrtime.bigint(); for (let k = 0; k < 1000; k++) net.ensureNear(300, 800, 350, 5); const idle = ms(t) / 1000;
  check('a call never builds more than its budget of junctions', over === 0, `${builtHere} junctions over 400 calls`);
  check('a call is cheap (worst under 60 ms, and a call with nothing new to build under 0.05 ms)', worst < 60 && idle < 0.05, `worst ${worst.toFixed(1)} ms, mean ${(total / calls).toFixed(2)} ms, idle ${(idle * 1000).toFixed(1)} us`);
}

// ---- 4. buildings streaming in by tile: nothing is built on partial data
{
  const rnd = mulberry32(11), loaded = new Set(), R = 6;
  const net = new PedNetwork(city.map, signals, { blocked: city.blockedIn(loaded), isLoaded: city.isLoadedIn(loaded) });
  const order = [];
  for (let tx = -R; tx < R; tx++) for (let ty = -R; ty < R; ty++) order.push(`${tx},${ty}`);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  let builtBefore = net.ensureNear(0, 0, 1000);
  check('with no tiles loaded nothing is built', builtBefore === 0 && net.edges.length === 0, '');
  let premature = 0, sawWaiting = false;
  const loadedAround = (x, y, m) => [[-m, -m], [m, -m], [-m, m], [m, m], [0, 0]].every(([dx, dy]) => loaded.has(`${Math.floor((x + dx) / T)},${Math.floor((y + dy) / T)}`));
  for (const k of order) {
    loaded.add(k); net.tilesChanged();
    net.ensureNear(0, 0, 1000);
    if (net.builtSet.size < gn.filter((n) => Math.hypot(n.x, n.y) <= 1000).length) sawWaiting = true;
    for (const i of net.builtSet) for (const l of net.incident[i]) {
      const info = net.einfo(l >> 1), q = {};
      for (let d = 0; d <= info.len; d += 5) { pointAt(info, d, q); if (!loadedAround(q.x, q.y, 40)) premature++; }
    }
  }
  const inside = gn.filter((n) => Math.hypot(n.x, n.y) <= 1000).length;
  check('a junction is only built when building data is loaded 40 m round it and along all its streets', premature === 0 && sawWaiting, `${premature} unloaded samples, junctions waited for tiles: ${sawWaiting}`);
  check('after all tiles arrive every junction in range is built, none twice', net.builtSet.size === inside && noDuplicateNodes(net), `${net.builtSet.size}/${inside}`);
  check('tile by tile gives exactly the same sidewalks as having every building at once', sameSet(multiset(net.edges), multiset(expectedFor(full, net))) && frontiersRight(net), `${net.edges.length} edges`);
  // and a tile that is dropped again does not disturb what is built
  const before = net.edges.length; loaded.delete(order[3]); net.tilesChanged(); net.ensureNear(0, 0, 1000);
  check('unloading a tile leaves the built network alone', net.edges.length === before, '');
}

// ---- 5. dropping far pieces bounds memory and stays consistent
{
  const net = new PedNetwork(city.map, signals, everything);
  net.ensureNear(0, 0, 900);
  const total = { n: net.nodes.length, e: net.edges.length };
  const gone = net.dropFar(0, 0, 500);
  check('far junctions are dropped and the near ones kept', gone > 0 && net.builtSet.size > 0 && [...net.builtSet].every((i) => net.nodeDist(i, 0, 0) <= 500) && net.edges.length < total.e, `${gone} dropped, ${net.builtSet.size} kept, ${net.edges.length}/${total.e} edges`);
  check('after a drop the network is still exactly the one-shot pieces of what is built, with frontier flags right', sameSet(multiset(net.edges), multiset(expectedFor(full, net))) && noDuplicateNodes(net) && frontiersRight(net), '');
  check('dropped edges are marked gone and left the spatial index', net.edges.every((e) => !e.gone) && net.edges.every((e, i) => e._i === i) && net.nodes.every((n, i) => n._i === i), '');
  net.ensureNear(0, 0, 900);
  check('building the area again after a drop restores exactly what was there', net.nodes.length === total.n && net.edges.length === total.e && sameSet(multiset(net.edges), multiset(expectedFor(full, net))), '');
  net.dropFar(1e6, 1e6, 10);
  check('dropping everything leaves nothing behind (nodes, edges, spatial index)', net.nodes.length === 0 && net.edges.length === 0 && net.grid.size === 0 && net.sw.every((s) => !s) && net.legArr.every((l) => !l), '');
  // spatial index answers agree with a brute-force scan
  net.ensureNear(1200, -700, 400);
  let bad = 0; const rnd = mulberry32(5);
  for (let k = 0; k < 300; k++) {
    const x = 1200 + (rnd() - 0.5) * 500, y = -700 + (rnd() - 0.5) * 500;
    let best = null;
    for (const e of net.edges) { const d = distTo(e.info, x, y); if (d <= 18 && (!best || d < best.d || (d === best.d && e.id < best.e.id))) best = { e, d }; }
    const got = net.nearestEdge(x, y, 18);
    if ((got?.e ?? null) !== (best?.e ?? null)) bad++;
  }
  check('the spatial index finds the same nearest edge as a full scan', bad === 0, `${bad}/300 differ`);
}
function distTo(info, x, y) {
  let d = Infinity;
  for (let i = 0; i < info.pts.length - 1; i++) {
    const a = info.pts[i], b = info.pts[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2));
    d = Math.min(d, Math.hypot(x - (a[0] + dx * t), y - (a[1] + dy * t)));
  }
  return d;
}

// ---- 6. the long street: standing in the middle of it still builds its sidewalks
{
  const net = new PedNetwork(city.map, signals, everything);
  const L = ge.find((e) => e.name.startsWith('Long')), mid = L.points[1];
  net.ensureNear(mid[0], mid[1], 350);
  check('a 600 m street with no junction nearby is walkable when the player is in the middle of it', net.edges.some((e) => e.type === 'walk' && e.gedge === L.id), `street ${L.length.toFixed(0)} m, middle ${Math.hypot(mid[0] - net.gn[net.fromI[L.id]].x, mid[1] - net.gn[net.fromI[L.id]].y).toFixed(0)} m from its ends`);
}

// ---- helpers for the simulations
const makePlayer = (x, y) => ({ x, y, vx: 0, vy: 0, heading: 0 });
const view = (p) => ({ cx: p.x, cy: p.y, hw: 60, hh: 38 });
const DT = 1 / 60;

// ---- 7. people never appear where the network is not built; with no data at all there is nobody
{
  const nothing = new PedSim(city.map, signals, { seed: 2, blocked: city.blockedAll, isLoaded: () => false, radius: 350 });
  const p = makePlayer(0, 0);
  nothing.prime(p, view(p));
  for (let k = 0; k < 300; k++) nothing.update(DT, p, view(p), city.blockedAll);
  check('with no building data loaded nobody appears and nothing is built', nothing.peds.length === 0 && nothing.net.edges.length === 0, '');

  const sim = new PedSim(city.map, signals, { seed: 2, blocked: city.blockedAll, isLoaded: everything.isLoaded, radius: 350, count: 60 });
  const spawn = sim.spawn.bind(sim); let onGhost = 0, farSpawn = 0, spawns = 0;
  sim.spawn = (edge, s, dir) => {
    spawns++;
    if (edge.gone || sim.net.edges[edge._i] !== edge) onGhost++;
    const q = pointAt(edge.info, dir > 0 ? s : edge.len - s, {}); if (Math.hypot(q.x - p.x, q.y - p.y) > 106) farSpawn++;
    return spawn(edge, s, dir);
  };
  check('nobody exists before the network is built round the player', sim.peds.length === 0 && sim.net.edges.length === 0, '');
  sim.update(DT, p, view(p), city.blockedAll);
  const afterOne = sim.net.builtSet.size;
  for (let k = 0; k < 600; k++) sim.update(DT, p, view(p), city.blockedAll);
  check('the network grows a little each frame (budget), then people appear', afterOne > 0 && afterOne <= 6 && sim.peds.length > 0, `${afterOne} junctions after frame 1, ${sim.net.builtSet.size} after 10 s`);
  check('people spawn only on edges that exist, within 105 m of the player', spawns > 0 && onGhost === 0 && farSpawn === 0, `${spawns} spawns, ${onGhost} on missing edges, ${farSpawn} too far`);
  check('the crowd fills to its count round the player', sim.peds.length === 60, `${sim.peds.length}`);
}

// ---- 8. the frontier: a person who reaches a junction that is not built just leaves
{
  const sim = new PedSim(city.map, signals, { seed: 8, blocked: city.blockedAll, isLoaded: everything.isLoaded, radius: 130, count: 40 });
  const p = makePlayer(0, 0);
  sim.prime(p, view(p));
  let stuck = 0, outside = 0;
  for (let k = 0; k < 120 * 60; k++) {
    sim.update(DT, p, view(p), city.blockedAll);
    if (k > 20 * 60) for (const q of sim.peds) { if (q.state === 'walk' && q.v === 0 && q.dist > 0) stuck++; if (!sim.net.edges.includes(q.edge)) outside++; } // (v is 0 on the frame someone spawns)
  }
  check('people keep crossing on green in the local crowd', sim.stats.crossings > 10 && sim.stats.badCrossStarts === 0, `${sim.stats.crossings} crossings`);
  check('people reaching an unbuilt junction leave (and the crowd is topped up again)', sim.stats.frontier > 0 && sim.peds.length === 40, `${sim.stats.frontier} left at the frontier, ${sim.stats.left} at the city limit`);
  check('nobody stands stuck on the frontier or walks on a forgotten edge', stuck === 0 && outside === 0, `${stuck} stuck steps, ${outside} steps on missing edges`);
}

// ---- 9. people far away are removed, however they got there
{
  const sim = new PedSim(city.map, signals, { seed: 3, blocked: city.blockedAll, isLoaded: everything.isLoaded, radius: 350, count: 60 });
  let p = makePlayer(-1000, -1000);
  sim.prime(p, view(p));
  for (let k = 0; k < 300; k++) sim.update(DT, p, view(p), city.blockedAll);
  const before = sim.peds.length;
  p = makePlayer(1500, 1200); // teleport 3 km away
  sim.update(DT, p, view(p), city.blockedAll);
  const far = sim.peds.filter((q) => Math.hypot(q.x - p.x, q.y - p.y) > 350 * 1.3).length;
  check('after the player jumps 3 km everybody left behind is removed at once', before === 60 && far === 0 && sim.peds.length < 60, `${before} before, ${far} still far, ${sim.peds.length} now`);
  for (let k = 0; k < 900; k++) sim.update(DT, p, view(p), city.blockedAll);
  check('and a new crowd builds up at the new place, on a network built there', sim.peds.length === 60 && sim.peds.every((q) => Math.hypot(q.x - p.x, q.y - p.y) < 350 * 1.3 && !q.edge.gone), `${sim.peds.length} people`);
  check('the network left behind is forgotten', sim.net.builtSet.size > 0 && [...sim.net.builtSet].every((i) => sim.net.nodeDist(i, p.x, p.y) < 350 * 1.7), `${sim.net.builtSet.size} junctions`);
}

// ---- 10. ten minutes of driving across the city, with tiles streaming in and out around the car
{
  const seed = 21, count = 80, radius = 350;
  const loaded = new Set();
  const blockedNow = city.blockedIn(loaded);
  const sim = new PedSim(city.map, signals, { seed, count, radius, blocked: blockedNow, isLoaded: city.isLoadedIn(loaded) });
  const route = [[-2500, 1500], [1000, 1500], [1000, -1500], [-1200, -1500], [-1200, 1000]];
  const speed = 12;
  let leg = 0, pos = route[0].slice(), tileKey = '';
  const player = makePlayer(pos[0], pos[1]);
  const setTiles = () => {
    const tx = Math.floor(player.x / T), ty = Math.floor(player.y / T), k = `${tx},${ty}`;
    if (k === tileKey) return false;
    tileKey = k; loaded.clear();
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) loaded.add(`${tx + a},${ty + b}`); // 5 x 5 tiles: buildings stream in 512 m ahead
    return true;
  };
  setTiles(); sim.prime(player, view(player));
  let nan = 0, inBuilding = 0, crowdShort = 0, steps = 0, maxDist = 0, maxNodes = 0, maxEdges = 0, worst = 0, sum = 0, tileLoads = 0, badFrontier = 0;
  const fullN = full.nodes.length;
  for (let t = 0; t < 600; t += DT) {
    // drive along the route
    const to = route[leg + 1] ?? route[route.length - 1];
    let dx = to[0] - pos[0], dy = to[1] - pos[1], d = Math.hypot(dx, dy);
    if (d < speed * DT && route[leg + 2]) { leg++; }
    else if (d > 1e-6) { pos[0] += (dx / d) * speed * DT; pos[1] += (dy / d) * speed * DT; }
    d = Math.hypot(dx, dy) || 1;
    const wob = 3.5 * Math.sin(t * 0.4); // weave across the street so the crowd on the sidewalks has to scatter
    player.x = pos[0] - (dy / d) * wob; player.y = pos[1] + (dx / d) * wob; player.vx = (dx / d) * speed; player.vy = (dy / d) * speed; player.heading = Math.atan2(dy, dx);
    if (setTiles()) { sim.tilesChanged(); tileLoads++; }
    const t1 = process.hrtime.bigint();
    sim.update(DT, player, view(player), blockedNow);
    const dtms = ms(t1); worst = Math.max(worst, dtms); sum += dtms; steps++;
    maxNodes = Math.max(maxNodes, sim.net.nodes.length); maxEdges = Math.max(maxEdges, sim.net.edges.length);
    if (t > 20 && sim.peds.length < count) crowdShort++;
    for (const p of sim.peds) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.heading) || !Number.isFinite(p.v)) nan++;
      else if (city.blockedAll(p.x, p.y)) inBuilding++;
      maxDist = Math.max(maxDist, Math.hypot(p.x - player.x, p.y - player.y));
    }
    if (steps % 600 === 0 && !frontiersRight(sim.net)) badFrontier++;
  }
  const st = sim.stats;
  console.log(`\n--- ten minutes driving ${Math.round(speed * 600)} m across the city, ${count} people ---`);
  console.log(`      ${st.spawned} spawned, ${st.left} left at the city limit, ${st.frontier} at the frontier, ${st.crossings} crossings, ${st.scatters} scattered, ${tileLoads} tile changes`);
  console.log(`      update: mean ${(sum / steps).toFixed(3)} ms, worst ${worst.toFixed(1)} ms; network at most ${maxNodes} nodes / ${maxEdges} edges (whole city: ${fullN} / ${full.edges.length})`);
  check('no NaN in any person, ever', nan === 0, `${nan} steps`);
  check('nobody is ever inside a building (checked against every building in the city)', inBuilding === 0, `${inBuilding} steps`);
  check('the crowd stays at its count once it has built up', crowdShort < 5 * 60, `${crowdShort} short frames`);
  check('nobody is ever more than 1.3 x radius from the player', maxDist <= radius * 1.3 + 1e-6, `${maxDist.toFixed(0)} m`);
  check('every crossing starts only while the cross street has green', st.badCrossStarts === 0 && st.crossings > 5, `${st.badCrossStarts} bad starts of ${st.crossings}`);
  check('the network stays small (under 10% of the city) however far the car goes', maxNodes < fullN * 0.1, `${maxNodes} of ${fullN} nodes`);
  check('frontier flags stay right while pieces come and go', badFrontier === 0, '');
  check('a frame stays cheap (mean under 2 ms, worst under 80 ms)', sum / steps < 2 && worst < 80, `mean ${(sum / steps).toFixed(3)} ms, worst ${worst.toFixed(1)} ms`);
}

// ---- 11. the frame cost does not grow with the size of the city
{
  const time = (c, label) => {
    const sm = new Signals(buildNetwork(c.map));
    const sim = new PedSim(c.map, sm, { seed: 4, count: 80, radius: 350, blocked: c.blockedAll, isLoaded: () => true });
    const p = makePlayer(0, 0); sim.prime(p, view(p));
    for (let k = 0; k < 600; k++) sim.update(DT, p, view(p), c.blockedAll); // settle
    const t = process.hrtime.bigint();
    for (let k = 0; k < 3000; k++) sim.update(DT, p, view(p), c.blockedAll);
    const per = ms(t) / 3000;
    console.log(`      ${label}: ${per.toFixed(3)} ms per update`);
    return per;
  };
  const small = time(makeCity(16, 4, { longEdge: false }), '16 x 16 blocks'), big = time(city, '60 x 60 blocks');
  check('a 14 times bigger city costs about the same per frame (under 3 x, or under 0.3 ms)', big < small * 3 || big < 0.3, `${small.toFixed(3)} -> ${big.toFixed(3)} ms`);
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
