#!/usr/bin/env python3
"""
Measure the real height of every OpenStreetMap building from USGS LiDAR (public domain).

  python3 tools/lidar_heights.py --lidar ~/Projects/SwapCity/data/minneapolis/lidar

Reads the LiDAR surface model (dsm.npy, 1 m cells) and ground model (dem.npy, 2 m cells) that SwapCity built from
USGS 3DEP point clouds, plus the raw OSM download in data/raw/. For each building footprint it takes the surface
height minus the ground height over the roof (cells at least 1 m inside the footprint) and writes
data/heights_lidar.json. This is a one-off build step: the game only ever reads the small JSON file, so the
big rasters never ship. Nothing here uses Google data.

Buildings whose height varies a lot (a wide low base with a tower rising from part of it) are also split into a few
rectangular blocks, each with its own measured height, written to data/parts_lidar.json in the GAME frame (metres,
rotated so the streets run straight, see data/map_config.json). The grid is aligned with the streets, which are also the
building walls, so the rectangles follow the real walls.

Raster layout (from SwapCity's lidar.py): local tangent plane in metres, origin at the centre of the LiDAR bbox,
column = (east - x0) / cell, row = (y1 - north) / cell, so row 0 is the NORTH edge.
"""
import argparse, json, math, os
import numpy as np

def make_projector(lat0, lon0):  # identical to SwapCity's bake_city.make_projector, so the rasters line up
    m_lat = 111132.954 - 559.822 * math.cos(2 * math.radians(lat0)) + 1.175 * math.cos(4 * math.radians(lat0))
    m_lon = 111412.84 * math.cos(math.radians(lat0)) - 93.5 * math.cos(3 * math.radians(lat0))
    return lambda lon, lat: ((lon - lon0) * m_lon, (lat - lat0) * m_lat)

def points_in_polygon(px, py, poly):
    inside = np.zeros(px.shape, dtype=bool)
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]; xj, yj = poly[j]
        cond = ((yi > py) != (yj > py)) & (px < (xj - xi) * (py - yi) / ((yj - yi) or 1e-12) + xi)
        inside ^= cond
        j = i
    return inside

def dist_to_edges(px, py, poly):
    best = np.full(px.shape, np.inf)
    n = len(poly)
    for i in range(n):
        ax, ay = poly[i]; bx, by = poly[(i + 1) % n]
        dx, dy = bx - ax, by - ay
        l2 = dx * dx + dy * dy or 1e-12
        t = np.clip(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1)
        best = np.minimum(best, np.hypot(px - (ax + dx * t), py - (ay + dy * t)))
    return best


GRID = 1.5  # metres per grid cell when splitting a stepped building
MIN_TOWER_AREA = 30.0  # m2: smaller raised areas are treated as roof clutter

class GameFrame:
    """The game's coordinate frame (see tools/bake_map.mjs): rotated so the street grid runs straight."""
    def __init__(self, cfg):
        self.lat0, self.lon0 = cfg['origin']['lat'], cfg['origin']['lon']
        self.kx = 111320 * math.cos(math.radians(self.lat0)); self.ky = 110540
        th = math.radians(cfg['rotationDegrees']); self.c, self.s = math.cos(th), math.sin(th)
        b = cfg['box']; self.cx = (b['xMin'] + b['xMax']) / 2; self.cy = (b['yMin'] + b['yMax']) / 2
    def forward(self, lon, lat):
        x = (lon - self.lon0) * self.kx; y = (lat - self.lat0) * self.ky
        return x * self.c - y * self.s - self.cx, -(x * self.s + y * self.c - self.cy)
    def inverse(self, gx, gy):  # arrays: game -> (lon, lat)
        rx = gx + self.cx; ry = -gy + self.cy
        x = rx * self.c + ry * self.s; y = -rx * self.s + ry * self.c
        return self.lon0 + x / self.kx, self.lat0 + y / self.ky


