import { Grid, bboxOfPoints } from '../world/grid2d.js';
import { paintRoadLayer, makePatterns, pathOf, CHUNK, PPM } from './ground.js';
import { scaleAt } from './perspective.js';
import { layerZ } from '../world/layers.js';

// Bridge and overpass decks: roads on layer 1, 2 or 3 are painted (deck, railings, lane lines, a shadow onto what is below) into
// transparent chunk images drawn ABOVE the cars on the ground and below the cars on the deck. A deck is above the ground, so each image is
// scaled away from the middle of the screen by the same perspective factor buildings use (the deck's height is layerZ).

export class BridgeStreamer {
  constructor(scene, world) {
    this.scene = scene; this.world = world;
    this.size = CHUNK / PPM;
    this.pat = makePatterns(document.createElement('canvas').getContext('2d'));
    this.grid = new Grid(128);
    for (const r of world.roads) if (r.layer > 0 && r.layer <= 3) { const [x0, y0, x1, y1] = bboxOfPoints(r.points); this.grid.insert(r, x0, y0, x1, y1); }
    this.chunks = new Map(); // "i_j_layer" -> { image, key, i, j, layer }
    this.visible = true;
    this.painted = 0;
  }

  setVisible(v) { this.visible = v; for (const c of this.chunks.values()) c.image.setVisible(v); return this; }

  /** @param cx, cy the middle of the screen; hw, hh half the screen in metres; H the camera height */
  update(cx, cy, hw, hh, H, budget = 2) {
    const s = this.size, m = s * 0.6;
    const i0 = Math.floor((cx - hw - m) / s), i1 = Math.floor((cx + hw + m) / s), j0 = Math.floor((cy - hh - m) / s), j1 = Math.floor((cy + hh + m) / s);
    const want = new Set();
    let n = 0;
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const x0 = i * s, y0 = j * s, roads = this.grid.query(x0 - 8, y0 - 8, x0 + s + 8, y0 + s + 8);
      if (!roads.size) continue;
      const layers = new Set([...roads].map((r) => r.layer));
      for (const L of layers) {
        const k = `${i}_${j}_${L}`;
        want.add(k);
        if (!this.chunks.has(k) && n < budget) { this.paint(i, j, L, roads); n++; }
      }
    }
    for (const [k, c] of this.chunks) {
      if (!want.has(k) && !(c.i >= i0 - 1 && c.i <= i1 + 1 && c.j >= j0 - 1 && c.j <= j1 + 1)) { this.scene.textures.remove(c.key); c.image.destroy(); this.chunks.delete(k); continue; }
      const f = scaleAt(H, layerZ(c.layer)), x0 = c.i * s, y0 = c.j * s;
      c.image.setPosition(cx + (x0 - cx) * f, cy + (y0 - cy) * f).setDisplaySize(s * f, s * f).setVisible(this.visible && want.has(k));
    }
  }

  paint(i, j, layer, roadSet) {
    const s = this.size, originX = i * s, originY = j * s;
    const x0 = originX - 8, y0 = originY - 8, x1 = originX + s + 8, y1 = originY + s + 8;
    const view = this.world.view(x0, y0, x1, y1);
    view.roads = view.roads.filter((r) => r.layer === layer);
    const c = document.createElement('canvas');
    c.width = c.height = CHUNK;
    const ctx = c.getContext('2d');
    ctx.setTransform(PPM, 0, 0, PPM, -originX * PPM, -originY * PPM);
    ctx.lineJoin = 'round'; ctx.lineCap = 'butt';
    // the shadow of the deck on what is below (the light is from the upper left)
    ctx.save();
    ctx.translate(2.4, 3.2);
    ctx.strokeStyle = 'rgba(0,0,0,0.30)';
    for (const r of view.roads) { ctx.lineWidth = r.width + 3.6; pathOf(ctx, r.points); ctx.stroke(); }
    ctx.restore();
    // the deck: concrete fascia, then the road as on the ground (railings are the kerb line, lane lines, stop lines)
    ctx.strokeStyle = '#8d9088';
    for (const r of view.roads) { ctx.lineWidth = r.width + 1.8; pathOf(ctx, r.points); ctx.stroke(); }
    // butt ends: where the deck ends the street at ground level takes over at that spot, so the deck just stops square (round ends made a curl)
    paintRoadLayer(ctx, view, this.pat, layer);
    const key = `deck_${i}_${j}_${layer}`;
    if (this.scene.textures.exists(key)) this.scene.textures.remove(key);
    this.scene.textures.addCanvas(key, c);
    const image = this.scene.add.image(originX, originY, key).setOrigin(0, 0).setDisplaySize(s, s).setDepth(8 + layer).setVisible(this.visible);
    this.chunks.set(`${i}_${j}_${layer}`, { image, key, i, j, layer });
    this.painted++;
  }
}
