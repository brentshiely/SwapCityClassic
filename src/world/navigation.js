import { polyInfo, nearestOnPolyline, pointAt } from './geometry.js';

// Where am I and where am I headed? Street names come from OpenStreetMap; the compass accounts for the map
// being rotated (map.meta.rotationDegrees) so the streets run straight on screen: straight up on screen is NOT north.
// Pure maths, testable in Node.

const WINDS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compassName = (bearing) => WINDS[Math.round((((bearing % 360) + 360) % 360) / 22.5) % 16];

/**
 * Compass bearing (0 = north, 90 = east, degrees) of a direction on screen.
 * heading: radians, 0 = toward the right of the screen, y down (so -PI/2 is straight up the screen).
 * Straight up the screen is the bearing `rotationDegrees` (30 for this map), because the map was turned by that much.
 */
export function bearingOf(rotationDegrees, headingRad) {
  const clockwiseFromUp = (headingRad * 180) / Math.PI + 90;
  return (((rotationDegrees + clockwiseFromUp) % 360) + 360) % 360;
}

const CROSS_STREET_SKIP = /^(alley|service)$/i;

export class Navigator {
  constructor(map) {
    this.rotation = map.meta.rotationDegrees;
    this.roads = map.roads.filter((r) => r.layer >= 0).map((r) => ({ r, info: polyInfo(r.points) }));
    this.edges = map.graph.edges.map((e) => ({ e, info: polyInfo(e.points) }));
    this.nodes = map.graph.nodes;
    this.tmp = {};
  }

  label(r) {
    if (r.name) return r.name;
    return r.highway === 'service' ? 'Alley' : 'Unnamed street';
  }

  /** the street the player is on (or nearest to): the road whose edge is closest, named streets favoured over alleys */
  streetAt(x, y) {
    let best = null, bd = Infinity;
    for (const { r, info } of this.roads) {
      const n = nearestOnPolyline(info, x, y);
      const d = Math.max(0, n.dist - r.width / 2) + (r.name ? 0 : 6);
      if (d < bd) { bd = d; best = r; }
    }
    return best ? { name: this.label(best), road: best, dist: bd } : null;
  }

  /**
   * @param car {x, y, vx, vy, heading}
   * @returns { street, atJunction, bearing, compass, next: { name, dist } | null, facing }
   */
  locate(car) {
    const speed = Math.hypot(car.vx, car.vy);
    // travel direction when moving, the way the car points when (nearly) stopped
    const dirAngle = speed > 2 ? Math.atan2(car.vy, car.vx) : car.heading;
    const bearing = bearingOf(this.rotation, dirAngle);
    const here = this.streetAt(car.x, car.y);

    // at a junction: name both streets
    let atJunction = null, nearNode = null, nd = 14;
    for (const n of this.nodes) {
      if (n.degree < 3) continue;
      const d = Math.hypot(n.x - car.x, n.y - car.y);
      if (d < nd) { nd = d; nearNode = n; }
    }
    if (nearNode) {
      const names = [...new Set(this.edges.filter(({ e }) => e.from === nearNode.id || e.to === nearNode.id).map(({ e }) => e.name).filter(Boolean))];
      if (names.length >= 2) atJunction = names.slice(0, 2).join(' & ');
    }

    // the next cross street ahead: follow the nearest street segment in the direction of travel to its far end
    let next = null;
    let bestE = null, be = Infinity;
    for (const ed of this.edges) {
      const n = nearestOnPolyline(ed.info, car.x, car.y);
      if (n.dist < be) { be = n.dist; bestE = { ...ed, s: n.s }; }
    }
    if (bestE && be < 25) {
      const p = pointAt(bestE.info, bestE.s, this.tmp);
      const forward = Math.cos(dirAngle) * p.tx + Math.sin(dirAngle) * p.ty >= 0;
      let cur = bestE.e, node = this.nodes[forward ? cur.to : cur.from];
      let dist = forward ? bestE.info.len - bestE.s : bestE.s;
      // a street is often cut into short pieces; a join with only two legs is a bend, not a junction, so keep going
      for (let i = 0; i < 10 && node.degree === 2 && !node.boundary; i++) {
        const nx = this.edges.find(({ e }) => e !== cur && (e.from === node.id || e.to === node.id));
        if (!nx) break;
        dist += nx.info.len;
        cur = nx.e;
        node = this.nodes[cur.from === node.id ? cur.to : cur.from];
      }
      if (node.boundary) next = { name: 'the edge of the map', dist, edge: true };
      else if (dist > 14 || !nearNode) {
        const cross = this.edges.map(({ e }) => e).filter((e) => (e.from === node.id || e.to === node.id) && e.name && e.name !== bestE.e.name && !CROSS_STREET_SKIP.test(e.name));
        if (cross.length) next = { name: cross[0].name, dist };
      }
    }
    return { street: here?.name ?? '', atJunction, bearing, compass: compassName(bearing), next };
  }
}