def plateau_levels(h):
    """the distinct roof levels of a building: heights that a real share of its roof sits at"""
    bins = np.arange(0, h.max() + 3, 3.0)
    counts, edges = np.histogram(h, bins=bins)
    strong = counts >= max(10, 0.05 * len(h))
    levels, i = [], 0
    while i < len(counts):
        if strong[i]:
            j = i
            while j + 1 < len(counts) and strong[j + 1]: j += 1
            sel = h[(h >= edges[i]) & (h < edges[j + 1])]
            levels.append((float(np.median(sel)), len(sel)))
            i = j + 1
        else: i += 1
    merged = []  # levels within 8 m are one level (keep the one with more roof)
    for lv, n in levels:
        if merged and lv - merged[-1][0] < 8: 
            if n > merged[-1][1]: merged[-1] = (lv, n)
        else: merged.append((lv, n))
    return [lv for lv, _ in merged]

def components(mask):
    """8-connected components of a boolean grid: list of lists of (row, col)"""
    H, W = mask.shape
    seen = np.zeros_like(mask)
    out = []
    for i in range(H):
        for j in range(W):
            if not mask[i, j] or seen[i, j]: continue
            stack, comp = [(i, j)], []
            seen[i, j] = True
            while stack:
                r, c = stack.pop(); comp.append((r, c))
                for dr in (-1, 0, 1):
                    for dc in (-1, 0, 1):
                        rr, cc = r + dr, c + dc
                        if 0 <= rr < H and 0 <= cc < W and mask[rr, cc] and not seen[rr, cc]:
                            seen[rr, cc] = True; stack.append((rr, cc))
            out.append(comp)
    return out

def clip_to_rect(poly, x0, y0, x1, y1):
    """Sutherland-Hodgman: the part of a polygon inside an axis-aligned rectangle"""
    def clip(pts, inside, cut):
        out = []
        for i in range(len(pts)):
            a, b = pts[i - 1], pts[i]
            ia, ib = inside(a), inside(b)
            if ib:
                if not ia: out.append(cut(a, b))
                out.append(b)
            elif ia: out.append(cut(a, b))
        return out
    def cx(x): return lambda a, b: (x, a[1] + (b[1] - a[1]) * (x - a[0]) / ((b[0] - a[0]) or 1e-12))
    def cy(y): return lambda a, b: (a[0] + (b[0] - a[0]) * (y - a[1]) / ((b[1] - a[1]) or 1e-12), y)
    pts = list(poly)
    for inside, cut in ((lambda p: p[0] >= x0, cx(x0)), (lambda p: p[0] <= x1, cx(x1)), (lambda p: p[1] >= y0, cy(y0)), (lambda p: p[1] <= y1, cy(y1))):
        if not pts: break
        pts = clip(pts, inside, cut)
    return pts

