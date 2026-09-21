#!/usr/bin/env python3
"""
Whole-city building heights from USGS LiDAR: every building in data/city/tiles/*.json gets a measured height (and stepped
buildings get blocks), the same way tools/lidar_heights.py does it for downtown.

  python3 tools/lidar_heights_city.py            # -> data/heights_lidar_city.json, data/parts_lidar_city.json (npm run lidar-heights-city)

Inputs   data/raw/lidar/blocks/  the 1 m surface / 2 m ground rasters that tools/fetch_lidar_city.py builds (UTM 15N, see
                                 tools/lib/lidar_common.py), data/city/tiles/*.json (footprints in the game frame, deduplicated by id).
Outputs  data/heights_lidar_city.json  { source, buildings: { "<osm id>": { h, p50, max, n } } }   same schema as data/heights_lidar.json
         data/parts_lidar_city.json    { source, parts: { "<osm id>": [ { poly: [[x, y]...], base, top } ] } }  game frame, as parts_lidar.json
         data/raw/lidar/heights_city_report.json  the statistics printed at the end

Rules (identical to lidar_heights.py, so downtown numbers are comparable): the roof height of a building is the 90th percentile of
(surface - ground) over its footprint cells at least 1 m inside the edge (all cells for a tiny building); `n` = cell count; ground =
the 2 m ground model with its holes (under buildings) filled from the surroundings; a building with a large spread (p90 - median > 12 m,
n >= 150) is split into a base and towers by the same plateau logic (GRID 1.5 m, towers >= 30 m2). Buildings with no LiDAR
coverage (no block, or no return over the footprint) get no entry. Processing goes block by block (2 km) in a few worker
processes, each holding one 2.6 km square of the rasters (well under 1 GB per worker).
"""
import argparse, glob, json, math, os, sys, time
import numpy as np
from multiprocessing import Pool

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))
import lidar_common as lc
from lidar_heights import points_in_polygon, dist_to_edges, split_stepped_poly

MARGIN = 350.0  # metres of raster kept around a block (a building that starts in the block may reach out of it)


def fill_holes(a):
    """Pyramid fill of NaNs (same as SwapCity tools/lidar.py): coarsen until every cell has a value, push values back down."""
    a = a.astype(np.float32, copy=True)
    levels = [a]
    while np.isnan(levels[-1]).any() and min(levels[-1].shape) > 2:
        cur = levels[-1]
        h, w = cur.shape; h2, w2 = (h + 1) // 2, (w + 1) // 2
        pad = np.full((h2 * 2, w2 * 2), np.nan, dtype=np.float32); pad[:h, :w] = cur
        blocks = pad.reshape(h2, 2, w2, 2).transpose(0, 2, 1, 3).reshape(h2, w2, 4)
        with np.errstate(all='ignore'):
            levels.append(np.nanmean(blocks, axis=2))
    for k in range(len(levels) - 1, 0, -1):
        coarse = levels[k]; fine = levels[k - 1]
        up = np.repeat(np.repeat(coarse, 2, axis=0), 2, axis=1)[:fine.shape[0], :fine.shape[1]]
        m = np.isnan(fine); fine[m] = up[m]
    a = levels[0]
    if np.isnan(a).any() and not np.isnan(a).all(): a[np.isnan(a)] = np.nanmean(a)
    return a


class Window:
    """DSM (1 m) and filled DEM (2 m) over a UTM box, sampled by UTM coordinates"""
    def __init__(self, store, e0, n0, e1, n1):
        self.dsm, self.we, self.wn = store.window(e0, n0, e1, n1)                       # 1 m, row 0 = north, west/north edge coords
        dem, self.de, self.dn = store.window(e0, n0, e1, n1, dem=True)
        self.has_dem = not np.isnan(dem).all()
        self.dem = fill_holes(dem) if self.has_dem else dem
    def sample(self, e, n):
        """(surface, ground) at UTM points (arrays); NaN outside or without data"""
        c = np.floor(e - self.we).astype(np.int64); r = np.floor(self.wn - n).astype(np.int64)
        ok = (c >= 0) & (c < self.dsm.shape[1]) & (r >= 0) & (r < self.dsm.shape[0])
        s = np.full(e.shape, np.nan, dtype=np.float32); s[ok] = self.dsm[r[ok], c[ok]]
        cd = np.floor((e - self.de) / lc.DEM_CELL).astype(np.int64); rd = np.floor((self.dn - n) / lc.DEM_CELL).astype(np.int64)
        okd = (cd >= 0) & (cd < self.dem.shape[1]) & (rd >= 0) & (rd < self.dem.shape[0])
        g = np.full(e.shape, np.nan, dtype=np.float32); g[okd] = self.dem[rd[okd], cd[okd]]
        return s, g


