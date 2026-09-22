# Whole-city data format (Minneapolis)

Same game frame as data/map.json: metres, x right, y down, origin at the centre of the downtown 3x3-block box, rotated 30 degrees
(see tools/bake_map.mjs `toGame`, data/map_config.json). Downtown data stays valid as it is. Coordinates rounded to 0.1 m.

Tile size T = 256 m. A point (x, y) is in tile (floor(x / T), floor(y / T)). Tile indices can be negative.

## data/city/city.json  (loaded whole at start; a few MB)
{
  meta: { name, origin, rotationDegrees, tileSize: 256, generated, attribution: '(c) OpenStreetMap contributors (ODbL)',
          world: { minX, minY, maxX, maxY },           // bounding box of the city limit, metres
          tiles: { minTx, minTy, maxTx, maxTy },       // tile index bounds
          boundary: [[x, y], ...] },                    // the city limit polygon (outer ring of Minneapolis), game metres, wound like buildings
  roads:  [ same objects as map.roads ],                // every drivable road (and service roads/alleys) inside the boundary, clipped 60 m past it
  graph:  { nodes: [...], edges: [...] }                // same shape as map.graph; node.boundary = true where a road leaves the city limit
}

## data/city/tiles/{tx}_{ty}.json  (streamed per tile)
{ tx, ty, buildings: [ same as map.buildings (id, name, type, height, heightSource, points, optional parts/levels/material/colour) ],
  areas: [ same as map.areas ], walkways: [ same as map.walkways ], crossings: [ same as map.crossings ], skyways: [ same as map.skyways ] }
A feature is written into EVERY tile its bounding box touches (the engine de-duplicates by id). Empty tiles are omitted.

Heights: data/heights_lidar.json + data/parts_lidar.json (by OSM id) where present (downtown), else OSM height, else levels * 3.4 + 2,
else a default by building type. More LiDAR later fills the same two files.

## Status

Built 2026-09-21. `npm run fetch-city` (tools/fetch_city_osm.mjs) then `npm run bake-city` (tools/bake_city.mjs); the rules shared with the
downtown bake live in tools/lib/bake_common.mjs, and `npm run bake` (data/map.json) is unchanged, byte for byte apart from its timestamp.

Real numbers (OSM as of 2026-09-21):
- Fetch: city limit = relation 136712 (Minneapolis, MN), 537 points. 49 chunks of about 2 km (9 x 6 grid, only chunks within 120 m of the limit), 108 MB of raw JSON in
  data/raw/city/ (only the tags the bake reads are kept). Resumable; ~2 hours because overpass-api.de kept answering 504/429 and refused connections for a while (the script then uses overpass.kumi.systems, about 3 min per chunk).
- data/city/city.json 9.8 MB (not "a few MB": 16,762 road pieces and the graph geometry). 2,581 non-empty tiles, 45.5 MB in total, biggest tile 47 KB, 18 KB on average.
- World (city limit box) 16,631 x 17,493 m, x -7385..9247, y -7484..10008; tile bounds x -29..36, y -30..39.
- Roads: 16,762 drawn pieces (from 20,869 drivable ways). Buildings: 162,066 kept of 196,303 (the rest lie wholly outside the limit); 180,740 tile entries.
  Walkways 37,805, crossings 17,418, ground areas 6,540, skyway spans 122 (121 unique ids).
- Graph: 11,721 nodes (953 signals, 1,455 stops, 289 boundary), 17,263 edges (4,650 one-way; layers 0:16,699, 1:453, 2:45, 3:1, -1:65). 27 connected pieces: the main one has 11,635 nodes (99.3%), the rest are 13, 6, 4 ... (parking loops, cut-off stubs).
- Heights: 630 from LiDAR (downtown), 24 OSM height, 4,681 from levels, 156,731 guessed (14 + hash * 26 m by type). Nearly the whole city still needs LiDAR.
- Bake: 1.8 s, peak memory about 0.5 GB (the npm script passes `--max-old-space-size=8192` to be safe).

Checked against data/map.json inside its world box (-219.5..219.5 x -211.5..211.5): buildings 50 = 50, walkways 91 = 91, ground areas 9 = 9, skyways 23 = 23, crossings 50 = 50, road ways 35 = 35,
with the same ids. The 22 interior graph nodes are identical (same coordinates, signal and stop flags). The old map has 15 more graph nodes there only because it cuts the graph at its box edge. No NaN; every tile parses and every feature sits in the tiles its bounding box touches.

