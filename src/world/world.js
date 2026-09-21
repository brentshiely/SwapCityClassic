import { insidePolygon, bboxOfPoints, Grid } from './grid2d.js';
import { junctionInfo } from './geometry.js';

// The whole city as the game sees it: the road graph is loaded once (city.json), everything else (buildings, parks and lots,
// sidewalks, crosswalks, skyways) arrives in 256 m tiles as the player moves. This class decides which tiles are wanted, fetches
// them, keeps the near ones and lets the far ones go, and tells the rest of the game through onLoad / onUnload.
// See design/CITY_DATA.md for the data format.

export const fetchSource = (base) => async (tx, ty) => {
  const r = await fetch(`${base}/tiles/${tx}_${ty}.json`);
  return r.ok ? r.json() : null;
};

export class World {
  /**
   * @param city the parsed city.json
   * @param source (tx, ty) => Promise<tile | null>  (null = an empty tile)
   * @param loadRadius tiles around the player that must be loaded (2 = a 5 x 5 block of tiles)
   * @param keepRadius tiles farther than this from the player are dropped
   */
  constructor(city, source, { loadRadius = 2, keepRadius = 3, parallel = 4 } = {}) {
    this.city = city;
    this.meta = city.meta;
    this.roads = city.roads;
    this.graph = city.graph;
    this.T = city.meta.tileSize ?? 256;
    this.source = source;
    Object.assign(this, { loadRadius, keepRadius, parallel });
    this.tiles = new Map(); // key -> tile (loaded; missing ones are stored as an empty tile)
    this.loading = new Set();
    this.queue = []; // loaded but not yet announced: spreads the work of using a tile over several frames
    this.onLoad = []; this.onUnload = [];
    this.stats = { loaded: 0, unloaded: 0, fetched: 0, failed: 0 };
    const b = city.meta.boundary;
    this.boundary = b;
    this.bx0 = Math.min(...b.map((p) => p[0])); this.bx1 = Math.max(...b.map((p) => p[0]));
    this.by0 = Math.min(...b.map((p) => p[1])); this.by1 = Math.max(...b.map((p) => p[1]));
  }

  key(tx, ty) { return `${tx}_${ty}`; }
  tileOf(x, y) { return [Math.floor(x / this.T), Math.floor(y / this.T)]; }

  /** is the tile at (x, y) here (or known to be empty)? Building data around this spot can be trusted. */
  isLoaded(x, y) { return this.tiles.has(this.key(Math.floor(x / this.T), Math.floor(y / this.T))); }
  /** is every tile within `r` metres of (x, y) loaded? */
  isLoadedAround(x, y, r) {
    for (let tx = Math.floor((x - r) / this.T); tx <= Math.floor((x + r) / this.T); tx++) {
      for (let ty = Math.floor((y - r) / this.T); ty <= Math.floor((y + r) / this.T); ty++) if (!this.tiles.has(this.key(tx, ty))) return false;
    }
    return true;
  }

  /**
   * features of one kind ('buildings', 'areas', 'crossings', 'walkways', 'skyways') in loaded tiles whose bounding box touches the box,
   * each once. Crossings are points {x, y}, the rest have `points`.
   */
  featuresIn(kind, x0, y0, x1, y1) {
    const out = new Set();
    for (let tx = Math.floor(x0 / this.T); tx <= Math.floor(x1 / this.T); tx++) {
      for (let ty = Math.floor(y0 / this.T); ty <= Math.floor(y1 / this.T); ty++) {
        const tile = this.tiles.get(this.key(tx, ty));
        if (!tile) continue;
        for (const f of tile[kind]) {
          const bb = f._bb ?? (f._bb = f.points ? bboxOfPoints(f.points) : [f.x, f.y, f.x, f.y]);
          if (bb[2] >= x0 && bb[0] <= x1 && bb[3] >= y0 && bb[1] <= y1) out.add(f);
        }
      }
    }
    return [...out];
  }

