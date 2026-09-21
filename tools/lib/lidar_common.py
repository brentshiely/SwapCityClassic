"""Shared helpers for the city-wide LiDAR tools (fetch_lidar_city.py, lidar_heights_city.py, roof_lean_city.py).

Game frame <-> lon/lat <-> UTM zone 15N (EPSG:26915, the CRS of the USGS point clouds), and access to the block rasters
written by fetch_lidar_city.py.

Block rasters live in data/raw/lidar/blocks/ and are cut on the UTM grid itself (no rotation, no resampling):
  block (i, j) = UTM easting [i*2000, (i+1)*2000) x northing [j*2000, (j+1)*2000)
  {i}_{j}.dsm.npy  float32 [2000, 2000]  1 m cells, row 0 = NORTH edge (northing (j+1)*2000 - 0.5 - row), column 0 = WEST edge;
                   metres above the NAVD88 datum (orthometric, NOT above ground); NaN = no return / not covered
  {i}_{j}.dem.npy  float32 [1000, 1000]  2 m cells, same orientation; ground (class 2) mean, NaN = no ground return
  index.json       { "grid": 2000, "cell": 1, "dem_cell": 2, "blocks": { "i_j": {...counts...} }, "done": [...] }
"""
import json, math, os
import numpy as np

BLOCK = 2000          # metres per block edge
CELL = 1.0            # DSM cell, metres
DEM_CELL = 2.0        # DEM cell, metres
EPSG = 26915

_here = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(_here, '..', '..'))
LIDAR_DIR = os.path.join(ROOT, 'data', 'raw', 'lidar')
BLOCK_DIR = os.path.join(LIDAR_DIR, 'blocks')


class GameFrame:
    """The game's coordinate frame (see tools/bake_map.mjs): rotated so the street grid runs straight. Same maths as
    GameFrame in tools/lidar_heights.py, with numpy support."""
    def __init__(self, cfg):
        self.lat0, self.lon0 = cfg['origin']['lat'], cfg['origin']['lon']
        self.kx = 111320 * math.cos(math.radians(self.lat0)); self.ky = 110540
        th = math.radians(cfg['rotationDegrees']); self.c, self.s = math.cos(th), math.sin(th)
        b = cfg['box']; self.cx = (b['xMin'] + b['xMax']) / 2; self.cy = (b['yMin'] + b['yMax']) / 2
    def forward(self, lon, lat):
        x = (np.asarray(lon) - self.lon0) * self.kx; y = (np.asarray(lat) - self.lat0) * self.ky
        return x * self.c - y * self.s - self.cx, -(x * self.s + y * self.c - self.cy)
    def inverse(self, gx, gy):
        rx = np.asarray(gx) + self.cx; ry = -np.asarray(gy) + self.cy
        x = rx * self.c + ry * self.s; y = -rx * self.s + ry * self.c
        return self.lon0 + x / self.kx, self.lat0 + y / self.ky


def load_frame():
    return GameFrame(json.load(open(os.path.join(ROOT, 'data', 'map_config.json'))))


_tr = {}
def to_utm(lon, lat):
    from pyproj import Transformer
    if 'f' not in _tr: _tr['f'] = Transformer.from_crs('EPSG:4326', f'EPSG:{EPSG}', always_xy=True)
    return _tr['f'].transform(lon, lat)


def from_utm(e, n):
    from pyproj import Transformer
    if 'b' not in _tr: _tr['b'] = Transformer.from_crs(f'EPSG:{EPSG}', 'EPSG:4326', always_xy=True)
    return _tr['b'].transform(e, n)


class GameToUtm:
    """game metres -> UTM metres, exact via lon/lat + pyproj."""
    def __init__(self, frame):
        self.frame = frame
    def __call__(self, gx, gy):
        lon, lat = self.frame.inverse(gx, gy)
        return to_utm(lon, lat)
    def local_affine(self, gx0, gy0, gx1, gy1, n=4):
        """affine (2x3) with utm = A @ [gx, gy, 1] valid over the given game box; returns (A, max_err_m)"""
        gx, gy = np.meshgrid(np.linspace(gx0, gx1, n), np.linspace(gy0, gy1, n)); gx = gx.ravel(); gy = gy.ravel()
        e, nn = self(gx, gy)
        M = np.c_[gx, gy, np.ones(gx.size)]
        ce = np.linalg.lstsq(M, e, rcond=None)[0]; cn = np.linalg.lstsq(M, nn, rcond=None)[0]
        err = max(np.abs(M @ ce - e).max(), np.abs(M @ cn - nn).max())
        return np.array([ce, cn]), float(err)


def city_boundary_utm(meta=None):
    """the city limit polygon as an (N, 2) array of UTM metres"""
    if meta is None: meta = json.load(open(os.path.join(ROOT, 'data', 'city', 'city.json')))['meta']
    fr = load_frame()
    b = np.array(meta['boundary'], dtype=float)
    lon, lat = fr.inverse(b[:, 0], b[:, 1])
    e, n = to_utm(lon, lat)
    return np.c_[e, n]


class BlockStore:
    """read access to the block rasters, with a tiny LRU cache. Everything is addressed in UTM metres."""
    def __init__(self, folder=BLOCK_DIR, keep=6):
        self.dir = folder; self.keep = keep; self.cache = {}; self.order = []
    def has(self, i, j):
        return os.path.exists(os.path.join(self.dir, f'{i}_{j}.dsm.npy'))
    def get(self, i, j):
        k = (i, j)
        if k in self.cache:
            self.order.remove(k); self.order.append(k); return self.cache[k]
        dp = os.path.join(self.dir, f'{i}_{j}.dsm.npy')
        v = (np.load(dp), np.load(os.path.join(self.dir, f'{i}_{j}.dem.npy'))) if os.path.exists(dp) else None
        self.cache[k] = v; self.order.append(k)
        while len(self.order) > self.keep: self.cache.pop(self.order.pop(0), None)
        return v
    def window(self, e0, n0, e1, n1, dem=False):
        """the DSM (or DEM) over UTM box [e0,e1] x [n0,n1] mosaicked from the blocks: (array, e_west, n_north) with
        cell size CELL (or DEM_CELL); row 0 = north. NaN where there is no block."""
        cell = DEM_CELL if dem else CELL
        per = int(BLOCK / cell)
        ce0 = int(math.floor(e0 / cell)); ce1 = int(math.ceil(e1 / cell))
        cn0 = int(math.floor(n0 / cell)); cn1 = int(math.ceil(n1 / cell))   # cell index counted from the south
        W = ce1 - ce0; H = cn1 - cn0
        out = np.full((H, W), np.nan, dtype=np.float32)
        for i in range(int(math.floor(e0 / BLOCK)), int(math.floor((e1 - 1e-6) / BLOCK)) + 1):
            for j in range(int(math.floor(n0 / BLOCK)), int(math.floor((n1 - 1e-6) / BLOCK)) + 1):
                b = self.get(i, j)
                if b is None: continue
                arr = b[1] if dem else b[0]
                a0 = max(ce0, i * per); a1 = min(ce1, (i + 1) * per)
                b0 = max(cn0, j * per); b1 = min(cn1, (j + 1) * per)
                if a1 <= a0 or b1 <= b0: continue
                sub = arr[(j + 1) * per - b1:(j + 1) * per - b0, a0 - i * per:a1 - i * per]
                out[cn1 - b1:cn1 - b0, a0 - ce0:a1 - ce0] = sub
        return out, ce0 * cell, cn1 * cell