Deviations and things the engine must know:
- The traffic graph and the drawn roads use the SAME clip: the city polygon grown by 60 m (`meta.roadMargin`). `boundary: true` nodes are where a road leaves that region, i.e. about 60 m outside the city limit, not on the limit itself
  (so a road that runs along the limit, like 37th Ave NE, stays whole instead of breaking into fragments with a barricade every few metres). Put barricades at those nodes; the limit itself is `meta.boundary`.
- A drivable way that leaves and re-enters the region comes out as several road pieces with the same `id` (rare, e.g. across the river); edges likewise carry the same `wayId`. De-duplicate by id only for tile features (buildings, areas, walkways, skyways), not roads.
- Graph nodes are only junctions/road ends, as in the downtown bake; edges keep the full polyline. Service roads are drawn in `roads` but, as before, are not in the graph.
- Building filter: any vertex inside the limit or within 1.5 m of it. Walkways and areas are kept if any vertex is in the limit + 60 m. Multipolygon buildings/parks (relations) are not fetched, as in the downtown bake.
- `meta` has extra fields beyond the spec: `source`, `frame`, `roadMargin`. `meta.tiles` is the tile range of the city limit box (the non-empty tiles are a subset).
- Skyways clipped against building footprints, as before (downtown only in practice). Crossings are stored in the tile their point is in.

## Roof photos

`data/city/tiles/{tx}_{ty}.jpg` is the aerial photo (USDA NAIP, public domain, via the USGS National Map ImageServer) of tile (tx, ty) in the
game frame, written next to the tile JSON for every tile that has at least one building. `data/city/roofs.json` holds
`{ ppm: 2, margin: 40, tileSize: 256, source }`. Tiles without buildings have no jpg (the loader must treat a missing jpg as "no roofs").

Extent: game metres x in [tx*256 - 40, (tx+1)*256 + 40], y in [ty*256 - 40, (ty+1)*256 + 40], i.e. the tile plus a 40 m margin (a leaning
roof can be cut from beside its footprint). Size (256 + 2*40) * 2 = 672 x 672 px, 2 px per game metre, JPEG q80 (4:2:0), Contrast 1.10 / Color 0.95
as `data/roofs_naip.jpg`. Pixel (i, j), i to the right, j down, covers the square whose centre is
`x = tx*256 - 40 + (i + 0.5)/2`, `y = ty*256 - 40 + (j + 0.5)/2` (game metres, x right, y down); pixel corner (0, 0) is exactly (tx*256 - 40, ty*256 - 40).
The frame is rotated 30 degrees against north: the photo is resampled (bicubic) so downtown streets are straight; elsewhere streets are tilted.
Like NAIP itself the photo is straightened to the ground, so a tall roof appears shifted away from its footprint (see "Roof photos" in the README).

Build: `npm run fetch-naip-city` (tools/fetch_naip_city.py) downloads north-up mercator blocks (4000 x 4000 px, 0.5 m per ground pixel, all on one pixel grid, origin
(-10400000, 5600000) EPSG:3857, mercator 0.70681 per px) to `data/raw/naip/` (gitignored) with `index.json` (bbox3857 per block, blank flags) and
`fetch.log`; resumable. `npm run bake-roof-tiles` (tools/bake_roof_tiles.py) cuts the tile photos (same game -> lon/lat -> mercator maths as
tools/bake_naip.py, shared in tools/lib/naip_common.py; blocks are joined on the common pixel grid, so tiles across block edges have no seams); resumable
(`--force` to redo), writes `data/raw/naip/bake_report.json`.

Real numbers (NAIP as served 2026-09-21): 61 blocks, 257 MB downloaded (245 MB on disk), none blank, in 20 min (one request at a time, 1.5 s pause).
2,222 tiles photographed (of 2,581 non-empty tiles; the other 359 have no buildings), 206.7 MB in total, 50 to 108 KB per tile (median 96 KB), baked in 18 s
with 7 processes. No tile lacks coverage. Downtown check against `data/roofs_naip.jpg`: position agrees to within 0.1 m (phase correlation), mean absolute
pixel difference 2.6 to 3.7 of 255 (different resolution, 0.3 vs 0.5 m/px).

## LiDAR heights, stepped blocks and roof lean (whole city)

Source: USGS 3DEP point clouds of project MN_CentralMissRiver_B22 (acquired 2022, published 2023-24, public domain), the same project SwapCity used for
downtown, so downtown numbers stay consistent. Index: the National Map Access API (`tnmaccess.nationalmap.gov`), files on `rockyweb.usgs.gov`.
Nothing else is downloaded. The point clouds are 500 m tiles in UTM zone 15N (EPSG:26915, NAD83(2011), heights NAVD88 metres), ~100 MB each.

