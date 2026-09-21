import { pointAt } from '../world/geometry.js';
import { mulberry32 } from '../render/rng.js';
import { PedNetwork } from './pedNetwork.js';

// Pedestrian logic, no graphics. People walk the sidewalks, round corners and across the street at the
// painted crosswalks, waiting at the kerb until the light gives them a turn to cross. They scatter from a
// car coming at them and are nudged aside, unharmed, if it touches them. Pure maths, testable in Node.

export const SKINS = ['#f1c9a5', '#d9a679', '#a9714a', '#6b4530'];
export const CLOTHES = ['#c0392b', '#2e6da4', '#2f8f5b', '#d9a521', '#7b4fa3', '#e07b39', '#3d3d3d', '#e8e6df', '#1f5a5a', '#b5527a'];

const RADIUS = 0.3; // metres
const WALK_START = 12.5, WALK_END = 19.0; // seconds into a street's red phase: the cross street is green, people may start crossing
const FLEE_SPEED = 3.6, STUMBLE_SPEED = 2.4;
const SPAWN_RADIUS = 105; // metres around the player where people appear
const RECYCLE_RADIUS = 135; // people who wander farther than this are replaced by new ones near the player
const CROSS_HURRY = 1.3; // people walk faster across the road
const ROAD_CLEAR_BY = 24.0; // a crossing must be finished by then (green returns at 25)
const KEEP_FACTOR = 1.6; // city mode: pieces of the network farther than radius * this from the player are forgotten
const REMOVE_FACTOR = 1.3; // city mode: people farther than radius * this from the player are removed
const HOUSEKEEP = 1.0, RETRY = 2.0; // city mode: seconds between forgetting far pieces / retrying nodes whose tiles were not loaded

export class PedSim {
  /**
   * blocked: (x, y) => true inside a building. cars: the traffic's cars, so people do not step in front of one (set later if needed).
   * Whole-city mode (off by default): with `radius` (metres, e.g. 350) the walking network is built lazily around the player
   * as update() runs (at most `buildBudget` junctions per call) and only where `isLoaded(x, y)` says building data is loaded;
   * people appear only near the player and are removed beyond radius * 1.3. Without `radius` everything is built up front, as ever.
   */
  constructor(map, signals, { count = 80, seed = 1, blocked = null, radius = 0, isLoaded = null, buildBudget = 6 } = {}) {
    this.signals = signals;
    this.cars = [];
    this.radius = radius; this.buildBudget = buildBudget;
    this.net = new PedNetwork(map, signals, { blocked, isLoaded });
    if (!radius) this.net.buildAll();
    this.nextKeep = 0; this.nextRetry = RETRY; this.spawnCache = null;
    this.rand = mulberry32(seed + 1000);
    this.count = count;
    this.peds = [];
    this.t = 0;
    this.nextId = 1;
    this.tmp = {};
    this.stats = { spawned: 0, left: 0, crossings: 0, badCrossStarts: 0, scatters: 0, nudges: 0, blocked: 0, frontier: 0 };
    const walk = radius ? [] : this.net.edges.filter((e) => e.type === 'walk' && !e.blocked);
    this.spawnEdges = walk;
    this.spawnWeight = walk.reduce((a, e) => a + e.len, 0);
  }

  /** city mode: call when building tiles load or unload, so junctions that were waiting for them are built */
  tilesChanged() { this.net.tilesChanged(); }

  /** city mode: build the network round the player in one go and seed the crowd (do this once at the start; update() does it in small steps) */
  prime(player, view = null) {
    if (!this.radius) return;
    this.net.ensureNear(player.x, player.y, this.radius);
    for (let i = 0; i < 10 && this.peds.length < this.count; i++) this.fill(view, player);
  }

  // ---------- spawning ----------
  spawn(edge, s, dir) {
    const p = {
      id: this.nextId++, edge, s, dir, state: 'walk', v0: 1.1 + this.rand() * 0.5, v: 0, dead: false,
      skin: Math.floor(this.rand() * SKINS.length), clothes: Math.floor(this.rand() * CLOTHES.length),
      lat: (this.rand() - 0.5) * 1.4, x: 0, y: 0, heading: 0, dist: 0, prev: null,
      fleeT: 0, fx: 0, fy: 0, waitEdge: null, vx: 0, vy: 0,
    };
    this.place(p);
    this.peds.push(p);
    this.stats.spawned++;
    return p;
  }

