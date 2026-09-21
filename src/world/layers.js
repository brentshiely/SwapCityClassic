import { polyInfo, nearestOnPolyline, offsetPolyline } from './geometry.js';

// Layers: where a road runs relative to the ground. 0 is the ground; 1, 2, 3 are bridges and overpasses one, two, three decks up;
// -1 is a tunnel. A car is on one layer (a bridge deck, the street under it, a tunnel) and only touches what is on its layer.
// Layer numbers come from OpenStreetMap; they are trusted for a road, but a CAR changes layer only by driving from one road onto a
// road it is connected to (a ramp), never by passing over or under a road it is not connected to.

export const ALL_LAYERS = -99; // a wall on this layer stops every car (the city limit)
export const DECK_HEIGHT = 8; // metres per layer up
export const layerZ = (layer) => (layer > 0 ? layer * DECK_HEIGHT : 0); // tunnels are drawn on the ground, only dimmer

const LOOKAHEAD = 3.5; // metres ahead of the car's middle where its layer is decided
const TRIM = 7; // metres of a deck's side rails left off at each end, so cars can drive on and off at ramps and junctions

/**
 * The side rails of every bridge and tunnel road: [{ pts, layer, side }]. `side` is +1 for the right of travel (its wall faces left,
 * toward the road) and -1 for the left.
 */
export function deckRails(roads) {
  const out = [];
  for (const r of roads) {
    if (r.layer === 0 || r.highway === 'service') continue;
    const pts = r.points, info = polyInfo(pts);
    if (info.len < 2 * TRIM + 3) continue;
    // cut TRIM off both ends
    const cut = [], tmp = [];
    for (let i = 0; i < pts.length; i++) {
      const s = info.cum[i];
      if (s >= TRIM && s <= info.len - TRIM) cut.push(pts[i]);
    }
    const at = (s) => { let i = 0; while (i < pts.length - 2 && info.cum[i + 1] < s) i++; const t = (s - info.cum[i]) / ((info.cum[i + 1] - info.cum[i]) || 1); return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t]; };
    const line = [at(TRIM), ...cut, at(info.len - TRIM)];
    if (line.length < 2) continue;
    const d = r.width / 2 + 0.3;
    for (const side of [1, -1]) out.push({ pts: offsetPolyline(line, side * d), layer: r.layer, side, road: r });
  }
  return out;
}

/** where a car's layer is decided: from the roads under it and the one it was just on */
export class LayerTracker {
  /** @param world a World (its edge index) */
  constructor(world) {
    this.world = world;
    this.infos = new WeakMap(); // graph edge -> polyInfo
    this.layer = 0;
    this.edge = null; // the edge the car was last on
    this.onRoad = false; // is the car (its look-ahead point) on some road now?
  }

  info(e) { let i = this.infos.get(e); if (!i) { i = polyInfo(e.points); this.infos.set(e, i); } return i; }

  /**
   * the layer of the road the car is on now (unchanged if it is not on a road). A road whose end the car has just passed only counts weakly
   * (the nearest point is its end point), so a road it joins there, which the car is properly ON, takes over at once: a tunnel mouth or
   * a ramp is crossed at the node, not several metres after it (where the building above the tunnel would already have stopped the car).
   */
  update(x, y, heading = null) {
    // decide from a point just ahead of the car's nose: a wall at a tunnel mouth stops the front of the car before its middle reaches the mouth
    if (heading !== null) { x += Math.cos(heading) * LOOKAHEAD; y += Math.sin(heading) * LOOKAHEAD; }
    let strong = null, weak = null, connected = null, best = null, bestD = Infinity;
    this.onRoad = false;
    for (const e of this.world.edgesNear(x, y, 6)) {
      const half = Math.max(6.6, e.lanes * 3.3) / 2 + 1.5;
      const info = this.info(e), r = nearestOnPolyline(info, x, y);
      if (r.dist > half) continue;
      this.onRoad = true;
      const atEnd = r.s < 0.05 || r.s > info.len - 0.05;
      if (e.layer === this.layer) {
        if (!atEnd) { if (!strong || r.dist < strong.d) strong = { e, d: r.dist }; }
        else if (!weak || r.dist < weak.d) weak = { e, d: r.dist };
      } else if (this.edge && !atEnd && (e.from === this.edge.from || e.from === this.edge.to || e.to === this.edge.from || e.to === this.edge.to) && (!connected || r.dist < connected.d)) connected = { e, d: r.dist };
      if (r.dist < bestD) { bestD = r.dist; best = e; }
    }
    if (strong) { this.edge = strong.e; return this.layer; } // still properly on a road of its own layer: stay
    if (connected) { this.edge = connected.e; this.layer = connected.e.layer; return this.layer; } // onto a road it joins: a ramp or a tunnel mouth
    if (weak) { this.edge = weak.e; return this.layer; } // only at the end of its own layer's road (nothing joins there): stay
    if (best && !this.edge) { this.edge = best; this.layer = best.layer; } // first frame
    return this.layer;
  }

  /** force the layer (a teleport or restart) */
  reset(layer = 0) { this.layer = layer; this.edge = null; }
}

/** where a tunnel meets the open road: [{ x, y, angle, width }] with angle pointing OUT of the tunnel */
export function computePortals(graph) {
  const nodes = graph.nodes, out = [];
  const layersAt = new Map();
  for (const e of graph.edges) for (const id of [e.from, e.to]) { let s = layersAt.get(id); if (!s) layersAt.set(id, (s = new Set())); s.add(e.layer); }
  for (const e of graph.edges) {
    if (e.layer >= 0) continue;
    for (const end of ['from', 'to']) {
      const id = end === 'from' ? e.from : e.to;
      if (![...layersAt.get(id)].some((l) => l >= 0)) continue; // the tunnel continues under this node: not a mouth
      const pts = end === 'from' ? e.points : e.points.slice().reverse();
      const a = pts[0], b = pts[Math.min(1, pts.length - 1)];
      const n = nodes[id];
      const dx = a[0] - b[0], dy = a[1] - b[1], l = Math.hypot(dx, dy) || 1; // out of the tunnel
      out.push({ x: n.x, y: n.y, angle: Math.atan2(dy / l, dx / l), width: Math.max(6.6, e.lanes * 3.3) });
    }
  }
  return out;
}
