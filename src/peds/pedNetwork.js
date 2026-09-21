import { offsetPolyline, polyInfo, pointAt, sliceInfo, junctionInfo, nearestOnPolyline } from '../world/geometry.js';

// The pedestrians' walking network, derived from the road graph so it always matches the streets:
//   sidewalk edges  - both sides of every street, a couple of metres in from the kerb
//   corner edges    - round the corner from one street's sidewalk to the next
//   crossing edges  - straight across a street at the painted crosswalk, at signalized junctions
// Nodes sit where a street meets a junction, one per side of each street ("leg") at that junction.
// Nodes on the map's edge are terminals: people walk off the map there.
//
// It is built INCREMENTALLY so a whole city (tens of thousands of junctions, buildings streaming in by tile) works:
// `ensureNear(x, y, radius)` builds the pieces of the graph nodes near a point, lazily, and only where the building
// data is loaded (`isLoaded`), because the sidewalks steer round buildings. A graph node's pieces are its corners and
// crossings plus the sidewalks of the streets that meet it; a sidewalk is shared by the two junctions at its ends and
// made once. A sidewalk's far end may belong to a junction that is not built yet: those ped nodes have `frontier` set
// and a person arriving at one simply leaves. `buildAll()` builds everything at once (the small-map path).

export const CURB = 0.4;
export const WALK_OFFSET = 1.6; // metres in from the kerb
export const CROSSWALK_DIST = 2.6; // metres beyond the road's half width, where the crosswalk is painted

const CELL = 64, STEP = 16; // spatial index of the walking edges: cell size, and spacing of the points that register an edge in cells
const NODE_CELL = 128; // spatial index of the graph nodes
const LOAD_MARGIN = 40, LOAD_STEP = 48; // building data must be loaded this far around every point along a street (checked every LOAD_STEP)
const LONG_EDGE = 300, LONG_STEP = 200; // a street longer than this also counts as "near" at points along it, so its middle is walkable

export class PedNetwork {
  /**
   * @param map has graph {nodes, edges} (edges: id, from, to, points, lanes, name; nodes: id, x, y, degree, boundary)
   * @param signals the traffic's Signals (byNode, axisOfHeading)
   * @param blocked optional (x, y) => true if that spot is inside a building; sidewalks are kept out of buildings
   * @param isLoaded optional (x, y) => true if building data is loaded at that spot; a node is only built when it is
   *                 loaded within loadMargin of the node and along all its streets (else it waits: see tilesChanged)
   */
  constructor(map, signals, { blocked = null, isLoaded = null, loadMargin = LOAD_MARGIN } = {}) {
    this.signals = signals; this.blocked = blocked; this.isLoaded = isLoaded; this.margin = loadMargin;
    const { nodes: gn, edges: ge } = map.graph;
    this.gn = gn; this.ge = ge; this.jinfo = junctionInfo(map);
    this.gi = new Map(gn.map((n, i) => [n.id, i]));
    this.nodes = []; this.edges = []; // the live ped nodes and edges (ids are never reused)
    this.version = 0; // bumps whenever pieces are built or dropped
    this.gen = 0; // bumps when loaded tiles change (tilesChanged), which lets deferred nodes try again
    this.nextNodeId = 0; this.nextEdgeId = 0;
    this.built = new Uint8Array(gn.length); // per graph node: its corners and crossings exist
    this.builtSet = new Set();
    this.deferGen = new Int32Array(gn.length).fill(-1); // per graph node: the gen at which it last found its tiles not loaded
    this.pieces = new Array(gn.length).fill(null); // per graph node: the corner and crossing edges it made
    this.sw = new Array(ge.length).fill(null); // per graph edge: its sidewalks { nodes, edges }
    this.legArr = new Array(ge.length * 2).fill(null); // per (edge, end): key = edge index * 2 + (end === 'to')
    this.infoArr = new Array(ge.length).fill(null);
    this.incident = gn.map(() => []); // per graph node: the leg keys of the streets that meet it, in edge order
    this.fromI = new Int32Array(ge.length); this.toI = new Int32Array(ge.length);
    ge.forEach((e, ei) => {
      const fi = this.gi.get(e.from), ti = this.gi.get(e.to);
      this.fromI[ei] = fi; this.toI[ei] = ti;
      this.incident[fi].push(ei * 2); this.incident[ti].push(ei * 2 + 1);
    });
    // where each graph node counts as being: its own spot, plus points along the long streets it ends
    this.spots = gn.map((n) => [[n.x, n.y]]);
    this.nodeGrid = new Map();
    const reg = (i, x, y) => { const k = this.nkey(x, y); let l = this.nodeGrid.get(k); if (!l) this.nodeGrid.set(k, l = []); l.push({ i, x, y }); };
    gn.forEach((n, i) => reg(i, n.x, n.y));
    ge.forEach((e, ei) => {
      if (!(e.length > LONG_EDGE)) return;
      const info = this.einfo(ei), tmp = {};
      for (let s = LONG_STEP / 2; s < info.len - LONG_STEP / 2; s += LONG_STEP) {
        pointAt(info, s, tmp);
        for (const i of [this.fromI[ei], this.toI[ei]]) { this.spots[i].push([tmp.x, tmp.y]); reg(i, tmp.x, tmp.y); }
      }
      this.infoArr[ei] = null;
    });
    this.seen = new Int32Array(gn.length); this.stamp = 0;
    this.last = null; // the last ensureNear query that finished, so an unmoved caller costs nothing
    this.grid = new Map(); this.qstamp = 0; // spatial index of the live ped edges
  }

