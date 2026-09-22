import { pointAt, polyInfo } from '../world/geometry.js';
import { mulberry32 } from '../render/rng.js';
import { buildNetwork } from './network.js';
import { Signals, CYCLE } from './signals.js';

// Traffic logic, no graphics: cars follow the real one-way / two-way street network, keep to the
// speed limit OpenStreetMap gives (else 25 mph), stop for red lights and for whatever is in front of
// them (other cars and the player), turn at junctions and leave at the map edge. Cars never crash
// into each other, they queue. Pure maths, so it can be tested in Node.
//
// Two scales. By default the cars roam the WHOLE map (`count` cars, anywhere). With a finite `radius` (metres) the cars only
// exist near the player, which is what a whole-city map needs: they spawn on streets within `radius` of the player (outside
// the view), and are removed once they are farther than radius * 1.3. Per-frame cost then depends on the cars nearby, not on
// the size of the city.

export const TYPES = [
  { name: 'compact', length: 3.9, width: 1.75, weight: 3 },
  { name: 'sedan', length: 4.5, width: 1.9, weight: 5 },
  { name: 'van', length: 5.3, width: 2.05, weight: 1.5 },
  { name: 'pickup', length: 5.4, width: 2.0, weight: 1.5 },
];
export const COLORS = ['#e8e8e2', '#b9bec2', '#7f8890', '#25292d', '#2f4a7a', '#3c5e45', '#7a2f2f', '#c9a23a', '#5a4635'];

const ACCEL = 2.6; // m/s^2
const B_COMFORT = 3.2; // braking used to plan for corners and speed changes
const B_STOP = 3.4; // braking used to plan a stop at a red light
const B_LEAD = 4.5; // braking used to plan a stop behind a car
const B_MAX = 8; // hardest braking allowed
const TURN_SPEED = 5.5; // m/s through a turn
const STRAIGHT_SPEED = 9.5; // m/s through a junction going straight
const STAND_GAP = 1.6; // m left between bumpers when stopped

