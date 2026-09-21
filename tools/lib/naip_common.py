"""Shared maths for the whole-city NAIP roof photos: game frame <-> web mercator, the block grid, the tile list.
Same projection as tools/bake_naip.py (linearised around the map origin, the frame of tools/bake_map.mjs / bake_city.mjs)."""
import json, math, os, glob

R = 6378137.0
TILE = 256.0
M = 40.0            # margin in game metres around each tile in its photo
PPM = 2             # photo pixels per game metre
GROUND_M_PER_PX = 0.5   # NAIP block resolution, ground metres per pixel (native is ~0.6 m)
BLOCK_PX = 4000
RAWDIR = "data/raw/naip"

cfg = json.load(open("data/map_config.json"))
lat0, lon0 = cfg["origin"]["lat"], cfg["origin"]["lon"]
kx = 111320 * math.cos(math.radians(lat0)); ky = 110540
th = math.radians(cfg["rotationDegrees"]); _c, _s = math.cos(th), math.sin(th)
_B = cfg["box"]; cx, cy = (_B["xMin"] + _B["xMax"]) / 2, (_B["yMin"] + _B["yMax"]) / 2

def game_to_local(gx, gy):
    a, b = gx + cx, cy - gy
    return a * _c + b * _s, -a * _s + b * _c

def merc(x, y):
    lon = lon0 + x / kx; lat = lat0 + y / ky
    return R * math.radians(lon), R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))

def game_to_merc(gx, gy):
    return merc(*game_to_local(gx, gy))

# Block grid: mercator units per pixel, and the origin (top-left corner of block 0,0). Block (bi, bj) covers
# mercator x in [GX0 + bi*BLOCK*UPP, +BLOCK*UPP], y in [GY0 - (bj+1)*BLOCK*UPP, GY0 - bj*BLOCK*UPP]  (north up).
UPP = GROUND_M_PER_PX / math.cos(math.radians(lat0))
GX0, GY0 = -10400000.0, 5600000.0
BLOCK_SPAN = BLOCK_PX * UPP

def block_bbox(bi, bj):
    return (GX0 + bi * BLOCK_SPAN, GY0 - (bj + 1) * BLOCK_SPAN, GX0 + (bi + 1) * BLOCK_SPAN, GY0 - bj * BLOCK_SPAN)

def block_name(bi, bj):
    return f"b_{bi}_{bj}"

def tile_list(tiles_dir="data/city/tiles", need_buildings=True):
    out = []
    for f in glob.glob(tiles_dir + "/*.json"):
        b = os.path.basename(f)[:-5]
        tx, ty = map(int, b.split("_"))
        out.append((tx, ty, f))
    out.sort()
    return out

def tile_game_box(tx, ty, margin=M):
    return tx * TILE - margin, ty * TILE - margin, (tx + 1) * TILE + margin, (ty + 1) * TILE + margin

def tile_merc_bounds(tx, ty, pad_px=6):
    x0, y0, x1, y1 = tile_game_box(tx, ty)
    pts = [game_to_merc(x, y) for x in (x0, x1) for y in (y0, y1)]
    p = pad_px * UPP
    return min(q[0] for q in pts) - p, min(q[1] for q in pts) - p, max(q[0] for q in pts) + p, max(q[1] for q in pts) + p

def blocks_for_bounds(b):
    x0, y0, x1, y1 = b
    bi0, bi1 = math.floor((x0 - GX0) / BLOCK_SPAN), math.floor((x1 - GX0) / BLOCK_SPAN)
    bj0, bj1 = math.floor((GY0 - y1) / BLOCK_SPAN), math.floor((GY0 - y0) / BLOCK_SPAN)
    return [(i, j) for i in range(bi0, bi1 + 1) for j in range(bj0, bj1 + 1)]

def has_buildings(path):
    with open(path) as f:
        return len(json.load(f).get("buildings", [])) > 0