  einfo(ei) { return (this.infoArr[ei] ??= polyInfo(this.ge[ei].points)); }
  nkey(x, y) { return (Math.floor(x / NODE_CELL) + 32768) * 65536 + Math.floor(y / NODE_CELL) + 32768; }
  ckey(cx, cy) { return (cx + 32768) * 65536 + cy + 32768; }

  newNode(x, y, terminal) {
    const n = { id: this.nextNodeId++, x, y, edges: [], terminal, frontier: false, _i: this.nodes.length, gone: false };
    this.nodes.push(n);
    return n;
  }
  newEdge(type, a, b, pts, extra = {}) {
    const info = polyInfo(pts), e = { id: this.nextEdgeId++, type, a, b, info, len: info.len, ...extra, _i: this.edges.length, _q: 0, cells: null, gone: false };
    this.edges.push(e); a.edges.push(e); b.edges.push(e);
    this.indexEdge(e);
    return e;
  }
  removeEdge(e) {
    const last = this.edges.pop();
    if (last !== e) { this.edges[e._i] = last; last._i = e._i; }
    for (const n of [e.a, e.b]) { const i = n.edges.indexOf(e); if (i >= 0) n.edges.splice(i, 1); }
    for (const k of e.cells) {
      const l = this.grid.get(k), i = l.indexOf(e);
      l[i] = l[l.length - 1]; l.pop();
      if (!l.length) this.grid.delete(k);
    }
    e.gone = true;
  }
  removeNode(n) {
    const last = this.nodes.pop();
    if (last !== n) { this.nodes[n._i] = last; last._i = n._i; }
    n.gone = true;
  }

  // ---------- spatial index of the walking edges ----------
  indexEdge(e) {
    const keys = new Set(), pts = e.info.pts;
    for (let i = 0; i < pts.length; i++) {
      keys.add(this.ckey(Math.floor(pts[i][0] / CELL), Math.floor(pts[i][1] / CELL)));
      if (i === pts.length - 1) break;
      const dx = pts[i + 1][0] - pts[i][0], dy = pts[i + 1][1] - pts[i][1], n = Math.ceil(Math.hypot(dx, dy) / STEP);
      for (let k = 1; k < n; k++) keys.add(this.ckey(Math.floor((pts[i][0] + (dx * k) / n) / CELL), Math.floor((pts[i][1] + (dy * k) / n) / CELL)));
    }
    e.cells = [...keys];
    for (const k of e.cells) { let l = this.grid.get(k); if (!l) this.grid.set(k, l = []); l.push(e); }
  }

