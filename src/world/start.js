// Where the player's car starts: on Marquette Avenue in the middle block, facing up the street, in the right-hand lane
// (Minneapolis). A city with no street by that name (tools/add_city.mjs) instead starts on whichever real road passes
// closest to `near`, so it never spawns off-road on a plaza or park -- found from the map data either way.
export function findStart(map, name = 'Marquette Avenue', near = [70, 0]) {
  const edges = map.graph.edges.filter((e) => e.name === name);
  let best = nearestPointOnEdges(edges, near);
  if (!best) best = nearestPointOnEdges(map.graph.edges, [0, 0]);
  if (!best) return { x: 0, y: 0, heading: -Math.PI / 2 };
  let { dx, dy } = best;
  const l = Math.hypot(dx, dy);
  dx /= l; dy /= l;
  if (dy > 0) { dx = -dx; dy = -dy; } // face up the screen
  const heading = Math.atan2(dy, dx);
  const lane = 1.7; // metres to the right of the street's centre line
  return { x: best.px - dy * lane, y: best.py + dx * lane, heading };
}

function nearestPointOnEdges(edges, near) {
  let best = null, bd = Infinity;
  for (const e of edges) {
    for (let i = 0; i < e.points.length - 1; i++) {
      const a = e.points[i], b = e.points[i + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((near[0] - a[0]) * dx + (near[1] - a[1]) * dy) / l2));
      const px = a[0] + dx * t, py = a[1] + dy * t, d = Math.hypot(near[0] - px, near[1] - py);
      if (d < bd) { bd = d; best = { px, py, dx, dy }; }
    }
  }
  return best;
}
