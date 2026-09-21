#!/usr/bin/env python3
"""
City-wide USGS 3DEP LiDAR for Minneapolis, streamed tile by tile into 1 m surface / 2 m ground rasters.

  python3 tools/fetch_lidar_city.py plan     # which point-cloud files touch the city -> data/raw/lidar/plan.json (no download)
  python3 tools/fetch_lidar_city.py run      # download -> rasterise -> merge into blocks -> delete the .laz  (resumable)
  python3 tools/fetch_lidar_city.py status

Source: USGS National Map (TNM Access API index, files on rockyweb.usgs.gov), the same server and project family
(MN_CentralMissRiver_B22, 3DEP, public domain) that SwapCity used for downtown. Nothing else is downloaded.

PLAN. The city limit (data/city/city.json meta.boundary, game frame) is turned into lon/lat and UTM 15N. Every tile whose
nominal square touches the limit (grown by 25 m) is listed; the newest project wins where two overlap, older projects
(Minnesota 2011 Metro) are only used for ground the newer ones do not cover.

RUN. Per file: download to data/raw/lidar/laz/ (resumable with HTTP Range, retries), read all returns, drop class 7 (low
noise; class 18 is kept, USGS uses it as a height cap over tall downtowns), rasterise
  DSM 1 m : density-robust maximum height per cell, exactly the rule of SwapCity's tools/lidar.py: the highest return counts
            only if at least 35 % of the cell's returns (and 4) lie within 2.5 m below it, otherwise the next surface below;
            done per file in memory (a cell's returns all live in one tile, tiles are cut on the 1 m grid)
  DEM 2 m : mean of the ground (class 2) returns
merge into per-2 km block files (see tools/lib/lidar_common.py), record the file in blocks/index.json, delete the .laz.
The free-disk guard pauses the run whenever less than 8 GB would be free; at most 2 downloads at once (1 while the processor
is busy on a full queue), a pause between requests.
"""
import argparse, json, math, os, re, sys, threading, time, shutil, queue, urllib.request, urllib.parse, urllib.error
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))
import lidar_common as lc

LAZ_DIR = os.path.join(lc.LIDAR_DIR, 'laz')
PLAN = os.path.join(lc.LIDAR_DIR, 'plan.json')
INDEX = os.path.join(lc.BLOCK_DIR, 'index.json')
LOG = os.path.join(lc.LIDAR_DIR, 'fetch.log')
MIN_FREE_GB = 8.0
TNM = 'https://tnmaccess.nationalmap.gov/api/v1/products'
UA = 'SwapCityClassic/0.1 (personal hobby project; USGS 3DEP LiDAR)'
BUFFER_M = 25.0


def log(*a):
    s = time.strftime('%Y-%m-%d %H:%M:%S ') + ' '.join(str(x) for x in a)
    print(s, flush=True)
    try:
        with open(LOG, 'a') as f: f.write(s + '\n')
    except Exception: pass


def free_gb():
    st = shutil.disk_usage(lc.LIDAR_DIR)
    return st.free / 1e9


# ------------------------------------------------------------------------------------------------------------ plan
def http_json(url, tries=6):
    for a in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            return json.load(urllib.request.urlopen(req, timeout=120))
        except Exception as e:
            log('  index request failed, retrying:', str(e)[:80]); time.sleep(5 * (a + 1))
    raise SystemExit('TNM index not reachable')


def tnm_items(bbox):
    cache = os.path.join(lc.LIDAR_DIR, 'tnm_items_raw.json')
    if os.path.exists(cache): return json.load(open(cache))
    items, off = [], 0
    while True:
        q = urllib.parse.urlencode({'datasets': 'Lidar Point Cloud (LPC)', 'bbox': bbox, 'max': 100, 'offset': off})
        d = http_json(TNM + '?' + q)
        items += d['items']; off += 100
        if not d['items'] or off >= d['total']: break
        time.sleep(1)
    json.dump(items, open(cache, 'w'))
    return items


def project_of(url):
    return '/'.join(url.split('/Projects/')[1].split('/')[:2])


