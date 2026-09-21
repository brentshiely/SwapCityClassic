#!/usr/bin/env python3
"""
Aerial photo for the roofs of the offline look. Downloads USDA NAIP (public domain; a US Government work) for the map area from
the USGS National Map image service, then turns it into the game's own frame (metres, x right, y down, streets straight) so a
roof can be cut out with its footprint polygon.

  python3 tools/bake_naip.py            # fetch (once, cached in data/raw/) and bake
  python3 tools/bake_naip.py --refetch

Writes data/roofs_naip.jpg and data/roofs_naip.json ({minX, minY, maxX, maxY, ppm}). No Google data is used.
The offline game does not need the internet: only this tool does.
"""
import argparse, json, math, os, urllib.request
from PIL import Image, ImageEnhance

R = 6378137.0
SERVER = "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage"
ap = argparse.ArgumentParser()
ap.add_argument("--refetch", action="store_true")
ap.add_argument("--ppm", type=float, default=3.0, help="pixels per metre of the baked roof photo")
ap.add_argument("--margin", type=float, default=150.0, help="metres beyond the playable world (the map also draws scenery there)")
args = ap.parse_args()

cfg = json.load(open("data/map_config.json"))
world = json.load(open("data/map.json"))["meta"]["world"]
lat0, lon0 = cfg["origin"]["lat"], cfg["origin"]["lon"]
kx = 111320 * math.cos(math.radians(lat0)); ky = 110540   # the same as tools/bake_map.mjs
th = math.radians(cfg["rotationDegrees"]); c, s = math.cos(th), math.sin(th)
B = cfg["box"]; cx, cy = (B["xMin"] + B["xMax"]) / 2, (B["yMin"] + B["yMax"]) / 2

def game_to_local(gx, gy):           # inverse of toGame in bake_map.mjs: local metres east (x), north (y) of the origin
    a, b = gx + cx, cy - gy          # a = x cos - y sin, b = x sin + y cos
    return a * c + b * s, -a * s + b * c

def merc(x, y):                      # local metres -> web mercator, linearised around the origin (fine over a kilometre)
    k = R * math.pi / 180.0
    lon = lon0 + x / kx; lat = lat0 + y / ky
    return R * math.radians(lon), R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))

minX, minY, maxX, maxY = world["minX"] - args.margin, world["minY"] - args.margin, world["maxX"] + args.margin, world["maxY"] + args.margin
pts = [merc(*game_to_local(x, y)) for x in (minX, maxX) for y in (minY, maxY)]
pad = 20
X0, X1 = min(p[0] for p in pts) - pad, max(p[0] for p in pts) + pad
Y0, Y1 = min(p[1] for p in pts) - pad, max(p[1] for p in pts) + pad
UPP = 0.3 / math.cos(math.radians(lat0)) * 1.0          # mercator units per pixel (0.3 m on the ground)
W, H = int(math.ceil((X1 - X0) / UPP)), int(math.ceil((Y1 - Y0) / UPP))
X1, Y0 = X0 + W * UPP, Y1 - H * UPP
raw = "data/raw/naip_mercator.jpg"
if args.refetch or not os.path.exists(raw):
    print(f"fetching NAIP {W}x{H} px ...")
    q = f"?bbox={X0},{Y0},{X1},{Y1}&bboxSR=3857&imageSR=3857&size={W},{H}&format=jpg&interpolation=RSP_BilinearInterpolation&f=json"
    req = urllib.request.Request(SERVER + q, headers={"User-Agent": "SwapCityClassic/1.0 (offline game build tool)"})
    meta = json.loads(urllib.request.urlopen(req, timeout=180).read())
    if "href" not in meta: raise SystemExit(f"server said: {meta}")
    open(raw, "wb").write(urllib.request.urlopen(urllib.request.Request(meta["href"], headers={"User-Agent": "SwapCityClassic/1.0"}), timeout=180).read())
    json.dump({"bbox3857": [X0, Y0, X1, Y1], "size": [W, H], "source": "USDA NAIP via USGS National Map ImageServer"}, open("data/raw/naip_mercator.json", "w"))
src = Image.open(raw).convert("RGB")
print("source", src.size)

# output pixel (i, j) -> game metres -> mercator -> source pixel: an affine map, so one PIL transform does it
ppm = args.ppm
OW, OH = int(round((maxX - minX) * ppm)), int(round((maxY - minY) * ppm))
def src_px(i, j):
    mx, my = merc(*game_to_local(minX + (i + 0.5) / ppm, minY + (j + 0.5) / ppm))
    return (mx - X0) / UPP * (src.size[0] / W), (Y1 - my) / UPP * (src.size[1] / H)
p00, p10, p01 = src_px(0, 0), src_px(1, 0), src_px(0, 1)
coef = (p10[0] - p00[0], p01[0] - p00[0], p00[0], p10[1] - p00[1], p01[1] - p00[1], p00[1])
out = src.transform((OW, OH), Image.AFFINE, coef, resample=Image.BICUBIC)
out = ImageEnhance.Contrast(out).enhance(1.10)
out = ImageEnhance.Color(out).enhance(0.95)
out.save("data/roofs_naip.jpg", "JPEG", quality=88, subsampling=0)
json.dump({"minX": minX, "minY": minY, "maxX": maxX, "maxY": maxY, "ppm": ppm, "width": OW, "height": OH,
           "attribution": "Aerial imagery: USDA NAIP (public domain)"}, open("data/roofs_naip.json", "w"), indent=1)
print(f"wrote data/roofs_naip.jpg {OW}x{OH} ({os.path.getsize('data/roofs_naip.jpg') / 1e6:.1f} MB)")
