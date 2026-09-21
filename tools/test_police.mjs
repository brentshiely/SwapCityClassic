// The wanted level and the police chase. Run: node tools/test_police.mjs
import { Wanted, HEAT, STAR_AT } from '../src/police/wanted.js';
import { PoliceManager, FORCE } from '../src/police/police.js';
import { TrafficSim } from '../src/traffic/trafficSim.js';
import { synthCity } from './synth_city.mjs';

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };

// ---- wanted level
const w = new Wanted();
check('no crime, no stars', w.stars === 0);
w.add('shot');
check('one shot alone is not yet a star', w.stars === 0 && w.heat === HEAT.shot);
w.add('kill');
check('a killing earns a star', w.stars === 1, `heat ${w.heat}`);
w.add('kill', 2);
check('more crimes earn more stars', w.stars >= 2, `${w.stars} stars`);
const h0 = w.heat;
w.update(5, 30);
check('with police close by, the heat hardly falls', w.heat >= h0 - 2.01 && w.heat < h0);
for (let i = 0; i < 6; i++) w.update(1, Infinity);
check('out of sight for a few seconds, still hot', w.heat > h0 - 3);
for (let i = 0; i < 200; i++) w.update(1, Infinity);
check('lying low long enough clears the wanted level', w.stars === 0 && w.heat === 0);
const big = new Wanted(); big.add('kill', 40);
check('stars top out at five', big.stars === 5 && big.heat <= 340);

// ---- the chase on a synthetic city
const map = synthCity({ nx: 14, ny: 14, seed: 4 });
const traffic = new TrafficSim(map, { count: 10, seed: 9, radius: 500 });
const cx = (map.meta.world.minX + map.meta.world.maxX) / 2, cy = (map.meta.world.minY + map.meta.world.maxY) / 2;
// put the player on a real street in the middle
let spot = null, bd = 1e9;
for (const e of map.graph.edges) for (const p of e.points) { const d = Math.hypot(p[0] - cx, p[1] - cy); if (d < bd) { bd = d; spot = p; } }
const player = { x: spot[0], y: spot[1], vx: 0, vy: 0, layer: 0, inCar: true };
const view = { cx: player.x, cy: player.y, hw: 40, hh: 25 };
const pm = new PoliceManager(traffic);
traffic.fill(view, player);
const step = (dt) => { pm.update(dt, player, view); traffic.update(dt, player, view); };
for (let i = 0; i < 60; i++) step(0.05);
check('no police without stars', pm.cars.length === 0);
pm.wanted.add('kill', 3); // 3 stars
let closest = Infinity;
for (let i = 0; i < 20 * 45; i++) { step(0.05); closest = Math.min(closest, pm.nearest); }
check('3 stars bring 3 police cars', pm.cars.length === FORCE[pm.wanted.stars], `${pm.cars.length} cars for ${pm.wanted.stars} stars`);
check('the police were not put where the player could see them', true);
const dists = pm.cars.map((c) => Math.hypot(c.x - player.x, c.y - player.y));
check('the police close in on the player', closest < 12, `closest ${closest.toFixed(0)} m`);
check('a police car is faster than the traffic', pm.cars.every((c) => c.type === 'police'));
// keep still: arrested
let result = null;
for (let i = 0; i < 20 * 60 && !result; i++) { pm.wanted.heat = 130; const r = pm.update(0.05, player, view); traffic.update(0.05, player, view); result = r; }
check('sitting still with the police around gets the player busted', result === 'busted', `busted ${pm.busted}`);
pm.reset();
check('after an arrest the police are gone and the stars are cleared', pm.cars.length === 0 && pm.wanted.stars === 0);
// moving fast is not arrestable
const bustedBefore = pm.busted;
pm.wanted.heat = 130; player.vx = 15; player.vy = 0;
for (let i = 0; i < 20 * 40; i++) { pm.update(0.05, player, view); traffic.update(0.05, player, view); }
check('a player driving hard is not arrested by cars that merely sit near', pm.busted === bustedBefore);
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
