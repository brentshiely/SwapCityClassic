#!/usr/bin/env python3
"""
Aerial roof photo for every city tile, in the game frame. Reads the NAIP blocks that tools/fetch_naip_city.py put in data/raw/naip/ and
writes data/city/tiles/{tx}_{ty}.jpg next to each tile JSON that has at least one building, plus data/city/roofs.json.

  python3 tools/bake_roof_tiles.py            # resumable: existing jpgs are skipped
  python3 tools/bake_roof_tiles.py --force    # redo all      (--workers N, --only tx_ty,tx_ty for a few tiles, --out DIR)

Photo of tile (tx, ty): game metres [tx*256 - 40, (tx+1)*256 + 40] x [ty*256 - 40, (ty+1)*256 + 40] (40 m margin so a leaning roof can be cut
from beside its footprint), 2 pixels per metre, 672 x 672 px. Pixel (i, j) is at game metre x = tx*256 - 40 + (i + 0.5)/2,
y = ty*256 - 40 + (j + 0.5)/2  (x right, y down, the rotated frame of design/CITY_DATA.md). Same game -> lon/lat -> mercator maths as
tools/bake_naip.py (in tools/lib/naip_common.py). All blocks share one pixel grid, so a tile that straddles blocks is sampled from a crop
assembled from them (no seams). Contrast 1.10, Color 0.95 as bake_naip.py. No Google data.
"""
import argparse, json, os, sys, time, math
from multiprocessing import Pool
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from naip_common import *
import numpy as np
from PIL import Image, ImageEnhance

OUT_PX = int(round((TILE + 2 * M) * PPM))
_cache = {}      # per worker: block name -> Image (a few, most recently used)
ap = argparse.ArgumentParser()
ap.add_argument("--force", action="store_true"); ap.add_argument("--workers", type=int, default=6)
ap.add_argument("--only", default=""); ap.add_argument("--out", default="data/city/tiles"); ap.add_argument("--quality", type=int, default=80)
args = ap.parse_args()

def get_block(bi, bj):
    name = block_name(bi, bj)
    if name in _cache:
        im = _cache.pop(name); _cache[name] = im; return im
    path = f"{RAWDIR}/{name}.jpg"
    im = Image.open(path).convert("RGB") if os.path.exists(path) else None
    _cache[name] = im
    while len(_cache) > 5: _cache.pop(next(iter(_cache)))
    return im

def bake_tile(t):
    tx, ty = t
    out = f"{args.out}/{tx}_{ty}.jpg"
    if os.path.exists(out) and not args.force:
        return (tx, ty, "skip", 0.0, 0)
    # crop of the block grid (integer pixel rect of the global grid) that covers the photo plus a few pixels for the bicubic taps
    b = tile_merc_bounds(tx, ty, pad_px=6)
    px0, px1 = math.floor((b[0] - GX0) / UPP), math.ceil((b[2] - GX0) / UPP)
    py0, py1 = math.floor((GY0 - b[3]) / UPP), math.ceil((GY0 - b[1]) / UPP)
    canvas = Image.new("RGB", (px1 - px0, py1 - py0), (0, 0, 0))
    absent = False
    for bi in range(px0 // BLOCK_PX, (px1 - 1) // BLOCK_PX + 1):
        for bj in range(py0 // BLOCK_PX, (py1 - 1) // BLOCK_PX + 1):
            im = get_block(bi, bj)
            if im is None: absent = True; continue
            x0, y0 = max(px0, bi * BLOCK_PX), max(py0, bj * BLOCK_PX)
            x1, y1 = min(px1, (bi + 1) * BLOCK_PX), min(py1, (bj + 1) * BLOCK_PX)
            canvas.paste(im.crop((x0 - bi * BLOCK_PX, y0 - bj * BLOCK_PX, x1 - bi * BLOCK_PX, y1 - bj * BLOCK_PX)), (x0 - px0, y0 - py0))
    # output pixel (i, j) -> game metres -> mercator -> canvas pixel. PIL evaluates the affine map at the pixel CENTRE, coefficients are
    # relative to the continuous corner (0, 0), so c is the source position of the corner.
    gx0, gy0 = tx * TILE - M, ty * TILE - M
    def src(i, j):
        mx, my = game_to_merc(gx0 + i / PPM, gy0 + j / PPM)
        return (mx - GX0) / UPP - px0, (GY0 - my) / UPP - py0
    p00, p10, p01 = src(0, 0), src(1, 0), src(0, 1)
    coef = (p10[0] - p00[0], p01[0] - p00[0], p00[0], p10[1] - p00[1], p01[1] - p00[1], p00[1])
    img = canvas.transform((OUT_PX, OUT_PX), Image.AFFINE, coef, resample=Image.BICUBIC)
    a = np.asarray(img)[::2, ::2]
    blank = float(((a.max(axis=2) <= 2) | (a.min(axis=2) >= 253)).mean())
    if blank > 0.5:
        return (tx, ty, "missing", blank, 0)
    img = ImageEnhance.Contrast(img).enhance(1.10)
    img = ImageEnhance.Color(img).enhance(0.95)
    img.save(out + ".tmp.jpg", "JPEG", quality=args.quality)
    os.replace(out + ".tmp.jpg", out)
    return (tx, ty, "partial" if (blank > 0.02 or absent) else "ok", blank, os.path.getsize(out))

def main():
    t0 = time.time()
    if args.only:
        tiles = [tuple(map(int, s.split("_"))) for s in args.only.split(",")]
    else:
        tiles = [(tx, ty) for tx, ty, f in tile_list() if has_buildings(f)]
    os.makedirs(args.out, exist_ok=True)
    if not args.only and args.out == "data/city/tiles":
        json.dump({"ppm": PPM, "margin": int(M), "tileSize": int(TILE), "source": "USDA NAIP (public domain) via USGS National Map"},
                  open("data/city/roofs.json", "w"), indent=1)
    print(f"{len(tiles)} tiles, {args.workers} workers", flush=True)
    stats = {"ok": 0, "skip": 0, "partial": [], "missing": []}; total = 0
    with Pool(args.workers) as pool:
        for n, (tx, ty, st, blank, size) in enumerate(pool.imap_unordered(bake_tile, tiles, chunksize=8)):
            if st in ("ok", "skip"): stats[st] += 1
            else: stats[st].append([tx, ty, round(blank, 3)])
            total += size
            if (n + 1) % 100 == 0: print(f"  {n + 1}/{len(tiles)} ({time.time() - t0:.0f}s)", flush=True)
    rep = {"tiles": len(tiles), "baked": stats["ok"] + len(stats["partial"]), "skipped": stats["skip"], "partial": stats["partial"],
           "missing": stats["missing"], "bytesWritten": total, "seconds": round(time.time() - t0, 1)}
    if not args.only: json.dump(rep, open(f"{RAWDIR}/bake_report.json", "w"), indent=1)
    print(json.dumps({k: (v if not isinstance(v, list) else f"{len(v)} tiles {v[:10]}") for k, v in rep.items()}))

if __name__ == "__main__":
    main()
