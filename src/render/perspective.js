// True perspective for a camera looking straight down from height H. A point at height z above the ground is drawn at
// H / (H - z) times its ground distance from the middle of the screen: 1 at the ground, growing without limit as z
// approaches H. A block whose top reaches H is above the lens: its roof cannot be seen and its walls run off the
// screen edge (drawn out to S_MAX times, which is off any screen). Pure maths, tested in Node.

export const S_MAX = 40;

/** the height at which things are treated as above the lens (S_MAX times scale) */
export const lensHeight = (H) => H * (1 - 1 / S_MAX);

/** scale for a point at height z, clamped so a block reaching the camera stays finite */
export function scaleAt(H, z) {
  const zc = lensHeight(H);
  return z >= zc ? S_MAX : H / (H - z);
}

/** camera height for the current zoom: pixels-per-metre = focal / height, so zooming out raises the camera */
export const cameraHeight = (heightAtNearZoom, nearZoom, zoom) => (heightAtNearZoom * nearZoom) / zoom;

/**
 * Is any part of a block (its base ring, its top ring, or the wall between) possibly on screen?
 * Conservative: the box around both rings, scaled about (cx, cy), against the view rectangle.
 */
export function hullVisible(bbox, cx, cy, sBase, sTop, view) {
  const [x0, y0, x1, y1] = bbox;
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (const s of [sBase, sTop]) {
    const ax = cx + (x0 - cx) * s, bx = cx + (x1 - cx) * s, ay = cy + (y0 - cy) * s, by = cy + (y1 - cy) * s;
    mnx = Math.min(mnx, ax, bx); mxx = Math.max(mxx, ax, bx); mny = Math.min(mny, ay, by); mxy = Math.max(mxy, ay, by);
  }
  return mxx >= view.x && mnx <= view.right && mxy >= view.y && mny <= view.bottom;
}
