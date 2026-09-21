// Missions: a small state machine. A mission is a list of steps (go somewhere, steal a car, take out some people), each perhaps with a time
// limit; finishing the last one pays. Places are given by street name and resolved against the road graph, so they land on the real streets.
// Pure logic, no Phaser: the game feeds it where the player is each frame and shows what it says (objective text, target, time left).

export const MISSIONS = [
  {
    id: 'joyride', title: 'Joyride', giver: { street: 'Marquette Avenue', near: [70, 0] }, reward: 500,
    brief: 'A friend needs a driver. Take the car over the Mississippi on the 3rd Avenue Bridge, fast.',
    steps: [{ kind: 'goto', target: { street: '3rd Avenue Bridge' }, radius: 16, need: 'car', time: 110, text: 'Drive to the 3rd Avenue Bridge' }],
  },
  {
    id: 'borrowed', title: 'Borrowed Wheels', giver: { street: 'Nicollet Mall', near: [-56, 0] }, reward: 900,
    brief: 'Get out. Take somebody else\'s car (E next to it) and deliver it to Hennepin Avenue.',
    steps: [
      { kind: 'steal', text: 'Steal a car: get out (E) and take one from the street' },
      { kind: 'goto', target: { street: 'Hennepin Avenue', near: [-30, -1060] }, radius: 20, need: 'stolen', time: 160, text: 'Deliver the stolen car to Hennepin Avenue' },
    ],
  },
  {
    id: 'legwork', title: 'Leg Work', giver: { street: 'South 8th Street', near: [0, 60] }, reward: 700,
    brief: 'No wheels this time. Walk to the river bank, and clear the crowd off the street on the way back.',
    steps: [
      { kind: 'goto', target: { street: 'Nicollet Mall', near: [-56, 480] }, radius: 10, need: 'foot', time: 120, text: 'Walk south along Nicollet Mall to the park' },
      { kind: 'kill', n: 3, time: 90, text: 'Shoot 3 people (Space or click)' },
    ],
  },
];

const polylineMiddle = (pts) => {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  let d = len / 2;
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (d <= l || i === pts.length - 1) { const t = l ? d / l : 0; return { x: pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, y: pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t }; }
    d -= l;
  }
  return { x: pts[0][0], y: pts[0][1] };
};

/** where a spec {street, near} or {x, y} is: the point of that street's road closest to `near` (else its middle) */
export function resolveSpot(world, spec) {
  if (spec.x !== undefined) return { x: spec.x, y: spec.y };
  let best = null, bd = Infinity;
  for (const e of world.graph.edges) {
    if (e.name !== spec.street || (e.layer | 0) < 0) continue;
    for (const p of e.points) {
      const d = spec.near ? Math.hypot(p[0] - spec.near[0], p[1] - spec.near[1]) : 0;
      if (d < bd || (!spec.near && !best)) { bd = d; best = { x: p[0], y: p[1] }; }
    }
    if (!spec.near) return polylineMiddle(e.points);
  }
  return best;
}

export class MissionManager {
  /** @param world anything with graph.edges (named); @param save {load(): {cash, done}, save(state)} where progress is kept */
  constructor(world, save = null, missions = MISSIONS) {
    this.save = save;
    const s = save?.load() ?? { cash: 0, done: [] };
    this.cash = s.cash | 0; this.done = new Set(s.done ?? []);
    this.missions = missions.map((m) => ({
      ...m, spot: resolveSpot(world, m.giver),
      steps: m.steps.map((st) => ({ ...st, spot: st.target ? resolveSpot(world, st.target) : null })),
    })).filter((m) => m.spot && m.steps.every((st) => !st.target || st.spot));
    this.active = null; this.step = 0; this.stepT = 0; this.killBase = 0; this.message = null;
  }

  /** the next mission still to be done (in order) */
  nextOffer() { return this.missions.find((m) => !this.done.has(m.id)) ?? null; }

  /** the mission on offer if the player stands at its phone (and none is running) */
  offerAt(x, y, radius = 5) {
    if (this.active) return null;
    const m = this.nextOffer();
    return m && Math.hypot(x - m.spot.x, y - m.spot.y) < radius ? m : null;
  }

  start(mission, ctx) {
    this.active = mission; this.step = 0; this.stepT = 0; this.killBase = ctx.kills | 0; this.message = { text: mission.brief, t: 6 };
  }

  /** what to show: { title, text, target: {x, y} | null, timeLeft | null } or null */
  objective() {
    if (!this.active) return null;
    const st = this.active.steps[this.step];
    return { title: this.active.title, text: st.text, target: st.spot ?? null, timeLeft: st.time ? Math.max(0, st.time - this.stepT) : null, step: this.step + 1, steps: this.active.steps.length };
  }

  /** ctx: {x, y, inCar, stolen, kills}. Returns the events of this frame: 'step', 'complete', 'fail'. */
  update(dt, ctx) {
    const events = [];
    if (this.message) { this.message.t -= dt; if (this.message.t <= 0) this.message = null; }
    if (!this.active) return events;
    const st = this.active.steps[this.step];
    this.stepT += dt;
    let ok = false;
    if (st.kind === 'goto') {
      const near = Math.hypot(ctx.x - st.spot.x, ctx.y - st.spot.y) < st.radius;
      const how = !st.need || (st.need === 'car' && ctx.inCar) || (st.need === 'foot' && !ctx.inCar) || (st.need === 'stolen' && ctx.inCar && ctx.stolen);
      ok = near && how;
    } else if (st.kind === 'steal') ok = !!(ctx.inCar && ctx.stolen);
    else if (st.kind === 'kill') ok = (ctx.kills | 0) - this.killBase >= st.n;
    if (ok) {
      this.step++; this.stepT = 0; this.killBase = ctx.kills | 0;
      if (this.step >= this.active.steps.length) {
        const m = this.active;
        this.cash += m.reward; this.done.add(m.id); this.active = null;
        this.message = { text: `Mission passed: ${m.title}   +$${m.reward}`, t: 5, good: true };
        this.persist(); events.push({ type: 'complete', mission: m });
      } else events.push({ type: 'step', mission: this.active, step: this.step });
    } else if (st.time && this.stepT > st.time) {
      const m = this.active; this.active = null;
      this.message = { text: `Mission failed: ${m.title} (out of time)`, t: 5, bad: true };
      events.push({ type: 'fail', mission: m });
    }
    return events;
  }

  abandon() { if (this.active) { this.message = { text: `Mission abandoned: ${this.active.title}`, t: 3, bad: true }; this.active = null; } }

  persist() { this.save?.save({ cash: this.cash, done: [...this.done] }); }
}