def nominal_rect(it):
    """UTM rectangle (e0, n0, e1, n1) that a file really covers: the tile square implied by its name (where the scheme is
    known) cut down to the file's own lon/lat bounding box from the index, because tiles at a project edge are partial
    slivers (a 500 m tile can hold a 50 m strip, and a neighbouring sub-project supplies the rest)"""
    u = it['downloadURL']; name = u.split('/')[-1]
    b = it['boundingBox']
    e0, n0 = lc.to_utm(b['minX'], b['minY']); e1, n1 = lc.to_utm(b['maxX'], b['maxY'])
    bb = (min(e0, e1) - 6, min(n0, n1) - 6, max(e0, e1) + 6, max(n0, n1) + 6)
    m = re.search(r'CentralMissRiver_B22_(\d{4,5})_(\d{5})\.laz$', name)
    nom = None
    if m: nom = (int(m[1]) * 100, int(m[2]) * 100, int(m[1]) * 100 + 500, int(m[2]) * 100 + 500)
    m = re.search(r'CentralMissRiver_B22_(\d{3})_(\d{4})\.laz$', name)   # 1 km tiles
    if m: nom = (int(m[1]) * 1000, int(m[2]) * 1000, int(m[1]) * 1000 + 1000, int(m[2]) * 1000 + 1000)
    if nom is None: return (bb[0] + 6, bb[1] + 6, bb[2] - 6, bb[3] - 6)
    return (max(nom[0], bb[0]), max(nom[1], bb[1]), min(nom[2], bb[2]), min(nom[3], bb[3]))


def year_of(proj):
    m = re.search(r'(20\d\d)', proj)
    return int(m[1]) if m else 2022   # B22 / B23 style names: FY22


def make_mask(poly, res=10.0, buf=BUFFER_M):
    from PIL import Image, ImageDraw
    e0, n0 = poly.min(axis=0) - 100; e1, n1 = poly.max(axis=0) + 100
    W = int((e1 - e0) / res) + 1; H = int((n1 - n0) / res) + 1
    im = Image.new('L', (W, H), 0); d = ImageDraw.Draw(im)
    pts = [((e - e0) / res, (n1 - n) / res) for e, n in poly]
    d.polygon(pts, fill=1)
    d.line(pts + [pts[0]], fill=1, width=int(2 * buf / res))
    return np.array(im, dtype=bool), e0, n1, res


def mask_cells_in_rect(mask, e0, n1, res, rect):
    r0 = int((n1 - rect[3]) / res); r1 = int(math.ceil((n1 - rect[1]) / res))
    c0 = int((rect[0] - e0) / res); c1 = int(math.ceil((rect[2] - e0) / res))
    r0 = max(r0, 0); c0 = max(c0, 0)
    return mask[r0:r1, c0:c1], (r0, c0)


def cmd_plan(args):
    os.makedirs(lc.LIDAR_DIR, exist_ok=True)
    poly = lc.city_boundary_utm()
    lon, lat = lc.from_utm(poly[:, 0], poly[:, 1])
    bbox = f'{min(lon):.4f},{min(lat):.4f},{max(lon):.4f},{max(lat):.4f}'
    log('city limit bbox lon/lat', bbox, ' UTM', poly.min(axis=0).round(), poly.max(axis=0).round())
    items = tnm_items(bbox)
    log('TNM lists', len(items), 'point-cloud files whose bbox meets the city bbox')
    mask, me0, mn1, res = make_mask(poly)
    by = {}
    for it in items:
        if not it.get('downloadURL'): continue
        p = project_of(it['downloadURL'])
        it['_proj'] = p; it['_rect'] = nominal_rect(it)
        by.setdefault(p, []).append(it)
    projects = sorted(by, key=lambda p: (-year_of(p), p))
    for p in projects: log(f'  project {p}: {len(by[p])} files, {sum(i["sizeInBytes"] for i in by[p]) / 1e9:.1f} GB (bbox hits)')
    # newest project first; an item is needed if its rect touches the (buffered) city and adds mask cells not yet covered
    covered = np.zeros_like(mask)
    chosen = []
    # project priority: 2022+ CentralMissRiver parts first (all of them), then older
    for p in projects:
        take = []
        for it in sorted(by[p], key=lambda i: i['_rect']):
            sub, (r0, c0) = mask_cells_in_rect(mask, me0, mn1, res, it['_rect'])
            if sub.size == 0 or not sub.any(): continue
            cov = covered[r0:r0 + sub.shape[0], c0:c0 + sub.shape[1]]
            new = sub & ~cov
            if not new.any(): continue           # every needed cell in it is already served by a newer tile
            take.append((it, sub, r0, c0))
        # mark the whole project as covering after choosing (tiles of the same project never exclude each other)
        for it, sub, r0, c0 in take:
            cov = covered[r0:r0 + sub.shape[0], c0:c0 + sub.shape[1]]
            cov |= sub
            chosen.append(it)
        log(f'  -> {len(take)} files from {p}')
    uncovered = int((mask & ~covered).sum())
    # de-dupe by file name
    seen, files = set(), []
    for it in chosen:
        name = it['downloadURL'].split('/')[-1]
        if name in seen: continue
        seen.add(name)
        e0, n0, e1, n1 = it['_rect']
        files.append({'name': name, 'url': it['downloadURL'], 'bytes': int(it['sizeInBytes']), 'project': it['_proj'],
                      'rect_utm': [round(x, 1) for x in (e0, n0, e1, n1)], 'published': it.get('publicationDate')})
    files.sort(key=lambda f: (f['rect_utm'][1], f['rect_utm'][0]))
    total = sum(f['bytes'] for f in files)
    perproj = {}
    for f in files:
        d = perproj.setdefault(f['project'], {'files': 0, 'bytes': 0}); d['files'] += 1; d['bytes'] += f['bytes']
    plan = {'generated': time.strftime('%Y-%m-%d %H:%M:%S'), 'source': 'USGS 3DEP LPC via TNM Access API + rockyweb.usgs.gov',
            'city_bbox_lonlat': bbox, 'buffer_m': BUFFER_M, 'files': len(files), 'total_bytes': total, 'total_gb': round(total / 1e9, 2),
            'projects': perproj, 'uncovered_mask_cells_10m': uncovered, 'uncovered_km2': round(uncovered * res * res / 1e6, 3),
            'city_mask_km2': round(int(mask.sum()) * res * res / 1e6, 1), 'items': files}
    json.dump(plan, open(PLAN, 'w'), indent=1)
    log(f'PLAN: {len(files)} files, {total / 1e9:.1f} GB -> {PLAN}')
    for p, d in perproj.items(): log(f'   {p}: {d["files"]} files, {d["bytes"] / 1e9:.1f} GB')
    log(f'   city area under the buffered limit {plan["city_mask_km2"]} km2, not covered by any listed file: {plan["uncovered_km2"]} km2')


