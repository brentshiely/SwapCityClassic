// Skyways: the enclosed walkways that span the streets between buildings, seen from above as a block floating over the road.
// The baked map lists the stretches over open ground (tools/bake_map.mjs); each is turned here into a rectangular block that
// the building renderer draws from the height of the deck to the height of the roof, so a car driving under one passes beneath it.
// Nothing collides with a skyway: its underside is well above a truck.

export const SKYWAY = { width: 6, base: 5.5, top: 10.5, tuck: 0.6 }; // metres: block width, deck height, roof height, overlap into the buildings at each end

// pseudo-buildings for BuildingRenderer, one block per straight piece
export function skywayBuildings(map) {
  const out = [];
  for (const s of map.skyways ?? []) {
    for (let i = 0; i < s.points.length - 1; i++) {
      let [ax, ay] = s.points[i], [bx, by] = s.points[i + 1];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 0.5) continue;
      const dx = (bx - ax) / len, dy = (by - ay) / len, nx = -dy * SKYWAY.width / 2, ny = dx * SKYWAY.width / 2;
      const t = i === 0 ? SKYWAY.tuck : 0, u = i === s.points.length - 2 ? SKYWAY.tuck : 0; // only the ends that meet a building
      ax -= dx * t; ay -= dy * t; bx += dx * u; by += dy * u;
      let pts = [[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]];
      let area = 0;
      for (let k = 0; k < 4; k++) { const [x1, y1] = pts[k], [x2, y2] = pts[(k + 1) % 4]; area += x1 * y2 - x2 * y1; }
      if (area < 0) pts = pts.reverse(); // footprints are wound one way so the walls know which side is outside
      out.push({ id: s.id * 10 + i, points: pts, height: SKYWAY.top, facade: 'glass', pal: { roof: [142, 152, 158], wall: [70, 92, 108] }, parts: [{ points: pts, base: SKYWAY.base, top: SKYWAY.top }] });
    }
  }
  return out;
}
