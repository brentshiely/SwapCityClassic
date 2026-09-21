// Car damage. Run: node tools/test_damage.mjs
import { CarDamage, DAMAGE } from '../src/vehicles/damage.js';

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };

const d = new CarDamage();
check('a new car is fine', d.hp === 100 && d.level === 0 && d.power === 1 && d.smoke === 0);
check('a bump costs nothing', d.hit(1.5) === 0 && d.hp === 100);
const c1 = d.hit(8), c2 = new CarDamage().hit(20);
check('a harder crash costs more', c2 > c1 && c1 > 0, `${c1.toFixed(1)} vs ${c2.toFixed(1)}`);
check('no crash takes more than 70 health at once', new CarDamage().hit(60) <= 70);
const levels = [];
const e = new CarDamage();
for (let i = 0; i < 12; i++) { e.hit(10); levels.push(e.level); }
check('repeated hits step the damage up through the levels', levels[0] >= 0 && levels.at(-1) === 3 && levels.every((l, i) => i === 0 || l >= levels[i - 1]), levels.join(''));
check('a damaged car is weaker, a burning one weakest', new CarDamage().power > (() => { const x = new CarDamage(); x.hp = 60; return x.power; })() && (() => { const x = new CarDamage(); x.hp = 60; const y = new CarDamage(); y.hp = 10; return x.power > y.power; })());
const f = new CarDamage(); f.hp = 30;
check('a smoking car is not yet burning', f.level === 2 && f.smoke > 0 && !f.onFire);
f.hit(9);
let blew = false, t = 0;
while (t < 60 && !blew) { blew = f.update(0.1); t += 0.1; }
check('a burning car eventually explodes, and only once', blew && f.exploded && f.update(0.1) === false, `after ${t.toFixed(1)} s`);
check('a car on fire does not blow up instantly', t > DAMAGE.explodeDelay);
const g = new CarDamage(); g.hp = 15; g.update(0.5);
g.repair();
check('the paint shop repairs everything', g.hp === 100 && g.level === 0 && !g.exploded);
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
