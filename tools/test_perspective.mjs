// Perspective maths checks. Run: node tools/test_perspective.mjs
import { scaleAt, lensHeight, cameraHeight, hullVisible, S_MAX } from '../src/render/perspective.js';
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;

check('the ground does not move (scale 1 at height 0)', near(scaleAt(300, 0), 1), scaleAt(300, 0));
check('scale is H / (H - z): a 60 m roof from 300 m is 1.25x', near(scaleAt(300, 60), 300 / 240), scaleAt(300, 60).toFixed(3));
check('the IDS Center tower (236 m) from 300 m is about 4.7x', Math.abs(scaleAt(300, 236) - 4.6875) < 1e-9, scaleAt(300, 236).toFixed(2));
let mono = true, prev = 0;
for (let z = 0; z < 300; z += 5) { const s = scaleAt(300, z); if (s < prev) mono = false; prev = s; }
check('the higher, the bigger (scale never decreases with height)', mono, '');
check('a block reaching the camera stays finite (clamped to S_MAX)', scaleAt(300, 300) === S_MAX && scaleAt(300, 500) === S_MAX && Number.isFinite(scaleAt(300, 299.9)), `${scaleAt(300, 300)}`);
check('the lens height is just under the camera height', lensHeight(300) < 300 && lensHeight(300) > 290, lensHeight(300).toFixed(1));
check('taller than the camera means above the lens (a 250 m tower under a 200 m camera)', 250 >= lensHeight(200), '');
check('a lower camera makes the same building loom more (60 m: 200 m camera vs 400 m camera)', scaleAt(200, 60) > scaleAt(400, 60), `${scaleAt(200, 60).toFixed(2)} vs ${scaleAt(400, 60).toFixed(2)}`);
check('zooming out raises the camera: 300 m at 20 px/m is 500 m at 12 px/m', near(cameraHeight(300, 20, 12), 500), cameraHeight(300, 20, 12));
check('and the same camera height at the same zoom', near(cameraHeight(300, 20, 20), 300), '');

// culling: a tall tower well outside the view still shows if its wall streaks into it
const view = { x: -40, y: -25, right: 40, bottom: 25 };
check('a building in view is visible', hullVisible([-5, -5, 5, 5], 0, 0, 1, 1.2, view), '');
check('a small building far outside the view is not', !hullVisible([300, 300, 310, 310], 0, 0, 1, 1.2, view), '');
check('but a tower 100 m away whose wall streaks toward the centre is not lost (base outside, top scaled outward)', hullVisible([-45, 20, -35, 30], 0, 0, 1, 4.7, { x: -80, y: -50, right: 80, bottom: 50 }), '');
check('a tower whose top is scaled off the far side of the view is still drawn while its base is in view', hullVisible([20, -5, 30, 5], 0, 0, 1, 20, view), '');

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