def load_coverage(blocks_dir):
    """the UTM rectangles of the point-cloud files already merged into the blocks (from plan.json + blocks/index.json), or None if unknown"""
    ip = os.path.join(blocks_dir, 'index.json'); pp = os.path.join(lc.LIDAR_DIR, 'plan.json')
    if not (os.path.exists(ip) and os.path.exists(pp)): return None
    done = json.load(open(ip))['done']
    return [f['rect_utm'] for f in json.load(open(pp))['items'] if f['name'] in done]


class Coverage:
    """union of the merged point-cloud rectangles as a 10 m occupancy grid; `box_ok` tests a box grown by `grow` m on a coarse grid of points"""
    RES = 10.0
    def __init__(self, rects):
        self.e0 = min(r[0] for r in rects) - 100; self.n0 = min(r[1] for r in rects) - 100
        W = int((max(r[2] for r in rects) + 100 - self.e0) / self.RES) + 1; H = int((max(r[3] for r in rects) + 100 - self.n0) / self.RES) + 1
        self.g = np.zeros((H, W), dtype=bool)
        for r in rects:
            c0 = int(math.ceil((r[0] - self.e0) / self.RES - 0.5)); c1 = int(math.floor((r[2] - self.e0) / self.RES - 0.5)) + 1
            r0 = int(math.ceil((r[1] - self.n0) / self.RES - 0.5)); r1 = int(math.floor((r[3] - self.n0) / self.RES - 0.5)) + 1
            self.g[max(r0, 0):max(r1, 0), max(c0, 0):max(c1, 0)] = True
    def box_ok(self, e0, n0, e1, n1, grow=10.0):
        E, N = np.meshgrid(np.linspace(e0 - grow, e1 + grow, 5), np.linspace(n0 - grow, n1 + grow, 5))
        c = np.floor((E - self.e0) / self.RES).astype(int); r = np.floor((N - self.n0) / self.RES).astype(int)
        if c.min() < 0 or r.min() < 0 or c.max() >= self.g.shape[1] or r.max() >= self.g.shape[0]: return False
        return bool(self.g[r, c].all())


def measure_block(job):
    (bi, bj), items, folder, rects = job
    cov = Coverage(rects) if rects else None
    store = lc.BlockStore(folder, keep=9)
    game2utm = lc.GameToUtm(lc.load_frame())
    # window over the extent of the block's buildings plus margin
    e0 = min(it['ue'].min() for it in items) - MARGIN; e1 = max(it['ue'].max() for it in items) + MARGIN
    n0 = min(it['un'].min() for it in items) - MARGIN; n1 = max(it['un'].max() for it in items) + MARGIN
    w = Window(store, e0, n0, e1, n1)
    heights, parts, nomeas, nocov = {}, {}, 0, 0
    for it in items:
        ue, un = it['ue'], it['un']
        if cov is not None and not cov.box_ok(ue.min(), un.min(), ue.max(), un.max()): nocov += 1; continue
        poly = list(zip(ue, un))
        c0 = int(math.floor(ue.min())); c1 = int(math.ceil(ue.max())); r0 = int(math.floor(un.min())); r1 = int(math.ceil(un.max()))
        # cell centres (1 m grid): easting c + 0.5, northing r + 0.5
        ex, ny = np.meshgrid(np.arange(c0, c1) + 0.5, np.arange(r0, r1) + 0.5)
        if ex.size == 0: nomeas += 1; continue
        inside = points_in_polygon(ex, ny, poly)
        keep = inside & (dist_to_edges(ex, ny, poly) >= 1.0)
        if keep.sum() < 4: keep = inside          # tiny building: the plain interior
        if keep.sum() == 0: nomeas += 1; continue
        s, g = w.sample(ex[keep], ny[keep])
        h = s - g
        h = h[np.isfinite(h)]
        if len(h) == 0: nomeas += 1; continue
        rec = {'h': round(float(np.percentile(h, 90)), 1), 'p50': round(float(np.percentile(h, 50)), 1), 'max': round(float(h.max()), 1), 'n': int(len(h))}
        heights[it['id']] = rec
        if rec['n'] >= 150 and rec['h'] - rec['p50'] > 12:
            gpoly = [tuple(p) for p in it['game']]
            def sample_h(GX, GY, w=w):
                e, n = game2utm(GX, GY)
                s2, g2 = w.sample(np.asarray(e), np.asarray(n))
                return s2 - g2
            try:
                pr = split_stepped_poly(gpoly, sample_h)
            except Exception as ex_:
                pr = []
            if len(pr) > 1: parts[it['id']] = pr
    return (bi, bj), heights, parts, nomeas, nocov