  /** put a walking ped at its place along its edge (with its sideways offset, smaller when crossing) */
  place(p) {
    const e = p.edge, s = p.dir > 0 ? p.s : e.len - p.s;
    pointAt(e.info, s, this.tmp);
    const tx = this.tmp.tx * p.dir, ty = this.tmp.ty * p.dir;
    const lat = e.type === 'cross' ? p.lat * 0.5 : p.lat;
    p.x = this.tmp.x - ty * lat; p.y = this.tmp.y + tx * lat;
    p.heading = Math.atan2(ty, tx);
  }

  visible(x, y, view, margin) {
    return !!view && Math.abs(x - view.cx) < view.hw + margin && Math.abs(y - view.cy) < view.hh + margin;
  }

  /** city mode: candidate walk edges are the ones near the player, from the network's spatial index (cached until the player or the network moves on) */
  localSpawnEdges(player) {
    const c = this.spawnCache;
    if (c && c.ver === this.net.version && Math.hypot(c.x - player.x, c.y - player.y) < 30) return c;
    const edges = [];
    this.net.queryEdges(player.x, player.y, SPAWN_RADIUS + 30, (e) => { if (e.type === 'walk' && !e.blocked) edges.push(e); });
    return (this.spawnCache = { ver: this.net.version, x: player.x, y: player.y, edges, weight: edges.reduce((a, e) => a + e.len, 0) });
  }

  fill(view, player) {
    let spawnEdges = this.spawnEdges, spawnWeight = this.spawnWeight;
    if (this.radius) {
      if (!player || this.peds.length >= this.count) return;
      const c = this.localSpawnEdges(player);
      spawnEdges = c.edges; spawnWeight = c.weight;
      if (!spawnEdges.length) return;
    }
    for (let tries = 0; this.peds.length < this.count && tries < 40; tries++) {
      let r = this.rand() * spawnWeight, edge = spawnEdges[0];
      for (const e of spawnEdges) { r -= e.len; if (r <= 0) { edge = e; break; } }
      const s = 4 + this.rand() * Math.max(1, edge.len - 8), dir = this.rand() < 0.5 ? 1 : -1;
      pointAt(edge.info, s, this.tmp);
      if (this.visible(this.tmp.x, this.tmp.y, view, 12)) continue; // never appear where the player can see
      if (player) {
        // keep the crowd around the player: close enough to be walking into view soon, never on top of them
        const d = Math.hypot(this.tmp.x - player.x, this.tmp.y - player.y);
        if (d < 25 || d > SPAWN_RADIUS) continue;
      }
      this.spawn(edge, dir > 0 ? s : edge.len - s, dir); // spawn() counts s along the walking direction; the checks above used s along the edge
    }
  }

  // ---------- crossing rules ----------
  /** how long this person needs from the kerb until they are clear of the road (the first ~2 m of the crossing is pavement) */
  crossTime(edge, p) { return Math.max(3, edge.len - 2) / (p.v0 * CROSS_HURRY); }

  /** may this person step off the kerb onto this crossing now? Only while the cross street has green, with time to
   *  finish, and no car moving near where they would step out. */
  crossOpen(edge, p, node) {
    const local = this.signals.localAxis(edge.nodeId, edge.axis, this.t);
    if (local < WALK_START || local + this.crossTime(edge, p) > ROAD_CLEAR_BY) return false;
    const n = node ?? edge.a;
    for (const c of this.cars) if (!c.dead && c.v > 1.5 && Math.hypot(c.x - n.x, c.y - n.y) < 22) return false;
    return true;
  }

  // ---------- walking ----------
  chooseNext(p, node) {
    let options = node.edges.filter((e) => e !== p.edge && !e.blocked);
    if (!options.length) options = node.edges.filter((e) => e !== p.edge);
    if (!options.length) return p.edge;
    const arrivedVia = p.edge.type;
    const weight = (e) => {
      if (arrivedVia === 'walk') return e.type === 'corner' ? 6 : 1; // along a street: mostly turn the corner
      if (arrivedVia === 'corner') return e.type === 'cross' ? 5 : 3;
      return e.type === 'walk' ? 4 : 4; // just crossed: carry on along the street or round the corner
    };
    let r = this.rand() * options.reduce((a, e) => a + weight(e), 0);
    for (const e of options) { r -= weight(e); if (r <= 0) return e; }
    return options[0];
  }

