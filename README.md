# SwapCityClassic

A top-down, GTA1-style driving game on real OpenStreetMap streets of downtown Minneapolis (a 3x3-block
box around the IDS Center). Drive a car through traffic and crowds, obey (or ignore) the lights.
Runs entirely in the browser with **no internet**. Built for the flight to India, 2026-09-28.

The story board is `design/BACKLOG.md` (the drag-to-reorder version lives in the Claude Artifact).

## Play (the plane version)

    npm run package        # builds and writes release/SwapCityClassic.html + HOW TO PLAY.txt

`release/SwapCityClassic.html` is ONE self-contained file (about 1.3 MB). Copy it anywhere, double-click it,
or drag it onto Chrome. No server, no internet, nothing else to copy.

Controls: arrows or WASD to drive, Space = handbrake, R = restart, **T = settings panel** (camera zoom,
top speed, grip, traffic, crowd... changes live and is remembered in your browser).
Address-bar extras (after the file name): `?cars=30` `?peds=150` `?notraffic` `?nopeds` `?free` `?debug`
`?seed=7` (same traffic every time) `?autopilot` (scripted drive, for testing).

The top of the screen shows the street you are on (both streets at a junction), your heading, the next cross
street ahead with its distance, and a compass rose. The map is turned 30 degrees so the streets run straight, so
true north is 30 degrees anticlockwise from straight up; the rose shows that.

## Develop

    npm install
    npm run dev            # dev server with hot reload
    npm run build          # dist/index.html, one self-contained file
    npm run bake           # rebuild data/map.json from the saved OSM download (data/raw)
    npm test               # handling, collision, traffic and pedestrian tests (plain Node, a few minutes)
    npm run check-offline  # proves the build makes no network request (needs Google Chrome)

`node tools/fetch_osm.mjs` downloads fresh OpenStreetMap data (needs internet; not part of the game).
`python3 tools/lidar_heights.py --lidar <folder with dsm.npy, dem.npy, meta.json>` measures real building heights from
USGS LiDAR into `data/heights_lidar.json` (numpy needed; the bake uses that file when present).

## Google Earth mode

Online, the ground under the cars can be live Google Photorealistic 3D Tiles (`src/earth/`); offline it falls back to
the drawn OpenStreetMap + LiDAR city. Put a Map Tiles API key in `secrets/google_maps_key.txt` (gitignored) before
`npm run build`; with no key the game is offline-only. The `Scenery` choice in the T panel (Auto / Google Earth /
Offline), the G key and `?look=auto|google|offline` pick the look (G and the panel beat the address bar). Each launch
that uses Google is one billed session, so no mode (Auto, G, `?look=google`, a retry) opens more than 40 a day in that browser (a session left running past 170 minutes counts again, since its token is renewed)
(`LIMIT_PER_DAY` in `src/earth/lookController.js`); keep one tab open. Tiles are never cached or mined (Google's
policy) and the Google logo and attribution always show. `tools/earth_align.py` produced `data/earth_align.json`, the
game-frame-to-Earth alignment (ground height, no Google data).

**Our streets over Google** (`src/earth/roadOverlay.js`): the road surface (kerbs, asphalt, lane lines, crosswalks, stop
lines) is drawn over Google's picture so the cars photographed on its streets are covered. It reuses `paintRoadLayer` from
`src/render/ground.js` through a recording canvas that turns the strokes into triangles in the same three.js scene, so
tower walls still hide it. It floats 3 m up (above a car roof) and is scaled toward the camera to land where the ground
would. The T panel choice `Our streets over Google` switches it off; `?roadlift=` changes the height for experiments.
It only draws over Google's imagery and reads nothing back from it.

The overlay now also lays our paver sidewalks, parks and parking lots under the roads, so only Google's buildings, trees,
poles and wires remain of its ground level. Whatever of Google's picture is higher than `OVERHEAD_FROM` (3.7 m, in
`roadOverlay.js`) is drawn a second time ABOVE the game: `earthLayer.js` renders the tiles with a clipping plane into a
transparent frame and copies it to `#earth-top`, a canvas above the game canvas. So mast arms, signal heads, signs, wires,
tree canopies, Google's real skyways and building walls pass over cars and people, and traffic drives under them. Google's
picture is used as it is (nothing painted or read back). The flat ground assumption (ground at one height) is what the plane
relies on; the T panel switch `Google overhead above cars` turns the second pass off (then our skyway blocks show again).

## Skyways

OSM has the Minneapolis Skyway (bridge=covered ways). `tools/bake_map.mjs` keeps the stretches over open ground into
`map.skyways` (anything inside a building footprint is dropped); `src/world/skyways.js` turns each into a block that a second
`BuildingRenderer` draws from deck height to roof height, above the cars, so traffic passes underneath. It is a separate
layer so it also shows over Google's picture, where it covers Google's own skyway. Skyways do not collide.

## Adding a setting to the T panel

The panel is built from a list, so a new slider is one entry:

1. `src/settings.js`: add the default to `DEFAULTS` and an item (`key`, `label`, `unit`, `min`, `max`, `step`, `hint`)
   to a group in `SPEC` (or a new group). The panel, saving, and "Reset all" pick it up automatically.
2. `WorldScene.applySettings()` (src/scenes/WorldScene.js): push the value into whatever uses it.

## Credits

Map data (c) OpenStreetMap contributors (ODbL). Phaser 3 (MIT). See `LICENSES.md`.
