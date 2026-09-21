#!/usr/bin/env python3
"""
Work out how high the ground is (metres above the WGS84 ellipsoid) at the game's origin, so a camera placed over it in
Google Earth mode sits the right height above the streets. Uses SwapCity's LiDAR datum and its geoid/height trim
(cities/minneapolis/cesium_align.json), which were measured against Google's tiles there.

  python3 tools/earth_align.py --lidar ~/Projects/SwapCity/data/minneapolis/lidar --swapcity ~/Projects/SwapCity

Writes data/earth_align.json. Only these few numbers ship; no Google data is stored or derived here.
"""
import argparse, json, math, os
import numpy as np

def make_projector(lat0, lon0):  # same as SwapCity's bake_city.make_projector
    m_lat = 111132.954 - 559.822 * math.cos(2 * math.radians(lat0)) + 1.175 * math.cos(4 * math.radians(lat0))
    m_lon = 111412.84 * math.cos(math.radians(lat0)) - 93.5 * math.cos(3 * math.radians(lat0))
    return lambda lon, lat: ((lon - lon0) * m_lon, (lat - lat0) * m_lat)

ap = argparse.ArgumentParser()
ap.add_argument('--lidar', required=True); ap.add_argument('--swapcity', required=True)
ap.add_argument('--config', default='data/map_config.json'); ap.add_argument('--out', default='data/earth_align.json')
a = ap.parse_args()
meta = json.load(open(os.path.join(a.lidar, 'meta.json')))
align = json.load(open(os.path.join(a.swapcity, 'cities/minneapolis/cesium_align.json')))
cfg = json.load(open(a.config))
dem = np.load(os.path.join(a.lidar, 'dem.npy'))
S, W, N, E = meta['bbox']
proj = make_projector((S + N) / 2, (W + E) / 2)
(x0, y0), (x1, y1) = proj(W, S), proj(E, N)
lat0, lon0 = cfg['origin']['lat'], cfg['origin']['lon']
e, n = proj(lon0, lat0)
ground = float(dem[int((y1 - n) / meta['dem_cell']), int((e - x0) / meta['dem_cell'])])
# spread of the ground under the 9 blocks, to see how flat downtown is
b = cfg['box']; rows = []
for gx in np.linspace(b['xMin'], b['xMax'], 5):
    for gy in np.linspace(b['yMin'], b['yMax'], 5):
        # box corners are in the game's rotated frame, so just sample the origin neighbourhood on a small ring instead
        pass
h_ellipsoid = meta['z0_datum_m'] + align['geoid_offset_m'] + ground + align['height_trim_cm'] / 100.0
out = {
    'origin': cfg['origin'], 'rotationDegrees': cfg['rotationDegrees'],
    'boxCentreLocal': {'x': (b['xMin'] + b['xMax']) / 2, 'y': (b['yMin'] + b['yMax']) / 2},
    'groundEllipsoidHeightM': round(h_ellipsoid, 2),
    'note': f"LiDAR datum {meta['z0_datum_m']:.2f} m + geoid {align['geoid_offset_m']} m + DEM at the origin {ground:.2f} m + trim {align['height_trim_cm']} cm",
}
json.dump(out, open(a.out, 'w'), indent=2)
print(json.dumps(out, indent=2))