def osm_tags(raw_dir):
    """id -> (explicit height in m or None, building:levels or None) from the raw OSM chunks"""
    out = {}
    for f in sorted(glob.glob(os.path.join(raw_dir, 'c_*.json'))):
        for el in json.load(open(f)).get('elements', []):
            if el.get('type') != 'way': continue
            t = el.get('tags') or {}
            if 'building' not in t: continue
            h = lv = None
            try: h = float(str(t['height']).split()[0]) if 'height' in t else None
            except ValueError: pass
            try: lv = float(t['building:levels']) if 'building:levels' in t else None
            except ValueError: pass
            out[str(el['id'])] = (h, lv)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tiles', default=os.path.join(lc.ROOT, 'data/city/tiles'))
    ap.add_argument('--blocks', default=lc.BLOCK_DIR)
    ap.add_argument('--raw', default=os.path.join(lc.ROOT, 'data/raw/city'))
    ap.add_argument('--out', default=os.path.join(lc.ROOT, 'data/heights_lidar_city.json'))
    ap.add_argument('--parts-out', default=os.path.join(lc.ROOT, 'data/parts_lidar_city.json'))
    ap.add_argument('--report', default=os.path.join(lc.LIDAR_DIR, 'heights_city_report.json'))
    ap.add_argument('--procs', type=int, default=4)
    ap.add_argument('--no-coverage-check', action='store_true', help='measure buildings even where the point-cloud files are not all merged yet')
    ap.add_argument('--only-blocks', default='', help='comma list of i_j: measure only buildings whose centroid lies in these blocks (testing)')
    a = ap.parse_args()
    t0 = time.time()

    # ---- footprints, deduplicated by id ----
    blds = {}
    for f in glob.glob(os.path.join(a.tiles, '*.json')):
        for b in json.load(open(f)).get('buildings', []):
            if b['id'] not in blds: blds[b['id']] = {'id': str(b['id']), 'pts': b['points'], 'type': b.get('type'), 'name': b.get('name', '')}
    print(f'{len(blds)} unique buildings in {len(glob.glob(os.path.join(a.tiles, "*.json")))} tiles')
    ids = list(blds)
    npts = np.array([len(blds[i]['pts']) for i in ids])
    flat = np.array([p for i in ids for p in blds[i]['pts']], dtype=np.float64)
    ue, un = lc.GameToUtm(lc.load_frame())(flat[:, 0], flat[:, 1])
    ue = np.asarray(ue); un = np.asarray(un)
    off = np.r_[0, np.cumsum(npts)]
    only = {tuple(int(v) for v in s.split('_')) for s in a.only_blocks.split(',') if s}
    by_block = {}
    for k, i in enumerate(ids):
        sl = slice(off[k], off[k + 1])
        item = {'id': blds[i]['id'], 'ue': ue[sl], 'un': un[sl], 'game': flat[sl]}
        cx = float(ue[sl].mean()); cy = float(un[sl].mean())
        key = (int(cx // lc.BLOCK), int(cy // lc.BLOCK))
        if only and key not in only: continue
        by_block.setdefault(key, []).append(item)
    store = lc.BlockStore(a.blocks)
    rects = None if a.no_coverage_check else load_coverage(a.blocks)
    if rects is not None: print(f'coverage check: {len(rects)} point-cloud files merged so far; a building is measured only if its whole footprint (+10 m) lies inside them')
    jobs = [(k, v, a.blocks, rects) for k, v in sorted(by_block.items(), key=lambda kv: -len(kv[1])) if store.has(*k)]
    skipped = {f'{k[0]}_{k[1]}': len(v) for k, v in by_block.items() if not store.has(*k)}
    print(f'{len(jobs)} blocks with rasters, {len(skipped)} blocks without ({sum(skipped.values())} buildings there get no entry)')

    heights, parts, nomeas, nocov = {}, {}, 0, 0
    with Pool(a.procs) as pool:
        for n, (key, h, p, nm, nc) in enumerate(pool.imap_unordered(measure_block, jobs)):
            heights.update(h); parts.update(p); nomeas += nm; nocov += nc
            print(f'  block {key[0]}_{key[1]}: {len(h)} measured, {nm} without a return, {nc} not fully covered yet, {len(p)} stepped   [{n + 1}/{len(jobs)}] {time.time() - t0:.0f}s', flush=True)

    heights = dict(sorted(heights.items(), key=lambda kv: int(kv[0])))
    parts = dict(sorted(parts.items(), key=lambda kv: int(kv[0])))
    src = 'USGS 3DEP LiDAR (public domain), 2022 MN_CentralMissRiver_B22, surface minus ground, 90th percentile over the roof'
    json.dump({'source': src, 'buildings': heights}, open(a.out, 'w'), separators=(',', ':'))
    json.dump({'source': 'USGS 3DEP LiDAR, stepped buildings split into blocks (game frame, metres)', 'parts': parts}, open(a.parts_out, 'w'), separators=(',', ':'))
    print(f'measured {len(heights)} of {len(blds)} buildings -> {a.out}  ({os.path.getsize(a.out) / 1e6:.1f} MB)')
    print(f'split {len(parts)} stepped buildings into {sum(len(v) for v in parts.values())} blocks -> {a.parts_out}  ({os.path.getsize(a.parts_out) / 1e6:.1f} MB)')

    # ---- statistics and validation ----
    rep = {'buildings': len(blds), 'measured': len(heights), 'without_lidar': len(blds) - len(heights), 'stepped': len(parts),
           'no_return_over_footprint': nomeas, 'not_fully_covered': nocov, 'blocks_without_rasters': skipped, 'seconds': round(time.time() - t0)}
    hs = np.array([v['h'] for v in heights.values()])
    if len(hs):
        rep['height_m'] = {'min': float(hs.min()), 'p10': float(np.percentile(hs, 10)), 'median': float(np.median(hs)), 'p90': float(np.percentile(hs, 90)),
                           'p99': float(np.percentile(hs, 99)), 'max': float(hs.max()),
                           'under_3': int((hs < 3).sum()), 'over_20': int((hs > 20).sum()), 'over_50': int((hs > 50).sum()), 'over_100': int((hs > 100).sum())}
        print('heights (m):', json.dumps(rep['height_m']))
    if os.path.isdir(a.raw):
        tags = osm_tags(a.raw)
        ex, lv = [], []
        for i, rec in heights.items():
            t = tags.get(i)
            if not t: continue
            if t[0] and t[0] >= 8: ex.append((rec['h'] - t[0]) / t[0])
            elif t[1]: lv.append((rec['h'] - (t[1] * 3.4 + 2)) / (t[1] * 3.4 + 2))
        ex = np.array(ex); lv = np.array(lv)
        def summ(e): return {'n': int(len(e)), 'within10': round(float((abs(e) < .10).mean()), 3), 'within20': round(float((abs(e) < .20).mean()), 3),
                             'median_rel_diff': round(float(np.median(e)), 3), 'median_abs_rel': round(float(np.median(abs(e))), 3)} if len(e) else {'n': 0}
        rep['vs_osm_height_tag_ge8m'] = summ(ex); rep['vs_osm_levels_x3.4+2'] = summ(lv)
        rep['osm_buildings_with_height_tag'] = sum(1 for i in heights if tags.get(i, (None,))[0])
        print('vs explicit OSM height (>= 8 m):', rep['vs_osm_height_tag_ge8m'])
        print('vs OSM levels (levels*3.4+2), a rough proxy:', rep['vs_osm_levels_x3.4+2'])
    tall = sorted(heights.items(), key=lambda kv: -kv[1]['h'])[:10]
    rep['tallest'] = [{'id': i, 'h': r['h'], 'name': blds[int(i)]['name'] if int(i) in blds else ''} for i, r in tall]
    print('tallest:', ', '.join(f"{blds[int(i)]['name'] or i} {r['h']}" for i, r in tall))
    json.dump(rep, open(a.report, 'w'), indent=1)
    print(f'report -> {a.report}   ({time.time() - t0:.0f} s)')


if __name__ == '__main__':
    main()