Pipeline (each step resumable; big intermediates in `data/raw/lidar/`, gitignored):

1. `npm run fetch-lidar-city` (tools/fetch_lidar_city.py; `plan` writes `data/raw/lidar/plan.json` without downloading, `run` streams, `status` reports).
   Per file: download (2 at a time, resumable, retries) -> read every return (class 7 low noise dropped) -> 1 m DSM = density-robust maximum (the max counts only if
   at least 35 % of the cell's returns lie within 2.5 m below it, else the surface below; the rule of SwapCity's lidar.py) and 2 m DEM = mean of class-2 ground
   returns -> merged into 2 km block files -> the .laz is deleted. Free-disk guard: never below 8 GB. Log `data/raw/lidar/fetch.log`.
   Block files `data/raw/lidar/blocks/{i}_{j}.dsm.npy` (float32 [2000, 2000], 1 m cells) and `.dem.npy` (float32 [1000, 1000], 2 m cells); block (i, j) =
   UTM easting [i*2000, (i+1)*2000) x northing [j*2000, (j+1)*2000), row 0 = north edge, column 0 = west edge, heights above the NAVD88 datum (not above ground),
   NaN = no return. `blocks/index.json` lists the files done and the blocks each touched. Shared helpers (game <-> UTM, mosaic reader): tools/lib/lidar_common.py.
2. `npm run lidar-heights-city` (tools/lidar_heights_city.py) reads every building of `data/city/tiles/*.json` (deduplicated by id) and writes
   - `data/heights_lidar_city.json` `{ source, buildings: { "<osm id>": { h, p50, max, n } } }`: exactly the schema and rules of `data/heights_lidar.json`
     (h = 90th percentile of surface minus ground over the footprint cells at least 1 m inside the edge, p50 the median, max the top, n the cell count; ground = the DEM with
     holes under buildings filled by a pyramid fill). A building with no return over its footprint gets no entry.
   - `data/parts_lidar_city.json` `{ source, parts: { "<osm id>": [ { poly: [[x, y]...], base, top } ] } }` in the game frame, exactly like `parts_lidar.json`
     (base + towers by roof plateaus; only where p90 - median > 12 m and n >= 150).
   - `data/raw/lidar/heights_city_report.json`: statistics (coverage, distribution, validation against OSM tags).
   Only buildings whose whole footprint lies inside merged files are measured, so a half-finished download never produces a wrong height.
   The downtown script `tools/lidar_heights.py` is unchanged in behaviour (its outputs are byte-identical; the stepped-building split moved into a shared function
   `split_stepped_poly` and the file gained a `__main__` guard so it can be imported).
3. `node tools/bake_city.mjs` uses `data/heights_lidar_city.json` + `data/parts_lidar_city.json` when present: for every id they contain the city files win (heights and blocks); the
   downtown files only fill ids the city files lack (or everything if the city files are absent). The bake no longer deletes `data/city/tiles/*.jpg` and `roofs.json`, only the old tile JSON.
4. `npm run roof-lean-city` (tools/roof_lean_city.py) writes `data/roof_lean_city.json`:
   `{ "cell": 1500, "lean": { "i_j": [ax, ay], ... }, "fallback": [ax, ay], ... }`. Cell (i, j) = (floor(x / 1500), floor(y / 1500)) in game metres. A roof of height h whose footprint
   is at p is drawn at `p + h * (ax, ay)` in the tile photo (game metres, x right, y down; same convention as `data/roof_offsets.json`). Cells not listed use `fallback`.
   Extra keys (`cells_info`: towers per cell and spread, `min_h`, `towers_used`) are informational. Method: for every building of 25 m or more, the LiDAR roof edges (true position, cut in the
   game frame at 2 px/m) are cross-correlated (normalised, FFT) with the edges of the tile's NAIP photo over all shifts up to +-max(8 m, 30 % of the height); clear peaks only
   (correlation >= 0.25 and 0.04 above the best peak more than 4 m away); lean = shift / height; per cell the median, or the median of the 3x3 neighbourhood if the cell has
   fewer than 5 towers, else the city-wide median. Montage checks: `python3 tools/roof_lean_city.py --montage` writes crops to /tmp/sc/lean_{i}_{j}.png (yellow = footprint, red = footprint shifted by h * lean).

## Water

`data/city/water.json` (249 KB, whole file loaded at start) holds the water bodies of Minneapolis as polygons in the game frame (same `toGame` as everything else):

    { meta: { generated, count, areaKm2, source: '(c) OpenStreetMap contributors (ODbL)', frame, minAreaM2: 300, simplifyM: 0.4 },
      polygons: [ { id: <osm id>, name: '<name or empty>', outer: [[x, y], ...], holes: [ [[x, y], ...], ... ] } ] }

