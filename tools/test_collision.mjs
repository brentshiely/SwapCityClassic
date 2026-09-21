// Collision checks and a stress drive. Run: node tools/test_collision.mjs
import { readFileSync } from 'node:fs';
import { Car, CAR, PHYSICS_STEP } from '../src/vehicles/carPhysics.js';
import { CollisionWorld } from '../src/world/collision.js';
import { computeBarriers } from '../src/world/barriers.js';
import { mulberry32 } from '../src/render/rng.js';

const map = JSON.parse(readFileSync('data/map.json', 'utf8'));
const world = new CollisionWorld(map);
const { barriers } = computeBarriers(map);
const DT = PHYSICS_STEP;
const idle = { throttle: 0, brake: 0, steer: 0, handbrake: false };
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };
const drive = (car, secs, inputFn) => { for (let t = 0; t < secs; t += DT) { car.step(inputFn(t), DT); world.resolve(car, DT); } };

// Is a point strictly inside a solid building? (ray casting)
const solid = map.buildings.filter((b) => b.type !== 'roof');
const inside = (x, y) => solid.some((b) => {
  let c = false; const p = b.points;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) if ((p[i][1] > y) !== (p[j][1] > y) && x < ((p[j][0] - p[i][0]) * (y - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) c = !c;
  return c;
});
const corners = (car) => {
  const c = Math.cos(car.heading), s = Math.sin(car.heading), L = CAR.length / 2 - 0.03, W = CAR.width / 2 - 0.03; // 3 cm tolerance
  return [[L, W], [L, -W], [-L, W], [-L, -W], [0, 0]].map(([a, b]) => [car.x + c * a - s * b, car.y + s * a + c * b]);
};
const clipped = (car) => corners(car).some(([x, y]) => inside(x, y));

// 1. head-on into a building wall at top speed
{
  // find a building face: drive from open street straight at the block west of Marquette in the middle
  const car = new Car(70, 0, Math.PI); // facing -x (west), on Marquette, toward the IDS-block building
  car.vx = -20;
  drive(car, 2, () => ({ ...idle, throttle: 1 }));
  check('head-on into a building stops the car', car.speed < 1.5 && !clipped(car), `speed ${car.speed.toFixed(2)} m/s, clipped=${clipped(car)}, at x=${car.x.toFixed(1)}`);
}

// 2. glancing hit: driving north along Marquette, angled 17 degrees into the west-side buildings
{
  const h = -Math.PI / 2 - 0.3;
  const car = new Car(64, 45, h);
  car.vx = Math.cos(h) * 16; car.vy = Math.sin(h) * 16;
  const s0 = car.speed, x0 = car.x, y0 = car.y;
  drive(car, 1.5, () => ({ ...idle, throttle: 0.4 }));
  console.log(`      glancing: speed ${s0.toFixed(1)} -> ${car.speed.toFixed(1)} m/s, moved ${(y0 - car.y).toFixed(1)} m north, ${(x0 - car.x).toFixed(1)} m west`);
  check('a glancing hit slides along the wall (keeps >50% speed, travels on, not inside)', car.speed > s0 * 0.5 && y0 - car.y > 12 && !clipped(car), `clipped=${clipped(car)}`);
}

// 3. every street barricade stops a car driving into it at top speed
{
  let ok = 0;
  for (const b of barriers) {
    const car = new Car(b.x - Math.cos(b.angle) * 30, b.y - Math.sin(b.angle) * 30, b.angle);
    car.vx = Math.cos(b.angle) * 20; car.vy = Math.sin(b.angle) * 20;
    drive(car, 3, () => ({ ...idle, throttle: 1 }));
    const beyond = (car.x - b.x) * Math.cos(b.angle) + (car.y - b.y) * Math.sin(b.angle); // > 0 means it got past
    if (beyond < 0.2) ok++;
  }
  check(`all ${barriers.length} barricades hold at top speed`, ok === barriers.length, `${ok}/${barriers.length} held`);
}

// 4. the world wall holds from any direction
{
  const w = map.meta.world; let ok = true;
  for (const [x, y, h] of [[70, 0, 0], [70, 0, Math.PI], [70, 0, Math.PI / 2], [70, 0, -Math.PI / 2]]) { // start on Marquette
    const car = new Car(x, y, h);
    car.vx = Math.cos(h) * 20; car.vy = Math.sin(h) * 20;
    drive(car, 12, () => ({ ...idle, throttle: 1 }));
    if (car.x < w.minX || car.x > w.maxX || car.y < w.minY || car.y > w.maxY) ok = false;
  }
  check('the car can never leave the world rectangle', ok, '');
}

// 5. stress drive: random hard driving, five simulated minutes, several seeds
{
  world.rescues = 0;
  let worst = 0, clippedSteps = 0, total = 0, contacts = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const rand = mulberry32(seed * 7919);
    const car = new Car(70, 0, -Math.PI / 2);
    let steer = 0, throttle = 1, brake = 0, hb = false, next = 0;
    const w = map.meta.world;
    for (let t = 0; t < 300; t += DT) {
      if (t >= next) { // change the driver's mind every 0.2-1.5 s
        next = t + 0.2 + rand() * 1.3;
        steer = rand() < 0.35 ? 0 : rand() * 2 - 1;
        throttle = rand() < 0.75 ? 1 : 0;
        brake = throttle === 0 && rand() < 0.5 ? 1 : 0;
        hb = rand() < 0.15;
      }
      car.step({ throttle, brake, steer, handbrake: hb }, DT);
      if (world.resolve(car, DT)) contacts++;
      total++;
      if (clipped(car)) clippedSteps++;
      worst = Math.max(worst, Math.max(w.minX - car.x, car.x - w.maxX, w.minY - car.y, car.y - w.maxY, 0));
    }
  }
  check('stress drive: 6 x 5 minutes, the car is never inside a building', clippedSteps === 0, `${total} steps, ${contacts} steps in contact, ${clippedSteps} clipped`);
  check('stress drive: the safety net never had to step in', world.rescues === 0, `${world.rescues} rescues`);
  check('stress drive: never outside the world', worst === 0, `worst overshoot ${worst.toFixed(2)} m`);
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
