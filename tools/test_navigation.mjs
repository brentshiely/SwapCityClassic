// Street name and compass checks. Run: node tools/test_navigation.mjs
import { readFileSync } from 'node:fs';
import { Navigator, bearingOf, compassName } from '../src/world/navigation.js';
import { findStart } from '../src/world/start.js';
import { polyInfo, pointAt } from '../src/world/geometry.js';

const map = JSON.parse(readFileSync('data/map.json', 'utf8'));
const nav = new Navigator(map);
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };
const UP = -Math.PI / 2, RIGHT = 0, DOWN = Math.PI / 2, LEFT = Math.PI;

// the compass: the map is turned 30 degrees, so straight up on screen is a bearing of 30, NOT north
const rot = map.meta.rotationDegrees;
check('the map really is turned 30 degrees', rot === 30, `rotationDegrees=${rot}`);
check('up the screen = bearing 30 (NNE)', Math.abs(bearingOf(rot, UP) - 30) < 1e-6 && compassName(bearingOf(rot, UP)) === 'NNE', `${bearingOf(rot, UP).toFixed(1)} ${compassName(bearingOf(rot, UP))}`);
check('right on screen = bearing 120 (ESE)', Math.abs(bearingOf(rot, RIGHT) - 120) < 1e-6 && compassName(120) === 'ESE', `${bearingOf(rot, RIGHT).toFixed(1)}`);
check('down the screen = bearing 210 (SSW)', Math.abs(bearingOf(rot, DOWN) - 210) < 1e-6 && compassName(210) === 'SSW', `${bearingOf(rot, DOWN).toFixed(1)}`);
check('left on screen = bearing 300 (WNW)', Math.abs(bearingOf(rot, LEFT) - 300) < 1e-6 && compassName(300) === 'WNW', `${bearingOf(rot, LEFT).toFixed(1)}`);
check('north itself is 30 degrees anticlockwise from up (heading -PI/2 - 30 deg)', Math.abs(bearingOf(rot, UP - (30 * Math.PI) / 180)) < 1e-6, 'bearing 0');

// street names, from the real data
const s = findStart(map);
const car = (x, y, h, v = 10) => ({ x, y, vx: Math.cos(h) * v, vy: Math.sin(h) * v, heading: h });
let r = nav.locate(car(s.x, s.y, UP));
check('the start is on Marquette Avenue, heading NNE', r.street === 'Marquette Avenue' && r.compass === 'NNE', `${r.street}, ${r.compass} ${r.bearing.toFixed(0)}`);
check('heading up Marquette the next cross street is South 7th Street, about 60 m ahead', r.next?.name === 'South 7th Street' && r.next.dist > 45 && r.next.dist < 75, `${r.next?.name} in ${r.next?.dist.toFixed(0)} m`);
r = nav.locate(car(s.x, s.y, DOWN));
check('heading down Marquette the next cross street is South 8th Street', r.next?.name === 'South 8th Street' && r.next.dist > 55 && r.next.dist < 85, `${r.next?.name} in ${r.next?.dist.toFixed(0)} m; heading ${r.compass}`);

// along South 7th Street (y about -61) heading east (right on screen)
const y7 = -61;
r = nav.locate(car(-20, y7 - 4, RIGHT));
check('on South 7th Street heading ESE, the next street is Marquette Avenue', /7th/.test(r.street) && r.compass === 'ESE' && r.next?.name === 'Marquette Avenue', `${r.street}, ${r.compass}, next ${r.next?.name} in ${r.next?.dist.toFixed(0)} m`);

// South 8th Street is cut into short pieces: the search must look past the plain bends to the real junction
r = nav.locate(car(20, 66, LEFT));
check('heading west on South 8th Street the next street is Nicollet Mall, past the bends', r.street === 'South 8th Street' && r.next?.name === 'Nicollet Mall' && r.next.dist > 65 && r.next.dist < 90, `${r.street}, ${r.compass}, next ${r.next?.name} in ${r.next?.dist.toFixed(0)} m`);
r = nav.locate(car(-100, 62, RIGHT));
check('heading east on South 8th Street from the west the next street is Nicollet Mall', r.next?.name === 'Nicollet Mall', `next ${r.next?.name} in ${r.next?.dist.toFixed(0)} m`);

// at the junction of Marquette and South 7th
const j = map.graph.nodes.filter((n) => n.degree >= 3).sort((a, b) => Math.hypot(a.x - s.x, a.y - (-61)) - Math.hypot(b.x - s.x, b.y - (-61)))[0];
r = nav.locate(car(j.x, j.y, UP));
check('at the junction it names both streets', /&/.test(r.atJunction ?? '') && /Marquette/.test(r.atJunction) && /7th/.test(r.atJunction), r.atJunction ?? 'none');

// every named street in the data is recognised when the car sits on it, and the edge of the map is announced
const named = [...new Set(map.graph.edges.map((e) => e.name).filter(Boolean))];
let recognised = 0;
for (const name of named) {
  const e = map.graph.edges.filter((x) => x.name === name).sort((a, b) => b.length - a.length)[0];
  const p = e.points[Math.floor(e.points.length / 2)];
  if (nav.locate(car(p[0], p[1], UP, 0)).street === name) recognised++;
}
check(`all ${named.length} named streets are recognised from the middle of the street`, recognised === named.length, `${recognised}/${named.length}`);
const edgeNode = map.graph.nodes.filter((n) => n.boundary).find((n) => map.graph.edges.some((e) => (e.from === n.id || e.to === n.id) && e.length > 40));
const e0 = map.graph.edges.find((e) => (e.from === edgeNode.id || e.to === edgeNode.id) && e.length > 40);
const info0 = polyInfo(e0.points), atTo = e0.to === edgeNode.id;
const q = pointAt(info0, atTo ? info0.len - 30 : 30), inward = [q.x, q.y];
const outHeading = Math.atan2(edgeNode.y - inward[1], edgeNode.x - inward[0]);
r = nav.locate({ x: inward[0], y: inward[1], vx: Math.cos(outHeading) * 8, vy: Math.sin(outHeading) * 8, heading: outHeading });
check('driving toward the map edge, it says "the edge of the map"', r.next?.edge === true, `${r.street}: next ${r.next?.name} in ${r.next?.dist.toFixed(0)} m`);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
