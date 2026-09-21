// Whole-city scale checks for the traffic and the street-name HUD, on a synthetic 30,000-node / 40,000-edge road network
// (tools/synth_city.mjs). Run: node --expose-gc tools/test_city_scale.mjs  (the gc flag only makes the memory figure exact)
import { synthCity } from './synth_city.mjs';
import { TrafficSim } from '../src/traffic/trafficSim.js';
import { buildNetwork } from '../src/traffic/network.js';
import { Signals } from '../src/traffic/signals.js';
import { junctionInfo, polyInfo, pointAt, nearestOnPolyline } from '../src/world/geometry.js';
import { Navigator } from '../src/world/navigation.js';
import { mulberry32 } from '../src/render/rng.js';

let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };
const now = () => performance.now();
const heap = () => { global.gc?.(); return process.memoryUsage().heapUsed / 1e6; };
const RADIUS = 450, COUNT = 40;
const rnd = mulberry32(99); // the checks themselves are repeatable

// ---------- the city ----------
const t0 = now();
const city = synthCity();
const { nodes, edges } = city.graph;
console.log(`\n--- synthetic city: ${nodes.length} nodes, ${edges.length} edges, ${city.roads.length} roads, ${nodes.filter((n) => n.signal).length} signalized junctions (made in ${(now() - t0).toFixed(0)} ms) ---`);
check('the test city is city-sized (30,000+ nodes, 40,000+ edges)', nodes.length >= 30000 && edges.length >= 40000, `${nodes.length} / ${edges.length}`);

// ---------- 1. build cost and memory ----------
const h0 = heap();
let t = now();
junctionInfo(city);
const tJ = now() - t; t = now();
const net = buildNetwork(city);
const tN = now() - t; t = now();
const sig = new Signals(net);
const tS = now() - t; t = now();
const sim0 = new TrafficSim(city, { count: COUNT, seed: 1, radius: RADIUS });
sim0.fill(null, { x: 0, y: 0 }); // the first fill also builds the street index
const tSim = now() - t;
console.log(`      junctionInfo ${tJ.toFixed(0)} ms, buildNetwork ${tN.toFixed(0)} ms, Signals ${tS.toFixed(0)} ms (${sig.byNode.size} junctions), whole TrafficSim + first fill ${tSim.toFixed(0)} ms`);
check('network + junctionInfo + Signals build in under 2 s', tJ + tN + tS < 2000, `${(tJ + tN + tS).toFixed(0)} ms`);
check('TrafficSim (network, signals, street index, first fill) is ready in under 2 s', tSim < 2000, `${tSim.toFixed(0)} ms`);
const heapMB = heap() - h0;
check('memory is sane (two networks + signals + street index under 400 MB of heap)', heapMB < 400, `${heapMB.toFixed(0)} MB`);
check('the first fill puts the cars around the player', sim0.cars.length === COUNT && sim0.cars.every((c) => Math.hypot(c.x, c.y) <= RADIUS), `${sim0.cars.length} cars`);

