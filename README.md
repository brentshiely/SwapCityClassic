# SwapCityClassic

A top-down, GTA1-style driving game on real OpenStreetMap streets of downtown Minneapolis (a 3x3-block
box around the IDS Center). Drive a car through traffic and crowds, obey (or ignore) the lights.
Runs entirely in the browser with **no internet**. Built for the flight to India, 2026-09-28.

The story board is `design/BACKLOG.md` (the drag-to-reorder version lives in the Claude Artifact).

## Play (the plane version)

    npm run package        # builds and writes release/SwapCityClassic.html + HOW TO PLAY.txt

`release/SwapCityClassic.html` is ONE self-contained file (about 1.3 MB). Copy it anywhere, double-click it,
or drag it onto Chrome. No server, no internet, nothing else to copy.

Controls: arrows or WASD to drive, Space = handbrake, R = restart.
Address-bar extras (after the file name): `?cars=30` `?peds=150` `?notraffic` `?nopeds` `?free` `?debug`
`?seed=7` (same traffic every time) `?autopilot` (scripted drive, for testing).

## Develop

    npm install
    npm run dev            # dev server with hot reload
    npm run build          # dist/index.html, one self-contained file
    npm run bake           # rebuild data/map.json from the saved OSM download (data/raw)
    npm test               # handling, collision, traffic and pedestrian tests (plain Node, a few minutes)
    npm run check-offline  # proves the build makes no network request (needs Google Chrome)

`node tools/fetch_osm.mjs` downloads fresh OpenStreetMap data (needs internet; not part of the game).

## Credits

Map data (c) OpenStreetMap contributors (ODbL). Phaser 3 (MIT). See `LICENSES.md`.
