#!/usr/bin/env python3
"""
Where each roof really is in the aerial photo. NAIP is corrected to the GROUND, so the roof of a tall building appears shifted
away from the point the camera was above, in proportion to its height (the tower "leans"). This tool measures that shift.

  python3 tools/roof_offsets.py --lidar ~/Projects/SwapCity/data/minneapolis/lidar

For every building it compares the LiDAR surface's roof outlines (true positions) with the photo's edges to find how far the
photo shows the roof displaced, then fits one smooth model  shift = height * (k * position + b)  to all of them (a camera looks
straight down at one point, so the lean grows evenly away from it). The model gives every building and every stepped block a
shift for ITS OWN roof height. Writes data/roof_offsets.json. Reads data/roofs_naip.jpg (tools/bake_naip.py) and LiDAR.
"""
import argparse, json, math, os
import numpy as np
from PIL import Image, ImageFilter

ap = argparse.ArgumentParser()
ap.add_argument("--lidar", required=True)
ap.add_argument("--debug", default="")
args = ap.parse_args()

def make_projector(lat0, lon0):
    m_lat = 111132.954 - 559.822 * math.cos(2 * math.radians(lat0)) + 1.175 * math.cos(4 * math.radians(lat0))
    m_lon = 111412.84 * math.cos(math.radians(lat0)) - 93.5 * math.cos(3 * math.radians(lat0))
    return lambda lon, lat: ((lon - lon0) * m_lon, (lat - lat0) * m_lat)

cfg = json.load(open("data/map_config.json")); mp = json.load(open("data/map.json")); ph = json.load(open("data/roofs_naip.json"))
meta = json.load(open(os.path.join(args.lidar, "meta.json"))); dsm = np.load(os.path.join(args.lidar, "dsm.npy")); dem = np.load(os.path.join(args.lidar, "dem.npy"))
S, W, N, E = meta["bbox"]; proj = make_projector((S + N) / 2, (W + E) / 2)
x0e, y0n, x1e, y1n = meta["bbox_en"]; cell = meta["cell"]; dcell = meta["dem_cell"]

lat0, lon0 = cfg["origin"]["lat"], cfg["origin"]["lon"]
kx = 111320 * math.cos(math.radians(lat0)); ky = 110540
th = math.radians(cfg["rotationDegrees"]); c, s = math.cos(th), math.sin(th)
B = cfg["box"]; cx, cy = (B["xMin"] + B["xMax"]) / 2, (B["yMin"] + B["yMax"]) / 2
def game_to_lonlat(gx, gy):
    rx = gx + cx; ry = -gy + cy
    x = rx * c + ry * s; y = -rx * s + ry * c
    return lon0 + x / kx, lat0 + y / ky

# work at 1.5 px per metre in the game frame
P = 1.5
minX, minY, maxX, maxY = ph["minX"], ph["minY"], ph["maxX"], ph["maxY"]
w, h = int((maxX - minX) * P), int((maxY - minY) * P)
gx = minX + (np.arange(w) + 0.5) / P; gy = minY + (np.arange(h) + 0.5) / P
GX, GY = np.meshgrid(gx, gy)
lon, lat = game_to_lonlat(GX, GY)
Ee, Nn = proj(lon, lat)
col = np.clip(((Ee - x0e) / cell).astype(int), 0, dsm.shape[1] - 1); row = np.clip(((y1n - Nn) / cell).astype(int), 0, dsm.shape[0] - 1)
z = dsm[row, col].astype(np.float32)
z = np.nan_to_num(z, nan=0.0)
gyz, gxz = np.gradient(np.clip(z, -5, 300))
Edsm = np.minimum(np.hypot(gxz, gyz), 25.0)          # roof outlines and steps, at their true position

photo = Image.open("data/roofs_naip.jpg").convert("L").resize((w, h), Image.LANCZOS).filter(ImageFilter.GaussianBlur(0.8))
pa = np.asarray(photo, dtype=np.float32)
gyp, gxp = np.gradient(pa)
Gph = np.hypot(gxp, gyp)                                # edges in the photo

def norm(a):
    a = a - a.mean(); d = a.std()
    return a / d if d > 1e-6 else a * 0

def region(b, pad):
    xs = [p[0] for p in b["points"]]; ys = [p[1] for p in b["points"]]
    return (int((min(xs) - pad - minX) * P), int((min(ys) - pad - minY) * P), int((max(xs) + pad - minX) * P) + 1, int((max(ys) + pad - minY) * P) + 1)

