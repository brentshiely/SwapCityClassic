// Where the playable world ends. Every street that reaches the edge of the map gets a row of
// barricades across it; the rest of the edge is a fence. Collision uses the same data (see the
// collisions card): `barriers` are rotated rectangles, `wall` is the world rectangle to stay inside.
import { insidePolygon } from './grid2d.js';

export const BARRIER_THICKNESS = 1.2;

const distToSegment = (p, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / l2));
  return Math.hypot(p.x - (a[0] + dx * t), p.y - (a[1] + dy * t));
};

export function computeBarriers(map) {
  const streets = map.roads.filter((r) => r.highway !== 'service' && r.layer >= 0);
  const barriers = [];
  for (const n of map.graph.nodes) {
    if (!n.boundary) continue;
    // Direction of the street where it leaves the map, taken from the drawn road geometry
    // (short stub edges at the boundary are too small to give a reliable direction).
    let best = null, bd = Infinity;
    for (const r of streets) {
      for (let i = 0; i < r.points.length - 1; i++) {
        const d = distToSegment(n, r.points[i], r.points[i + 1]);
        if (d < bd) { bd = d; best = { r, a: r.points[i], b: r.points[i + 1] }; }
      }
    }
    if (!best || bd > 3) continue;
    let dx = best.b[0] - best.a[0], dy = best.b[1] - best.a[1];
    const l = Math.hypot(dx, dy) || 1;
    dx /= l; dy /= l;
    let bx = n.x, by = n.y;
    const limit = map.meta.boundary;
    if (limit) {
      // the city limit is an irregular polygon and the graph's boundary nodes sit up to 60 m beyond it: walk from the node along the
      // street, the way that reaches the inside first, and close the street where it crosses the limit
      const reach = (sx, sy) => { for (let d = 0; d <= 100; d += 0.5) if (insidePolygon(n.x + sx * d, n.y + sy * d, limit)) return d; return Infinity; };
      const a = reach(dx, dy), b = reach(-dx, -dy);
      if (a === Infinity && b === Infinity) continue; // a street that never comes inside: nothing to close
      if (a < b) { dx = -dx; dy = -dy; } // (dx, dy) points out of the city
      bx = n.x - dx * Math.min(a, b); by = n.y - dy * Math.min(a, b);
    } else if (dx * n.x + dy * n.y < 0) { dx = -dx; dy = -dy; } // point away from the middle of the map
    barriers.push({
      x: bx - dx * 0.8, y: by - dy * 0.8, angle: Math.atan2(dy, dx),
      length: best.r.width + 4, thickness: BARRIER_THICKNESS, street: best.r.name,
    });
  }
  return { barriers, wall: { ...map.meta.world } };
}
