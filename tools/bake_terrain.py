#!/usr/bin/env python3
"""
Ground height for Google mode. Google's picture sits on real terrain (the Mississippi valley is ~30 m below downtown's plateau), while the game's
overlay and camera assumed ONE flat ground height. This bakes the LiDAR ground model (public domain, USGS 3DEP; the DEM SwapCity built, 2 m
cells) into a coarse height grid in the GAME frame, relative to the ground at the game origin:

  python3 tools/bake_terrain.py --lidar ~/Projects/SwapCity/data/minneapolis/lidar

Writes data/city/terrain.json { minX, minY, cell, w, h, base, dm: [heights in decimetres, row-major, y down; -32768 = no data] }.
Only the region the DEM covers (downtown, ~3.5 x 2.8 km) is filled. No Google data is used.
"""
import argparse, json, math, os, re
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('--lidar', required=True)
ap.add_argument('--cell', type=float, default=8.0)
ap.add_argument('--out', default='data/city/terrain.json')
ap.add_argument('--base', type=float, default=None, help='DEM height that counts as 0 (default: the value earth_align.py used at the origin, data/earth_align.json)')
a = ap.parse_args()

def make_projector(lat0, lon0):  # SwapCity's bake_city.make_projector (the rasters use it)
    m_lat = 111132.954 - 559.822 * math.cos(2 * math.radians(lat0)) + 1.175 * math.cos(4 * math.radians(lat0))
    m_lon = 111412.84 * math.cos(math.radians(lat0)) - 93.5 * math.cos(3 * math.radians(lat0))
    return lambda lon, lat: ((lon - lon0) * m_lon, (lat - lat0) * m_lat)

meta = json.load(open(os.path.join(a.lidar, 'meta.json')))
dem = np.load(os.path.join(a.lidar, 'dem.npy')).astype(np.float64)
S, W, N, E = meta['bbox']; proj = make_projector((S + N) / 2, (W + E) / 2)
x0e, y0n, x1e, y1n = meta['bbox_en']; dcell = meta['dem_cell']
cfg = json.load(open('data/map_config.json'))
lat0, lon0 = cfg['origin']['lat'], cfg['origin']['lon']
kx = 111320 * math.cos(math.radians(lat0)); ky = 110540
th = math.radians(cfg['rotationDegrees']); c, s = math.cos(th), math.sin(th)
B = cfg['box']; cx, cy = (B['xMin'] + B['xMax']) / 2, (B['yMin'] + B['yMax']) / 2

def game_to_en(gx, gy):
    rx = gx + cx; ry = -gy + cy
    x = rx * c + ry * s; y = -rx * s + ry * c
    return proj(lon0 + x / kx, lat0 + y / ky)

def sample(e, n):
    col = (e - x0e) / dcell - 0.5; row = (y1n - n) / dcell - 0.5
    if col < 0 or row < 0 or col > dem.shape[1] - 1 or row > dem.shape[0] - 1: return None
    c0, r0 = int(col), int(row); fc, fr = col - c0, row - r0
    c1, r1 = min(c0 + 1, dem.shape[1] - 1), min(r0 + 1, dem.shape[0] - 1)
    v = dem[r0, c0] * (1 - fc) * (1 - fr) + dem[r0, c1] * fc * (1 - fr) + dem[r1, c0] * (1 - fc) * fr + dem[r1, c1] * fc * fr
    return None if not np.isfinite(v) else v

base = a.base
if base is None:
    m = re.search(r'DEM at the origin ([0-9.]+)', json.load(open('data/earth_align.json'))['note'])
    base = float(m.group(1)) if m else sample(*game_to_en(0.0, 0.0))  # the same ground height the Google camera was aligned to
# the game-frame rectangle that surrounds the DEM box
corners = []
for e, n in [(x0e, y0n), (x1e, y0n), (x0e, y1n), (x1e, y1n)]:
    lon = (W + E) / 2 + e / (111412.84 * math.cos(math.radians((S + N) / 2)))
    lat = (S + N) / 2 + n / 111132.954
    x = (lon - lon0) * kx; y = (lat - lat0) * ky
    corners.append((x * c - y * s - cx, -(x * s + y * c - cy)))
minX = math.floor(min(p[0] for p in corners) / a.cell) * a.cell; maxX = math.ceil(max(p[0] for p in corners) / a.cell) * a.cell
minY = math.floor(min(p[1] for p in corners) / a.cell) * a.cell; maxY = math.ceil(max(p[1] for p in corners) / a.cell) * a.cell
w, h = int((maxX - minX) / a.cell) + 1, int((maxY - minY) / a.cell) + 1
dm = np.full((h, w), -32768, dtype=np.int32); have = 0
for j in range(h):
    for i in range(w):
        v = sample(*game_to_en(minX + i * a.cell, minY + j * a.cell))
        if v is not None: dm[j, i] = int(round((v - base) * 10)); have += 1
out = {'minX': minX, 'minY': minY, 'cell': a.cell, 'w': w, 'h': h, 'base': round(base, 2), 'dm': dm.flatten().tolist(),
       'note': 'ground height above the ground at the game origin, decimetres, from the USGS LiDAR DEM (public domain)'}
os.makedirs(os.path.dirname(a.out), exist_ok=True)
json.dump(out, open(a.out, 'w'), separators=(',', ':'))
vals = dm[dm > -32768] / 10
print(f'{w}x{h} cells of {a.cell} m, {have} filled; heights {vals.min():.1f} .. {vals.max():.1f} m (origin ground {base:.2f} m); {os.path.getsize(a.out)/1e3:.0f} KB')
