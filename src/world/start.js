// Where the player's car starts: on Marquette Avenue in the middle block, facing up the street,
// in the right-hand lane. Found from the map data so it always sits on the real road.
export function findStart(map, name = 'Marquette Avenue', near = [70, 0]) {
  let best = null, bd = Infinity;
  for (const e of map.graph.edges.filter((e) => e.name === name)) {
    for (let i = 0; i < e.points.length - 1; i++) {
      const a = e.points[i], b = e.points[i + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((near[0] - a[0]) * dx + (near[1] - a[1]) * dy) / l2));
      const px = a[0] + dx * t, py = a[1] + dy * t, d = Math.hypot(near[0] - px, near[1] - py);
      if (d < bd) { bd = d; best = { px, py, dx, dy }; }
    }
  }
  if (!best) return { x: 0, y: 0, heading: -Math.PI / 2 };
  let { dx, dy } = best;
  const l = Math.hypot(dx, dy);
  dx /= l; dy /= l;
  if (dy > 0) { dx = -dx; dy = -dy; } // face up the screen
  const heading = Math.atan2(dy, dx);
  const lane = 1.7; // metres to the right of the street's centre line
  return { x: best.px - dy * lane, y: best.py + dx * lane, heading };
}
