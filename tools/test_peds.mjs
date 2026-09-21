// Pedestrian checks: run people and traffic together for a long time and look for rule breaking. Run: node tools/test_peds.mjs
import { readFileSync } from 'node:fs';
import { TrafficSim } from '../src/traffic/trafficSim.js';
import { PedSim } from '../src/peds/pedSim.js';
import { CollisionWorld } from '../src/world/collision.js';
import { Car, PHYSICS_STEP } from '../src/vehicles/carPhysics.js';
import { pointAt as import_pointAt } from '../src/world/geometry.js';

const map = JSON.parse(readFileSync('data/map.json', 'utf8'));
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };
const world = new CollisionWorld(map);
const blocked = (x, y) => world.insideSolid(x, y);

// ---- 1. the network
{
  const traffic = new TrafficSim(map, { seed: 3 });
  const peds = new PedSim(map, traffic.signals, { seed: 3, blocked });
  const net = peds.net;
  const seen = new Set([net.nodes[0].id]), queue = [net.nodes[0]];
  while (queue.length) { const n = queue.pop(); for (const e of n.edges) for (const m of [e.a, e.b]) if (!seen.has(m.id)) { seen.add(m.id); queue.push(m); } }
  check('the walking network is one connected piece', seen.size === net.nodes.length, `${seen.size}/${net.nodes.length} nodes reachable`);
  const usable = net.edges.filter((e) => !e.blocked);
  const inside = usable.filter((e) => { for (let d = 0; d <= e.len; d += 0.5) { const q = {}; import_pointAt(e.info, d, q); if (blocked(q.x, q.y)) return true; } return false; }).length;
  check('no usable sidewalk, corner or crosswalk passes through a building (checked every 0.5 m)', inside === 0, `${inside} edges touch a building; ${net.edges.length - usable.length} sidewalks dropped as blocked`);
  const crosses = net.edges.filter((e) => e.type === 'cross');
  check('every crosswalk is at a signalized junction and a sensible length (8-20 m)', crosses.every((e) => traffic.signals.byNode.has(e.nodeId) && e.len > 8 && e.len < 20), `${crosses.length} crosswalks, lengths ${Math.min(...crosses.map((e) => e.len)).toFixed(0)}-${Math.max(...crosses.map((e) => e.len)).toFixed(0)} m`);
}

// ---- 2. people and traffic together, no player interfering
{
  const traffic = new TrafficSim(map, { seed: 5 });
  const peds = new PedSim(map, traffic.signals, { seed: 5, blocked, count: 40 });
  traffic.peds = peds.peds; peds.cars = traffic.cars;
  traffic.fill(null, null); peds.fill(null, null);
  const DT = 1 / 60, view = { cx: 0, cy: 0, hw: 60, hh: 38 };
  let inBuilding = 0, countOk = true, carHits = 0, moving = 0, samples = 0, crossingSteps = 0, wrongPhase = 0;
  for (let t = 0; t < 20 * 60; t += DT) {
    traffic.update(DT, null, view);
    peds.update(DT, null, view, blocked);
    if (t > 20 && peds.peds.length !== 40) countOk = false;
    for (const p of peds.peds) {
      if (blocked(p.x, p.y)) inBuilding++;
      if (p.v > 0.3) moving++; samples++;
      if (p.edge.type === 'cross' && p.state === 'walk' && Math.abs(p.s - p.edge.len / 2) < (p.edge.len - 4) / 2) { // actually in the roadway
        crossingSteps++;
        const local = traffic.signals.localAxis(p.edge.nodeId, p.edge.axis, traffic.t);
        // a person in the road while their street still has green traffic, beyond the grace for finishing a crossing, is wrong
        if (local < 0.5 && local >= 0) wrongPhase++;
      }
      for (const c of traffic.cars) {
        const cs = Math.cos(c.heading), sn = Math.sin(c.heading);
        for (const k of [-0.3, 0, 0.3]) if (Math.hypot(p.x - (c.x + cs * c.length * k), p.y - (c.y + sn * c.length * k)) < c.width / 2 + 0.15) { carHits++; break; }
      }
    }
  }
  const st = peds.stats;
  console.log(`\n--- people and traffic together: 20 simulated minutes ---`);
  console.log(`      ${st.spawned} people spawned, ${st.left} walked off the map, ${st.crossings} crossings started, ${(100 * moving / samples).toFixed(0)}% of person-time walking, ${crossingSteps} person-steps on crosswalks`);
  check('the crowd stays at 40', countOk, '');
  check('nobody is ever inside a building', inBuilding === 0, `${inBuilding} steps`);
  check('every crossing starts only while the cross street has green', st.badCrossStarts === 0, `${st.badCrossStarts} bad starts`);
  check('nobody is in the crosswalk while their own street has fresh green traffic', wrongPhase === 0, `${wrongPhase} steps`);
  check('cars never drive through people (the traffic yields)', carHits === 0, `${carHits} person-steps inside a car`);
  check('people keep moving (over 45% of person-time walking; the rest waits at kerbs)', moving / samples > 0.45, `${(100 * moving / samples).toFixed(0)}%`);
  check('people actually cross streets', st.crossings > 100, `${st.crossings} crossings`);
}

