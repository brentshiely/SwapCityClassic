// A uniform grid over the plane for "what is near here?" questions. Items go in with a bounding box and come out (once each) for any
// query box that touches theirs. Used for roads, graph edges and the like at city scale, where scanning everything is too slow.
export class Grid {
  constructor(cell = 128) { this.cell = cell; this.cells = new Map(); }
  key(i, j) { return i * 131072 + j; }
  insert(item, x0, y0, x1, y1) {
    const c = this.cell;
    for (let i = Math.floor(x0 / c); i <= Math.floor(x1 / c); i++) for (let j = Math.floor(y0 / c); j <= Math.floor(y1 / c); j++) {
      const k = this.key(i, j);
      const list = this.cells.get(k);
      if (list) list.push(item); else this.cells.set(k, [item]);
    }
    return this;
  }
  /** every item whose box touches the query box, each once (a Set) */
  query(x0, y0, x1, y1, out = new Set()) {
    const c = this.cell;
    for (let i = Math.floor(x0 / c); i <= Math.floor(x1 / c); i++) for (let j = Math.floor(y0 / c); j <= Math.floor(y1 / c); j++) {
      const list = this.cells.get(this.key(i, j));
      if (list) for (const it of list) out.add(it);
    }
    return out;
  }
}

export const bboxOfPoints = (pts) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
  return [x0, y0, x1, y1];
};

/** is (x, y) inside the polygon [[x, y], ...]? */
export function insidePolygon(x, y, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if ((poly[i][1] > y) !== (poly[j][1] > y) && x < ((poly[j][0] - poly[i][0]) * (y - poly[i][1])) / (poly[j][1] - poly[i][1]) + poly[i][0]) c = !c;
  }
  return c;
}
