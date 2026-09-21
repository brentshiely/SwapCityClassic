import Phaser from 'phaser';
import { scaleAt } from './perspective.js';
import { mulberry32 } from './rng.js';

// Facades: what the walls of a building look like from above at a slant. Nothing is in the data but the building type, its
// height, sometimes its number of storeys, and (rarely) a material or colour from OpenStreetMap, so each building gets a STYLE
// from those, deterministic per building:
//   glass      a curtain-wall tower: continuous glass bands with thin mullions, tinted (blue, green, bronze, grey)
//   punched    brick, stone or concrete with a window in every bay of every floor; a storefront on the ground floor
//   garage     a parking deck: open concrete floors with dark openings
// Floors are drawn at their true heights, so with the camera's perspective the upper floors of a tall building stretch out.

const rgb = ([r, g, b], k = 1) => Phaser.Display.Color.GetColor(Math.min(255, r * k), Math.min(255, g * k), Math.min(255, b * k));
const hash = (a, b, c) => { let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35) ^ Math.imul(c + 0x165667b1, 0x27d4eb2f); h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); return ((h ^ (h >>> 12)) >>> 0) / 4294967296; };

const GLASS_TINTS = [
  { wall: [64, 82, 98], glass: [96, 134, 162], high: [150, 184, 206] }, // blue
  { wall: [58, 84, 84], glass: [88, 134, 132], high: [146, 188, 184] }, // green
  { wall: [86, 76, 68], glass: [138, 116, 92], high: [190, 166, 132] }, // bronze
  { wall: [70, 78, 86], glass: [112, 126, 138], high: [170, 184, 194] }, // grey
  { wall: [30, 40, 54], glass: [56, 72, 92], high: [110, 132, 156] }, // dark
];
const WALLS = [
  { name: 'brick', wall: [156, 90, 68] }, { name: 'brick', wall: [130, 76, 62] }, { name: 'brick', wall: [172, 108, 80] },
  { name: 'stone', wall: [196, 182, 152] }, { name: 'stone', wall: [180, 168, 144] }, { name: 'limestone', wall: [206, 198, 176] },
  { name: 'concrete', wall: [152, 154, 152] }, { name: 'concrete', wall: [134, 138, 140] }, { name: 'granite', wall: [150, 128, 124] },
];
const MATERIAL_WALL = { brick: WALLS[0], stone: WALLS[3], limestone: WALLS[5], concrete: WALLS[6], granite: WALLS[8], sandstone: WALLS[4] };