// ---- 3. the player's car drives into a group of people on a sidewalk
{
  const traffic = new TrafficSim(map, { seed: 9 });
  const peds = new PedSim(map, traffic.signals, { seed: 9, blocked });
  peds.count = 0;
  // a crowd standing along Marquette's east sidewalk, north of the start
  const edge = peds.net.edges.filter((e) => e.type === 'walk').sort((a, b) => Math.hypot(a.info.pts[0][0] - 82, a.info.pts[0][1]) - Math.hypot(b.info.pts[0][0] - 82, b.info.pts[0][1]))[0];
  for (let i = 0; i < 12; i++) peds.spawn(edge, 25 + i * 3, 1);
  const car = new Car(edge.info.pts[0][0], edge.info.pts[0][1] + 1, 0);
  // aim the car along the sidewalk edge
  const p0 = edge.info.pts[0], p1 = edge.info.pts[edge.info.pts.length - 1];
  car.heading = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
  car.x = p0[0]; car.y = p0[1];
  car.vx = Math.cos(car.heading) * 12; car.vy = Math.sin(car.heading) * 12;
  let touched = 0, worstOverlap = 0, minCarSpeed = Infinity;
  const DT = PHYSICS_STEP;
  for (let t = 0; t < 8; t += DT) {
    car.step({ throttle: 1, brake: 0, steer: 0, handbrake: false }, DT);
    world.resolve(car, DT);
    const n = peds.update(DT, car, null, blocked);
    if (n) { touched += n; car.vx *= 0.985 ** n; car.vy *= 0.985 ** n; }
    minCarSpeed = Math.min(minCarSpeed, car.speed);
    const cs = Math.cos(car.heading), sn = Math.sin(car.heading);
    for (const p of peds.peds) for (const k of [-1.3, 0, 1.3]) worstOverlap = Math.max(worstOverlap, 0.97 + 0.3 - Math.hypot(p.x - (car.x + cs * k), p.y - (car.y + sn * k)));
  }
  console.log(`\n--- the car drives at a crowd ---`);
  console.log(`      ${peds.stats.scatters} people scattered, ${peds.stats.nudges} nudged, car speed never below ${minCarSpeed.toFixed(1)} m/s`);
  check('people scatter from the approaching car', peds.stats.scatters >= 6, `${peds.stats.scatters} scattered`);
  check('anyone touched is pushed clear (never left inside the car)', worstOverlap < 0.12, `worst overlap ${worstOverlap.toFixed(2)} m`);
  check('the car barely slows (stays above 8 m/s)', minCarSpeed > 8, `${minCarSpeed.toFixed(1)} m/s`);
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