const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const endTangent = (info) => { const p = info.pts, a = p[p.length - 2], b = p[p.length - 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
const startTangent = (info) => { const p = info.pts, a = p[0], b = p[1], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };

export class TrafficSim {
  constructor(map, { count = 16, seed = 1, radius = Infinity } = {}) {
    this.net = buildNetwork(map);
    this.signals = new Signals(this.net);
    this.rand = mulberry32(seed);
    this.count = count;
    this.radius = radius;
    this.cars = [];
    this.t = 0;
    this.nextId = 1;
    this.tmp = {};
    this.stats = { spawned: 0, despawned: 0, culled: 0, redRuns: 0, overlapSteps: 0, crashSteps: 0, ghosts: 0, wrongWay: 0 };
    this.cumWeights = null; // whole-map spawning only, built on first use
    if (isFinite(radius)) this.net.edgeGrid(); // index the streets now, not in the first frame
  }

  /** the point local traffic is kept around (the player, else the view's centre); null = whole-map traffic */
  anchor(view, player) {
    if (!isFinite(this.radius)) return null;
    return player ?? (view ? { x: view.cx, y: view.cy } : null);
  }

  // ---------- route building ----------
  edgeSeg(de, laneIdx) {
    const info = this.net.lane(de, laneIdx);
    const ji = this.net.jinfo.get(de.to), node = this.net.nodeById.get(de.to);
    return {
      kind: 'edge', de, lane: laneIdx, info, limit: de.speed,
      stopS: de.signal && ji ? info.len - ji.stopDist : null,
      boundaryEnd: node.boundary,
    };
  }

  connSeg(a, b) {
    const pa = a.info.pts[a.info.pts.length - 1], pb = b.info.pts[0];
    const ta = endTangent(a.info), tb = startTangent(b.info);
    const dx = pb[0] - pa[0], dy = pb[1] - pa[1];
    const det = ta[0] * tb[1] - tb[0] * ta[1];
    const ang = Math.atan2(det, ta[0] * tb[0] + ta[1] * tb[1]);
    const turn = Math.abs(ang) > 0.35;
    let cx = (pa[0] + pb[0]) / 2, cy = (pa[1] + pb[1]) / 2;
    if (Math.abs(det) > 0.05) {
      const u = (dx * tb[1] - tb[0] * dy) / det, v = (ta[0] * dy - dx * ta[1]) / det;
      if (u > 0 && v > 0 && u < 30 && v < 30) { cx = pa[0] + ta[0] * u; cy = pa[1] + ta[1] * u; }
    }
    const n = turn ? 12 : 4, pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, m = 1 - t;
      pts.push([m * m * pa[0] + 2 * m * t * cx + t * t * pb[0], m * m * pa[1] + 2 * m * t * cy + t * t * pb[1]]);
    }
    return { kind: 'conn', turn, info: polyInfo(pts), limit: turn ? TURN_SPEED : Math.min(a.limit, STRAIGHT_SPEED), stopS: null };
  }

  /** choose the next street at the end of the route and append the connector and the street */
  plan(c) {
    const last = c.segs[c.segs.length - 1];
    if (last.boundaryEnd) return false;
    const net = this.net;
    let opts = net.out.get(last.de.to).filter((o) => !(o.edge === last.de.edge && o.dir !== last.de.dir)); // no U-turns
    if (!opts.length) opts = net.out.get(last.de.to);
    if (!opts.length) return false;
    const h1 = net.headingAtEnd(last.de);
    const turnOf = (o) => {
      const h2 = Math.atan2(o.pts[1][1] - o.pts[0][1], o.pts[1][0] - o.pts[0][0]);
      const d = wrap(h2 - h1); // y is down, so a positive angle turns right
      return Math.abs(d) < 0.5 ? 'straight' : d > 0 ? 'right' : 'left';
    };
    // like real drivers: turn left only from the leftmost lane and right only from the rightmost,
    // so a turning car never cuts across the lane of the car beside it
    const laneOk = (o) => { const t = turnOf(o); return t === 'straight' || last.de.nl === 1 || (t === 'left' ? last.lane === 0 : last.lane === last.de.nl - 1); };
    const allowed = opts.filter(laneOk);
    if (allowed.length) opts = allowed;
    const weights = opts.map((o) => (turnOf(o) === 'straight' ? 6 : 2)); // straight ahead is likelier than turning
    let r = this.rand() * weights.reduce((a, b) => a + b, 0), pick = opts[0];
    for (let i = 0; i < opts.length; i++) { r -= weights[i]; if (r <= 0) { pick = opts[i]; break; } }
    let lane = Math.min(c.lane, pick.nl - 1);
    if (this.rand() < 0.3) lane = Math.floor(this.rand() * pick.nl);
    c.lane = lane;
    const next = this.edgeSeg(pick, lane);
    c.segs.push(this.connSeg(last, next), next);
    return true;
  }

  // ---------- spawning ----------
  spawn(de, laneIdx, s, typeName = null) {
    const total = TYPES.reduce((a, t) => a + t.weight, 0);
    let r = this.rand() * total, type = TYPES[0];
    for (const t of TYPES) { r -= t.weight; if (r <= 0) { type = t; break; } }
    if (typeName) type = TYPES.find((t) => t.name === typeName) ?? type;
    const seg = this.edgeSeg(de, laneIdx);
    const c = {
      id: this.nextId++, type: type.name, length: type.length, width: type.width,
      color: COLORS[Math.floor(this.rand() * COLORS.length)],
      segs: [seg], s, v: Math.min(seg.limit * 0.8, 8), lane: laneIdx, ghostT: 0, waitFor: null, braking: false,
      x: 0, y: 0, heading: 0, dead: false, age: 0,
    };
    this.plan(c);
    const p = pointAt(seg.info, s, this.tmp);
    c.x = p.x; c.y = p.y; c.heading = Math.atan2(p.ty, p.tx);
    c.layer = de.edge.layer | 0;
    this.cars.push(c);
    this.stats.spawned++;
    return c;
  }

  visible(x, y, view, margin) {
    return !!view && Math.abs(x - view.cx) < view.hw + margin && Math.abs(y - view.cy) < view.hh + margin;
  }

  /** the directed streets that come within `radius` of the anchor (long enough to spawn on), with running length totals for a weighted pick */
  nearbyEdges(a) {
    const list = [], cum = [];
    let sum = 0;
    this.net.edgeGrid().query(a.x, a.y, this.radius, (de) => { if (de.edge.length < 20) return; sum += de.edge.length; list.push(de); cum.push(sum); });
    return { list, cum, sum };
  }

  /** a random index by running totals (the first one whose total reaches r) */
  pickIndex(cum, r) {
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] >= r) hi = mid; else lo = mid + 1; }
    return lo;
  }

  fill(view, player) {
    const a = this.anchor(view, player);
    let near = null; // the streets around the player, looked up only when a car is actually needed
    // (a lot of nearby streets are too short or too close to a light to hold a car, so the local first fill needs more tries)
    for (let tries = 0, max = a ? 40 + 3 * this.count : 40; this.cars.length < this.count && tries < max; tries++) {
      let de;
      if (a) {
        near ??= this.nearbyEdges(a);
        if (!near.list.length) break;
        de = near.list[this.pickIndex(near.cum, this.rand() * near.sum)];
      } else {
        // pick streets to spawn on in proportion to their length
        if (!this.cumWeights) { let sum = 0; this.cumWeights = this.net.directed.map((d) => (sum += d.edge.length)); }
        const cw = this.cumWeights;
        de = this.net.directed[this.pickIndex(cw, this.rand() * cw[cw.length - 1])];
      }
      const lane = Math.floor(this.rand() * de.nl), info = this.net.lane(de, lane);
      if (info.len < 25) continue;
      const stopS = de.signal ? info.len - (this.net.jinfo.get(de.to)?.stopDist ?? 10) : null;
      // a new car must have room to stop for the light ahead, so never spawn close to a stop line
      const room = stopS != null ? stopS - 34 - 6 : info.len - 22;
      if (room < 1) continue;
      const s = 6 + this.rand() * room;
      const p = pointAt(info, s, this.tmp);
      if (a && Math.hypot(p.x - a.x, p.y - a.y) > this.radius) continue; // only near the player
      if (this.visible(p.x, p.y, view, 18)) continue; // cars never pop in where the player can see
      if (player && Math.hypot(p.x - player.x, p.y - player.y) < 30) continue;
      if (this.cars.some((o) => Math.hypot(o.x - p.x, o.y - p.y) < 16)) continue;
      this.spawn(de, lane, s);
    }
  }

  // ---------- driving ----------
  /** where car `o` will be after travelling `ds` more metres along its own planned route */
  posAlong(o, ds, out) {
    let s = o.s + ds, i = 0;
    while (i < o.segs.length - 1 && s > o.segs[i].info.len) { s -= o.segs[i].info.len; i++; }
    return pointAt(o.segs[i].info, Math.min(s, o.segs[i].info.len), out);
  }

  /**
   * The nearest thing on this car's path (another car or the player) as {gap, who}, or null. gap = metres from the
   * front bumper. Other cars count both where they are now and where they will be when this car gets there,
   * which is what stops crossing, merging and turning cars from meeting in a junction.
   */
  leadGap(c, player) {
    const L = 6 + c.v * 2.2, rMe = c.width / 2 - 0.05, tmp = this.tmp, tmp2 = this.tmp2 ?? (this.tmp2 = {});
    // nothing farther from this car than the probe reaches (plus what the other thing can move meanwhile) can matter: skip it fast
    const reach = c.length / 2 + L;
    for (let d = c.length / 2 + 0.3; d <= c.length / 2 + L; d += 1.5) {
      let s = c.s + d, i = 0;
      while (i < c.segs.length - 1 && s > c.segs[i].info.len) { s -= c.segs[i].info.len; i++; }
      pointAt(c.segs[i].info, s, tmp);
      const x = tmp.x, y = tmp.y;
      const t = d / Math.max(c.v, 3); // when this car would be at this point
      if (c.ghostT <= 0) {
        for (const o of this.cars) {
          if (o === c || o.dead || !o.segs.length || (o.layer | 0) !== (c.layer | 0)) continue; // a car on a bridge or under it is not in the way
          const far = reach + 6 + o.length + 4 * o.v;
          if (Math.abs(o.x - c.x) > far || Math.abs(o.y - c.y) > far) continue;
          if (this.hits(o, x, y, rMe)) return { gap: d - c.length / 2, who: o };
          // cars ahead of us in our own lane are handled by the plain rule above; everything else is checked in the future too
          const os = o.segs[0], cs = c.segs[0];
          const sameLane = os.kind === 'edge' && cs.kind === 'edge' && os.de === cs.de && os.lane === cs.lane;
          // predicted meetings: only the younger car gives way, so two cars can never both hold for each other
          if (!sameLane && o.v > 0.5 && t < 4 && o.id < c.id) {
            const q = this.posAlong(o, o.v * t, tmp2);
            if (Math.hypot(q.x - x, q.y - y) < rMe + o.width / 2 + 0.1) return { gap: d - c.length / 2, who: null };
          }
        }
      }
      // people in the road: stop for them (this.peds is set by the game or the tests)
      if (this.peds) {
        for (const p of this.peds) {
          if (p.dead) continue;
          const pf = reach + 3 + 3 * Math.hypot(p.vx, p.vy);
          if (Math.abs(p.x - c.x) > pf || Math.abs(p.y - c.y) > pf) continue;
          // where the person is now, and where they will be when this car gets there (someone stepping off the kerb)
          const tt = Math.min(3, t), pr = rMe + (p.edge?.type === 'cross' ? 1.3 : 0.45); // anyone on a crosswalk is given more room
          if (Math.hypot(p.x - x, p.y - y) < pr || Math.hypot(p.x + p.vx * tt - x, p.y + p.vy * tt - y) < pr) return { gap: d - c.length / 2, who: null };
        }
      }
      if (player && (player.layer | 0) === (c.layer | 0) && this.hits(player, x, y, rMe)) return { gap: d - c.length / 2, who: 'player' };
      // the player's parked car (while they are on foot) and the player walking: cars stop for both
      if (this.obstacles) for (const ob of this.obstacles) if ((ob.layer | 0) === (c.layer | 0) && this.hits(ob, x, y, rMe)) return { gap: d - c.length / 2, who: 'player' };
      if (this.walkers) for (const p of this.walkers) if ((p.layer | 0) === (c.layer | 0) && Math.hypot(p.x - x, p.y - y) < rMe + 0.9) return { gap: d - c.length / 2, who: 'player' };
    }
    return null;
  }

  /** points every metre along a connector, for path-crossing tests */
  dense(seg) {
    if (seg.denseSamples) return seg.denseSamples;
    const out = [], tmp = {};
    for (let s = 0; s <= seg.info.len; s += 1) { pointAt(seg.info, s, tmp); out.push([tmp.x, tmp.y]); }
    return (seg.denseSamples = out);
  }

  /** bounding box of a connector, so two connectors far apart are ruled out without comparing their points */
  bbox(seg) {
    if (seg.bb) return seg.bb;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of seg.info.pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return (seg.bb = [x0 - 3.4, y0 - 3.4, x1 + 3.4, y1 + 3.4]);
  }

  crosses(a, b) {
    const ba = this.bbox(a), bb = this.bbox(b);
    if (ba[0] > bb[2] || bb[0] > ba[2] || ba[1] > bb[3] || bb[1] > ba[3]) return false;
    const A = this.dense(a), B = this.dense(b);
    for (const p of A) for (const q of B) if (Math.hypot(p[0] - q[0], p[1] - q[1]) < 3.4) return true;
    return false;
  }

  /**
   * Junction right of way. Before this car enters a junction it must give way to any car whose path through the
   * junction crosses its own and that is already in it, or gets there first (going straight beats turning).
   * Returns the distance to hold at, or null if clear.
   */
  holdForJunction(c) {
    const seg = c.segs[0], conn = c.segs[1];
    if (seg.kind !== 'edge' || !conn || conn.kind !== 'conn') return null;
    // the line where a car commits to the junction: the stop line, or the same distance from the junction if unsignalized.
    // A car already past it must keep going (it is in the way of others if it stops), so only cars before it ever hold.
    const line = seg.stopS ?? seg.info.len - (this.net.jinfo.get(seg.de.to)?.stopDist ?? 8);
    if (c.s + c.length / 2 >= line - 0.2) { c.holdFor = null; return null; }
    const myDist = seg.info.len - c.s;
    const myTime = myDist / Math.max(c.v, 2);
    const myRank = conn.turn ? 1 : 0;
    for (const o of this.cars) {
      if (o === c || o.dead || !o.segs.length || (o.layer | 0) !== (c.layer | 0)) continue;
      const os = o.segs[0];
      // queue-mates on the same street are handled by the car-in-front rule, not by right of way
      if (os.kind === 'edge' && os.de === seg.de) continue;
      let oConn = null, oTime = 0, inside = false;
      if (os.kind === 'conn') { oConn = os; inside = true; }
      else if (o.segs[1]?.kind === 'conn' && os.de.to === seg.de.to) {
        // approaching the same junction: not a threat if it is held at a red light or is not really moving yet
        const distEnd = os.info.len - o.s;
        if (os.stopS != null && o.s + o.length / 2 < os.stopS && this.signals.state(os.de, this.t) === 'red') continue;
        if (o.v < 0.5 && distEnd > 6) continue;
        oConn = o.segs[1]; oTime = distEnd / Math.max(o.v, 2);
      }
      if (!oConn || !this.crosses(conn, oConn)) continue;
      const oRank = oConn.turn ? 1 : 0;
      const theyFirst = inside || oRank < myRank || (oRank === myRank && (oTime < myTime - 0.3 || (Math.abs(oTime - myTime) <= 0.3 && o.id < c.id)));
      if (theyFirst) { c.holdFor = o; c.holdWhy = inside ? 'inside' : 'arrives first'; return line; }
    }

    // do not enter the junction if the street beyond it is jammed right at its start (do not block the box)
    const exit = c.segs[2];
    if (exit && exit.kind === 'edge') {
      for (const o of this.cars) {
        if (o === c || o.dead || !o.segs.length) continue;
        const os = o.segs[0];
        if (os.kind === 'edge' && os.de === exit.de && os.lane === exit.lane && o.s < c.length + 6 && o.v < 2.5) {
          c.holdFor = o; c.holdWhy = 'exit jammed';
          return line;
        }
      }
    }
    c.holdFor = null;
    return null;
  }

  /** how deep the outlines of two cars (three circles each) overlap, in metres (0 if they do not) */
  overlapDepth(a, b) {
    const ca = Math.cos(a.heading), sa = Math.sin(a.heading), cb = Math.cos(b.heading), sb = Math.sin(b.heading);
    let deepest = 0;
    for (const ka of [-0.3, 0, 0.3]) {
      const ax = a.x + ca * a.length * ka, ay = a.y + sa * a.length * ka;
      for (const kb of [-0.3, 0, 0.3]) {
        const bx = b.x + cb * b.length * kb, by = b.y + sb * b.length * kb;
        deepest = Math.max(deepest, a.width / 2 + b.width / 2 - Math.hypot(ax - bx, ay - by));
      }
    }
    return deepest;
  }

  hits(o, x, y, r) {
    const len = o.length ?? 4.5, w = o.width ?? 1.9, ro = w / 2 + 0.1;
    const cx = Math.cos(o.heading), sx = Math.sin(o.heading);
    for (const k of [-0.3, 0, 0.3]) {
      const ox = o.x + cx * len * k, oy = o.y + sx * len * k;
      if (Math.hypot(ox - x, oy - y) < r + ro) return true;
    }
    return false;
  }

  driveCar(c, dt, player) {
    const seg = c.segs[0];
    let vt = seg.limit;

    // slow down in time for corners and lower limits on the road ahead
    let dist = seg.info.len - c.s;
    for (let i = 1; i < c.segs.length && i <= 2; i++) {
      const nx = c.segs[i];
      vt = Math.min(vt, Math.sqrt(nx.limit ** 2 + 2 * B_COMFORT * Math.max(0, dist - c.length / 2)));
      dist += nx.info.len;
    }

    // traffic light
    if (seg.stopS != null) {
      const d = seg.stopS - (c.s + c.length / 2);
      if (d > -0.6) {
        const st = this.signals.state(seg.de, this.t);
        // on yellow, go through only if the car can get past the line before the light turns red
        const yellowLeft = CYCLE.green + CYCLE.yellow - this.signals.local(seg.de, this.t);
        const clears = st === 'yellow' && d + 0.5 <= c.v * yellowLeft;
        if (st === 'red' || (st === 'yellow' && !clears)) vt = Math.min(vt, Math.sqrt(2 * B_STOP * Math.max(0, d - 0.9)));
      }
    }

    // give way inside junctions
    const hold = this.holdForJunction(c);
    if (hold !== null) {
      const d = hold - (c.s + c.length / 2);
      if (d > -0.6) vt = Math.min(vt, Math.sqrt(2 * B_STOP * Math.max(0, d - 0.9)));
    }

    // whatever is in front
    const lead = this.leadGap(c, player);
    c.waitFor = lead ? lead.who : null;
    if (lead) vt = Math.min(vt, Math.sqrt(2 * B_LEAD * Math.max(0, lead.gap - STAND_GAP)));

    const v0 = c.v;
    c.v = c.v < vt ? Math.min(vt, c.v + ACCEL * dt) : Math.max(vt, c.v - B_MAX * dt);
    c.braking = (v0 - c.v) / dt > 0.7 || (c.v < 0.3 && vt < 0.3);
    if (c.ghostT > 0) c.ghostT -= dt;

    // move along the route
    const runLine = seg.stopS != null ? seg.stopS + 0.5 : 0; // a car that stops a hair over the line is stopping, not running the light
    const before = seg.stopS != null ? c.s + c.length / 2 : 0;
    c.s += c.v * dt;
    if (seg.stopS != null && before < runLine && c.s + c.length / 2 >= runLine) {
      const st = this.signals.state(seg.de, this.t);
      const local = this.signals.local(seg.de, this.t);
      if (st === 'red' && local - (CYCLE.green + CYCLE.yellow) > 1.0) {
        this.stats.redRuns++;
        this.stats.log?.push({ kind: 'red', t: +this.t.toFixed(1), id: c.id, v: +c.v.toFixed(1), redFor: +(local - CYCLE.green - CYCLE.yellow).toFixed(1), key: seg.de.key });
      }
    }
    while (c.segs.length && c.s >= c.segs[0].info.len) {
      const done = c.segs.shift();
      c.s -= done.info.len;
      if (done.kind === 'edge' && done.de.dir === -1 && done.de.edge.oneway) this.stats.wrongWay++;
      if (c.segs.length < 3 && c.segs.length && c.segs[c.segs.length - 1].kind === 'edge') this.plan(c);
    }
    const cur = c.segs[0];
    if (!cur) { c.dead = true; return; }
    if (cur.kind === 'edge' && cur.boundaryEnd && cur.info.len - c.s < 4) { c.dead = true; return; } // leaves the map
    if (cur.kind === 'edge' && c.segs.length < 3) this.plan(c);

    const p = pointAt(cur.info, c.s, this.tmp);
    const target = Math.atan2(p.ty, p.tx);
    c.heading += wrap(target - c.heading) * (1 - Math.exp(-12 * dt));
    c.x = p.x; c.y = p.y;
    if (cur.kind === 'edge') c.layer = cur.de.edge.layer | 0; // on a bridge, at street level, in a tunnel (a connector keeps the layer it left)
    c.age += dt;
  }

  /**
   * @param dt seconds
   * @param player {x, y, heading} the player's car, an obstacle the traffic stops for
   * @param view {cx, cy, hw, hh} what the player can currently see, in metres (cars spawn outside it)
   */
  update(dt, player, view) {
    dt = Math.min(dt, 0.05);
    this.t += dt;
    // local traffic: cars that fell far behind the player go (never while the player could see them)
    const a = this.anchor(view, player);
    if (a) {
      const far2 = (this.radius * 1.3) ** 2;
      for (const c of this.cars) {
        if (c.dead || (c.x - a.x) ** 2 + (c.y - a.y) ** 2 <= far2 || this.visible(c.x, c.y, view, 18)) continue;
        c.dead = true; this.stats.culled++;
      }
    }
    for (const c of this.cars) if (!c.dead) this.driveCar(c, dt, player);
    for (let i = this.cars.length - 1; i >= 0; i--) {
      if (this.cars[i].dead) { this.cars.splice(i, 1); this.stats.despawned++; }
    }
    // a real deadlock is a ring of cars each waiting for the next: let the lowest-numbered one through
    for (const c of this.cars) {
      if (typeof c.waitFor !== 'object' || !c.waitFor || c.ghostT > 0) continue;
      let x = c.waitFor, n = 0, minId = c.id, ring = false;
      while (x && typeof x === 'object' && n++ < 40) {
        if (x === c) { ring = true; break; }
        minId = Math.min(minId, x.id);
        x = x.waitFor;
      }
      if (ring && c.id === minId) {
        c.ghostT = 3; this.stats.ghosts++;
        this.stats.log?.push({ kind: 'ring', t: +this.t.toFixed(1), members: (() => { const m = [c]; let y = c.waitFor; while (y && typeof y === 'object' && y !== c && m.length < 12) { m.push(y); y = y.waitFor; } return m.map((q) => `${q.id}@${q.segs[0].kind}:${q.segs[0].de?.key ?? ''}(s${q.s.toFixed(0)}/${q.segs[0].info.len.toFixed(0)},v${q.v.toFixed(1)})`); })() });
      }
    }
    this.fill(view, player);
    // bookkeeping for tests: how often do two cars overlap?
    for (let i = 0; i < this.cars.length; i++) {
      for (let j = i + 1; j < this.cars.length; j++) {
        const a = this.cars[i], b = this.cars[j];
        if (a.ghostT > 0 || b.ghostT > 0) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) > 7) continue;
        const depth = this.overlapDepth(a, b);
        if (depth > 0.6) this.stats.crashSteps++;
        if (depth > 0.15) {
          this.stats.overlapSteps++;
          this.stats.log?.push({ kind: 'overlap', t: +this.t.toFixed(1), a: a.id, b: b.id, d: +Math.hypot(a.x - b.x, a.y - b.y).toFixed(2), ka: a.segs[0].kind + ':' + (a.segs[0].de?.key ?? ''), kb: b.segs[0].kind + ':' + (b.segs[0].de?.key ?? ''), va: +a.v.toFixed(1), vb: +b.v.toFixed(1) });
        }
      }
    }
  }
}

