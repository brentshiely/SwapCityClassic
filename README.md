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
    npm test               # handling, collision, traffic, pedestrian, street-name and whole-city-scale tests (plain Node, a few minutes)
    npm run check-offline  # proves the build makes no network request (needs Google Chrome)

`node tools/fetch_osm.mjs` downloads fresh OpenStreetMap data (needs internet; not part of the game).
`python3 tools/lidar_heights.py --lidar <folder with dsm.npy, dem.npy, meta.json>` measures real building heights from
USGS LiDAR into `data/heights_lidar.json` (numpy needed; the bake uses that file when present).

## The whole city (tiles)

The game world is all of Minneapolis, streamed. `data/city/city.json` (roads, the road graph, the city-limit polygon; loaded whole, ~10 MB)
and `data/city/tiles/{tx}_{ty}.json` (buildings, parks and lots, sidewalks, crosswalks, skyways per 256 m tile; format in
`design/CITY_DATA.md`) come from `npm run fetch-city` (OpenStreetMap via Overpass, resumable, ~2 h) and `npm run bake-city`.
`src/world/world.js` keeps the tiles within 2 of the player loaded and drops those beyond 3, and announces them (`onLoad` / `onUnload`);
`WorldScene.trackTiles` feeds each tile's buildings to the renderer and collision (counted, because a building sits in several tiles).
Ground is painted per 85 m chunk on demand (`GroundStreamer` in `render/ground.js`); the Google overlay is built per tile
(`RoadOverlay`); traffic (`TrafficSim radius`) and pedestrians (`PedSim radius`, `PedNetwork`) live only near the player;
the car cannot leave the city limit (a wall along `meta.boundary`, a striped barricade across every street that crosses it).
The car waits if the tile under it has not arrived. Downtown-only dev data: `node tools/map_to_city.mjs` -> `data/city_dt/`
(served at `/city/` when `data/city` is missing). The single offline file (`npm run package`) embeds the downtown data (`EMBED_CITY=1`).
City-wide roof photos: `npm run fetch-naip-city` + `npm run bake-roof-tiles` write `tiles/{tx}_{ty}.jpg` (672 px, 2 px/m, 40 m margin) and `roofs.json`; the tile brings its photo and `RoofCutter` cuts roofs from it (downtown keeps its sharper global photo; the lean outside downtown is held constant). Not yet city-wide: LiDAR heights (downtown only; elsewhere heights are guessed), and Google mode
(only lined up within ~1.8 km of downtown, then the offline look). The flight build is tag `flight-2026-09-28` (+ `release/flight/`).

## Water, bridges and tunnels (layers)

`water.json` (`npm run fetch-water`, `npm run bake-water`: 262 polygons) is drawn into the ground chunks; the shore is a collision wall, so
the car stops at the water (and islands keep it on them). Every road has an OSM `layer`: 0 ground, 1..3 bridge or overpass decks, -1 tunnel.
A car is on one layer (`src/world/layers.js`: `LayerTracker` changes it only when the car drives onto a road connected to the one it was
on, i.e. a ramp, never by crossing over or under an unconnected road) and only collides with walls of its own layer (`CollisionWorld`
`seg.layer`; the city limit is on every layer). Bridge decks are painted by `BridgeStreamer` (`render/bridges.js`) into transparent chunk
images above the ground cars and drawn with the same perspective scaling as building roofs (deck height 8 m per layer); a car on a bridge
is scaled the same way and drawn above its deck; side rails (`deckRails`) keep it on. Tunnels are painted as a dark cutaway with a concrete
mouth (`computePortals`), the car in them is dimmed. Traffic cars carry a layer too and ignore cars on other layers. In Google mode our decks are still drawn over Google's (the
bridge deck under ours is Google's real mesh, drawn over by our asphalt deck so a bridge looks like every other street); the overhead pass rises to the deck height while the player is on a bridge. Water is cut out of the ground overlay (a depth-only mesh) so Google's real river shows.

## Google Earth mode