# ------------------------------------------------------------------------------------------------------------ run
def download(url, dest, expect):
    """resumable download with retries; returns True when the file is complete"""
    part = dest + '.part'
    for attempt in range(8):
        have = os.path.getsize(part) if os.path.exists(part) else 0
        if have >= expect > 0: break
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA, **({'Range': f'bytes={have}-'} if have else {})})
            with urllib.request.urlopen(req, timeout=90) as r:
                if have and r.status != 206: have = 0     # server ignored the range: start over
                with open(part, 'ab' if have else 'wb') as f:
                    while True:
                        b = r.read(1 << 20)
                        if not b: break
                        f.write(b)
                        if free_gb() < MIN_FREE_GB - 1: raise RuntimeError('disk nearly full')
        except Exception as e:
            log(f'    download retry {attempt + 1} ({os.path.basename(dest)}): {str(e)[:90]}')
            time.sleep(min(60, 5 * (attempt + 1)))
            continue
        if os.path.getsize(part) >= expect > 0 or expect <= 0: break
    ok = os.path.exists(part) and (expect <= 0 or os.path.getsize(part) >= expect)
    if ok: os.replace(part, dest)
    return ok


def rasterise(path):
    """one LAZ -> { (i, j): (dsm_patch, dem_patch) } as dicts of full-block-sized sparse updates (we return arrays cut to bboxes)"""
    import laspy
    xs, ys, zs, cs = [], [], [], []
    with laspy.open(path) as rd:
        for pts in rd.chunk_iterator(4_000_000):
            c = np.asarray(pts.classification)
            keep = c != 7
            if not keep.any(): continue
            xs.append(np.asarray(pts.x)[keep].astype(np.float64)); ys.append(np.asarray(pts.y)[keep].astype(np.float64))
            zs.append(np.asarray(pts.z)[keep].astype(np.float32)); cs.append(c[keep].astype(np.uint8))
    x = np.concatenate(xs); y = np.concatenate(ys); z = np.concatenate(zs); c = np.concatenate(cs)
    del xs, ys, zs, cs
    npts = len(z)
    # the tile's extent on the 1 m grid (with the odd point outside the nominal square)
    cx = np.floor(x).astype(np.int64); cy = np.floor(y).astype(np.int64)
    ex0, ex1 = int(cx.min()), int(cx.max()) + 1; ny0, ny1 = int(cy.min()), int(cy.max()) + 1
    W = ex1 - ex0; H = ny1 - ny0
    idx = (cy - ny0) * W + (cx - ex0)          # cell index, row = northing from the SOUTH here
    del cx, cy
    dsm = np.full(W * H, -np.inf, dtype=np.float32)
    _fast_max(dsm, idx, z)
    top = (dsm[idx] - z) <= 2.5
    n_all = np.bincount(idx, minlength=W * H).astype(np.int32)
    n_top = np.bincount(idx[top], minlength=W * H).astype(np.int32)
    second = np.full(W * H, -np.inf, dtype=np.float32)
    lo = ~top
    if lo.any(): _fast_max(second, idx[lo], z[lo])
    supported = n_top >= np.maximum(4, (0.35 * n_all).astype(np.int32))
    out = np.where(supported, dsm, np.where(np.isfinite(second), second, -np.inf)).astype(np.float32)
    out[~np.isfinite(out)] = np.nan
    out = out.reshape(H, W)[::-1]                 # row 0 = north
    # ground, 2 m cells on the global 2 m grid
    g = c == 2
    d = None
    if g.any():
        gx = np.floor(x[g] / 2).astype(np.int64); gy = np.floor(y[g] / 2).astype(np.int64)
        dx0, dx1 = int(gx.min()), int(gx.max()) + 1; dy0, dy1 = int(gy.min()), int(gy.max()) + 1
        gw = dx1 - dx0; gh = dy1 - dy0
        gi = (gy - dy0) * gw + (gx - dx0)
        cnt = np.bincount(gi, minlength=gw * gh); sm = np.bincount(gi, weights=z[g].astype(np.float64), minlength=gw * gh)
        with np.errstate(all='ignore'): dm = (sm / cnt).astype(np.float32)
        dm[cnt == 0] = np.nan
        d = (dm.reshape(gh, gw)[::-1], dx0, dy1)  # row 0 = north; dy1 = northing cell index (2 m) just above the top row
    return {'dsm': out, 'x0': ex0, 'ny1': ny1, 'dem': d, 'points': npts, 'ground': int(g.sum())}


