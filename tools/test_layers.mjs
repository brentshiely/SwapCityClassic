// Layers: bridges, tunnels and the street under a bridge. Run: node tools/test_layers.mjs
import { LayerTracker, deckRails, computePortals, layerZ } from '../src/world/layers.js';
import { CollisionWorld } from '../src/world/collision.js';
import { Car } from '../src/vehicles/carPhysics.js';

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };

// a tiny city: a street along y=0 (ground), a bridge along x=100 crossing over it (not connected), and a ramp street that climbs onto a second deck
const edge = (id, from, to, pts, layer) => ({ id, from, to, points: pts, layer, lanes: 2, length: Math.hypot(pts.at(-1)[0] - pts[0][0], pts.at(-1)[1] - pts[0][1]) });
const nodes = [{ id: 0, x: 0, y: 0, degree: 1 }, { id: 1, x: 200, y: 0, degree: 1 }, { id: 2, x: 100, y: -100, degree: 1 }, { id: 3, x: 100, y: 100, degree: 1 },
  { id: 4, x: 0, y: 300, degree: 2 }, { id: 5, x: 100, y: 300, degree: 2 }, { id: 6, x: 300, y: 300, degree: 1 }];
const A = edge(0, 0, 1, [[0, 0], [200, 0]], 0);
const B = edge(1, 2, 3, [[100, -100], [100, 100]], 1);
const C = edge(2, 4, 5, [[0, 300], [100, 300]], 0); // ground street that becomes a bridge at node 5
const D = edge(3, 5, 6, [[100, 300], [300, 300]], 1);
const edges = [A, B, C, D];
const world = { edgesNear: (x, y, r) => edges.filter((e) => e.points.some(([px, py]) => Math.abs(px - x) <= r + 200 && Math.abs(py - y) <= r + 200)) };
const layerAfterDriving = (edgesOnPath, start, end, layer0 = 0) => {
  const t = new LayerTracker(world); t.reset(layer0);
  let x = start[0], y = start[1];
  const n = Math.ceil(Math.hypot(end[0] - start[0], end[1] - start[1]) / 0.5);
  const seen = new Set();
  for (let i = 0; i <= n; i++) { x = start[0] + ((end[0] - start[0]) * i) / n; y = start[1] + ((end[1] - start[1]) * i) / n; seen.add(t.update(x, y)); }
  return { layer: t.layer, seen };
};

const under = layerAfterDriving(edges, [20, 0], [180, 0], 0);
check('driving on the street under a bridge stays on layer 0 the whole way', under.layer === 0 && under.seen.size === 1, [...under.seen].join(','));
const over = layerAfterDriving(edges, [100, -90], [100, 90], 1);
check('driving on the bridge over the street stays on layer 1 the whole way', over.layer === 1 && over.seen.size === 1, [...over.seen].join(','));
const ramp = layerAfterDriving(edges, [10, 300], [290, 300], 0);
check('driving up a ramp (a road that joins the bridge) changes to layer 1', ramp.layer === 1 && ramp.seen.has(0) && ramp.seen.has(1), [...ramp.seen].join(','));

// side rails
const roads = [{ id: 1, layer: 1, highway: 'primary', width: 8, points: [[0, 0], [120, 0]] }, { id: 2, layer: 0, highway: 'primary', width: 8, points: [[0, 30], [120, 30]] }];
const rails = deckRails(roads);
check('a bridge gets two side rails and a ground road none', rails.length === 2 && rails.every((r) => r.layer === 1), `${rails.length} rails`);
const ends = rails.map((r) => [r.pts[0][0], r.pts.at(-1)[0]]);
check('rails stop short of the ends (so cars can drive on and off)', ends.every(([a, b]) => a >= 6.9 && b <= 113.1), JSON.stringify(ends));

// collision: the rails stop a car on the deck, and a car on the street below drives through the same place
const world2 = { meta: { world: { minX: -500, minY: -500, maxX: 500, maxY: 500 } }, roads: [], graph: { nodes: [], edges: [] }, buildings: [] };
const cw = new CollisionWorld(world2); cw.addRails(rails);
const drive = (layer) => {
  const car = new Car(60, 0, Math.PI / 2); // heading +y (down), aimed at the +y rail from the middle of the deck
  car.layer = layer; car.x = 60; car.y = 0; car.vx = 0; car.vy = 12; car.heading = Math.PI / 2;
  for (let i = 0; i < 480; i++) { car.step({ throttle: 0.5, brake: 0, steer: 0, handbrake: false }, 1 / 240); cw.resolve(car, 1 / 240); }
  return car;
};
const onDeck = drive(1), below = drive(0);
check('a car on the deck is stopped by the rail', onDeck.y < 6, `y = ${onDeck.y.toFixed(1)}`);
check('a car on another layer drives through that spot', below.y > 20, `y = ${below.y.toFixed(1)}`);

// a car drives into a tunnel whose mouth is under a building: the layer must change AT the mouth, before the building's wall on layer 0
{
  const G = edge(0, 0, 1, [[0, 0], [100, 0]], 0), T = edge(1, 1, 2, [[100, 0], [200, 0]], -1);
  const w = { edgesNear: () => [G, T] };
  const cw2 = new CollisionWorld({ meta: { world: { minX: -500, minY: -500, maxX: 500, maxY: 500 } }, roads: [], graph: { nodes: [], edges: [] }, buildings: [{ id: 1, type: 'yes', points: [[100.5, -20], [140, -20], [140, 20], [100.5, 20]] }] });
  const t = new LayerTracker(w); t.reset(0);
  const car = new Car(40, 0, 0); car.vx = 0; car.vy = 0;
  let stuckAt = null;
  for (let i = 0; i < 240 * 14; i++) {
    car.layer = t.update(car.x, car.y, car.heading);
    car.step({ throttle: 0.6, brake: 0, steer: 0, handbrake: false }, 1 / 240);
    cw2.resolve(car, 1 / 240);
  }
  check('a car drives into a tunnel under a building (the layer changes at the mouth, not after it)', car.x > 150 && car.layer === -1, `x = ${car.x.toFixed(1)}, layer ${car.layer}`);
}

// tunnel mouths
const tg = { nodes: [{ id: 0, x: 0, y: 0 }, { id: 1, x: 100, y: 0 }, { id: 2, x: 200, y: 0 }], edges: [edge(0, 0, 1, [[0, 0], [100, 0]], 0), edge(1, 1, 2, [[100, 0], [200, 0]], -1)] };
const portals = computePortals(tg);
check('a tunnel that meets the open road has one mouth, facing out', portals.length === 1 && Math.abs(portals[0].x - 100) < 0.01 && Math.abs(Math.abs(portals[0].angle) - Math.PI) < 0.01, JSON.stringify(portals));
check('deck heights: ground and tunnel 0 m, each layer up 8 m', layerZ(0) === 0 && layerZ(-1) === 0 && layerZ(1) === 8 && layerZ(2) === 16);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