**Terrain.** Google's picture is on real terrain (the river valley is ~35 m below downtown), so the game bakes the LiDAR ground model
(`python3 tools/bake_terrain.py --lidar <folder>` -> `data/city/terrain.json`, 8 m grid, height above the ground at the origin) and
`src/world/terrain.js` serves it: the Google camera is H above the ground UNDER the screen's middle, the overlay meshes follow the terrain, and
a small shader addition to Google's materials (`patchGoogleMaterials`) drops fragments less than 3.7 m above the local ground in the "overhead"
pass. Google mode is only used where the terrain grid exists (downtown). **Bridges are OpenStreetMap's:** Google's own bridge deck, rails and
piers are dropped by a mask of the bridge footprints (whole width over water, the road plus 4.5 m on land), our deck is drawn instead, and
our own (dark, Google-tinted) water is laid under the bridge where Google has none.

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

## Roof photos

In the offline look each roof is a cut-out of a real aerial photo (USDA NAIP, public domain). `python3 tools/bake_naip.py` downloads
NAIP for the map area from the USGS National Map image service (needs internet; the game does not) and writes it in the game's own
frame to `data/roofs_naip.jpg` (+ `roofs_naip.json`). NAIP is straightened to the ground, so a tall roof appears shifted in the photo
(the tower leans); `python3 tools/roof_offsets.py --lidar <folder>` measures that against the LiDAR roof outlines and fits
`shift = height * (a*x + c, b*y + d)` into `data/roof_offsets.json`. `src/render/roofs.js` cuts each building's (and each stepped
block's) roof from where it really is, and `BuildingRenderer` draws it scaled with the perspective. Each building is its own
Graphics with the roof Image on top, so near and far buildings keep their painter's order. Google mode does not use the photos.

## Facades

`src/render/facades.js` gives each building a wall style from what is known: OSM type, height, storey count (`building:levels`, 75 of
134), and rarely a material or colour (10 carry a material). Styles: `glass` (a curtain-wall tower with continuous glass bands and mullions
in one of five tints), `punched` (brick, stone or concrete with a window per bay per floor and a storefront on the ground floor of
shops and offices) and `garage` (open parking decks). The choice is deterministic per building. Floors are drawn at their true heights, so with
the perspective the upper floors of a tall building stretch. Detail drops out when a wall is thin on screen (level of detail).
The same renderer draws the offline look only; Google mode has its own real walls.

## Skyways

OSM has the Minneapolis Skyway (bridge=covered ways). `tools/bake_map.mjs` keeps the stretches over open ground into
`map.skyways` (anything inside a building footprint is dropped); `src/world/skyways.js` turns each into a block that a second
`BuildingRenderer` draws from deck height to roof height, above the cars, so traffic passes underneath. It is a separate
layer so it also shows over Google's picture, where it covers Google's own skyway. Skyways do not collide.

## Traffic and street names at city scale

`new TrafficSim(map, { count, seed, radius })`: by default (`radius` unset) the cars roam the whole map, as on the downtown box.
With a finite `radius` in metres (say 450) the cars exist only near the player: they spawn on streets within `radius` of the player
(outside the view, over 30 m away), are removed beyond `radius * 1.3`, and `count` is how many are kept near the player. Streets are
found through a 200 m grid (`src/world/spatial.js`), built once; `Navigator` and the signal lamps use the same kind of grid, so a frame
costs the same on 30,000 graph nodes as on 40. `node tools/synth_city.mjs` makes a synthetic city of that size (only for tests):
`tools/test_city_scale.mjs` builds it and drives 10 minutes through it.

## Adding a setting to the T panel

The panel is built from a list, so a new slider is one entry:

1. `src/settings.js`: add the default to `DEFAULTS` and an item (`key`, `label`, `unit`, `min`, `max`, `step`, `hint`)
   to a group in `SPEC` (or a new group). The panel, saving, and "Reset all" pick it up automatically.
2. `WorldScene.applySettings()` (src/scenes/WorldScene.js): push the value into whatever uses it.

## Credits

Map data (c) OpenStreetMap contributors (ODbL). Phaser 3 (MIT). See `LICENSES.md`.
