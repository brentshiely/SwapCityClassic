/** Smallest angle between two headings when direction is ignored (0 = parallel, PI/2 = crossing). */
export function headingsMod(a, b) {
  let d = Math.abs(a - b) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d;
}