/** The player's car cannot drive through traffic: push it out of any traffic car it overlaps (traffic itself never moves). */
export function pushPlayerOutOfTraffic(car, cars) {
  const pc = Math.cos(car.heading), ps = Math.sin(car.heading);
  const mine = [-1.3, 0, 1.3].map((k) => [car.x + pc * k, car.y + ps * k, 0.97]);
  let hit = false;
  for (const o of cars) {
    if ((o.layer | 0) !== (car.layer | 0)) continue;
    const oc = Math.cos(o.heading), os = Math.sin(o.heading), ro = o.width / 2 + 0.05;
    for (const k of [-0.3, 0, 0.3]) {
      const ox = o.x + oc * o.length * k, oy = o.y + os * o.length * k;
      for (const m of mine) {
        let dx = m[0] - ox, dy = m[1] - oy;
        const dist = Math.hypot(dx, dy), need = m[2] + ro;
        if (dist >= need) continue;
        if (dist < 1e-6) { dx = pc; dy = ps; }
        const nx = dist < 1e-6 ? dx : dx / dist, ny = dist < 1e-6 ? dy : dy / dist, depth = need - dist;
        car.x += nx * depth; car.y += ny * depth;
        m[0] += nx * depth; m[1] += ny * depth;
        const vn = car.vx * nx + car.vy * ny;
        if (vn < 0) { car.vx -= 1.12 * vn * nx; car.vy -= 1.12 * vn * ny; }
        hit = true;
      }
    }
  }
  return hit;
}