// ---------- 2. local traffic over a long drive ----------
// the player drives along one street (both cities use the same route shape: the street's own polyline, out and back if it is short)
function route(c, row) {
  const name = `${row + 1}th Street`, pts = [];
  for (const r of c.roads) if (r.name === name) for (const p of r.points) if (!pts.length || pts[pts.length - 1][0] !== p[0] || pts[pts.length - 1][1] !== p[1]) pts.push(p);
  return polyInfo(pts);
}
function drive(label, c, { minutes, speed = 12, row = 46, radius = RADIUS, count = COUNT }) {
  const info = route(c, row), tmp = {};
  const sim = new TrafficSim(c, { count, seed: 7, radius });
  const player = { x: 0, y: 0, vx: 0, vy: 0, heading: 0, length: 4.5, width: 1.9 };
  const DT = 1 / 60, steps = Math.round(minutes * 60 / DT);
  let worst = 0, popIn = 0, spawnFar = 0, low = Infinity, sumN = 0, nMax = 0, costSum = 0, costMax = 0;
  const costs = [];
  const place = (s) => {
    const L = info.len, m = ((s % (2 * L)) + 2 * L) % (2 * L), back = m > L; // out and back
    pointAt(info, back ? 2 * L - m : m, tmp);
    const dir = back ? -1 : 1; // right-hand lane of its direction of travel
    player.x = tmp.x - tmp.ty * dir * 1.65; player.y = tmp.y + tmp.tx * dir * 1.65;
    player.heading = Math.atan2(tmp.ty * dir, tmp.tx * dir);
    player.vx = Math.cos(player.heading) * speed; player.vy = Math.sin(player.heading) * speed;
  };
  place(0);
  const view = { cx: 0, cy: 0, hw: 80, hh: 50 };
  const setView = () => { view.cx = player.x; view.cy = player.y; };
  setView();
  sim.fill(view, player);
  const seen = new Set(sim.cars.map((q) => q.id));
  for (let i = 0; i < steps; i++) {
    place((i + 1) * DT * speed); setView();
    const ts = now();
    sim.update(DT, player, view);
    const cost = now() - ts;
    costSum += cost; costMax = Math.max(costMax, cost); if (i % 20 === 0) costs.push(cost);
    for (const q of sim.cars) {
      const d = Math.hypot(q.x - player.x, q.y - player.y);
      worst = Math.max(worst, d);
      if (!seen.has(q.id)) { // a car that appeared this step
        seen.add(q.id);
        if (Math.abs(q.x - view.cx) < view.hw && Math.abs(q.y - view.cy) < view.hh) popIn++; // spawned where the player can see
        if (d > radius + 1 || d < 30) spawnFar++;
      }
    }
    if (i * DT > 60) { low = Math.min(low, sim.cars.length); sumN += sim.cars.length; nMax++; }
  }
  costs.sort((a, b) => a - b);
  const st = sim.stats;
  console.log(`\n--- ${label}: ${minutes} simulated minutes, player at ${speed} m/s along ${info.len.toFixed(0)} m of street, ${count} cars within ${radius} m ---`);
  console.log(`      spawned ${st.spawned}, removed ${st.despawned} (${st.culled} left behind, ${st.despawned - st.culled} left the map), farthest car ${worst.toFixed(0)} m, mean cars ${(sumN / nMax).toFixed(1)}, deadlock breaks ${st.ghosts}`);
  console.log(`      update cost: mean ${(costSum / steps).toFixed(3)} ms, p99 ${costs[Math.floor(costs.length * 0.99)].toFixed(3)} ms, worst ${costMax.toFixed(2)} ms`);
  return { sim, worst, popIn, spawnFar, low, mean: sumN / nMax, cost: costSum / steps };
}

const big = drive('city', city, { minutes: 10 });
check(`cars only exist within radius x 1.3 (${(RADIUS * 1.3).toFixed(0)} m) of the player`, big.worst <= RADIUS * 1.3 + 1, `farthest ${big.worst.toFixed(1)} m`);
check('the car count stays at the target near the player', big.low >= COUNT - 3 && big.mean > COUNT - 1, `min ${big.low}, mean ${big.mean.toFixed(1)}`);
check('no car ever appears where the player can see', big.popIn === 0, `${big.popIn} pop-ins`);
check('cars only spawn between 30 m and radius from the player', big.spawnFar === 0, `${big.spawnFar} spawns outside`);
check('no car ever runs a red light', big.sim.stats.redRuns === 0, `${big.sim.stats.redRuns} red-light runs`);
check('no car ever drives the wrong way down a one-way street', big.sim.stats.wrongWay === 0, `${big.sim.stats.wrongWay} wrong-way trips`);
// same metric test_traffic.mjs uses (deeper than 0.6 m for under 2 s in total over 20 minutes; this run is 10 minutes with 2.5x the cars)
check('cars essentially never crash (under 2 s in total of overlap deeper than 0.6 m)', big.sim.stats.crashSteps / 60 < 2, `${(big.sim.stats.crashSteps / 60).toFixed(2)} s`);
console.log(`      light contact (overlap 0.15-0.6 m): ${((big.sim.stats.overlapSteps - big.sim.stats.crashSteps) / 60).toFixed(1)} s in total`);