def _fast_max(acc, idx, z):
    """acc[idx] = max(acc[idx], z), for big arrays: sort by (cell, z) and take the last of each cell (np.maximum.at is slow)"""
    order = np.lexsort((z, idx))
    si = idx[order]; sz = z[order]
    last = np.r_[si[1:] != si[:-1], True]
    ci = si[last]; cz = sz[last]
    acc[ci] = np.maximum(acc[ci], cz)


def merge(res, name):
    """paste one rasterised tile into the block files (max for the DSM where two tiles meet, unweighted mean for the DEM)"""
    os.makedirs(lc.BLOCK_DIR, exist_ok=True)
    touched = []
    dsm = res['dsm']; H, W = dsm.shape; x0 = res['x0']; n1 = res['ny1']    # cell columns / rows: easting x0.., northing n1 - row
    per = lc.BLOCK
    for i in range(x0 // per, (x0 + W - 1) // per + 1):
        for j in range((n1 - H) // per, (n1 - 1) // per + 1):
            bp = os.path.join(lc.BLOCK_DIR, f'{i}_{j}.dsm.npy'); dp = os.path.join(lc.BLOCK_DIR, f'{i}_{j}.dem.npy')
            bd = np.load(bp) if os.path.exists(bp) else np.full((per, per), np.nan, dtype=np.float32)
            bm = np.load(dp) if os.path.exists(dp) else np.full((per // 2, per // 2), np.nan, dtype=np.float32)
            a0 = max(x0, i * per); a1 = min(x0 + W, (i + 1) * per)
            b0 = max(n1 - H, j * per); b1 = min(n1, (j + 1) * per)           # northing cells [b0, b1)
            if a1 > a0 and b1 > b0:
                sub = dsm[n1 - b1:n1 - b0, a0 - x0:a1 - x0]
                tgt = bd[(j + 1) * per - b1:(j + 1) * per - b0, a0 - i * per:a1 - i * per]
                with np.errstate(all='ignore'): tgt[:] = np.fmax(tgt, sub)        # fmax ignores NaN
            if res['dem'] is not None:
                dm, dx0, dy1 = res['dem']; dh, dw = dm.shape
                h = per // 2
                a0 = max(dx0, i * h); a1 = min(dx0 + dw, (i + 1) * h)
                b0 = max(dy1 - dh, j * h); b1 = min(dy1, (j + 1) * h)
                if a1 > a0 and b1 > b0:
                    sub = dm[dy1 - b1:dy1 - b0, a0 - dx0:a1 - dx0]
                    tgt = bm[(j + 1) * h - b1:(j + 1) * h - b0, a0 - i * h:a1 - i * h]
                    with np.errstate(all='ignore'): tgt[:] = np.where(np.isnan(tgt), sub, np.where(np.isnan(sub), tgt, (tgt + sub) / 2))
            np.save(bp + '.tmp.npy', bd); os.replace(bp + '.tmp.npy', bp)
            np.save(dp + '.tmp.npy', bm); os.replace(dp + '.tmp.npy', dp)
            touched.append(f'{i}_{j}')
    return touched


def load_index():
    if os.path.exists(INDEX): return json.load(open(INDEX))
    return {'grid': lc.BLOCK, 'cell': lc.CELL, 'dem_cell': lc.DEM_CELL, 'epsg': lc.EPSG,
            'note': 'block (i, j) = UTM easting [i*2000, (i+1)*2000) x northing [j*2000, (j+1)*2000); row 0 = north', 'done': {}, 'blocks': {}}


def save_index(ix):
    os.makedirs(lc.BLOCK_DIR, exist_ok=True)
    with open(INDEX + '.tmp', 'w') as f: json.dump(ix, f, indent=1)
    os.replace(INDEX + '.tmp', INDEX)


def tall_first(todo):
    """names of the files (from todo) holding buildings whose OSM height / levels say >= 24 m, ordered round-robin over 1500 m game cells"""
    import glob
    seen = {}
    for f in glob.glob(os.path.join(lc.ROOT, 'data/city/tiles/*.json')):
        for b in json.load(open(f)).get('buildings', []):
            if b['id'] in seen or b.get('heightSource') not in ('height', 'levels') or b['height'] < 24: continue
            p = np.array(b['points']); seen[b['id']] = (p[:, 0].mean(), p[:, 1].mean())
    a = np.array(list(seen.values()))
    e, n = lc.GameToUtm(lc.load_frame())(a[:, 0], a[:, 1]); e = np.asarray(e); n = np.asarray(n)
    per = {}
    for it in todo:
        r = it['rect_utm']; m = (e >= r[0]) & (e < r[2]) & (n >= r[1]) & (n < r[3])
        if m.any(): per[it['name']] = (int(m.sum()), (int(a[m, 0].mean() // 1500), int(a[m, 1].mean() // 1500)))
    bycell = {}
    for name, (c, cell) in per.items(): bycell.setdefault(cell, []).append((-c, name))
    out, rnd = [], 0
    lists = {k: sorted(v) for k, v in bycell.items()}
    while any(len(v) > rnd for v in lists.values()):
        for k in sorted(lists): 
            if len(lists[k]) > rnd: out.append(lists[k][rnd][1])
        rnd += 1
    return out


def cmd_run(args):
    if not os.path.exists(PLAN): cmd_plan(args)
    plan = json.load(open(PLAN))
    os.makedirs(LAZ_DIR, exist_ok=True); os.makedirs(lc.BLOCK_DIR, exist_ok=True)
    ix = load_index()
    todo = [f for f in plan['items'] if f['name'] not in ix['done']]
    # nearest the downtown origin first (so partial results are useful early); files that SwapCity already downloaded
    # for downtown (read-only, byte-identical) are rasterised in place, not downloaded again
    oe, on = lc.to_utm(lc.load_frame().lon0, lc.load_frame().lat0)
    dist = lambda f: math.hypot((f['rect_utm'][0] + f['rect_utm'][2]) / 2 - oe, (f['rect_utm'][1] + f['rect_utm'][3]) / 2 - on)
    todo.sort(key=dist)
    # then files that hold OSM-tagged tall buildings (>= 24 m) come first, spread over the city (each 1500 m cell's best file first,
    # then each cell's second ...), so the roof-lean of every region can be measured early; the rest follows nearest-first
    try:
        first = tall_first(todo)
        rank = {n: k for k, n in enumerate(first)}
        todo.sort(key=lambda f: (rank.get(f['name'], 1 << 30), dist(f)))
        log(f'{len(first)} files with tall OSM buildings are fetched first')
    except Exception as e:
        log('  (tall-first ordering skipped:', str(e)[:80] + ')')
    local = {}
    if args.local_dir and os.path.isdir(args.local_dir):
        for f in todo:
            lp = os.path.join(args.local_dir, f['name'])
            if os.path.exists(lp) and os.path.getsize(lp) == f['bytes']: local[f['name']] = lp
    log(f'{len(local)} files are already on disk in {args.local_dir} (used in place, not copied or deleted)')
    if args.limit: todo = todo[:args.limit]
    log(f'run: {len(todo)} files to do of {len(plan["items"])}; done {len(ix["done"])}')
    t0 = time.time(); gb_done = 0.0
    q = queue.Queue(maxsize=3)       # downloaded files waiting to be processed (bounds disk use to ~5 files)
    lock = threading.Lock(); pending = list(reversed([f for f in todo if f['name'] not in local])); stop = threading.Event()

    def wait_for_space(need_gb):
        while free_gb() - need_gb < MIN_FREE_GB:
            log(f'  free disk {free_gb():.1f} GB, need to stay above {MIN_FREE_GB} GB: pausing 60 s')
            time.sleep(60)
            if stop.is_set(): return

    def downloader():
        while not stop.is_set():
            with lock:
                if not pending: return
                f = pending.pop()
            dest = os.path.join(LAZ_DIR, f['name'])
            wait_for_space(f['bytes'] / 1e9 + 0.3)
            if not os.path.exists(dest):
                t = time.time()
                ok = download(f['url'], dest, f['bytes'])
                if not ok:
                    log(f'  FAILED download {f["name"]}, will be retried on the next run'); continue
                log(f'  downloaded {f["name"]} {f["bytes"] / 1e6:.0f} MB in {time.time() - t:.0f} s')
            q.put(f)
            time.sleep(1.0)          # be polite

    n_dl = 2
    threads = [threading.Thread(target=downloader, daemon=True) for _ in range(n_dl)]
    for t in threads: t.start()
    processed = 0
    local_todo = [f for f in todo if f['name'] in local]

    def process(f, path, delete):
        nonlocal processed, gb_done
        t = time.time()
        try:
            res = rasterise(path)
            touched = merge(res, f['name'])
        except Exception as e:
            log(f'  PROCESS ERROR {f["name"]}: {e.__class__.__name__} {str(e)[:120]} (file kept)')
            import traceback; traceback.print_exc()
            return
        ix['done'][f['name']] = {'points': res['points'], 'ground': res['ground'], 'bytes': f['bytes'], 'blocks': touched,
                                 'project': f['project'], 'source': 'downloaded' if delete else 'local'}
        for b in touched:
            d = ix['blocks'].setdefault(b, {'files': []}); d['files'].append(f['name'])
        save_index(ix)
        if delete: os.remove(path)          # merged -> the raw file is not needed any more
        processed += 1
        if delete: gb_done += f['bytes'] / 1e9
        el = time.time() - t0
        eta = (len(todo) - processed) * el / processed
        log(f'  [{processed}/{len(todo)}] {f["name"]}: {res["points"] / 1e6:.1f} M pts ({res["ground"] / 1e6:.1f} M ground), processed in {time.time() - t:.0f} s'
            f'{" (local file)" if not delete else ""}; {gb_done:.1f} GB downloaded, free {free_gb():.1f} GB, elapsed {el / 60:.0f} min')

    while True:
        if local_todo:                       # rasterise the files that are already on disk while the downloads run
            f = local_todo.pop(0); process(f, local[f['name']], False); continue
        try: f = q.get(timeout=5)
        except queue.Empty:
            if not any(t.is_alive() for t in threads) and q.empty(): break
            continue
        process(f, os.path.join(LAZ_DIR, f['name']), True)
    log('run finished:', processed, 'files processed;', len(ix['done']), 'done in total')


def cmd_status(args):
    plan = json.load(open(PLAN)); ix = load_index()
    done = ix['done']
    left = [f for f in plan['items'] if f['name'] not in done]
    log(f'{len(done)} of {len(plan["items"])} files done ({sum(d["bytes"] for d in done.values()) / 1e9:.1f} of {plan["total_gb"]} GB); '
        f'{len(left)} left ({sum(f["bytes"] for f in left) / 1e9:.1f} GB); free disk {free_gb():.1f} GB')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', nargs='?', default='run', choices=['plan', 'run', 'status'])
    ap.add_argument('--local-dir', default=os.path.expanduser('~/Projects/SwapCity/data/minneapolis/laz'), help='run: folder of already-downloaded files of the same project, read in place')
    ap.add_argument('--limit', type=int, default=0, help='run: only the first N files (testing)')
    a = ap.parse_args()
    {'plan': cmd_plan, 'run': cmd_run, 'status': cmd_status}[a.cmd](a)
