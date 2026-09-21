// Sanity checks for the handling model. Run: node tools/test_car.mjs
import { Car, CAR } from '../src/vehicles/carPhysics.js';

const DT = 1 / 120;
const run = (car, seconds, input) => { for (let t = 0; t < seconds; t += DT) car.step(typeof input === 'function' ? input(t) : input, DT); };
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };
const idle = { throttle: 0, brake: 0, steer: 0, handbrake: false };

// 0 to top speed
let c = new Car(0, 0, 0), t90 = null;
for (let t = 0; t < 12; t += DT) { c.step({ ...idle, throttle: 1 }, DT); if (t90 === null && c.speed >= CAR.vMax * 0.9) t90 = t; }
check('reaches 90% of top speed in 3-5 s', t90 !== null && t90 > 3 && t90 < 5, `t90=${t90?.toFixed(2)} s`);
check('top speed near 72 km/h', c.speed > 19 && c.speed <= 20.5, `${(c.speed * 3.6).toFixed(1)} km/h`);

// braking distance from top speed
const before = c.x;
run(c, 6, { ...idle, brake: 1 }); // brake until stopped (then it would reverse; measure first stop)
c = new Car(0, 0, 0); c.vx = 20;
let stopT = 0; while (c.forwardSpeed >= 0 && stopT < 6) { c.step({ ...idle, brake: 1 }, DT); stopT += DT; if (c.speed < 0.01) break; }
check('brakes from top speed in under 1.5 s and 25 m', stopT < 1.5 && c.x < 25, `stopped in ${stopT.toFixed(2)} s over ${c.x.toFixed(1)} m`);

// reverse cap
c = new Car(0, 0, 0);
run(c, 8, { ...idle, brake: 1 });
check('reverse tops out near 25 km/h', c.forwardSpeed < -6 && c.forwardSpeed >= -CAR.reverseMax - 0.01, `${(c.forwardSpeed * 3.6).toFixed(1)} km/h`);

// cannot rotate at a standstill
c = new Car(0, 0, 0);
run(c, 2, { ...idle, steer: 1 });
check('does not spin on the spot', Math.abs(c.heading) < 1e-6, `heading=${c.heading.toFixed(4)}`);

// turning radius, measured over the first half second so coasting has not bled the speed away
for (const v of [10, 20]) {
  c = new Car(0, 0, 0); c.vx = v; c.steer = 1; // wheel already at full lock
  run(c, 0.1, { ...idle, steer: 1 });
  const radius = c.speed / Math.abs(c.yawRate);
  check(`full-lock turn radius at ${v} m/s is sensible (${v === 10 ? '3-9' : '10-20'} m)`, v === 10 ? radius > 3 && radius < 9 : radius > 10 && radius < 20, `radius=${radius.toFixed(1)} m`);
}

// slide: turn hard at speed, measure peak sideways speed, then it must fade
c = new Car(0, 0, 0); c.vx = 16;
let peak = 0; run(c, 0.6, (t) => { return { ...idle, steer: 1, throttle: 1 }; }); peak = Math.abs(c.sideSpeed);
check('a hard turn at speed produces a small slide (0.3-3 m/s)', peak > 0.3 && peak < 3, `side speed ${peak.toFixed(2)} m/s`);
run(c, 1, { ...idle });
check('slide fades within a second once straight', Math.abs(c.sideSpeed) < 0.1, `side speed ${Math.abs(c.sideSpeed).toFixed(3)} m/s`);

// handbrake makes it bigger
const slide = (hb) => { const k = new Car(0, 0, 0); k.vx = 16; let m = 0; for (let t = 0; t < 1; t += DT) { k.step({ ...idle, steer: 1, handbrake: hb }, DT); m = Math.max(m, Math.abs(k.sideSpeed)); } return m; };
check('handbrake gives a much bigger slide', slide(true) > slide(false) * 1.8, `${slide(false).toFixed(2)} -> ${slide(true).toFixed(2)} m/s`);

// a handbrake turn must not kill the car's momentum
c = new Car(0, 0, 0); c.vx = 16;
run(c, 0.7, { ...idle, steer: 1, handbrake: true });
run(c, 0.4, { ...idle, throttle: 0 });
check('after a 0.7 s handbrake turn the car is still moving fast (> 7 m/s)', c.speed > 7, `speed ${c.speed.toFixed(1)} m/s (${(c.speed * 3.6).toFixed(0)} km/h)`);

// coasting comes to rest
c = new Car(0, 0, 0); c.vx = 20; run(c, 10, idle);
check('coasts to a stop within 10 s', c.speed < 0.05, `speed after 10 s ${c.speed.toFixed(3)}`);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