// update cost must not depend on the size of the city: the same drive on a 20 x 20 block city costs the same per frame
const small = drive('small city (20 x 20 blocks)', synthCity({ nx: 20, ny: 20, seed: 3 }), { minutes: 3, row: 8 });
check('the per-frame cost does not grow with the city (30,000 nodes vs 500 nodes)', big.cost < small.cost * 1.5 + 0.15, `${big.cost.toFixed(3)} ms vs ${small.cost.toFixed(3)} ms`);
check('the per-frame cost is small in absolute terms (mean under 3 ms)', big.cost < 3, `${big.cost.toFixed(3)} ms`);

// whole-map traffic still works on the big graph when no radius is given (the default), only more slowly to build
const all = new TrafficSim(city, { count: 12, seed: 2 });
all.fill(null, null);
check('without a radius the cars go anywhere on the map (default behaviour)', all.cars.length === 12 && all.cars.some((c) => Math.hypot(c.x, c.y) > 1500), `${all.cars.length} cars, farthest ${Math.max(...all.cars.map((c) => Math.hypot(c.x, c.y))).toFixed(0)} m from the origin`);

// ---------- 3. street names ----------
t = now();
const nav = new Navigator(city);
const tNav = now() - t;
console.log(`\n--- navigator: built in ${tNav.toFixed(0)} ms ---`);
check('the navigator is built in under 2 s', tNav < 2000, `${tNav.toFixed(0)} ms`);
// per-call cost while driving (the way the HUD calls it: one lookup per frame at the car's position)
const info = route(city, 46), tmp = {}, N = 30000;
const cars = [];
for (let i = 0; i < N; i++) {
  pointAt(info, (i / N) * info.len, tmp);
  const h = Math.atan2(tmp.ty, tmp.tx);
  cars.push({ x: tmp.x + (i % 7) - 3, y: tmp.y + (i % 5) - 2, vx: Math.cos(h) * 10, vy: Math.sin(h) * 10, heading: h });
}
for (let i = 0; i < 2000; i++) nav.locate(cars[i]); // warm up
t = now();
let named = 0;
for (const c of cars) if (nav.locate(c).street) named++;
const perCall = (now() - t) / N;
check('a locate() call takes under 0.1 ms on the big graph', perCall < 0.1, `${(perCall * 1000).toFixed(1)} us per call (${named}/${N} named)`);
// random points anywhere in the city, not only along one street
let worstCall = 0;
for (let i = 0; i < 3000; i++) {
  const x = city.meta.world.minX + rnd() * (city.meta.world.maxX - city.meta.world.minX), y = city.meta.world.minY + rnd() * (city.meta.world.maxY - city.meta.world.minY);
  const ts = now(); nav.locate({ x, y, vx: 5, vy: 5, heading: 0 }); worstCall = Math.max(worstCall, now() - ts);
}
check('the slowest of 3000 random lookups over the whole city is under 1 ms', worstCall < 1, `${worstCall.toFixed(3)} ms`);
// the index answers exactly what a scan of every road would
let mismatch = 0;
const scan = (x, y) => {
  let best = null, bd = Infinity;
  for (const { r, info: inf } of nav.roads) { const d = Math.max(0, nearestOnPolyline(inf, x, y).dist - r.width / 2) + (r.name ? 0 : 6); if (d < bd) { bd = d; best = r; } }
  return best;
};
for (let i = 0; i < 400; i++) {
  const e = edges[Math.floor(rnd() * edges.length)], p = e.points[0];
  const x = p[0] + (rnd() - 0.5) * 60, y = p[1] + (rnd() - 0.5) * 60;
  if (nav.streetAt(x, y)?.road !== scan(x, y)) mismatch++;
}
check('the street index gives the same street as scanning every road (400 random points)', mismatch === 0, `${mismatch} differences`);
// and it really names streets
let wrong = 0;
for (let i = 0; i < 300; i++) {
  const e = edges[Math.floor(rnd() * edges.length)];
  if (e.length < 40 || !e.name) continue;
  const m = pointAt(polyInfo(e.points), e.length / 2, {});
  const r = nav.locate({ x: m.x, y: m.y, vx: 0, vy: 0, heading: 0 });
  if (r.street !== e.name) wrong++;
}
check('the middle of every sampled street is named correctly', wrong === 0, `${wrong} wrong`);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
