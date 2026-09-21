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

/** where a roof at the given height appears in the photo relative to its footprint, metres */
export function roofShift(x, y, height) {
  return [height * (lean.x[0] * x + lean.x[1] * y + lean.x[2]), height * (lean.y[0] * x + lean.y[1] * y + lean.y[2])];
}

export class RoofCutter {
  /** @param scene the Phaser scene whose texture manager holds the loaded photo (ROOF_PHOTO.key) */
  constructor(scene) {
    this.scene = scene;
    const tex = scene.textures.exists(ROOF_PHOTO.key) ? scene.textures.get(ROOF_PHOTO.key) : null;
    this.photo = tex ? tex.getSourceImage() : null;
    this.count = 0;
  }

  /**
   * Cut the roof of a block: `pts` is its footprint [{x, y}], `top` its roof height. Returns { key, x0, y0, w, h } (the footprint's
   * bounding box in game metres, which is where the image goes before perspective), or null without the photo.
   */
  cut(id, pts, top) {
    if (!this.photo) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const w = x1 - x0, h = y1 - y0;
    if (w < 0.5 || h < 0.5) return null;
    const ppm = photoMeta.ppm, cw = Math.max(2, Math.ceil(w * ppm)), ch = Math.max(2, Math.ceil(h * ppm));
    const [sx, sy] = roofShift((x0 + x1) / 2, (y0 + y1) / 2, top);
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const g = c.getContext('2d');
    g.beginPath();
    pts.forEach((p, i) => { const px = (p.x - x0) * (cw / w), py = (p.y - y0) * (ch / h); i ? g.lineTo(px, py) : g.moveTo(px, py); });
    g.closePath();
    g.clip();
    // the photo region under the roof: the footprint's box moved by the lean, in photo pixels
    g.drawImage(this.photo, (x0 + sx - photoMeta.minX) * ppm, (y0 + sy - photoMeta.minY) * ppm, w * ppm, h * ppm, 0, 0, cw, ch);
    const key = `roof_${id}_${Math.round(top * 10)}`;
    if (this.scene.textures.exists(key)) this.scene.textures.remove(key);
    this.scene.textures.addCanvas(key, c);
    this.count++;
    return { key, x0, y0, w, h };
  }
}
