// Where the playable world ends. Every street that reaches the edge of the map gets a row of
// barricades across it; the rest of the edge is a fence. Collision uses the same data (see the
// collisions card): `barriers` are rotated rectangles, `wall` is the world rectangle to stay inside.
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
    if (dx * n.x + dy * n.y < 0) { dx = -dx; dy = -dy; } // point away from the middle of the map
    barriers.push({
      x: n.x - dx * 0.8, y: n.y - dy * 0.8, angle: Math.atan2(dy, dx),
      length: best.r.width + 4, thickness: BARRIER_THICKNESS, street: best.r.name,
    });
  }
  return { barriers, wall: { ...map.meta.world } };
}
