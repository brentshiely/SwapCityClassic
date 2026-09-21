import { offsetPolyline, polyInfo, pointAt, sliceInfo, junctionInfo } from '../world/geometry.js';

// The pedestrians' walking network, derived from the road graph so it always matches the streets:
//   sidewalk edges  - both sides of every street, a couple of metres in from the kerb
//   corner edges    - round the corner from one street's sidewalk to the next
//   crossing edges  - straight across a street at the painted crosswalk, at signalized junctions
// Nodes sit where a street meets a junction, one per side of each street ("leg") at that junction.
// Nodes on the map's edge are terminals: people walk off the map there.

export const CURB = 0.4;
export const WALK_OFFSET = 1.6; // metres in from the kerb
export const CROSSWALK_DIST = 2.6; // metres beyond the road's half width, where the crosswalk is painted

/**
 * @param blocked optional (x, y) => true if that spot is inside a building; sidewalks are kept out of buildings
 */
export function buildPedNetwork(map, signals, blocked = null) {
  const { nodes, edges } = map.graph;
  const jinfo = junctionInfo(map);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const legsAt = new Map(nodes.map((n) => [n.id, []]));
  const pn = [], pe = [];

  const newNode = (x, y, terminal) => { const n = { id: pn.length, x, y, edges: [], terminal }; pn.push(n); return n; };
  const newEdge = (type, a, b, pts, extra = {}) => {
    const info = polyInfo(pts), e = { id: pe.length, type, a, b, info, len: info.len, ...extra };
    pe.push(e); a.edges.push(e); b.edges.push(e);
    return e;
  };

  // one leg per street end at each node
  for (const e of edges) {
    const info = polyInfo(e.points);
    const width = Math.max(6.6, e.lanes * 3.3), off = width / 2 + CURB + WALK_OFFSET;
    for (const end of ['from', 'to']) {
      const nodeId = end === 'from' ? e.from : e.to, n = nodeById.get(nodeId);
      const dc = n.degree >= 3 ? jinfo.get(nodeId).maxHalf + CROSSWALK_DIST : 0;
      const s = end === 'from' ? dc : info.len - dc;
      const p = pointAt(info, s);
      const u = end === 'from' ? [p.tx, p.ty] : [-p.tx, -p.ty]; // pointing away from the junction
      legsAt.get(nodeId).push({ edge: e, end, nodeId, s, u, off, width, angle: Math.atan2(u[1], u[0]), terminal: n.boundary, sides: {} });
    }
  }
  const legOf = (e, end) => legsAt.get(end === 'from' ? e.from : e.to).find((l) => l.edge === e && l.end === end);

  // sidewalks along each street: the two ends are joined side to side. Legs store their nodes by the side of the
  // way OUT of the junction, so the right of F->T is +1 at F but -1 at T (facing the other way).
  for (const e of edges) {
    const F = legOf(e, 'from'), T = legOf(e, 'to');
    const info = polyInfo(e.points);
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
      const nF = newNode(pts[0][0], pts[0][1], F.terminal), nT = newNode(pts[pts.length - 1][0], pts[pts.length - 1][1], T.terminal);
      F.sides[side] = nF; T.sides[-side] = nT;
      newEdge('walk', nF, nT, pts, { street: e.name, blocked: !chosen });
    }
  }
  // corners and crossings at every node
  for (const n of nodes) {
    const legs = legsAt.get(n.id).slice().sort((a, b) => a.angle - b.angle); // clockwise on screen
    if (legs.length >= 2) {
      for (let i = 0; i < legs.length; i++) {
        const a = legs[i], b = legs[(i + 1) % legs.length];
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
        newEdge('corner', na, nb, pts);
      }
    }
    if (signals.byNode.has(n.id)) {
      for (const leg of legs) {
        const na = leg.sides[1], nb = leg.sides[-1];
        if (!na || !nb) continue;
        newEdge('cross', na, nb, [[na.x, na.y], [nb.x, nb.y]], { nodeId: n.id, axis: signals.axisOfHeading(n.id, leg.angle), street: leg.edge.name });
      }
    }
  }
  return { nodes: pn, edges: pe };
}
