// Turn the Overpass boundary relation (members with geometry) into the largest closed outer ring, as [[lat, lon], ...].
export function assembleRings(rel) {
  const segs = rel.members.filter((m) => m.type === 'way' && m.role !== 'inner' && m.geometry?.length > 1).map((m) => m.geometry.map((p) => [p.lat, p.lon]));
  const k = (p) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;
  const rings = [];
  const pool = segs.slice();
  while (pool.length) {
    let ring = pool.pop();
    let grew = true;
    while (grew && k(ring[0]) !== k(ring[ring.length - 1])) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const s = pool[i];
        if (k(s[0]) === k(ring[ring.length - 1])) ring = ring.concat(s.slice(1));
        else if (k(s[s.length - 1]) === k(ring[ring.length - 1])) ring = ring.concat(s.slice(0, -1).reverse());
        else if (k(s[s.length - 1]) === k(ring[0])) ring = s.concat(ring.slice(1));
        else if (k(s[0]) === k(ring[0])) ring = s.slice(1).reverse().concat(ring);
        else continue;
        pool.splice(i, 1);
        grew = true;
        break;
      }
    }
    rings.push(ring);
  }
  return rings;
}
const ringArea = (r) => { let a = 0; for (let i = 0; i < r.length - 1; i++) a += r[i][1] * r[i + 1][0] - r[i + 1][1] * r[i][0]; return Math.abs(a / 2); };
export const largestRing = (relations) => relations.flatMap(assembleRings).sort((a, b) => ringArea(b) - ringArea(a));
