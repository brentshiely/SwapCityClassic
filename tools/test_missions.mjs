// The mission state machine. Run: node tools/test_missions.mjs
import { MissionManager, resolveSpot } from '../src/missions/missions.js';

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };
const edge = (name, pts, layer = 0) => ({ name, points: pts, layer });
const world = { graph: { edges: [edge('Marquette Avenue', [[0, 0], [0, 100]]), edge('Nicollet Mall', [[-50, 0], [-50, 100]]), edge('3rd Avenue Bridge', [[500, 500], [500, 600]], 1), edge('Hennepin Avenue', [[300, 0], [300, 50]]), edge('South 8th Street', [[0, 60], [100, 60]])] } };
const store = { data: null, load() { return this.data ?? { cash: 0, done: [] }; }, save(s) { this.data = s; } };

check('a street name resolves to a point on that street, near the hint', (() => { const p = resolveSpot(world, { street: 'Marquette Avenue', near: [0, 90] }); return p && p.y === 100; })());
check('an unknown street resolves to nothing', resolveSpot(world, { street: 'Nowhere Road' }) === null);

const missions = [
  { id: 'a', title: 'A', giver: { street: 'Marquette Avenue', near: [0, 0] }, reward: 100, brief: 'go', steps: [{ kind: 'goto', target: { street: '3rd Avenue Bridge' }, radius: 10, need: 'car', time: 30, text: 'go' }] },
  { id: 'b', title: 'B', giver: { street: 'Nicollet Mall', near: [-50, 0] }, reward: 250, brief: 'steal', steps: [{ kind: 'steal', text: 's' }, { kind: 'goto', target: { street: 'Hennepin Avenue' }, radius: 10, need: 'stolen', text: 'd' }, { kind: 'kill', n: 2, text: 'k' }] },
  { id: 'c', title: 'C', giver: { street: 'Nowhere Road' }, reward: 1, brief: '', steps: [{ kind: 'kill', n: 1, text: '' }] },
];
const m = new MissionManager(world, store, missions);
check('a mission whose place does not exist is dropped', m.missions.length === 2);
check('the first mission is on offer at its phone only', m.offerAt(0, 2)?.id === 'a' && m.offerAt(50, 50) === null);
m.start(m.offerAt(0, 2), { kills: 0 });
check('while a mission runs nothing else is offered', m.offerAt(0, 2) === null);
let ev = m.update(1, { x: 500, y: 550, inCar: false, stolen: false, kills: 0 });
check('being there on foot does not count for a driving step', ev.length === 0 && m.active);
ev = m.update(1, { x: 500, y: 550, inCar: true, stolen: false, kills: 0 });
check('being there in a car completes it and pays', ev[0]?.type === 'complete' && m.cash === 100 && !m.active);
check('progress is saved', store.data.cash === 100 && store.data.done.includes('a'));
check('the next mission is offered after it', m.nextOffer().id === 'b');

m.start(m.nextOffer(), { kills: 0 });
ev = m.update(0.1, { x: 300, y: 25, inCar: true, stolen: false, kills: 0 });
check('a delivery does not count before the car is stolen', ev.length === 0 && m.objective().step === 1);
ev = m.update(0.1, { x: 0, y: 0, inCar: true, stolen: true, kills: 0 });
check('stealing a car moves on to the next step', ev[0]?.type === 'step' && m.objective().step === 2);
ev = m.update(0.1, { x: 300, y: 25, inCar: true, stolen: true, kills: 5 });
check('delivering the stolen car moves on again, and earlier kills do not count for the last step', ev[0]?.type === 'step' && m.objective().step === 3);
ev = m.update(0.1, { x: 300, y: 25, inCar: true, stolen: true, kills: 6 });
check('one kill is not two', ev.length === 0);
ev = m.update(0.1, { x: 300, y: 25, inCar: true, stolen: true, kills: 7 });
check('two kills finish it', ev[0]?.type === 'complete' && m.cash === 350);

const t = new MissionManager(world, store, [{ id: 't', title: 'T', giver: { street: 'Marquette Avenue' }, reward: 5, brief: '', steps: [{ kind: 'goto', target: { street: 'Hennepin Avenue' }, radius: 5, time: 10, text: '' }] }]);
t.done.clear(); t.start(t.nextOffer(), { kills: 0 });
for (let i = 0; i < 9; i++) t.update(1, { x: 0, y: 0, inCar: true, kills: 0 });
check('time left counts down', Math.round(t.objective().timeLeft) === 1, `${t.objective().timeLeft}`);
ev = []; for (let i = 0; i < 3; i++) ev.push(...t.update(1, { x: 0, y: 0, inCar: true, kills: 0 }));
check('running out of time fails the mission', ev.some((e) => e.type === 'fail') && !t.active && t.cash === 350);
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