function parseColour(c) {
  if (typeof c !== 'string') return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** decide the look of a building (`b` is a baked building; `top` the height of the whole building) */
export function facadeStyle(b, top) {
  const r = mulberry32(b.id ^ 0x5bd1e995);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const u = r(); // luck, for choices that should not depend on one another
  let kind;
  if (b.facade) kind = b.facade; // forced (skyways)
  else if (b.material === 'glass') kind = 'glass';
  else if (b.type === 'parking') kind = 'garage';
  else if (top >= 60) kind = u < 0.7 ? 'glass' : 'punched';
  else if (top >= 28 && (b.type === 'office' || b.type === 'commercial') && u < 0.45) kind = 'glass';
  else kind = 'punched';

  const s = { kind, id: b.id };
  if (kind === 'glass') {
    Object.assign(s, pick(GLASS_TINTS));
    s.floorH = 3.9; s.bay = 1.5 + r() * 0.6; s.mullion = true;
    if (b.colour) { const c = parseColour(b.colour); if (c) s.wall = c.map((v) => v * 0.55); }
  } else if (kind === 'garage') {
    s.wall = [150, 150, 146]; s.glass = [40, 44, 48]; s.high = [90, 94, 98]; s.floorH = 3.0; s.bay = 5.0;
  } else {
    const w = MATERIAL_WALL[b.material] ?? pick(WALLS);
    s.wall = w.wall.slice();
    const c = parseColour(b.colour);
    if (c) s.wall = c;
    const old = w.name === 'brick' || w.name === 'stone' || w.name === 'limestone';
    s.glass = old ? [44, 60, 74] : [60, 84, 102]; s.high = old ? [92, 112, 128] : [120, 148, 166];
    s.floorH = 3.4 + r() * 0.5; s.bay = old ? 2.6 + r() * 0.8 : 3.2 + r() * 1.2;
    s.window = old ? [0.5, 0.62] : [0.62, 0.7]; // share of the bay and of the floor that is window
    s.storefront = ['retail', 'commercial', 'office', 'hotel', 'yes'].includes(b.type) && top < 60;
  }
  if (b.levels && b.levels >= 2) s.floorH = Math.max(2.8, Math.min(5.5, top / b.levels)); // measured height / storeys OSM knows
  return s;
}

/**
 * Draw the windows on one wall of a block. A, B are the footprint end points of the wall (x, y), (cx, cy) the point the camera
 * is above, H the camera height, `rows` the number of floors rows to skip between drawn ones (level of detail).
 */
export function drawFacade(g, fac, blk, e, cx, cy, H, zoom, shade, dim) {
  const A = e.a, B = e.b;
  const at = (z) => { const k = scaleAt(H, z) - 1; return [A.x + (A.x - cx) * k, A.y + (A.y - cy) * k, B.x + (B.x - cx) * k, B.y + (B.y - cy) * k]; };
  const len = e.len, fh = fac.floorH;
  const zTop = blk.top, zBase = blk.base;
  // screen size of the wall decides how much to draw
  const a0 = at(zBase), a1 = at(zTop);
  const thick = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]) * zoom;
  if (thick < 2.2) return;
  const gh = fac.kind === 'punched' && fac.storefront ? fh * 1.35 : fh; // the ground floor is taller
  const f0 = zBase < gh ? 0 : 1 + Math.floor((zBase - gh) / fh);
  const nFloors = Math.max(1, Math.round((zTop - zBase) / fh));
  const perRow = thick / nFloors;
  const stride = perRow >= 2.4 ? 1 : Math.ceil(2.4 / Math.max(perRow, 0.1));
  const nb = Math.max(1, Math.round(len / fac.bay));
  const bayPx = (len / nb) * zoom;
  const q = drawFacade.q ?? (drawFacade.q = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]);
  const quad = (p, t0, t1, r) => { // wall point at param t along the wall for the two floor heights p (lower) and r (upper)
    q[0].x = p[0] + (p[2] - p[0]) * t0; q[0].y = p[1] + (p[3] - p[1]) * t0;
    q[1].x = p[0] + (p[2] - p[0]) * t1; q[1].y = p[1] + (p[3] - p[1]) * t1;
    q[2].x = r[0] + (r[2] - r[0]) * t1; q[2].y = r[1] + (r[3] - r[1]) * t1;
    q[3].x = r[0] + (r[2] - r[0]) * t0; q[3].y = r[1] + (r[3] - r[1]) * t0;
    g.fillPoints(q, true);
  };
  const rowBottom = (f) => (f === 0 ? 0 : gh + (f - 1) * fh);
  const rowTop = (f) => (f === 0 ? gh : gh + f * fh);
  const lastRow = f0 + 10000;
  const shadeK = shade * dim;

  for (let f = f0; f < lastRow; f += stride) {
    const zb = rowBottom(f), zt = rowTop(f);
    if (zb >= zTop - 0.05) break;
    if (zt > zTop + 0.05 && zb < zBase) continue;
    const z0 = Math.max(zb, zBase), z1 = Math.min(zt, zTop + 0.01);
    const h = z1 - z0;
    if (h < fh * 0.4 && f !== 0) continue;
    const tall = f / Math.max(1, nFloors + f0);
    if (fac.kind === 'glass') {
      // one continuous band of glass per floor, brighter toward the top (it reflects more sky)
      const lift = Math.min(1, (zb / Math.max(60, zTop)) * 0.9);
      const gc = [fac.glass[0] + (fac.high[0] - fac.glass[0]) * lift, fac.glass[1] + (fac.high[1] - fac.glass[1]) * lift, fac.glass[2] + (fac.high[2] - fac.glass[2]) * lift];
      const v = 0.94 + hash(fac.id, f, 1) * 0.12;
      g.fillStyle(rgb(gc, shadeK * v), 1);
      quad(at(zb + h * 0.16), 0.01, 0.99, at(zb + h * 0.86));
    } else if (fac.kind === 'garage') {
      g.fillStyle(rgb(fac.glass, dim), 0.85);
      quad(at(zb + h * 0.14), 0.02, 0.98, at(zb + h * 0.8));
    } else {
      const storefront = f === 0 && fac.storefront;
      const lo = at(zb + h * (storefront ? 0.1 : (1 - fac.window[1]) / 2)), hi = at(zb + h * (storefront ? 0.8 : 1 - (1 - fac.window[1]) / 2));
      const wfrac = storefront ? 0.86 : fac.window[0];
      for (let j = 0; j < nb; j++) {
        const t0 = (j + (1 - wfrac) / 2) / nb, t1 = (j + 1 - (1 - wfrac) / 2) / nb;
        const v = 0.85 + hash(fac.id, f * 131 + j, 2) * 0.3, blind = hash(fac.id, f * 131 + j, 3) < 0.12;
        const c = blind ? fac.high : fac.glass;
        g.fillStyle(rgb(c, shadeK * v), 1);
        quad(lo, t0, t1, hi);
      }
    }
  }

  // mullions / columns: one line per bay from the lowest to the highest drawn floor (a straight line in this view)
  if ((fac.kind === 'glass' || fac.kind === 'garage') && bayPx > 5 && thick > 10) {
    const lo = at(Math.max(zBase, 0)), hi = at(zTop);
    g.lineStyle(fac.kind === 'garage' ? 1.4 : 0.7, rgb(fac.kind === 'garage' ? fac.wall : fac.wall, shadeK * 0.9), fac.kind === 'garage' ? 1 : 0.85);
    for (let j = 1; j < nb; j++) {
      const t = j / nb;
      g.lineBetween(lo[0] + (lo[2] - lo[0]) * t, lo[1] + (lo[3] - lo[1]) * t, hi[0] + (hi[2] - hi[0]) * t, hi[1] + (hi[3] - hi[1]) * t);
    }
  }
}