  advance(p, dt) {
    if (p.state === 'wait') {
      if (this.crossOpen(p.waitEdge, p, p.waitNode)) { this.startEdge(p, p.waitEdge, p.waitNode); p.state = 'walk'; }
      else { p.v = 0; p.vx = 0; p.vy = 0; return; }
    }
    p.v = p.v0 * (p.edge.type === 'cross' ? CROSS_HURRY : 1);
    p.s += p.v * dt; p.dist += p.v * dt;
    while (p.s >= p.edge.len) {
      const node = p.dir > 0 ? p.edge.b : p.edge.a;
      if (node.terminal || node.frontier) { p.dead = true; if (node.terminal) this.stats.left++; else this.stats.frontier++; return; } // frontier: the junction is not built yet
      const next = this.chooseNext(p, node);
      const over = p.s - p.edge.len;
      if (next.type === 'cross' && !this.crossOpen(next, p, node)) {
        // wait at the kerb, on the node, until it is our turn
        p.s = p.edge.len; p.state = 'wait'; p.waitEdge = next; p.waitNode = node;
        p.x = node.x; p.y = node.y; p.v = 0; p.vx = 0; p.vy = 0;
        return;
      }
      this.startEdge(p, next, node);
      p.s = over;
    }
    this.place(p);
    p.vx = Math.cos(p.heading) * p.v; p.vy = Math.sin(p.heading) * p.v;
  }

  startEdge(p, edge, node) {
    if (edge.type === 'cross') {
      this.stats.crossings++;
      const local = this.signals.localAxis(edge.nodeId, edge.axis, this.t);
      if (local < WALK_START - 0.05 || local + this.crossTime(edge, p) > ROAD_CLEAR_BY + 0.3) this.stats.badCrossStarts++;
    }
    p.prev = p.edge; p.edge = edge; p.dir = edge.a === node ? 1 : -1; p.s = 0;
  }

  // ---------- reacting to the player's car ----------
  /** people in the path of a fast car jog away from it */
  scatter(player) {
    const speed = Math.hypot(player.vx, player.vy);
    if (speed < 2.5) return;
    const dx = player.vx / speed, dy = player.vy / speed, reach = Math.min(16, 4 + speed * 1.1);
    for (const p of this.peds) {
      if (p.dead || p.state === 'flee') continue;
      const rx = p.x - player.x, ry = p.y - player.y;
      const ahead = rx * dx + ry * dy, side = -rx * dy + ry * dx; // side: + is to the car's right (y down)
      if (ahead < -1 || ahead > reach || Math.abs(side) > 3.0) continue;
      // jog sideways, away from the car's line, and a little ahead of it
      const away = side >= 0 ? 1 : -1;
      p.state = 'flee'; p.fleeT = 1.3 + this.rand() * 0.5; p.fx = -dy * away * 0.9 + dx * 0.4; p.fy = dx * away * 0.9 + dy * 0.4;
      const l = Math.hypot(p.fx, p.fy); p.fx /= l; p.fy /= l; p.fleeSpeed = FLEE_SPEED;
      this.stats.scatters++;
    }
  }

  /** anyone the car actually touches is pushed clear (no harm) and stumbles away. Returns how many were touched. */
  pushFromCar(player) {
    const c = Math.cos(player.heading), s = Math.sin(player.heading);
    const circles = [[-1.3, 0.97], [0, 0.97], [1.3, 0.97]].map(([k, r]) => [player.x + c * k, player.y + s * k, r]);
    let touched = 0;
    for (const p of this.peds) {
      if (p.dead) continue;
      for (const m of circles) {
        let dx = p.x - m[0], dy = p.y - m[1];
        const d = Math.hypot(dx, dy), need = m[2] + RADIUS;
        if (d >= need) continue;
        if (d < 1e-6) { dx = c; dy = s; }
        const nx = d < 1e-6 ? dx : dx / d, ny = d < 1e-6 ? dy : dy / d;
        p.x += nx * (need - d + 0.05); p.y += ny * (need - d + 0.05);
        if (p.state !== 'flee' || p.fleeSpeed !== STUMBLE_SPEED) { touched++; this.stats.nudges++; }
        p.state = 'flee'; p.fleeT = 0.9; p.fx = nx; p.fy = ny; p.fleeSpeed = STUMBLE_SPEED;
      }
    }
    return touched;
  }

  // ---------- the player's gun and car-jacking ----------
  /** a person is shot: they are gone from the crowd (the game draws the body) */
  kill(p) { p.dead = true; this.stats.killed = (this.stats.killed ?? 0) + 1; }

