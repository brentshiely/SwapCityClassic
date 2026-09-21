import photoUrl from '../../data/roofs_naip.jpg?inline';
import photoMeta from '../../data/roofs_naip.json';
import lean from '../../data/roof_offsets.json';

// Roofs cut from a real aerial photo (USDA NAIP, public domain; tools/bake_naip.py put it in the game's own frame).
//
// NAIP is straightened to the ground, so the roof of a tall building is shifted in the photo away from where the camera was
// (the tower "leans", and its walls show). tools/roof_offsets.py measured that: a roof of height h at (x, y) sits at
// (x, y) + h * (a x + c, b y + d) in the photo. Each roof is cut from where it really is, so the picture on a roof is that roof.
// Each cut-out is a small transparent-edged image in the shape of the roof; the building renderer draws it scaled with the
// perspective, the same way it draws the flat roof polygon.

export const ROOF_PHOTO = { key: 'roof_photo', url: photoUrl };

/**
 * where a roof at the given height appears in the photo relative to its footprint, metres. The lean was measured downtown; farther out the
 * position terms are held at the edge of downtown (a constant lean, about a tenth of the height), which is close for the low buildings there.
 */
export function roofShift(x, y, height) {
  const cx = Math.max(-400, Math.min(400, x)), cy = Math.max(-400, Math.min(400, y));
  return [height * (lean.x[0] * cx + lean.x[1] * cy + lean.x[2]), height * (lean.y[0] * cx + lean.y[1] * cy + lean.y[2])];
}

/** the roof lean per 1500 m region of the city (data/city/roof_lean.json): a roof of height h is displaced by h * (ax, ay) in the photo */
export class LeanTable {
  constructor(t) { this.cell = t.cell; this.lean = t.lean; this.fallback = t.fallback ?? [-0.1, 0.055]; }
  shift(x, y, h) {
    const l = this.lean[`${Math.floor(x / this.cell)}_${Math.floor(y / this.cell)}`] ?? this.fallback;
    return [h * l[0], h * l[1]];
  }
}

export class RoofCutter {
  /** @param scene the Phaser scene whose texture manager holds the loaded photo (ROOF_PHOTO.key) */
  constructor(scene) {
    this.scene = scene;
    const tex = scene.textures.exists(ROOF_PHOTO.key) ? scene.textures.get(ROOF_PHOTO.key) : null;
    this.photo = tex ? tex.getSourceImage() : null;
    this.count = 0;
    this.tileMeta = null; // { ppm, margin, tileSize } of the per-tile roof photos, when the city has them
    this.lean = null; // per-region roof lean (LeanTable), when the city was measured with LiDAR (tools/roof_lean_city.py)
  }

  /**
   * Cut the roof of a block: `pts` is its footprint [{x, y}], `top` its roof height. Returns { key, x0, y0, w, h } (the footprint's
   * bounding box in game metres, which is where the image goes before perspective), or null without the photo.
   */
  cut(id, pts, top, tile = null) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const w = x1 - x0, h = y1 - y0;
    if (w < 0.5 || h < 0.5) return null;
    const cw = Math.max(2, Math.ceil(w * 3)), ch = Math.max(2, Math.ceil(h * 3)); // cut-out size: 3 px per metre (a tile photo has fewer, and is stretched)
    let [sx, sy] = roofShift((x0 + x1) / 2, (y0 + y1) / 2, top);
    // the photo to cut from: the sharp downtown one if the roof is inside it, else the photo of the tile it arrived with (with its margin)
    let photo = null, ox = photoMeta.minX, oy = photoMeta.minY, ppm = photoMeta.ppm;
    if (this.photo && x0 + sx >= photoMeta.minX && y0 + sy >= photoMeta.minY && x1 + sx <= photoMeta.maxX && y1 + sy <= photoMeta.maxY) photo = this.photo;
    else if (tile?.photo && this.tileMeta) {
      if (this.lean) [sx, sy] = this.lean.shift((x0 + x1) / 2, (y0 + y1) / 2, top); // this part of the city was photographed from another point: its own lean
      const { ppm: tp, margin: m, tileSize: T } = this.tileMeta;
      ox = tile.tx * T - m; oy = tile.ty * T - m; ppm = tp;
      if (x0 + sx >= ox && y0 + sy >= oy && x1 + sx <= ox + T + 2 * m && y1 + sy <= oy + T + 2 * m) photo = tile.photo;
    }
    if (!photo) return null; // no photo there: a flat roof colour is drawn instead
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const g = c.getContext('2d');
    g.beginPath();
    pts.forEach((p, i) => { const px = (p.x - x0) * (cw / w), py = (p.y - y0) * (ch / h); i ? g.lineTo(px, py) : g.moveTo(px, py); });
    g.closePath();
    g.clip();
    // the photo region under the roof: the footprint's box moved by the lean, in photo pixels
    g.drawImage(photo, (x0 + sx - ox) * ppm, (y0 + sy - oy) * ppm, w * ppm, h * ppm, 0, 0, cw, ch);
    const key = `roof_${id}_${Math.round(top * 10)}`;
    if (this.scene.textures.exists(key)) this.scene.textures.remove(key);
    this.scene.textures.addCanvas(key, c);
    this.count++;
    return { key, x0, y0, w, h };
  }
}
