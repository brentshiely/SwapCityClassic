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