Rings are metres, rounded to 0.01 m, no repeated closing point. The outer ring has POSITIVE shoelace area (sum of x1*y2 - x2*y1 over the ring, y down), every hole NEGATIVE.
Draw a polygon as one canvas path (outer + holes) with `evenodd`; the rings are also the shore walls (cars stop at any ring edge, outer or hole; a hole is an island).
Sorted by area, biggest first. A polygon can carry OSM's own name (56 of 262 do).

Build: `npm run fetch-water` (tools/fetch_water.mjs) downloads OSM ways and multipolygon relations with natural=water, waterway=riverbank, landuse=reservoir|basin (not wetland) from
Overpass for the city limit box + 200 m in 3 x 3 chunks (`out geom`) into `data/raw/city/water/w_{row}_{col}.json` (gitignored, 1.6 MB, resumable). `npm run bake-water`
(tools/bake_water.mjs) joins each relation's outer/inner ways end to end into rings (ways de-duplicated by id across chunks), drops water bodies under 300 m2 (net of holes), drops
closed ways that are also relation members or repeat a relation outline, culls bodies wholly outside the city box + 150 m, simplifies (Douglas-Peucker 0.4 m) and writes the file. Polygons that run past
the box + 150 m (the river relations run for kilometres beyond the city) are clipped to it (Sutherland-Hodgman); the river is NOT cut at the city limit, which follows the river bank/centre line in places.

Real numbers (OSM as of 2026-09-21): 9 chunks in ~5 min (overpass-api.de answered 504/429 a few times, retries worked), 310 ways + 31 relations, then 262 polygons, 12,190 outer points, 47 holes, 12.15 km2 in all
(9.5 km2 inside the city limit of 147.9 km2). Dropped: 47 under 300 m2, 39 wholly outside the box. 7 polygons clipped to the box (two Mississippi relations: `104592` 44 islands/holes, `20617924` 27, plus five small ponds).
Big lakes (km2): Bde Maka Ska 1.688, Lake Harriet 1.378, Lake Nokomis 0.824, Cedar Lake 0.676, Lake of the Isles 0.448 (2 islands), Lake Hiawatha 0.214, Wirth Lake 0.162, Powderhorn Lake 0.046, Loring Pond 0.028;
Minnehaha Creek appears only where it is mapped as an area (line waterways are not fetched); Brownie Lake, Diamond Lake, Crystal Lake, Sweeney Lake, Grass Lake, Ryan Lake, Kenilworth Channel, Lake of the Isles Lagoon and Channel, Bassett Creek Lagoons are also there.
Mississippi: the two big river polygons `104592` (downstream, south-east of the Stone Arch area) and `20617924` (upstream, north-west), plus lock, harbour and pond pieces.
Checks: every ring closed and simple (no self-intersections), windings as above; roads against water (`node tools/check_water.mjs`, plot `python3 tools/plot_water.py` -> /tmp/sc/water.png):
87 road pieces lie in water for 1 m or more; 86 of them are bridges (layer >= 1, bridge = true, all with layer 1 or 2, none a tunnel) and only one is a plain road: service way 759954898, 15.7 m of a
30 m stub running into Cedar Lake (a boat launch / dock; needs a barricade or is simply a road that stops at the shore).

Deviations and things the engine must know:
- Water polygons overlap no road except bridges (and the one Cedar Lake service stub), but nothing in the bake removes a road from the water: a bridge is a road with `layer >= 1` or `bridge: true`; the engine should let a car stay on a bridge road over water and stop a car that leaves any road into water.
- Bake-time merges are by outline only, so a big body split by OSM into several touching polygons (locks, harbour basins, the river pieces above) simply overlaps or abuts; treat the union as water.
- Lakes' names come from OSM (`name`); rivers mapped as unnamed relations have `name: ""`.

### LiDAR status and real numbers (2026-09-21, interim: the download is still running)

- Plan (`data/raw/lidar/plan.json`, `python3 tools/fetch_lidar_city.py plan`): TNM lists 1,275 point-cloud files whose bounding box meets the city box: 831 (81.9 GB) + 26 (1.5 GB) of
  MN_CentralMissRiver_B22 (sub-projects 4 and 5, 2022 flights) and 418 (23.3 GB) of the older 2011 Metro project. Newest project wins: **661 files, 67.2 GB, all from MN_CentralMissRiver_4_B22**
  (500 m tiles, 47-167 MB, median 100 MB; ~87 returns/m2). The 26 tiles of sub-project 5 and the 2011 files add nothing inside the city limit (grown by 25 m); 0.0 km2 of the 150 km2
  is uncovered. The plan is smaller than the ~95 GB first estimated because the city limit is only 150 km2, not the 17.9 x 10.7 km box.
