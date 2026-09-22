// Walking on foot and the walls that stop it. Run: node tools/test_onfoot.mjs
import { Walker, FOOT } from '../src/player/walker.js';
import { CollisionWorld } from '../src/world/collision.js';

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };
const map = { meta: { world: { minX: -500, minY: -500, maxX: 500, maxY: 500 } }, roads: [], graph: { nodes: [], edges: [] }, buildings: [] };
const cw = new CollisionWorld(map);
cw.addBuilding({ id: 1, type: 'yes', points: [[10, -10], [30, -10], [30, 10], [10, 10]] });

const w = new Walker(0, 0, 0);
for (let i = 0; i < 240; i++) w.step({ x: 1, y: 0, run: false }, 1 / 60);
check('walking reaches the walking speed and no more', Math.abs(w.speed - FOOT.walk) < 0.05, `${w.speed.toFixed(2)} m/s`);
for (let i = 0; i < 240; i++) w.step({ x: 1, y: 0, run: true }, 1 / 60);
check('holding Shift runs faster', Math.abs(w.speed - FOOT.run) < 0.05, `${w.speed.toFixed(2)} m/s`);
const d = new Walker(0, 0, 0);
for (let i = 0; i < 240; i++) d.step({ x: 1, y: 1, run: false }, 1 / 60);
check('going diagonally is not faster than straight', d.speed <= FOOT.walk + 0.05, `${d.speed.toFixed(2)} m/s`);
check('the person turns to face where they go', Math.abs(d.heading - Math.PI / 4) < 0.01);

const p = new Walker(0, 0, 0);
for (let i = 0; i < 600; i++) { p.step({ x: 1, y: 0.05, run: true }, 1 / 60); cw.resolveCircle(p, FOOT.radius, 0); }
check('a building stops a runner', p.x < 10 - FOOT.radius + 0.05 && p.x > 8, `x = ${p.x.toFixed(2)}`);
const q = new Walker(0, 0, 0);
cw.addRails([{ pts: [[-5, 5], [40, 5]], layer: 1, side: 1 }]); // a rail on layer 1 only
for (let i = 0; i < 300; i++) { q.step({ x: 0, y: 1, run: true }, 1 / 60); cw.resolveCircle(q, FOOT.radius, 0); }
check('a rail on another layer is not in the way', q.y > 6, `y = ${q.y.toFixed(1)}`);
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
