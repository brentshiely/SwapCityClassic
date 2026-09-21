#!/usr/bin/env python3
"""
How far do tall roofs lean in the city's NAIP tile photos, and does it change across the city?

  python3 tools/roof_lean_city.py [--montage]          # -> data/roof_lean_city.json   (npm run roof-lean-city)

NAIP is straightened to the ground, so the roof of a tall building appears shifted away from its footprint in proportion to its
height, and the shift depends on where the roof is in the flight frame (each frame has its own nadir, the point the camera looked
straight down at). tools/roof_offsets.py fitted one model for downtown; this measures it region by region for the whole city.

For every building taller than MIN_H (default 25 m) the LiDAR surface (data/raw/lidar/blocks, tools/fetch_lidar_city.py) gives the true
outline of its roof: the edges (gradient of the surface) of the tall structure, cut in the game frame at the tile photo's 2 px/m.
Its normalised cross-correlation with the edges of the tile photo (data/city/tiles/{tx}_{ty}.jpg) over every shift up to +-R
metres (FFT) gives the displacement of the roof in the photo (ox, oy) in game metres; lean = (ox, oy) / roof height. Only clear peaks
are kept (correlation and a peak-to-side-lobe ratio). Per 1500 m cell (i, j) = floor(x / 1500), floor(y / 1500) (game metres) the
lean is the MEDIAN of the buildings in it; a cell with fewer than MIN_TOWERS uses the median of its 3x3 neighbourhood if that has
enough, else the fallback (median over the whole city).

Output data/roof_lean_city.json:
  { "cell": 1500, "lean": { "i_j": [ax, ay], ... }, "fallback": [ax, ay], ...extra statistics }
  A roof of height h at footprint position p is drawn at  p + h * (ax, ay)  in the photo (same convention as data/roof_offsets.json,
  where ax = a*x + b*y + c evaluated at that position). Extra keys (n, spread, source) are informational.
"""
import argparse, glob, json, math, os, sys, time
import numpy as np
from PIL import Image, ImageFilter

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))
import lidar_common as lc

CELL = 1500
PPM = 2.0
MARGIN = 40.0
TILE = 256
MIN_H = 25.0
MIN_TOWERS = 5
PAD = 4.0


def norm_xcorr(T, I):
    """valid-mode normalised cross-correlation of template T (h, w) over image I (H, W) via FFT: (H-h+1, W-w+1)"""
    h, w = T.shape; H, W = I.shape
    Tz = T - T.mean(); tn = math.sqrt((Tz * Tz).sum())
    if tn < 1e-6: return None
    F = np.fft.rfft2(I); G = np.fft.rfft2(Tz, s=(H, W))
    num = np.fft.irfft2(F * np.conj(G), s=(H, W))[:H - h + 1, :W - w + 1]
    # local sums of I and I^2 over each template-sized window (integral images)
    def boxsum(A):
        c = np.zeros((A.shape[0] + 1, A.shape[1] + 1)); c[1:, 1:] = A.cumsum(0).cumsum(1)
        return c[h:, w:] - c[:-h, w:] - c[h:, :-w] + c[:-h, :-w]
    s1 = boxsum(I.astype(np.float64)); s2 = boxsum(I.astype(np.float64) ** 2)
    var = np.maximum(s2 - s1 * s1 / (h * w), 1e-9)
    return num / (tn * np.sqrt(var))


class Photos:
    def __init__(self, tiles_dir, keep=24):
        self.dir = tiles_dir; self.cache = {}; self.order = []; self.keep = keep
    def has(self, tx, ty): return os.path.exists(os.path.join(self.dir, f'{tx}_{ty}.jpg'))
    def gradient(self, tx, ty):
        k = (tx, ty)
        if k in self.cache: return self.cache[k]
        im = Image.open(os.path.join(self.dir, f'{tx}_{ty}.jpg')).convert('L').filter(ImageFilter.GaussianBlur(0.8))
        a = np.asarray(im, dtype=np.float32); gy, gx = np.gradient(a); g = np.hypot(gx, gy)
        self.cache[k] = g; self.order.append(k)
        while len(self.order) > self.keep: self.cache.pop(self.order.pop(0), None)
        return g


