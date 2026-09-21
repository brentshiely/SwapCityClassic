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
