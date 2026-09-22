// Route finding: the shortest way to drive somewhere, honouring one-way streets. Run: node tools/test_route.mjs
import { RoutePlanner, distanceFromRoute } from '../src/navigation/route.js';
import { synthCity } from './synth_city.mjs';

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };

// a tiny hand-built graph: a 2x2 grid of streets, one of them one-way
const nodes = [
  { id: 0, x: 0, y: 0, degree: 2 }, { id: 1, x: 100, y: 0, degree: 3 }, { id: 2, x: 200, y: 0, degree: 2 },
  { id: 3, x: 0, y: 100, degree: 2 }, { id: 4, x: 100, y: 100, degree: 3 }, { id: 5, x: 200, y: 100, degree: 2 },
];
const edge = (id, from, to, oneway = false) => ({ id, from, to, oneway, length: Math.hypot(nodes[to].x - nodes[from].x, nodes[to].y - nodes[from].y), points: [[nodes[from].x, nodes[from].y], [nodes[to].x, nodes[to].y]] });
const edges = [edge(0, 0, 1), edge(1, 1, 2), edge(2, 3, 4), edge(3, 4, 5), edge(4, 0, 3), edge(5, 1, 4, true), edge(6, 2, 5)]; // edge 5 (1->4) is one-way
const world = { graph: { nodes, edges }, edgesNear: (x, y) => edges.filter((e) => Math.hypot(nodes[e.from].x - x, nodes[e.from].y - y) < 260 || Math.hypot(nodes[e.to].x - x, nodes[e.to].y - y) < 260) };
const rp = new RoutePlanner(world);

const r1 = rp.find(0, 0, 200, 0);
check('the shortest way along a straight street is a straight line', r1 && Math.abs(r1.distance - 200) < 1, r1 && r1.distance.toFixed(1));
const r2 = rp.find(0, 0, 100, 100);
check('a route to a diagonal point goes by road, not as the crow flies', r2 && r2.distance > 141 && r2.distance < 250, r2 && r2.distance.toFixed(1));

const r3 = rp.find(100, 0, 100, 100); // node 1 to node 4: the one-way street runs this way
check('a one-way street is used in its own direction', r3 && Math.abs(r3.distance - 100) < 1, r3 && r3.distance.toFixed(1));
const r4 = rp.find(100, 100, 100, 0); // node 4 to node 1: against the one-way street, must detour
check('a one-way street is not used against its direction (a detour is taken instead)', r4 && r4.distance > 100.5, r4 && r4.distance.toFixed(1));

check('the route touches both the start and the end point', r1.points[0][0] === 0 && r1.points[0][1] === 0 && r1.points.at(-1)[0] === 200 && r1.points.at(-1)[1] === 0);
check('a point standing on its route reads as zero distance from it', distanceFromRoute(r1, 100, 0) < 0.01);
check('a point 30 m off the route reads about 30 m away', Math.abs(distanceFromRoute(r1, 100, 30) - 30) < 1);

const iso = { id: 99, x: 5000, y: 5000, degree: 0 };
const world2 = { graph: { nodes: [...nodes, iso], edges }, edgesNear: world.edgesNear };
const rp2 = new RoutePlanner(world2);
check('there is no route to a stranded island with no streets', rp2.find(0, 0, 5000, 5000) === null);

// performance and correctness on a real-sized synthetic city
const map = synthCity({ nx: 40, ny: 40, seed: 7 });
const t0 = performance.now();
const big = new RoutePlanner(map);
const buildMs = performance.now() - t0;
const w = map.meta.world;
const t1 = performance.now();
const far = big.find(w.minX + 10, w.minY + 10, w.maxX - 10, w.maxY - 10);
const findMs = performance.now() - t1;
check('a route across a big synthetic city (40x40 blocks) is found', !!far, far && `${(far.distance / 1000).toFixed(2)} km`);
check('building the planner and finding a cross-city route is fast enough for the game', buildMs < 300 && findMs < 200, `build ${buildMs.toFixed(0)} ms, find ${findMs.toFixed(0)} ms`);
// a short local route should be much cheaper than a cross-city one
const t2 = performance.now();
big.find(0, 0, 300, 300);
const shortMs = performance.now() - t2;
check('a short route costs much less than a cross-city one', shortMs < findMs, `${shortMs.toFixed(2)} ms vs ${findMs.toFixed(2)} ms`);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