def roof_edges(store, game2utm, x0, y0, x1, y1, h):
    """edges of the tall structure's roof over the game-frame box [x0,x1) x [y0,y1) in game metres, one value per 2 px/m pixel:
    (rows, cols) with pixel (r, c) centred on (x0 + (c + .5)/2, y0 + (r + .5)/2). None if the surface is missing there"""
    W = int(round((x1 - x0) * PPM)); H = int(round((y1 - y0) * PPM))
    # one pixel of border for the gradient
    gx = x0 + (np.arange(-1, W + 1) + 0.5) / PPM; gy = y0 + (np.arange(-1, H + 1) + 0.5) / PPM
    GX, GY = np.meshgrid(gx, gy)
    A, err = game2utm.local_affine(x0 - 2, y0 - 2, x1 + 2, y1 + 2)
    e = A[0, 0] * GX + A[0, 1] * GY + A[0, 2]; n = A[1, 0] * GX + A[1, 1] * GY + A[1, 2]
    dsm, we, wn = store.window(e.min() - 2, n.min() - 2, e.max() + 2, n.max() + 2)
    c = np.floor(e - we).astype(int); r = np.floor(wn - n).astype(int)
    if c.min() < 0 or r.min() < 0 or c.max() >= dsm.shape[1] or r.max() >= dsm.shape[0]: return None
    z = dsm[r, c]
    if np.isnan(z).mean() > 0.03: return None
    z = np.where(np.isnan(z), np.nanmedian(z), z)
    z = z - np.percentile(z, 3)                       # height above the local low ground, roughly
    z = np.clip(z, 0, 300)
    gyz, gxz = np.gradient(z)
    E = np.minimum(np.hypot(gxz, gyz), 25.0)[1:-1, 1:-1]
    # only edges that belong to the tall structure (either side of the edge reaches half the roof height)
    zm = z.copy()
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            zm = np.maximum(zm, np.roll(np.roll(z, dy, 0), dx, 1))
    E = E * (zm[1:-1, 1:-1] >= 0.5 * h)
    return E


def measure_building(b, h, photos, store, game2utm):
    xs = [p[0] for p in b['points']]; ys = [p[1] for p in b['points']]
    bx0, bx1, by0, by1 = min(xs), max(xs), min(ys), max(ys)
    want = min(60.0, max(0.3 * h, 8.0))
    # the tile whose photo holds the building (plus its padding) with the most room around it
    best = None
    for tx in range(math.floor((bx0 - PAD - want - MARGIN) / TILE), math.floor((bx1 + PAD + want + MARGIN) / TILE) + 1):
        for ty in range(math.floor((by0 - PAD - want - MARGIN) / TILE), math.floor((by1 + PAD + want + MARGIN) / TILE) + 1):
            ex0 = tx * TILE - MARGIN; ey0 = ty * TILE - MARGIN; ex1 = (tx + 1) * TILE + MARGIN; ey1 = (ty + 1) * TILE + MARGIN
            room = min(bx0 - PAD - ex0, ex1 - (bx1 + PAD), by0 - PAD - ey0, ey1 - (by1 + PAD))
            if room > 0 and (best is None or room > best[0]) and photos.has(tx, ty): best = (room, tx, ty, ex0, ey0)
    if best is None: return None, 'no photo'
    room, tx, ty, ex0, ey0 = best
    R = min(want, room - 0.5)
    if R < 0.12 * h + 1.5: return None, 'too close to the photo edge'
    G = photos.gradient(tx, ty)
    # template box, snapped to the photo pixel grid
    i0 = int(math.floor((bx0 - PAD - ex0) * PPM)); i1 = int(math.ceil((bx1 + PAD - ex0) * PPM))
    j0 = int(math.floor((by0 - PAD - ey0) * PPM)); j1 = int(math.ceil((by1 + PAD - ey0) * PPM))
    Rp = int(math.floor(R * PPM))
    if i0 - Rp < 0 or j0 - Rp < 0 or i1 + Rp > G.shape[1] or j1 + Rp > G.shape[0]: return None, 'outside photo'
    E = roof_edges(store, game2utm, ex0 + i0 / PPM, ey0 + j0 / PPM, ex0 + i1 / PPM, ey0 + j1 / PPM, h)
    if E is None: return None, 'no lidar'
    if E.shape != (j1 - j0, i1 - i0): return None, 'shape'
    I = G[j0 - Rp:j1 + Rp, i0 - Rp:i1 + Rp]
    ncc = norm_xcorr(E.astype(np.float64), I.astype(np.float64))
    if ncc is None: return None, 'flat template'
    ncc = np.nan_to_num(ncc, nan=-1)
    k = int(np.argmax(ncc)); pj, pi = divmod(k, ncc.shape[1]); peak = float(ncc[pj, pi])
    # side-lobe: best value more than 4 m from the peak
    yy, xx = np.mgrid[0:ncc.shape[0], 0:ncc.shape[1]]
    far = (yy - pj) ** 2 + (xx - pi) ** 2 > (4 * PPM) ** 2
    side = float(ncc[far].max()) if far.any() else 0.0
    # sub-pixel refinement (parabola through the neighbours)
    def sub(m, c, p):
        d = m - 2 * c + p
        return 0.0 if abs(d) < 1e-9 else 0.5 * (m - p) / d
    sx = sub(ncc[pj, pi - 1], peak, ncc[pj, pi + 1]) if 0 < pi < ncc.shape[1] - 1 else 0.0
    sy = sub(ncc[pj - 1, pi], peak, ncc[pj + 1, pi]) if 0 < pj < ncc.shape[0] - 1 else 0.0
    ox = (pi - Rp + sx) / PPM; oy = (pj - Rp + sy) / PPM
    return {'ox': ox, 'oy': oy, 'score': peak, 'side': side, 'R': R}, 'ok'