  /**
   * Everything needed to draw the roads in a box (painting the ground, building the Google overlay): the roads and graph edges that
   * touch it, and the crossings and parks/lots from loaded tiles. The junction widths are those of the WHOLE graph.
   */
  view(x0, y0, x1, y1, roadReach = 30) {
    if (!this.roadGrid) {
      this.roadGrid = new Grid(128); this.edgeGrid = new Grid(128);
      for (const r of this.roads) { const [a, b, c, d] = bboxOfPoints(r.points); this.roadGrid.insert(r, a, b, c, d); }
      for (const e of this.graph.edges) { const [a, b, c, d] = bboxOfPoints(e.points); this.edgeGrid.insert(e, a, b, c, d); }
      this.graph._ji ??= junctionInfo({ graph: this.graph });
    }
    return {
      roads: [...this.roadGrid.query(x0 - roadReach, y0 - roadReach, x1 + roadReach, y1 + roadReach)], // beyond the box, so an alley's end can find the street it meets
      graph: { nodes: this.graph.nodes, edges: [...this.edgeGrid.query(x0, y0, x1, y1)], _ji: this.graph._ji },
      crossings: this.featuresIn('crossings', x0, y0, x1, y1), areas: this.featuresIn('areas', x0, y0, x1, y1),
    };
  }

  insideCity(x, y) {
    return x >= this.bx0 && x <= this.bx1 && y >= this.by0 && y <= this.by1 && insidePolygon(x, y, this.boundary);
  }

  /** call each frame with the player's position */
  update(x, y) {
    const [cx, cy] = this.tileOf(x, y), R = this.loadRadius, t = this.meta.tiles;
    const want = [];
    for (let dx = -R; dx <= R; dx++) for (let dy = -R; dy <= R; dy++) {
      const tx = cx + dx, ty = cy + dy, k = this.key(tx, ty);
      if (this.tiles.has(k) || this.loading.has(k)) continue;
      if (t && (tx < t.minTx || tx > t.maxTx || ty < t.minTy || ty > t.maxTy)) { this.accept(tx, ty, null); continue; } // outside the data: empty
      want.push([Math.max(Math.abs(dx), Math.abs(dy)) * 1000 + Math.hypot(dx, dy), tx, ty]);
    }
    want.sort((a, b) => a[0] - b[0]);
    for (const [, tx, ty] of want) {
      if (this.loading.size >= this.parallel) break;
      const k = this.key(tx, ty);
      this.loading.add(k);
      this.stats.fetched++;
      Promise.resolve(this.source(tx, ty)).then((data) => { this.loading.delete(k); this.accept(tx, ty, data); },
        () => { this.loading.delete(k); this.stats.failed++; this.accept(tx, ty, null); }); // a failed tile is treated as empty (never blocks the game)
    }
    // drop far tiles
    for (const [k, tile] of this.tiles) {
      if (Math.max(Math.abs(tile.tx - cx), Math.abs(tile.ty - cy)) > this.keepRadius) {
        this.tiles.delete(k);
        this.stats.unloaded++;
        if (tile.announced) for (const f of this.onUnload) f(tile);
      }
    }
    // announce a couple of loaded tiles per frame
    for (let n = 0; n < 2 && this.queue.length; n++) {
      const tile = this.queue.shift();
      if (this.tiles.get(this.key(tile.tx, tile.ty)) !== tile) continue; // dropped before it was announced
      tile.announced = true;
      this.stats.loaded++;
      for (const f of this.onLoad) f(tile);
    }
  }

  accept(tx, ty, data) {
    const tile = { tx, ty, buildings: [], areas: [], walkways: [], crossings: [], skyways: [], ...(data ?? {}), empty: !data, announced: false };
    this.tiles.set(this.key(tx, ty), tile);
    this.queue.push(tile);
  }

  /** tiles are loaded synchronously from a ready source (Node tests, the starting area): fill the whole ring at once */
  async preload(x, y) {
    const [cx, cy] = this.tileOf(x, y), R = this.loadRadius, jobs = [];
    for (let dx = -R; dx <= R; dx++) for (let dy = -R; dy <= R; dy++) {
      const tx = cx + dx, ty = cy + dy, k = this.key(tx, ty), t = this.meta.tiles;
      if (this.tiles.has(k)) continue;
      if (t && (tx < t.minTx || tx > t.maxTx || ty < t.minTy || ty > t.maxTy)) { this.accept(tx, ty, null); continue; }
      jobs.push(Promise.resolve(this.source(tx, ty)).then((d) => this.accept(tx, ty, d), () => this.accept(tx, ty, null)));
    }
    await Promise.all(jobs);
    while (this.queue.length) { const tile = this.queue.shift(); tile.announced = true; this.stats.loaded++; for (const f of this.onLoad) f(tile); }
  }
}
