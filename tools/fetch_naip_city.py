#!/usr/bin/env python3
"""
Download USDA NAIP (public domain) for the whole city, as north-up web-mercator JPEG blocks (4000x4000 px, ~0.5 m per ground pixel),
into data/raw/naip/ (gitignored) + data/raw/naip/index.json. Only blocks that some tile of data/city/tiles/ (plus its 40 m photo margin)
touches are fetched. Same server and request as tools/bake_naip.py (USGS National Map ImageServer, EPSG:3857). No Google data.

  python3 tools/fetch_naip_city.py          # resumable: existing blocks are skipped

Blocks share one pixel grid (see tools/lib/naip_common.py), so tools/bake_roof_tiles.py can join them without seams.
Progress is logged to data/raw/naip/fetch.log. Blocks that come back blank (no NAIP there) are kept but flagged "blank" in the index.
"""
import json, os, sys, time, urllib.request, urllib.error
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from naip_common import *
import numpy as np
from PIL import Image

SERVER = "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage"
UA = {"User-Agent": "SwapCityClassic/1.0 (offline game build tool)"}
os.makedirs(RAWDIR, exist_ok=True)
INDEX = f"{RAWDIR}/index.json"
LOG = open(f"{RAWDIR}/fetch.log", "a")

def log(*a):
    s = time.strftime("%H:%M:%S ") + " ".join(str(x) for x in a)
    print(s, flush=True); LOG.write(s + "\n"); LOG.flush()

def load_index():
    if os.path.exists(INDEX):
        return json.load(open(INDEX))
    return {"source": "USDA NAIP via USGS National Map ImageServer", "blockPx": BLOCK_PX, "mercatorPerPx": UPP, "origin3857": [GX0, GY0], "blocks": {}}

def save_index(ix):
    json.dump(ix, open(INDEX + ".tmp", "w"), indent=1); os.replace(INDEX + ".tmp", INDEX)

def http(url, timeout):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read()

def fetch_block(bi, bj):
    x0, y0, x1, y1 = block_bbox(bi, bj)
    q = (f"?bbox={x0},{y0},{x1},{y1}&bboxSR=3857&imageSR=3857&size={BLOCK_PX},{BLOCK_PX}&format=jpg&compressionQuality=90"
         f"&interpolation=RSP_BilinearInterpolation&f=json")
    delay = 5
    for attempt in range(8):
        try:
            meta = json.loads(http(SERVER + q, 240))
            if "href" not in meta: raise RuntimeError(f"server said: {str(meta)[:300]}")
            data = http(meta["href"], 300)
            if len(data) < 10000: raise RuntimeError(f"tiny reply ({len(data)} bytes)")
            return data
        except Exception as e:
            log(f"  block {bi},{bj} attempt {attempt + 1} failed: {e!r}; waiting {delay}s")
            time.sleep(delay); delay = min(delay * 2, 120)
    return None

def blank_fraction(path):
    a = np.asarray(Image.open(path).convert("RGB"))[::4, ::4]
    mx, mn = a.max(axis=2), a.min(axis=2)
    return float(((mx <= 2) | (mn >= 253)).mean())

def main():
    tiles = tile_list()
    need = set()
    for tx, ty, f in tiles:
        need.update(blocks_for_bounds(tile_merc_bounds(tx, ty)))
    need = sorted(need)
    ix = load_index()
    log(f"{len(tiles)} tile files need {len(need)} blocks; {len(ix['blocks'])} already indexed")
    got = 0; mb = 0.0; t0 = time.time()
    for n, (bi, bj) in enumerate(need):
        name = block_name(bi, bj); path = f"{RAWDIR}/{name}.jpg"
        if name in ix["blocks"] and os.path.exists(path):
            continue
        t1 = time.time()
        data = fetch_block(bi, bj)
        if data is None:
            log(f"  block {name} GAVE UP; rerun to retry"); continue
        open(path + ".tmp", "wb").write(data); os.replace(path + ".tmp", path)
        bf = blank_fraction(path)
        ix["blocks"][name] = {"bi": bi, "bj": bj, "bbox3857": list(block_bbox(bi, bj)), "size": [BLOCK_PX, BLOCK_PX], "bytes": len(data),
                              "blankFraction": round(bf, 4), "blank": bf > 0.5, "partlyBlank": 0.02 < bf <= 0.5}
        save_index(ix)
        got += 1; mb += len(data) / 1e6
        flag = " BLANK" if bf > 0.5 else (" partly blank" if bf > 0.02 else "")
        log(f"[{n + 1}/{len(need)}] {name} {len(data) / 1e6:.1f} MB in {time.time() - t1:.0f}s, blank {bf:.3f}{flag}")
        time.sleep(1.5)
    left = [b for b in need if block_name(*b) not in ix["blocks"]]
    log(f"done: fetched {got} blocks ({mb:.0f} MB) in {time.time() - t0:.0f}s; {len(need) - len(left)}/{len(need)} blocks present; missing: {left}")
    return 1 if left else 0

if __name__ == "__main__":
    sys.exit(main())
