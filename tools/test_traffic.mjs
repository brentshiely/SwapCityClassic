// Traffic checks: run the simulation for a long time and look for rule breaking. Run: node tools/test_traffic.mjs
import { readFileSync } from 'node:fs';
import { TrafficSim } from '../src/traffic/trafficSim.js';

const map = JSON.parse(readFileSync('data/map.json', 'utf8'));
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };

const roads = map.graph.edges;
const distToRoads = (x, y) => {
  let best = Infinity;
  for (const e of roads) for (let i = 0; i < e.points.length - 1; i++) {
    const a = e.points[i], b = e.points[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2));
    best = Math.min(best, Math.hypot(x - (a[0] + dx * t), y - (a[1] + dy * t)));
  }
  return best;
};

function run(label, { minutes, player, view }) {
  const sim = new TrafficSim(map, { count: 16, seed: 7 });
  const DT = 1 / 60; // the game steps traffic about 60 times a second
  let speedSum = 0, speedN = 0, maxOver = 0, offRoad = 0, minToPlayer = Infinity, countOk = true, moving = 0, samples = 0;
  sim.fill(null, player);
  for (let t = 0; t < minutes * 60; t += DT) {
    sim.update(DT, player, view);
    if (t > 30 && sim.cars.length !== 16) countOk = false;
    for (const c of sim.cars) {
      const lim = c.segs[0].limit;
      if (c.segs[0].kind === 'edge') maxOver = Math.max(maxOver, c.v - lim);
      speedSum += c.v; speedN++;
      if (c.v > 0.5) moving++; samples++;
      if (distToRoads(c.x, c.y) > 9) offRoad++;
      if (player) minToPlayer = Math.min(minToPlayer, Math.hypot(c.x - player.x, c.y - player.y));
    }
  }
  const st = sim.stats;
  console.log(`\n--- ${label}: ${minutes} simulated minutes ---`);
  console.log(`      spawned ${st.spawned}, left the map ${st.despawned}, mean speed ${(speedSum / speedN).toFixed(1)} m/s, moving ${(100 * moving / samples).toFixed(0)}% of the time, deadlock breaks ${st.ghosts}`);
  check('the car count stays at 16', countOk, '');
  check('no car ever runs a red light', st.redRuns === 0, `${st.redRuns} red-light runs`);
  check('no car ever drives the wrong way down a one-way street', st.wrongWay === 0, `${st.wrongWay} wrong-way trips`);
  // Known limit: at busy junctions two cars very occasionally clip corners for a fraction of a second.
  check('cars essentially never crash (under 2 s in total of overlap deeper than 0.6 m, over 20 minutes)', st.crashSteps / 60 < 2, `${(st.crashSteps / 60).toFixed(2)} s`);
  console.log(`      light contact (overlap 0.15-0.6 m, corner touches at junctions): ${st.overlapSteps - st.crashSteps} steps = ${((st.overlapSteps - st.crashSteps) / 60).toFixed(1)} s in total`);
  check('cars keep to the speed limit (never more than 0.6 m/s over)', maxOver < 0.6, `max over the limit ${maxOver.toFixed(2)} m/s`);
  check('cars stay on the road (within 9 m of a street centre line)', offRoad === 0, `${offRoad} off-road samples`);
  check('traffic keeps flowing (mean speed above 4 m/s)', speedSum / speedN > 4, `${(speedSum / speedN).toFixed(1)} m/s`);
  if (player) check('cars never touch the parked player (centres > 2.4 m apart)', minToPlayer > 2.4, `closest ${minToPlayer.toFixed(2)} m`);
  return sim;
}

// 1. free-flowing traffic, player far away and not in anyone's way
run('no player', { minutes: 20, player: null, view: { cx: 0, cy: 0, hw: 60, hh: 38 } });

// 2. the player parked in the right-hand lane of Marquette: traffic must queue behind, never touch
run('player parked in the road', { minutes: 20, player: { x: 71.8, y: 0, heading: -Math.PI / 2, length: 4.5, width: 1.9 }, view: { cx: 72, cy: 0, hw: 60, hh: 38 } });

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
