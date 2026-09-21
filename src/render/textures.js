import { mulberry32 } from './rng.js';

// Procedural, tileable GTA1-style surface textures. Each returns a canvas at 1 texel = 1 screen pixel
// at the ground's baked resolution (see PPM in ground.js). No image files are used.

const canvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

// Per-pixel grain plus sparse light and dark specks.
function grain(ctx, size, base, rand, { amp, speckle, light, dark }) {
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let n = (rand() - 0.5) * amp;
    const r = rand();
    if (r < speckle) n += light;
    else if (r > 1 - speckle) n -= dark;
    d[i] = clamp(base[0] + n);
    d[i + 1] = clamp(base[1] + n);
    d[i + 2] = clamp(base[2] + n);
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

// Soft blotches that wrap around the edges so the tile stays seamless.
function blotches(ctx, size, rand, count, rgb, alpha, rMin, rMax) {
  for (let i = 0; i < count; i++) {
    const x = rand() * size, y = rand() * size, r = rMin + rand() * (rMax - rMin);
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        g.addColorStop(0, `rgba(${rgb},${alpha})`);
        g.addColorStop(1, `rgba(${rgb},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      }
    }
  }
}

export function asphaltTile(seed = 1, base = [72, 94, 96]) {
  const size = 256, c = canvas(size, size), ctx = c.getContext('2d'), rand = mulberry32(seed);
  grain(ctx, size, base, rand, { amp: 12, speckle: 0.018, light: 26, dark: 20 });
  blotches(ctx, size, rand, 16, '20,30,32', 0.07, 22, 60);
  blotches(ctx, size, rand, 10, '150,165,165', 0.05, 18, 45);
  return c;
}

// Stone slabs with a green-grey grout line, like the sidewalks in the GTA1 reference.
// slab = pixels per slab; the tile holds 2x2 slabs.
export function paverTile(slab = 30, seed = 2) {
  const size = slab * 2, c = canvas(size, size), ctx = c.getContext('2d'), rand = mulberry32(seed);
  for (let sy = 0; sy < 2; sy++) {
    for (let sx = 0; sx < 2; sx++) {
      const v = (rand() - 0.5) * 16;
      const x0 = sx * slab, y0 = sy * slab;
      ctx.fillStyle = `rgb(${196 + v},${193 + v},${176 + v})`;
      ctx.fillRect(x0, y0, slab, slab);
      // grain
      const img = ctx.getImageData(x0, y0, slab, slab), d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const n = (rand() - 0.5) * 9;
        d[i] = clamp(d[i] + n); d[i + 1] = clamp(d[i + 1] + n); d[i + 2] = clamp(d[i + 2] + n);
      }
      ctx.putImageData(img, x0, y0);
      // soft highlight and shade on the slab edges
      ctx.fillStyle = 'rgba(255,255,240,0.28)';
      ctx.fillRect(x0 + 2, y0 + 2, slab - 3, 1);
      ctx.fillRect(x0 + 2, y0 + 2, 1, slab - 3);
      ctx.fillStyle = 'rgba(60,60,40,0.16)';
      ctx.fillRect(x0 + 2, y0 + slab - 2, slab - 2, 1);
      ctx.fillRect(x0 + slab - 2, y0 + 2, 1, slab - 2);
      // grout on the top and left edge of every slab (neighbours supply the other sides)
      ctx.fillStyle = 'rgb(104,128,102)';
      ctx.fillRect(x0, y0, slab, 2);
      ctx.fillRect(x0, y0, 2, slab);
    }
  }
  return c;
}

export function grassTile(seed = 3) {
  const size = 128, c = canvas(size, size), ctx = c.getContext('2d'), rand = mulberry32(seed);
  grain(ctx, size, [62, 112, 58], rand, { amp: 16, speckle: 0.05, light: 30, dark: 24 });
  blotches(ctx, size, rand, 8, '30,70,30', 0.10, 14, 34);
  return c;
}
