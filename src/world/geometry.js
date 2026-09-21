// Small polyline helpers shared by the ground painter and the traffic. Metres, y down.
// "Right" is the right-hand side of the direction of travel as seen on screen.

/** Shift a polyline sideways by `dist` metres (positive = to the right of travel). */
export function offsetPolyline(pts, dist) {
  if (dist === 0) return pts;
  const n = pts.length, res = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    dx /= l; dy /= l;
    res.push([pts[i][0] - dy * dist, pts[i][1] + dx * dist]);
  }
  return res;
}

/** A polyline with cumulative distances, for walking along it. */
export function polyInfo(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, cum, len: cum[cum.length - 1] };
}

/** Point and unit tangent at distance s along a polyInfo (clamped to its ends). */
export function pointAt(info, s, out = {}) {
  const { pts, cum } = info;
  if (s <= 0) s = 0;
  if (s >= info.len) s = info.len;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const a = pts[i - 1], b = pts[i], seg = cum[i] - cum[i - 1] || 1, t = (s - cum[i - 1]) / seg;
  out.x = a[0] + (b[0] - a[0]) * t;
  out.y = a[1] + (b[1] - a[1]) * t;
  out.tx = (b[0] - a[0]) / seg;
  out.ty = (b[1] - a[1]) / seg;
  return out;
}

/** Per junction node: the widest half-road there and how far before the node cars stop for its signal. */
export function junctionInfo(map) {
  const half = new Map();
  for (const e of map.graph.edges) {
    const hw = Math.max(6.6, e.lanes * 3.3) / 2;
    for (const id of [e.from, e.to]) half.set(id, Math.max(half.get(id) ?? 0, hw));
  }
  const info = new Map();
  for (const [id, hw] of half) info.set(id, { maxHalf: hw, stopDist: hw + 4.5 });
  return info;
}

/** The points of a polyInfo between distances s0 and s1 along it (s0 <= s1), including both ends. */
export function sliceInfo(info, s0, s1) {
  const tmp = {}, out = [];
  pointAt(info, s0, tmp); out.push([tmp.x, tmp.y]);
  for (let i = 1; i < info.pts.length - 1; i++) if (info.cum[i] > s0 + 0.01 && info.cum[i] < s1 - 0.01) out.push(info.pts[i]);
  pointAt(info, s1, tmp); out.push([tmp.x, tmp.y]);
  return out;
}

/** Nearest point on a polyInfo to (x, y): { s, dist } */
export function nearestOnPolyline(info, x, y) {
  let best = { s: 0, dist: Infinity };
  for (let i = 0; i < info.pts.length - 1; i++) {
    const a = info.pts[i], b = info.pts[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2));
    const d = Math.hypot(x - (a[0] + dx * t), y - (a[1] + dy * t));
    if (d < best.dist) best = { s: info.cum[i] + t * Math.sqrt(l2), dist: d };
  }
  return best;
}