def build_json(meas, min_towers=MIN_TOWERS):
    good = [m for m in meas if m['ok']]
    cells = {}
    for m in good: cells.setdefault((int(m['cx'] // CELL), int(m['cy'] // CELL)), []).append(m)
    def med(ms):
        return [float(np.median([m['lx'] for m in ms])), float(np.median([m['ly'] for m in ms]))]
    fallback = med(good) if good else [0.0, 0.0]
    lean, info = {}, {}
    all_keys = set(cells)
    for (i, j) in list(all_keys):
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1): all_keys.add((i + di, j + dj))
    for (i, j) in sorted(all_keys):
        own = cells.get((i, j), [])
        if len(own) >= min_towers:
            v = med(own); src = 'cell'; used = own
        else:
            ring = [m for di in (-1, 0, 1) for dj in (-1, 0, 1) for m in cells.get((i + di, j + dj), [])]
            if len(ring) >= min_towers: v = med(ring); src = 'neighbours'; used = ring
            else: continue          # no entry: the loader uses the fallback
        lean[f'{i}_{j}'] = [round(v[0], 4), round(v[1], 4)]
        info[f'{i}_{j}'] = {'n': len(own), 'n_used': len(used), 'from': src,
                            'mad': [round(float(np.median(abs(np.array([m['lx'] for m in used]) - v[0]))), 4),
                                    round(float(np.median(abs(np.array([m['ly'] for m in used]) - v[1]))), 4)]}
    return {'cell': CELL, 'lean': lean, 'fallback': [round(fallback[0], 4), round(fallback[1], 4)],
            'min_h': MIN_H, 'towers_used': len(good), 'cells_info': info,
            'note': 'a roof of height h at footprint p is drawn at p + h * (ax, ay) metres in the tile photo; cell (i, j) = floor(x / 1500), floor(y / 1500), game metres; '
                    'cells not listed use "fallback"'}


def lean_at(js, x, y):
    k = f'{int(x // js["cell"])}_{int(y // js["cell"])}'
    return js['lean'].get(k, js['fallback'])


def montage(meas, js, tiles_dir, out_dir, per_region=6, regions=None):
    """for a few regions: crops of the tile photo around tall buildings with the footprint drawn as it is (yellow) and shifted by
    h * lean of its region (red)"""
    from PIL import ImageDraw
    os.makedirs(out_dir, exist_ok=True)
    good = [m for m in meas if m['ok']]
    cells = {}
    for m in good: cells.setdefault((int(m['cx'] // CELL), int(m['cy'] // CELL)), []).append(m)
    keys = regions or [k for k, v in sorted(cells.items(), key=lambda kv: -len(kv[1]))]
    made = []
    for key in keys[:regions and len(regions) or 8]:
        ms = sorted(cells.get(key, []), key=lambda m: -m['h'])[:per_region]
        if not ms: continue
        S = 4  # px per metre in the crop
        tiles = []
        for m in ms:
            b = m['b']; h = m['h']; ax, ay = lean_at(js, m['cx'], m['cy'])
            xs = [p[0] for p in b['points']]; ys = [p[1] for p in b['points']]
            pad = 14 + abs(ax) * h
            x0, x1, y0, y1 = min(xs) - 14 - max(0, -ax * h), max(xs) + 14 + max(0, ax * h), min(ys) - 14 - max(0, -ay * h), max(ys) + 14 + max(0, ay * h)
            tx, ty = math.floor(m['cx'] / TILE), math.floor(m['cy'] / TILE)
            path = os.path.join(tiles_dir, f'{tx}_{ty}.jpg')
            if not os.path.exists(path): continue
            im = Image.open(path).convert('RGB'); ex0, ey0 = tx * TILE - MARGIN, ty * TILE - MARGIN
            box = (int((x0 - ex0) * PPM), int((y0 - ey0) * PPM), int((x1 - ex0) * PPM), int((y1 - ey0) * PPM))
            if box[0] < 0 or box[1] < 0 or box[2] > im.width or box[3] > im.height: continue
            crop = im.crop(box).resize(((box[2] - box[0]) * S // 2, (box[3] - box[1]) * S // 2), Image.LANCZOS)
            d = ImageDraw.Draw(crop)
            def px(p, sh=(0, 0)): return ((p[0] + sh[0] - box[0] / PPM - ex0) * S, (p[1] + sh[1] - box[1] / PPM - ey0) * S)
            pts = b['points']
            d.line([px(p) for p in pts] + [px(pts[0])], fill=(255, 230, 0), width=1)
            sh = (ax * h, ay * h)
            d.line([px(p, sh) for p in pts] + [px(pts[0], sh)], fill=(255, 40, 40), width=2)
            d.text((3, 3), f'{b.get("name") or b["id"]} h{h:.0f} lean({ax:+.3f},{ay:+.3f}) meas({m["lx"]:+.3f},{m["ly"]:+.3f})', fill=(255, 255, 255))
            tiles.append(crop)
        if not tiles: continue
        cw = max(t.width for t in tiles); ch = max(t.height for t in tiles); cols = 3; rows = (len(tiles) + cols - 1) // cols
        sheet = Image.new('RGB', (cw * cols, ch * rows), (20, 20, 20))
        for k, t in enumerate(tiles): sheet.paste(t, ((k % cols) * cw, (k // cols) * ch))
        p = os.path.join(out_dir, f'lean_{key[0]}_{key[1]}.png'); sheet.save(p); made.append(p)
    return made


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tiles', default=os.path.join(lc.ROOT, 'data/city/tiles'))
    ap.add_argument('--blocks', default=lc.BLOCK_DIR)
    ap.add_argument('--heights', default=os.path.join(lc.ROOT, 'data/heights_lidar_city.json'))
    ap.add_argument('--parts', default=os.path.join(lc.ROOT, 'data/parts_lidar_city.json'))
    ap.add_argument('--out', default=os.path.join(lc.ROOT, 'data/roof_lean_city.json'))
    ap.add_argument('--min-h', type=float, default=MIN_H)
    ap.add_argument('--min-score', type=float, default=0.25)
    ap.add_argument('--min-side-gap', type=float, default=0.04, help='peak must beat the best value >4 m away by this much')
    ap.add_argument('--montage', action='store_true')
    ap.add_argument('--montage-dir', default='/tmp/sc')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--bbox', default='', help='x0,y0,x1,y1 game metres: only buildings whose centre is inside (testing)')
    a = ap.parse_args()
    t0 = time.time()
    heights = json.load(open(a.heights))['buildings']
    parts = json.load(open(a.parts))['parts'] if os.path.exists(a.parts) else {}
    seen, tall = set(), []
    for f in glob.glob(os.path.join(a.tiles, '*.json')):
        for b in json.load(open(f)).get('buildings', []):
            if b['id'] in seen: continue
            seen.add(b['id'])
            r = heights.get(str(b['id']))
            if not r: continue
            h = max(p['top'] for p in parts[str(b['id'])]) if str(b['id']) in parts else r['h']
            if h >= a.min_h and r['n'] >= 30: tall.append((b, h))
    if a.bbox:
        x0, y0, x1, y1 = (float(v) for v in a.bbox.split(','))
        tall = [(b, h) for b, h in tall if x0 <= np.mean([p[0] for p in b['points']]) <= x1 and y0 <= np.mean([p[1] for p in b['points']]) <= y1]
    tall.sort(key=lambda bh: (math.floor(np.mean([p[0] for p in bh[0]['points']]) / TILE), math.floor(np.mean([p[1] for p in bh[0]['points']]) / TILE)))
    if a.limit: tall = tall[:a.limit]
    print(f'{len(tall)} buildings of {a.min_h:.0f} m or more with LiDAR heights')
    store = lc.BlockStore(a.blocks, keep=9); photos = Photos(a.tiles); game2utm = lc.GameToUtm(lc.load_frame())
    meas, why = [], {}
    for n, (b, h) in enumerate(tall):
        cx = float(np.mean([p[0] for p in b['points']])); cy = float(np.mean([p[1] for p in b['points']]))
        try: res, status = measure_building(b, h, photos, store, game2utm)
        except Exception as ex:
            res, status = None, f'error {ex.__class__.__name__}'
        why[status] = why.get(status, 0) + 1
        if res is None: continue
        ok = res['score'] >= a.min_score and res['score'] - res['side'] >= a.min_side_gap and abs(res['ox']) < 0.5 * h and abs(res['oy']) < 0.5 * h
        meas.append({'id': b['id'], 'h': h, 'cx': cx, 'cy': cy, 'b': b, 'lx': res['ox'] / h, 'ly': res['oy'] / h, 'ox': res['ox'], 'oy': res['oy'],
                     'score': float(res['score']), 'side': float(res['side']), 'ok': bool(ok)})
        if (n + 1) % 200 == 0: print(f'  {n + 1}/{len(tall)}  {time.time() - t0:.0f}s  clear matches so far {sum(m["ok"] for m in meas)}', flush=True)
    print('status counts:', why, ' clear matches:', sum(m['ok'] for m in meas), 'of', len(meas), 'measured')
    js = build_json(meas)
    # a second pass: drop buildings far from their cell median (a wrong peak, e.g. a ground feature), then recompute
    for m in meas:
        if not m['ok']: continue
        ax, ay = lean_at(js, m['cx'], m['cy'])
        if math.hypot(m['lx'] - ax, m['ly'] - ay) * m['h'] > max(4.0, 0.06 * m['h']): m['ok'] = False
    js = build_json(meas)
    json.dump(js, open(a.out, 'w'), indent=1)
    good = [m for m in meas if m['ok']]
    print(f'towers used {len(good)}; cells with own value {sum(1 for v in js["cells_info"].values() if v["from"] == "cell")}, from neighbours {sum(1 for v in js["cells_info"].values() if v["from"] == "neighbours")}; fallback {js["fallback"]}')
    for k, v in sorted(js['lean'].items(), key=lambda kv: tuple(int(x) for x in kv[0].split('_'))):
        inf = js['cells_info'][k]; print(f'  cell {k:>6}  lean ({v[0]:+.3f}, {v[1]:+.3f})  n={inf["n"]:3d} ({inf["from"]})  mad {inf["mad"]}')
    if a.montage:
        for p in montage(meas, js, a.tiles, a.montage_dir): print('montage', p)
    print(f'-> {a.out}  ({time.time() - t0:.0f} s)')
    # keep the raw measurements for inspection (not part of the deliverable)
    json.dump([{k: v for k, v in m.items() if k != 'b'} for m in meas], open(os.path.join(lc.LIDAR_DIR, 'roof_lean_measurements.json'), 'w'))


if __name__ == '__main__':
    main()
