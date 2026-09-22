// How far a city's street grid is turned from true north/east, so the bake can rotate it the way Minneapolis was rotated by hand
// (rotationDegrees: 30, chosen so downtown's streets run straight up-down and left-right on screen). For a new city we do not know
// that angle in advance, so we measure it from the roads themselves: a street grid has 4-fold symmetry (its own direction and the
// one 90 degrees from it look the same), so this is exactly the "orientation histogram" trick from circular statistics: multiply
// every segment's angle by 4 (the fold count) before averaging as a vector, so directions 0, 90, 180, 270 degrees apart all land on
// the same point; the average vector's own angle, divided back by 4, is the grid's dominant axis, and its length (0..1) says how
// gridded the streets really are (close to 1 = a strict grid, close to 0 = no dominant direction, e.g. a lake shore's roads).
//
// segments: [{ dx, dy, weight }] in any consistent x/y (east/north, or metres, sign does not matter as long as it is consistent).
// Returns { axisDegrees, strength }: axisDegrees is in [0, 90); strength in [0, 1].
export function dominantAxis(segments) {
  let sx = 0, sy = 0, wsum = 0;
  for (const { dx, dy, weight } of segments) {
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const angle = Math.atan2(dy, dx), w = weight ?? len;
    sx += w * Math.cos(4 * angle);
    sy += w * Math.sin(4 * angle);
    wsum += w;
  }
  if (wsum < 1e-9) return { axisDegrees: 0, strength: 0 };
  const strength = Math.hypot(sx, sy) / wsum;
  const axisDegrees = (((Math.atan2(sy, sx) / 4) * 180) / Math.PI + 360) % 90;
  return { axisDegrees, strength };
}

/**
 * The game's `rotationDegrees` (see tools/lib/bake_common.mjs `makeFrame`) that puts this grid's dominant axis on screen's
 * vertical/horizontal, given the segments in local east/north metres (rotationDegrees = 0, i.e. before any rotation).
 */
export function rotationForGrid(segmentsEN) {
  const { axisDegrees, strength } = dominantAxis(segmentsEN);
  // the game frame's y is flipped (screen down) relative to north-up ENU (see the derivation in design/CITY_DATA.md), which turns
  // a +rotationDegrees rotation of the streets into a -axisDegrees turn of the drawn roads; wrap into [0, 90) as Minneapolis's own
  // rotationDegrees (30) is expressed.
  const rotationDegrees = ((-axisDegrees % 90) + 90) % 90;
  return { rotationDegrees, strength };
}