  /** calls fn(edge) once for every live edge that may come within r metres of (x, y) (a superset; test distances yourself) */
  queryEdges(x, y, r, fn) {
    const q = ++this.qstamp, pad = r + STEP / 2;
    const x0 = Math.floor((x - pad) / CELL), x1 = Math.floor((x + pad) / CELL), y0 = Math.floor((y - pad) / CELL), y1 = Math.floor((y + pad) / CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const l = this.grid.get(this.ckey(cx, cy));
      if (l) for (const e of l) if (e._q !== q) { e._q = q; fn(e); }
    }
  }

  /** the nearest edge (that `accept`s, if given) to (x, y) within maxDist: { e, s, dist } or null */
  nearestEdge(x, y, maxDist, accept = null) {
    let best = null;
    this.queryEdges(x, y, maxDist, (e) => {
      if (accept && !accept(e)) return;
      const n = nearestOnPolyline(e.info, x, y);
      if (n.dist <= maxDist && (!best || n.dist < best.dist || (n.dist === best.dist && e.id < best.e.id))) best = { e, ...n };
    });
    return best;
  }

  // ---------- building ----------
  /** one leg per street end at a node */
  leg(k) {
    let L = this.legArr[k];
    if (L) return L;
    const ei = k >> 1, end = k & 1 ? 'to' : 'from', e = this.ge[ei], info = this.einfo(ei);
    const nodeI = end === 'from' ? this.fromI[ei] : this.toI[ei], n = this.gn[nodeI];
    const width = Math.max(6.6, e.lanes * 3.3), off = width / 2 + CURB + WALK_OFFSET;
    const dc = n.degree >= 3 ? this.jinfo.get(n.id).maxHalf + CROSSWALK_DIST : 0;
    const s = end === 'from' ? dc : info.len - dc;
    const p = pointAt(info, s);
    const u = end === 'from' ? [p.tx, p.ty] : [-p.tx, -p.ty]; // pointing away from the junction
    return (this.legArr[k] = { edge: e, end, nodeId: n.id, s, u, off, width, angle: Math.atan2(u[1], u[0]), terminal: n.boundary, sides: {} });
  }

  /** sidewalks along a street: the two ends are joined side to side. Legs store their nodes by the side of the
   *  way OUT of the junction, so the right of F->T is +1 at F but -1 at T (facing the other way). */
  buildSidewalks(ei) {
    if (this.sw[ei]) return;
    const e = this.ge[ei], F = this.leg(ei * 2), T = this.leg(ei * 2 + 1), info = this.einfo(ei), blocked = this.blocked;
    const made = (this.sw[ei] = { nodes: [], edges: [] });
    for (const side of [1, -1]) {
      let pts;
      if (F.s < T.s) pts = sliceInfo(info, F.s, T.s);
      else { const p = pointAt(info, (F.s + T.s) / 2); pts = [[p.x, p.y], [p.x + 0.01, p.y]]; } // a street too short to have a middle
      // stay clear of buildings: walk 2 m in from the kerb if that is free, otherwise closer to it
      const base = pts, clear = (line) => {
        const inf = polyInfo(line), q = {};
        for (let d = 0; d <= inf.len; d += 1) {
          pointAt(inf, d, q);
          for (const w of [0, 0.75, -0.75]) if (blocked(q.x - q.ty * w, q.y + q.tx * w)) return false;
        }
        return true;
      };
      let chosen = null;
      for (const cut of [0, 0.6, 1.0, 1.3]) {
        const cand = offsetPolyline(base, side * (F.off - cut)); // + is the right of F -> T
        if (!blocked || clear(cand)) { chosen = cand; break; }
      }
      pts = chosen ?? offsetPolyline(base, side * F.off);
      const nF = this.newNode(pts[0][0], pts[0][1], F.terminal), nT = this.newNode(pts[pts.length - 1][0], pts[pts.length - 1][1], T.terminal);
      nF.frontier = !this.built[this.fromI[ei]]; nT.frontier = !this.built[this.toI[ei]]; // people leave at a junction that is not built
      F.sides[side] = nF; T.sides[-side] = nT;
      made.nodes.push(nF, nT);
      made.edges.push(this.newEdge('walk', nF, nT, pts, { street: e.name, blocked: !chosen, gedge: ei }));
    }
  }

