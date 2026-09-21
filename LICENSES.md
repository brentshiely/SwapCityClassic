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

## Google Earth mode (live, online only)

When online, the game can stream **Google Photorealistic 3D Tiles** (Google Map Tiles API) under the game, using a key
kept in the gitignored `secrets/google_maps_key.txt` and compiled into the local build only (never in git).
Google's policies apply: the tiles are streamed live and are **never cached, saved, or used to derive anything** (no
heights, geometry or textures are taken from them), and Google's logo and data attributions stay visible on screen.
Everything ships in the offline look (OpenStreetMap + USGS LiDAR), which needs no Google data. Rendering uses
`3d-tiles-renderer` (NASA-AMMOS, Apache-2.0) and three.js (MIT).
