# Credits and licenses

## Map data

Map data (c) **OpenStreetMap contributors**, available under the **Open Database License (ODbL) 1.0**
(https://www.openstreetmap.org/copyright).

`data/raw/downtown_wide.json` is an extract of OpenStreetMap; `data/map.json` is a derived database
built from it by `tools/bake_map.mjs` (streets, sidewalks, building footprints, road graph). The game
shows "Map data (c) OpenStreetMap contributors (ODbL)" on screen at all times. Under the ODbL, if this
map database is shared it must keep that credit and stay under the same license; the game's own code
and generated art are separate.

## Software

- **Phaser 3** (v3.90), MIT license, (c) Richard Davey / Phaser Studio Inc. https://phaser.io
  The MIT license text ships inside `node_modules/phaser/LICENSE.md`.
- **Vite** and **vite-plugin-singlefile**, MIT license (build tools only; not shipped in the game).

## Art

All textures, sprites, and lights are generated in code by this project. No image files are used.

## Building heights

`data/heights_lidar.json` holds the measured height of each OpenStreetMap building footprint, computed by
`tools/lidar_heights.py` from **USGS 3D Elevation Program (3DEP) LiDAR** point clouds (US Government work, public
domain). Only this small derived table ships with the game. No Google data of any kind is used to make it.