def score(b, ox, oy, pad=4.0):
    """how well the roof edges of building b, moved by (ox, oy) metres, sit on edges of the photo"""
    x0, y0, x1, y1 = region(b, pad)
    dx, dy = int(round(ox * P)), int(round(oy * P))
    if x0 + dx < 0 or y0 + dy < 0 or x1 + dx > w or y1 + dy > h or x0 < 0 or y0 < 0 or x1 > w or y1 > h: return -1
    return float((norm(Edsm[y0:y1, x0:x1]) * norm(Gph[y0 + dy:y1 + dy, x0 + dx:x1 + dx])).mean())

# measure each tall building on its own
tall = [b for b in mp["buildings"] if b["height"] >= 40]
meas = []
for b in tall:
    R = min(55.0, 0.2 * b["height"]); best = (-1, 0, 0)
    for oy in np.arange(-R, R + 0.1, 1.0):
        for ox in np.arange(-R, R + 0.1, 1.0):
            if ox * ox + oy * oy > R * R: continue
            sc = score(b, ox, oy)
            if sc > best[0]: best = (sc, ox, oy)
    xs = [p[0] for p in b["points"]]; ys = [p[1] for p in b["points"]]
    meas.append({"id": b["id"], "h": b["height"], "cx": (min(xs) + max(xs)) / 2, "cy": (min(ys) + max(ys)) / 2, "score": best[0], "ox": best[1], "oy": best[2]})
good = [m for m in meas if m["score"] > 0.12]
print(f"{len(tall)} tall buildings, {len(good)} with a clear match")

# One camera looks straight down at a point n: a roof at height h and position p is shifted h * alpha * (p - n) (away from n).
# alpha is about 1 / (camera height above the roof), so 0.0002 to 0.0004 per metre. Robust grid search on the clearest matches.
pool = [m for m in good if m["h"] >= 60]
def cost(alpha, nx, ny):
    tot = 0.0
    for m in pool:
        ex = m["h"] * alpha * (m["cx"] - nx) - m["ox"]; ey = m["h"] * alpha * (m["cy"] - ny) - m["oy"]
        tot += min(math.hypot(ex, ey), 12.0) ** 2 * (0.5 + min(m["score"], 0.4) * 2)
    return tot
best = (1e18, 0, 0, 0)
for alpha in np.linspace(0.00005, 0.0008, 31):
    for nx in np.linspace(-4000, 4000, 81):
        for ny in np.linspace(-4000, 4000, 81):
            cc = cost(alpha, nx, ny)
            if cc < best[0]: best = (cc, alpha, nx, ny)
_, alpha, nx, ny = best
for it in range(3):       # refine around the best
    step = [0.00002, 100, 100][0], 100.0
    for da in np.linspace(-0.00004, 0.00004, 9):
        for dx in np.linspace(-200, 200, 17):
            for dy in np.linspace(-200, 200, 17):
                cc = cost(alpha + da, nx + dx, ny + dy)
                if cc < best[0]: best = (cc, alpha + da, nx + dx, ny + dy)
    _, alpha, nx, ny = best
print("nadir point (%.0f, %.0f) m, alpha %.5f (camera about %.0f m above the roofs)" % (nx, ny, alpha, 1 / alpha))
def model(px, py, hh): return hh * alpha * (px - nx), hh * alpha * (py - ny)
errs = [math.hypot(*(np.array(model(m["cx"], m["cy"], m["h"])) - [m["ox"], m["oy"]])) for m in pool]
print("model fit on %d towers: median error %.1f m, 80%% within %.1f m" % (len(pool), np.median(errs), np.percentile(errs, 80)))
for m in sorted(pool, key=lambda m: -m["h"])[:10]:
    mo = model(m["cx"], m["cy"], m["h"])
    print("  id %d h %.0f at (%.0f, %.0f) measured (%.1f, %.1f) model (%.1f, %.1f) score %.2f" % (m["id"], m["h"], m["cx"], m["cy"], m["ox"], m["oy"], mo[0], mo[1], m["score"]))
fx, fy = [alpha, 0.0, -alpha * nx], [0.0, alpha, -alpha * ny]   # same form as before: shift = h * (a*x + b*y + c)
json.dump({"x": list(map(float, fx)), "y": list(map(float, fy)),
           "note": "shift of a roof in the photo, metres = height * (a*x + b*y + c); x from 'x', y from 'y'"}, open("data/roof_offsets.json", "w"), indent=1)