  /** corners and crossings at a node; its streets' sidewalks must exist */
  buildJunction(i) {
    const n = this.gn[i], mine = (this.pieces[i] = []);
    const legs = this.incident[i].map((k) => this.leg(k)).sort((a, b) => a.angle - b.angle); // clockwise on screen
    if (legs.length >= 2) {
      for (let j = 0; j < legs.length; j++) {
        const a = legs[j], b = legs[(j + 1) % legs.length];
        const na = a.sides[1], nb = b.sides[-1];
        if (!na || !nb) continue;
        // control point where the two sidewalk lines meet, so the corner is rounded
        const d = a.u[0] * b.u[1] - a.u[1] * b.u[0];
        let cx = (na.x + nb.x) / 2, cy = (na.y + nb.y) / 2;
        if (Math.abs(d) > 0.2) {
          const dx = nb.x - na.x, dy = nb.y - na.y;
          const t = (dx * b.u[1] - dy * b.u[0]) / d;
          if (t > -25 && t < 25) { cx = na.x + a.u[0] * t; cy = na.y + a.u[1] * t; }
        }
        const pts = [];
        for (let k = 0; k <= 8; k++) { const t = k / 8, m = 1 - t; pts.push([m * m * na.x + 2 * m * t * cx + t * t * nb.x, m * m * na.y + 2 * m * t * cy + t * t * nb.y]); }
        mine.push(this.newEdge('corner', na, nb, pts, { at: n.id }));
      }
    }
    if (this.signals.byNode.has(n.id)) {
      for (const leg of legs) {
        const na = leg.sides[1], nb = leg.sides[-1];
        if (!na || !nb) continue;
        mine.push(this.newEdge('cross', na, nb, [[na.x, na.y], [nb.x, nb.y]], { nodeId: n.id, axis: this.signals.axisOfHeading(n.id, leg.angle), street: leg.edge.name }));
      }
    }
    this.built[i] = 1; this.builtSet.add(i);
    for (const k of this.incident[i]) for (const s of [1, -1]) { const nd = this.leg(k).sides[s]; if (nd) nd.frontier = false; }
    this.version++;
  }

  buildNode(i) {
    if (this.built[i]) return;
    for (const k of this.incident[i]) this.buildSidewalks(k >> 1);
    this.buildJunction(i);
  }

  /** build everything at once (assumes all building data is loaded); same pieces, in the same order, as the old one-shot builder */
  buildAll() {
    for (let ei = 0; ei < this.ge.length; ei++) this.buildSidewalks(ei);
    for (let i = 0; i < this.gn.length; i++) if (!this.built[i]) this.buildJunction(i);
    return this;
  }

  // ---------- incremental ----------
  /** is building data loaded around this whole street (so the sidewalks' clear-of-buildings test is trustworthy)? */
  edgeLoaded(ei) {
    const isLoaded = this.isLoaded;
    if (!isLoaded || this.sw[ei]) return true;
    const info = this.einfo(ei), m = this.margin, tmp = {};
    for (let d = 0; ; d += LOAD_STEP) {
      pointAt(info, Math.min(d, info.len), tmp);
      const { x, y } = tmp;
      // a square of half-width m around the point touches at most 4 tiles, and each contains one of its corners
      if (!(isLoaded(x - m, y - m) && isLoaded(x + m, y - m) && isLoaded(x - m, y + m) && isLoaded(x + m, y + m) && isLoaded(x, y))) return false;
      if (d >= info.len) return true;
    }
  }

