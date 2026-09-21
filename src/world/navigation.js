import { polyInfo, nearestOnPolyline, pointAt } from './geometry.js';
import { PolyGrid } from './spatial.js';

// Where am I and where am I headed? Street names come from OpenStreetMap; the compass accounts for the map
// being rotated (map.meta.rotationDegrees) so the streets run straight on screen: straight up on screen is NOT north.
// Pure maths, testable in Node. Roads, streets and junctions sit in 64 m grids, so a lookup costs the same on a whole city as on a block.

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
    this.roads = map.roads.filter((r) => r.layer >= 0).map((r, i) => ({ r, info: polyInfo(r.points), i }));
    this.edges = map.graph.edges.map((e, i) => ({ e, info: polyInfo(e.points), i }));
    this.nodes = map.graph.nodes;
    this.nodeById = new Map(this.nodes.map((n) => [n.id, n]));
    this.tmp = {};
    // spatial indexes; `i` is the position in the original list, so ties are settled the way a plain scan would
    this.roadGrid = new PolyGrid(64);
    this.maxHalf = 0; // the widest road's half width: how far a road's edge can be closer than its centre line
    for (const rd of this.roads) { this.roadGrid.add(rd, rd.r.points); this.maxHalf = Math.max(this.maxHalf, rd.r.width / 2); }
    this.edgeGrid = new PolyGrid(64);
    this.byNode = new Map(); // node id -> the street pieces that end there, in data order
    for (const ed of this.edges) {
      this.edgeGrid.add(ed, ed.e.points);
      for (const id of [ed.e.from, ed.e.to]) { const l = this.byNode.get(id); if (l) l.push(ed); else this.byNode.set(id, [ed]); }
    }
    this.junctionGrid = new PolyGrid(64);
    this.nodes.forEach((n, i) => { if (n.degree >= 3) this.junctionGrid.add({ n, i }, [[n.x, n.y]]); });
  }

  label(r) {
    if (r.name) return r.name;
    return r.highway === 'service' ? 'Alley' : 'Unnamed street';
  }

  /** the street the player is on (or nearest to): the road whose edge is closest, named streets favoured over alleys */
  streetAt(x, y) {
    let best = null, bd = Infinity, bi = Infinity;
    const visit = ({ r, info, i }) => {
      const n = nearestOnPolyline(info, x, y);
      const d = Math.max(0, n.dist - r.width / 2) + (r.name ? 0 : 6);
      if (d < bd || (d === bd && i < bi)) { bd = d; best = r; bi = i; }
    };
    // widen the search until the best road found is certainly better than any road not yet looked at
    // (an unseen road's centre line is farther than R, so its score is above R - maxHalf)
    // (no road within 480 m means the car is out in the country: no street, rather than searching a whole city for one)
    for (let R = 60; R <= 480; R *= 2) {
      this.roadGrid.query(x, y, R, visit);
      if (best && bd <= R - this.maxHalf) break;
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
    let atJunction = null, nearNode = null, nd = 14, ni = Infinity;
    this.junctionGrid.query(car.x, car.y, 14, ({ n, i }) => {
      const d = Math.hypot(n.x - car.x, n.y - car.y);
      if (d < nd || (d === nd && nearNode && i < ni)) { nd = d; nearNode = n; ni = i; }
    });
    if (nearNode) {
      const names = [...new Set((this.byNode.get(nearNode.id) ?? []).map(({ e }) => e.name).filter(Boolean))];
      if (names.length >= 2) atJunction = names.slice(0, 2).join(' & ');
    }

    // the next cross street ahead: follow the nearest street segment in the direction of travel to its far end
    let next = null;
    let bestE = null, be = Infinity, bi = Infinity;
    this.edgeGrid.query(car.x, car.y, 25, (ed) => {
      const n = nearestOnPolyline(ed.info, car.x, car.y);
      if (n.dist < be || (n.dist === be && ed.i < bi)) { be = n.dist; bi = ed.i; bestE = { ...ed, s: n.s }; }
    });
    if (bestE && be < 25) {
      const p = pointAt(bestE.info, bestE.s, this.tmp);
      const forward = Math.cos(dirAngle) * p.tx + Math.sin(dirAngle) * p.ty >= 0;
      let cur = bestE.e, node = this.nodeById.get(forward ? cur.to : cur.from);
      let dist = forward ? bestE.info.len - bestE.s : bestE.s;
      // a street is often cut into short pieces; a join with only two legs is a bend, not a junction, so keep going
      for (let i = 0; i < 10 && node.degree === 2 && !node.boundary; i++) {
        const nx = (this.byNode.get(node.id) ?? []).find(({ e }) => e !== cur);
        if (!nx) break;
        dist += nx.info.len;
        cur = nx.e;
        node = this.nodeById.get(cur.from === node.id ? cur.to : cur.from);
      }
      if (node.boundary) next = { name: 'the edge of the map', dist, edge: true };
      else if (dist > 14 || !nearNode) {
        const cross = (this.byNode.get(node.id) ?? []).map(({ e }) => e).filter((e) => e.name && e.name !== bestE.e.name && !CROSS_STREET_SKIP.test(e.name));
        if (cross.length) next = { name: cross[0].name, dist };
      }
    }
    return { street: here?.name ?? '', atJunction, bearing, compass: compassName(bearing), next };
  }
}