- SwapCity's 48 downtown files (byte-identical, same project) are rasterised in place from `~/Projects/SwapCity/data/minneapolis/laz` (read only, not copied or deleted), so 613 files / 60.6 GB
  have to be downloaded. Fetch order: files with tall OSM buildings first (spread over the city), then nearest the downtown origin outwards.
- Speed: rockyweb.usgs.gov serves about 250 KB/s per connection (measured with 1, 2 and 4 parallel requests: it scales per connection, so 2 connections give ~0.5 MB/s, less at busy hours).
  2 connections at a time (the agreed maximum) means roughly 30 to 60 hours for the rest. Rasterising costs 4-9 s per file, so the download is the whole cost. Peak memory of one file: 2.6 GB.
  If the number of connections may be raised, `n_dl` in `cmd_run` of tools/fetch_lidar_city.py is the only change (per-connection limit, so 6 connections would take ~10-20 h).
  An alternative source of the same points is the USGS AWS EPT copy (`usgs-lidar-public.s3.amazonaws.com/MN_CentralMissRiver_4_B22`, octree nodes in EPSG:3857); not used.
- One run from a cold start: `npm run fetch-lidar-city` (resumable: kill and restart any time). `data/raw/lidar/finish.sh` is the unattended chain that waits for the download, restarts it if files
  failed, then runs `lidar-heights-city`, `roof-lean-city --montage` and `node tools/bake_city.mjs` (logs `finish.log`, `heights_city.out`, `roof_lean_city.out`, `bake_city.out`).
- Checked on what is merged so far (94 files: downtown plus 40 tall-building files, 17 blocks): 10,434 of the 162,066 buildings measured (only where the whole footprint is covered), 87 stepped
  (258 blocks). Median 9.4 m, p90 17.3 m, 682 over 20 m, 138 over 50 m, 29 over 100 m; tallest IDS Center 235.8 m. Against the 78 buildings with an explicit OSM `height` of 8 m or more:
  78 % within 10 %, 89 % within 20 %, median difference -0.6 %. Against `building:levels * 3.4 + 2` (a rough proxy, 2,025 buildings): median +10 %, 47 % within 20 %.
  For the downtown ids that both tools measure (630 common) the city tool agrees with `heights_lidar.json` to a median 0.0 m, 95 % within 0.7 m (the rest are 90th-percentile flips on two-level roofs).
  Re-baked with these: heights LiDAR 10,434, OSM height 9, levels 2,917, guessed 148,706; 2,581 tiles, 45.6 MB (same as before), 2,222 tile jpgs and roofs.json untouched.
- Roof lean (interim, 156 clear towers of 342 measured, cells 1500 m wide): the lean is NOT the same everywhere. Downtown west of x = 0 it is about (-0.17, +0.05) per metre of height, in the
  x = 0..1500 strip about (-0.05, 0), at x = 1500..3000 (University of Minnesota / Stadium Village) it flips to (+0.07, -0.09): a roof 50 m high sits 3.5 m east and 4.5 m north of its footprint there, 8 m west
  and 2 m south downtown. The steps between cells are the seams of the NAIP flight frames, so a single global model (or the old downtown fit extrapolated) is wrong by up to 0.24 m per metre of height
  (12 m on a 50 m building) across the city. Montages (/tmp/sc/lean_{i}_{j}.png) show the shifted outlines sitting on the roofs in the regions checked.


## Status: complete (2026-09-22)

The city-wide LiDAR download finished: 661 files, 67.2 GB. All three steps ran automatically (finish.sh):
- **Heights:** 162,064 of 162,066 buildings measured from LiDAR (was 10,434 interim). 137 stepped buildings, 378 blocks.
  Height distribution: median 7.4 m, p90 15.1 m, p99 21.2 m, tallest IDS Center-area tower 280.3 m (a radio mast, likely not a building --
  worth a look later). Against 81 buildings with an explicit OSM height >= 8 m: 79% within 10%, median relative difference -0.6%.
- **Roof lean:** the full per-region table (30 cells + fallback), replacing the interim 23-cell one.
- **Bake:** re-run with the final heights; roads 16,762 pieces, 956 named from route numbers, buildings 162,066 kept, all 2,222
  roof-photo tiles survived (46 KB biggest, 45.2 MB total).