  nodeReady(i) {
    for (const k of this.incident[i]) if (!this.edgeLoaded(k >> 1)) return false;
    return true;
  }

  /** Call when tiles load or unload: nodes that were waiting for building data try again on the next ensureNear. */
  tilesChanged() { this.gen++; this.last = null; }

  /**
   * Build the pieces of every not yet built graph node within `radius` metres of (x, y), nearest first, skipping
   * those whose tiles are not loaded (they retry after tilesChanged). `budget` caps how many nodes are built in
   * this call (default all), so the cost per frame is bounded. Returns how many were built.
   */
  ensureNear(x, y, radius, budget = Infinity) {
    const l = this.last;
    if (l && l.r === radius && l.gen === this.gen && Math.hypot(x - l.x, y - l.y) < 8) return 0; // nothing new since a finished query
    const stamp = ++this.stamp, cand = [];
    for (let cx = Math.floor((x - radius) / NODE_CELL); cx <= Math.floor((x + radius) / NODE_CELL); cx++) {
      for (let cy = Math.floor((y - radius) / NODE_CELL); cy <= Math.floor((y + radius) / NODE_CELL); cy++) {
        const list = this.nodeGrid.get((cx + 32768) * 65536 + cy + 32768);
        if (!list) continue;
        for (const en of list) {
          const i = en.i;
          if (this.built[i] || this.seen[i] === stamp || this.deferGen[i] === this.gen) continue;
          const d = Math.hypot(en.x - x, en.y - y);
          if (d > radius) continue;
          this.seen[i] = stamp; cand.push({ i, d });
        }
      }
    }
    cand.sort((a, b) => a.d - b.d);
    let done = 0, k = 0;
    for (; k < cand.length && done < budget; k++) {
      const i = cand[k].i;
      if (this.nodeReady(i)) { this.buildNode(i); done++; } else this.deferGen[i] = this.gen;
    }
    this.last = k >= cand.length ? { x, y, r: radius, gen: this.gen } : null; // budget ran out: carry on next call
    return done;
  }

  /** distance from (x, y) to the nearest place a graph node counts as being */
  nodeDist(i, x, y) {
    let d = Infinity;
    for (const s of this.spots[i]) d = Math.min(d, Math.hypot(s[0] - x, s[1] - y));
    return d;
  }

  /** Forget the pieces of every built node farther than `keep` metres from (x, y), to bound memory. Returns how many. */
  dropFar(x, y, keep) {
    const far = [];
    for (const i of this.builtSet) if (this.nodeDist(i, x, y) > keep) far.push(i);
    for (const i of far) this.dropNode(i);
    if (far.length) this.last = null;
    return far.length;
  }

  dropNode(i) {
    for (const e of this.pieces[i]) this.removeEdge(e);
    this.pieces[i] = null; this.built[i] = 0; this.builtSet.delete(i);
    for (const k of this.incident[i]) { const L = this.legArr[k]; if (L) for (const s of [1, -1]) if (L.sides[s]) L.sides[s].frontier = true; }
    for (const k of this.incident[i]) {
      const ei = k >> 1;
      if (!this.sw[ei] || this.built[this.fromI[ei]] || this.built[this.toI[ei]]) continue; // still wanted by the junction at the other end
      for (const e of this.sw[ei].edges) this.removeEdge(e);
      for (const nd of this.sw[ei].nodes) this.removeNode(nd);
      this.sw[ei] = null; this.legArr[ei * 2] = null; this.legArr[ei * 2 + 1] = null; this.infoArr[ei] = null;
    }
    this.version++;
  }
}

/**
 * The whole network in one go, for a small map.
 * @param blocked optional (x, y) => true if that spot is inside a building; sidewalks are kept out of buildings
 */
export function buildPedNetwork(map, signals, blocked = null) {
  return new PedNetwork(map, signals, { blocked }).buildAll();
}
