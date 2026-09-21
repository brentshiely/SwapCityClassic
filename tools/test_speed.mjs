// The car tops out at 150 mph (67 m/s): it gets there, stays stable, and cannot tunnel through a thin wall. Run: node tools/test_speed.mjs
import { Car, CAR } from '../src/vehicles/carPhysics.js';
import { CollisionWorld } from '../src/world/collision.js';

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };
const saved = { ...CAR };
Object.assign(CAR, { vMax: 67, accel: 7.5 });
const STEP = 1 / 240;
const map = { meta: { world: { minX: -5000, minY: -5000, maxX: 5000, maxY: 5000 } }, roads: [], graph: { nodes: [], edges: [] }, buildings: [] };

// top speed
{
  const car = new Car(0, 0, 0);
  let ok = true;
  for (let i = 0; i < 240 * 90; i++) { car.step({ throttle: 1, brake: 0, steer: 0, handbrake: false }, STEP); if (!Number.isFinite(car.x + car.y + car.vx + car.vy)) ok = false; }
  check('full throttle reaches 150 mph and no more', car.speed > 64 && car.speed <= 67 * 1.03, `${(car.speed * 2.23694).toFixed(0)} mph`);
  check('nothing goes NaN at top speed', ok);
}
// steering at top speed stays sane (turning circle, no spin-out to nonsense speeds)
{
  const car = new Car(0, 0, 0);
  for (let i = 0; i < 240 * 90; i++) car.step({ throttle: 1, brake: 0, steer: 0, handbrake: false }, STEP);
  let maxSpeed = 0, turned = 0, h0 = car.heading;
  for (let i = 0; i < 240 * 6; i++) { car.step({ throttle: 1, brake: 0, steer: 1, handbrake: false }, STEP); maxSpeed = Math.max(maxSpeed, car.speed); }
  turned = Math.abs(car.heading - h0);
  check('steering at 150 mph turns the car, gently, without gaining speed', turned > 0.3 && turned < 6 && maxSpeed < 67 * 1.03, `turned ${turned.toFixed(1)} rad in 6 s`);
}
// a thin wall (a 1.2 m barricade) stops a car doing 150 mph
{
  const cw = new CollisionWorld(map);
  cw.addPolygon([[200, -10], [201.2, -10], [201.2, 10], [200, 10]]);
  const car = new Car(0, 0, 0);
  car.vx = 67; car.vy = 0;
  let passed = false;
  for (let i = 0; i < 240 * 6; i++) { car.step({ throttle: 1, brake: 0, steer: 0, handbrake: false }, STEP); cw.resolve(car, STEP); if (car.x > 201.3) passed = true; }
  check('a car at 150 mph does not tunnel through a barricade', !passed && car.x < 199, `x = ${car.x.toFixed(1)} m`);
}
Object.assign(CAR, saved);
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
