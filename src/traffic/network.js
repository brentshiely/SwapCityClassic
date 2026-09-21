import { offsetPolyline, polyInfo, junctionInfo } from '../world/geometry.js';

// The traffic's view of the road graph: every street segment becomes one or two DIRECTED segments,
// following what OpenStreetMap says: a one-way street can only be driven from -> to, a two-way
// street both ways. Each directed segment has lanes (right of travel), a speed limit from OSM
// (`maxspeed`, else 25 mph) and, at a signalized junction, a stop line.

export const MPH = 0.44704;
export const DEFAULT_MPH = 25;
export const LANE_WIDTH = 3.3;

export function buildNetwork(map) {
  const { nodes, edges } = map.graph;
  const jinfo = junctionInfo(map);
  const out = new Map(nodes.map((n) => [n.id, []]));
  const directed = [];

  const add = (e, dir) => {
    const forward = dir === 1;
    const pts = forward ? e.points : e.points.slice().reverse();
    const from = forward ? e.from : e.to, to = forward ? e.to : e.from;
    const width = Math.max(6.6, e.lanes * LANE_WIDTH);
    // lanes per direction: a one-way street uses all its lanes, a two-way street splits them
    const nl = e.oneway ? Math.max(1, e.lanes) : Math.max(1, Math.floor(e.lanes / 2));
    // lane centres to the right of the street's centre line; one-way lanes are spread across the whole road
    const offsets = Array.from({ length: nl }, (_, i) => (e.oneway ? (i + 0.5 - nl / 2) * LANE_WIDTH : (i + 0.5) * LANE_WIDTH));
    const de = {
      key: `${e.id}${forward ? '+' : '-'}`, edge: e, dir, from, to, pts, width, nl, offsets,
      speed: (e.mph ?? DEFAULT_MPH) * MPH, name: e.name, oneway: e.oneway,
      lanes: new Array(nl).fill(null), signal: null,
    };
    out.get(from).push(de);
    directed.push(de);
    return de;
  };
  for (const e of edges) { add(e, 1); if (!e.oneway) add(e, -1); }

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const lane = (de, i) => (de.lanes[i] ??= polyInfo(offsetPolyline(de.pts, de.offsets[i])));
  const headingAtEnd = (de) => { const p = de.pts, a = p[p.length - 2], b = p[p.length - 1]; return Math.atan2(b[1] - a[1], b[0] - a[0]); };

  return { nodes, nodeById, directed, out, jinfo, lane, headingAtEnd };
}