def split_stepped(w, frame, proj, dsm, dem, x0, y1, cell, dcell):
    """split one stepped building into a base and the towers standing on it: [{'poly': [[x, y]...], 'base': m, 'top': m}]
    (game metres). A tier is the bounding rectangle of a raised area, clipped to the real footprint, and starts at the
    roof level of the tier below it."""
    poly = [frame.forward(p['lon'], p['lat']) for p in w['geometry']][:-1]
    xs = [p[0] for p in poly]; ys = [p[1] for p in poly]
    gx0, gy0 = math.floor(min(xs)), math.floor(min(ys))
    nx = int(math.ceil((max(xs) - gx0) / GRID)) + 1; ny = int(math.ceil((max(ys) - gy0) / GRID)) + 1
    gx = gx0 + (np.arange(nx) + 0.5) * GRID; gy = gy0 + (np.arange(ny) + 0.5) * GRID
    GX, GY = np.meshgrid(gx, gy)
    valid = points_in_polygon(GX, GY, poly) & (dist_to_edges(GX, GY, poly) >= 0.6)
    lon, lat = frame.inverse(GX, GY)
    e, n = proj(lon, lat)
    r = np.clip(((y1 - n) / cell).astype(int), 0, dsm.shape[0] - 1); c = np.clip(((e - x0) / cell).astype(int), 0, dsm.shape[1] - 1)
    rd = np.clip(((y1 - n) / dcell).astype(int), 0, dem.shape[0] - 1); cd = np.clip(((e - x0) / dcell).astype(int), 0, dem.shape[1] - 1)
    h = dsm[r, c] - dem[rd, cd]
    valid &= np.isfinite(h) & (h >= 2)
    if valid.sum() < 40: return []
    levels = plateau_levels(h[valid])
    if len(levels) < 2: return []
    thresholds = [(levels[k - 1] + levels[k]) / 2 for k in range(1, len(levels))]
    out = [{'poly': [[round(x, 1), round(y, 1)] for x, y in poly], 'base': 0.0, 'top': round(levels[0], 1)}]
    for k, t in enumerate(thresholds, start=1):
        upper = thresholds[k] if k < len(thresholds) else 1e9
        for comp in components(valid & (h >= t)):
            if len(comp) * GRID * GRID < MIN_TOWER_AREA: continue
            rr = [p[0] for p in comp]; cc = [p[1] for p in comp]
            bx0, bx1 = gx0 + min(cc) * GRID, gx0 + (max(cc) + 1) * GRID; by0, by1 = gy0 + min(rr) * GRID, gy0 + (max(rr) + 1) * GRID
            shape = clip_to_rect(poly, bx0, by0, bx1, by1)
            if len(shape) < 3: continue
            own = [h[p] for p in comp if h[p] < upper]
            top = float(np.median(own)) if own else levels[k]
            # a tower starts at the roof of the block it stands on: the highest lower block that contains this raised area
            mx = gx0 + (sum(cc) / len(cc) + 0.5) * GRID; my = gy0 + (sum(rr) / len(rr) + 0.5) * GRID
            base = levels[k - 1]
            for blk in out:
                if blk['top'] < top - 2 and blk['top'] > base and points_in_polygon(np.array([mx]), np.array([my]), blk['poly'])[0]: base = blk['top']
            if top - base < 3: continue
            out.append({'poly': [[round(x, 1), round(y, 1)] for x, y in shape], 'base': round(base, 1), 'top': round(top, 1)})
    return out if len(out) > 1 else []

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--lidar', required=True, help='folder with dsm.npy, dem.npy, meta.json')
    ap.add_argument('--raw', default='data/raw/downtown_wide.json')
    ap.add_argument('--out', default='data/heights_lidar.json')
    ap.add_argument('--inset', type=float, default=1.0, help='metres to stay inside each footprint edge')
    ap.add_argument('--config', default='data/map_config.json')
    ap.add_argument('--map', default='data/map.json', help='only split buildings that appear in this baked map (all if missing)')
    ap.add_argument('--parts-out', default='data/parts_lidar.json')
    a = ap.parse_args()

    meta = json.load(open(os.path.join(a.lidar, 'meta.json')))
    dsm = np.load(os.path.join(a.lidar, 'dsm.npy'))
    dem = np.load(os.path.join(a.lidar, 'dem.npy'))
    S, W, N, E = meta['bbox']
    proj = make_projector((S + N) / 2, (W + E) / 2)
    (x0, y0), (x1, y1) = proj(W, S), proj(E, N)
    cell, dcell = meta['cell'], meta['dem_cell']
    H, Wd = dsm.shape

    raw = json.load(open(a.raw))
    frame = GameFrame(json.load(open(a.config)))
    in_map = {str(b['id']) for b in json.load(open(a.map))['buildings']} if os.path.exists(a.map) else None
    out, stats, parts_out = {}, [], {}
    for w in raw['elements']:
        if w.get('type') != 'way' or 'building' not in w.get('tags', {}) or 'geometry' not in w: continue
        poly = [proj(p['lon'], p['lat']) for p in w['geometry']]
        if len(poly) < 4: continue
        poly = poly[:-1]
        xs = [p[0] for p in poly]; ys = [p[1] for p in poly]
        c0 = max(0, int((min(xs) - x0) / cell)); c1 = min(Wd - 1, int((max(xs) - x0) / cell) + 1)
        r0 = max(0, int((y1 - max(ys)) / cell)); r1 = min(H - 1, int((y1 - min(ys)) / cell) + 1)
        if c1 <= c0 or r1 <= r0: continue
        cc, rr = np.meshgrid(np.arange(c0, c1 + 1), np.arange(r0, r1 + 1))
        ex = x0 + (cc + 0.5) * cell; ny = y1 - (rr + 0.5) * cell  # cell centres in metres east / north
        keep = points_in_polygon(ex, ny, poly) & (dist_to_edges(ex, ny, poly) >= a.inset)
        if keep.sum() < 4:  # tiny building: fall back to the plain interior
            keep = points_in_polygon(ex, ny, poly)
        if keep.sum() == 0: continue
        r, c = rr[keep], cc[keep]
        ground = dem[np.clip(((y1 - (ny[keep])) / dcell).astype(int), 0, dem.shape[0] - 1), np.clip(((ex[keep] - x0) / dcell).astype(int), 0, dem.shape[1] - 1)]
        h = dsm[r, c] - ground
        h = h[np.isfinite(h)]
        if len(h) == 0: continue
        rec = {'h': round(float(np.percentile(h, 90)), 1), 'p50': round(float(np.percentile(h, 50)), 1), 'max': round(float(h.max()), 1), 'n': int(len(h))}
        out[str(w['id'])] = rec
        if (in_map is None or str(w['id']) in in_map) and rec['n'] >= 150 and rec['h'] - rec['p50'] > 12:
            parts = split_stepped(w, frame, proj, dsm, dem, x0, y1, cell, dcell)
            if len(parts) > 1: parts_out[str(w['id'])] = parts
        t = w['tags']
        osm = None
        try:
            osm = float(t['height'].split()[0]) if 'height' in t else (float(t['building:levels']) * 3.4 + 2 if 'building:levels' in t else None)
        except ValueError:
            pass
        stats.append((w['id'], t.get('name', ''), rec, osm, 'height' in t))

    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    json.dump({'source': 'USGS 3DEP LiDAR (public domain), surface minus ground, 90th percentile over the roof', 'buildings': out}, open(a.out, 'w'))
    json.dump({'source': 'USGS 3DEP LiDAR, stepped buildings split into blocks (game frame, metres)', 'parts': parts_out}, open(a.parts_out, 'w'))
    print(f'split {len(parts_out)} stepped buildings into {sum(len(v) for v in parts_out.values())} blocks (a base plus towers) -> {a.parts_out}')
    print(f'measured {len(out)} of {sum(1 for w in raw["elements"] if w.get("type") == "way" and "building" in w.get("tags", {}))} building footprints -> {a.out}')
    hs = np.array([v['h'] for v in out.values()])
    print(f'heights: min {hs.min():.1f}  median {np.median(hs):.1f}  max {hs.max():.1f} m;  {int((hs < 4).sum())} under 4 m (sheds, canopies or misses)')
    print('\nchecks against OpenStreetMap heights we already trust (explicit `height` tags):')
    print(f'  {"lidar":>7} {"osm":>6}  name')
    tagged = [s for s in stats if s[3] is not None and s[4]]
    errs = []
    for wid, name, rec, osm, _ in sorted(tagged, key=lambda s: -s[3])[:14]:
        print(f'  {rec["h"]:7.1f} {osm:6.1f}  {name or wid}')
    for wid, name, rec, osm, _ in tagged:
        if osm >= 8: errs.append((rec['h'] - osm) / osm)
    errs = np.array(errs)
    print(f'\n  {len(errs)} buildings with an explicit OSM height of 8 m or more: LiDAR is within 10% for {int((abs(errs) < .10).sum())}, within 20% for {int((abs(errs) < .20).sum())}; median difference {100 * np.median(errs):+.1f}%')
    big = sorted(out.items(), key=lambda kv: -kv[1]['h'])[:8]
    names = {str(w['id']): w.get('tags', {}).get('name', '') for w in raw['elements'] if w.get('type') == 'way'}
    print('\ntallest buildings by LiDAR:')
    for wid, rec in big: print(f'  {rec["h"]:6.1f} m  {names.get(wid) or "(unnamed)"}  [way {wid}]')

main()
