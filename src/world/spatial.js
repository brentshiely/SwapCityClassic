// A uniform grid over polylines (and points), so "what is near here?" costs the same on a whole city as on one block.
// Every item is registered in EVERY cell its polyline touches (exact, not sampled), so a query that covers a
// circle of radius r finds every item that comes within r of the centre. Pure maths, testable in Node.

// does the segment a-b touch the rectangle? (Liang-Barsky clip)
function segHitsRect(ax, ay, bx, by, x0, y0, x1, y1) {
  const dx = bx - ax, dy = by - ay;
  let t0 = 0, t1 = 1;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  return clip(-dx, ax - x0) && clip(dx, x1 - ax) && clip(-dy, ay - y0) && clip(dy, y1 - ay);
}

export class PolyGrid {
  constructor(cell = 200) {
    this.cell = cell;
    this.cells = new Map(); // cell key -> item indices
    this.items = [];
    this.stamp = []; // per item: the query that last visited it, so an item spanning many cells is reported once
    this.gen = 0;
  }

  put(idx, cx, cy) {
    const k = cx * 65536 + cy;
    const arr = this.cells.get(k);
    if (!arr) this.cells.set(k, [idx]);
    else if (arr[arr.length - 1] !== idx) arr.push(idx); // the last-entry check drops the common duplicate (neighbouring segments)
  }

  /** register `item` in every cell that its polyline `pts` ([[x, y], ...]; one point = a point item) comes within `pad` metres of */
  add(item, pts, pad = 0) {
    const idx = this.items.push(item) - 1, C = this.cell;
    this.stamp.push(0);
    if (pts.length === 1) {
      const [x, y] = pts[0];
      for (let cx = Math.floor((x - pad) / C); cx <= Math.floor((x + pad) / C); cx++) for (let cy = Math.floor((y - pad) / C); cy <= Math.floor((y + pad) / C); cy++) this.put(idx, cx, cy);
      return idx;
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const cx0 = Math.floor((Math.min(a[0], b[0]) - pad) / C), cx1 = Math.floor((Math.max(a[0], b[0]) + pad) / C);
      const cy0 = Math.floor((Math.min(a[1], b[1]) - pad) / C), cy1 = Math.floor((Math.max(a[1], b[1]) + pad) / C);
      const simple = cx0 === cx1 || cy0 === cy1; // a segment inside one row or column of cells touches all of them
      for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
        if (simple || segHitsRect(a[0], a[1], b[0], b[1], cx * C - pad, cy * C - pad, (cx + 1) * C + pad, (cy + 1) * C + pad)) this.put(idx, cx, cy);
      }
    }
    return idx;
  }

  /** call fn(item, index) once for each item registered in a cell that the square of half-size r around (x, y) overlaps */
  query(x, y, r, fn) {
    const C = this.cell, gen = ++this.gen, stamp = this.stamp, items = this.items;
    const cx1 = Math.floor((x + r) / C), cy1 = Math.floor((y + r) / C), cy0 = Math.floor((y - r) / C);
    for (let cx = Math.floor((x - r) / C); cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const arr = this.cells.get(cx * 65536 + cy);
      if (!arr) continue;
      for (let k = 0; k < arr.length; k++) {
        const idx = arr[k];
        if (stamp[idx] === gen) continue;
        stamp[idx] = gen;
        fn(items[idx], idx);
      }
    }
  }
}