  /** gunfire, or a car taken: everyone within r metres of (x, y) runs away from it for a few seconds */
  alarm(x, y, r) {
    for (const p of this.peds) {
      if (p.dead) continue;
      const dx = p.x - x, dy = p.y - y, d = Math.hypot(dx, dy);
      if (d > r) continue;
      const l = d || 1;
      p.state = 'flee'; p.fleeT = 3 + this.rand() * 2.5; p.fx = dx / l; p.fy = dy / l; p.fleeSpeed = FLEE_SPEED + 1.4;
    }
  }

  /** a person appears at a spot that is not on the walking network (a driver pulled out of a car) and runs from (fromX, fromY) */
  spawnLoose(x, y, fromX, fromY) {
    const dx = x - fromX, dy = y - fromY, l = Math.hypot(dx, dy) || 1;
    const p = {
      id: this.nextId++, edge: null, s: 0, dir: 1, state: 'flee', v0: 1.3, v: 0, dead: false,
      skin: Math.floor(this.rand() * SKINS.length), clothes: Math.floor(this.rand() * CLOTHES.length),
      lat: 0, x, y, heading: Math.atan2(dy, dx), dist: 0, prev: null,
      fleeT: 4, fx: dx / l, fy: dy / l, fleeSpeed: FLEE_SPEED + 1.6, waitEdge: null, vx: 0, vy: 0,
    };
    this.peds.push(p);
    return p;
  }

  fleeStep(p, dt, blocked) {
    p.fleeT -= dt;
    const nx = p.x + p.fx * p.fleeSpeed * dt, ny = p.y + p.fy * p.fleeSpeed * dt;
    if (!blocked || !blocked(nx, ny)) { p.x = nx; p.y = ny; p.dist += p.fleeSpeed * dt; }
    else { this.stats.blocked++; p.fleeT = Math.min(p.fleeT, 0.15); }
    p.heading = Math.atan2(p.fy, p.fx);
    p.v = p.fleeSpeed; p.vx = p.fx * p.fleeSpeed; p.vy = p.fy * p.fleeSpeed;
    if (p.fleeT <= 0) this.reattach(p);
  }

  /** after scattering, rejoin the nearest sidewalk, corner or crossing */
  reattach(p) {
    const best = this.net.nearestEdge(p.x, p.y, 18, (e) => !e.blocked);
    if (!best) { p.dead = true; return; }
    p.edge = best.e; p.s = best.s; p.dir = this.rand() < 0.5 ? 1 : -1; p.state = 'walk';
    if (p.dir < 0) p.s = best.e.len - best.s;
    p.lat = 0;
    this.place(p);
  }

  // ---------- the loop ----------
  /** city mode, every frame: build a few more junctions near the player, and now and then forget far ones / retry ones that waited for tiles */
  maintainNetwork(player) {
    this.net.ensureNear(player.x, player.y, this.radius, this.buildBudget);
    if (this.t > this.nextRetry) { this.nextRetry = this.t + RETRY; this.net.tilesChanged(); } // safety net in case the caller misses a tile change
    if (this.t > this.nextKeep) { this.nextKeep = this.t + HOUSEKEEP; this.net.dropFar(player.x, player.y, this.radius * KEEP_FACTOR); }
  }

  /**
   * @param dt seconds
   * @param player {x, y, vx, vy, heading}
   * @param view {cx, cy, hw, hh}
   * @param blocked (x, y) => true if that spot is inside a building
   */
  update(dt, player, view, blocked) {
    dt = Math.min(dt, 0.05);
    this.t += dt;
    if (this.radius && player) this.maintainNetwork(player);
    for (const p of this.peds) {
      if (p.dead) continue;
      if (this.radius && (p.state === 'walk' ? p.edge.gone : p.state === 'wait' && (p.edge.gone || p.waitEdge.gone))) { p.dead = true; continue; } // its street was forgotten
      if (p.state === 'flee') this.fleeStep(p, dt, blocked); else this.advance(p, dt);
    }
    let touched = 0;
    if (player) { this.scatter(player); touched = this.pushFromCar(player); }
    if (player) {
      const far = this.radius ? this.radius * REMOVE_FACTOR : Infinity;
      for (const p of this.peds) {
        const d = Math.hypot(p.x - player.x, p.y - player.y);
        if ((d > RECYCLE_RADIUS && !this.visible(p.x, p.y, view, 15)) || d > far) p.dead = true;
      }
    }
    for (let i = this.peds.length - 1; i >= 0; i--) if (this.peds[i].dead) this.peds.splice(i, 1);
    this.fill(view, player);
    return touched;
  }
}
