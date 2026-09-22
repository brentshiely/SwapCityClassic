import { nearestOnPolyline } from '../world/geometry.js';

// The route to an objective: the shortest way to drive there along real streets, honouring one-way streets, as a line of points
// to draw over the road. Pure maths (A*, straight-line distance as the guide), so it can be tested in Node.
//
// The graph is directed: a two-way street gives a hop each way, a one-way street only the way OSM allows. Ramps, alleys and
// service roads count like any other street (a mission never needs to route through a building). Tunnels and bridges are fine:
// the route does not know about layers, only about the streets on the ground plan, which is what a driver needs to see.

const MAX_EXPAND = 20000; // safety cap so a route with no path (a stranded island) gives up quickly

// A small binary min-heap of {id, f}, so A* costs O(log n) per step instead of scanning every open node (matters once a route
// crosses a good part of the city's 11,000+ junctions).
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(id, f) {
    const a = this.a; a.push({ id, f });
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p].f <= a[i].f) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) { a[0] = last; let i = 0; for (;;) { const l = i * 2 + 1, r = l + 1; let m = i; if (l < a.length && a[l].f < a[m].f) m = l; if (r < a.length && a[r].f < a[m].f) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
    return top;
  }
}

export class RoutePlanner {
  constructor(world) {
    this.world = world;
    this.build();
  }

  build() {
    const { nodes, edges } = this.world.graph;
    this.nodes = nodes;
    // adjacency: node id -> [{ to, edge, cost, dir }]; dir = 1 forward (edge.points as stored), -1 reversed
    this.adj = nodes.map(() => []);
    for (const e of edges) {
      if (e.length <= 0) continue;
      this.adj[e.from].push({ to: e.to, edge: e, cost: e.length, dir: 1 });
      if (!e.oneway) this.adj[e.to].push({ to: e.from, edge: e, cost: e.length, dir: -1 });
    }
  }

  /** the node nearest (x, y), searched through the edge spatial index so it costs the same at any city size */
  nearestNode(x, y, maxDist = 400) {
    const cand = this.world.edgesNear ? this.world.edgesNear(x, y, maxDist) : this.world.graph.edges;
    let best = null, bd = Infinity;
    for (const e of cand) {
      for (const id of [e.from, e.to]) {
        const n = this.nodes[id];
        const d = Math.hypot(n.x - x, n.y - y);
        if (d < bd) { bd = d; best = id; }
      }
    }
    return best;
  }

  /**
   * The shortest way from (x0, y0) to (x1, y1). Returns { points: [[x,y], ...], distance } along the streets (a straight line drawn
   * from the start point to the road, then the road, then a straight line to the target), or null if there is no way to get there.
   */
  find(x0, y0, x1, y1) {
    const from = this.nearestNode(x0, y0), to = this.nearestNode(x1, y1);
    if (from == null || to == null) return null;
    if (from === to) return { points: [[x0, y0], [x1, y1]], distance: Math.hypot(x1 - x0, y1 - y0) };
    const goal = this.nodes[to];
    const h = (id) => { const n = this.nodes[id]; return Math.hypot(n.x - goal.x, n.y - goal.y); };
    const g = new Map([[from, 0]]), came = new Map(), closed = new Set(), heap = new Heap();
    heap.push(from, h(from));
    let expanded = 0, found = false;
    while (heap.size && expanded++ < MAX_EXPAND) {
      const cur = heap.pop().id;
      if (closed.has(cur)) continue; // a stale, superseded entry
      if (cur === to) { found = true; break; }
      closed.add(cur);
      for (const link of this.adj[cur]) {
        if (closed.has(link.to)) continue;
        const cand = g.get(cur) + link.cost;
        if (cand < (g.get(link.to) ?? Infinity)) {
          g.set(link.to, cand); came.set(link.to, { from: cur, link }); heap.push(link.to, cand + h(link.to));
        }
      }
    }
    if (!found) return null;
    // walk the chain back to the start, collecting each edge's points in the direction travelled
    const chain = [];
    let cur = to;
    while (cur !== from) { const step = came.get(cur); chain.push(step.link); cur = step.from; }
    chain.reverse();
    const points = [[x0, y0]];
    for (const link of chain) {
      const pts = link.dir === 1 ? link.edge.points : link.edge.points.slice().reverse();
      for (const p of pts) points.push(p);
    }
    points.push([x1, y1]);
    return { points: dedupe(points), distance: g.get(to) + Math.hypot(x1 - points.at(-2)[0], y1 - points.at(-2)[1]) };
  }
}

function dedupe(pts) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) { const a = out[out.length - 1], b = pts[i]; if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.05) out.push(b); }
  return out;
}

/** how far (x, y) is from the route line (metres); used to tell whether the driver has left the suggested way */
export function distanceFromRoute(route, x, y) {
  if (!route || route.points.length < 2) return Infinity;
  let best = Infinity;
  for (let i = 0; i < route.points.length - 1; i++) {
    const a = route.points[i], b = route.points[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2));
    best = Math.min(best, Math.hypot(x - (a[0] + dx * t), y - (a[1] + dy * t)));
  }
  return best;
}
