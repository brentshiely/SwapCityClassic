# SwapCityClassic backlog

Cards in sequenced order (top = next). Brent reorders; Claude works from the top. Status: DONE / IN PROGRESS / READY / BLOCKED.
Started 2026-09-20. Goal: a playable top-down, GTA1-style drive through 9 real downtown Minneapolis blocks, working fully offline, for the flight to India on 2026-09-28.
Commit to git at the end of every card, before starting the next.
Walk through mechanics with Brent before building anything behavior-heavy (cards marked "walk through").

## Decisions locked (2026-09-20)

- **Separate project** from SwapCity (Unreal), which is paused. Spec: `~/Downloads/swapcity-2d-game-spec.md`.
- **Flight build = steps 1-3:** map, drivable car, NPC traffic and pedestrians. Carjacking, shooting, missions, police and wanted level come later.
- **Benchmark: the original Grand Theft Auto (1997).** Textured paver sidewalks, curbs, asphalt with yellow centre lines, crosswalks, building wall faces visible, small chunky sprites, tight zoomed camera, compressed scale.
- **Engine: Phaser 3** for loop, camera, input and rendering. Driving, collision and traffic logic live in plain modules so the engine can be swapped.
- **Map: 9 blocks (3x3)** around the pinpoint centre of downtown Minneapolis (about Nicollet Mall). No water, no tunnel, no bridge in the MVP. Keep OSM `layer` tags in the data for later maps.
- **Layers (future maps):** a car's layer follows what OSM says for the road it is on, changing at shared nodes where OSM connects ramps. Collision and pathing only consider the car's layer.
- **Map data:** OpenStreetMap, fetched once at build time and baked to static JSON. Never queried at runtime. Show "© OpenStreetMap contributors" in the game.
- **Client:** Brent's MacBook only. Load once, build static geometry once, never redraw it per frame.
- **Textures from the start**, generated in code (no art assets). OSM decides placement, textures are painted on.
- **Sprites:** cars and pedestrians drawn in code as GTA1-chunky placeholders. Real sprite art is a later discussion.
- **Player:** in a car the whole time for steps 1-3. Arrow keys or WASD, arcade handling with a slight slide.
- **Collisions:** the car stops or slides on buildings, barriers and other cars. No damage. A pedestrian is nudged aside and the car barely slows.
- **Map edge:** boundary streets are blocked by visible barriers plus an invisible wall behind them.
- **Sound:** not in the MVP.

## Sequence

**1. Scaffold the project.** READY, small.
Story: as Brent I can run one command and see a Phaser 3 window that works with no internet.
Approach: Vite + Phaser 3 installed locally (no CDN), one empty scene, `npm run dev` and `npm run build`, README with the run steps.
Accept: `npm run build` output opens from disk in the browser with Wi-Fi off; commit.

**2. Pick the centre and fetch the OSM data.** READY, small. Walk through: the centre point.
Story: as Brent I see exactly which 9 blocks the game covers before we build on them.
Approach: propose a centre near Nicollet Mall, compute a 3x3 block box from the street grid (not a fixed radius), fetch roads, sidewalks, crossings, buildings, parking and parks with Overpass at build time, save raw JSON in `data/raw/`. Reuse the fetch approach from `~/Projects/SwapCity/tools/bake_city.py` (overpass.kumi.systems worked when overpass-api.de timed out).
Accept: a simple debug plot of the box on a plain canvas; Brent approves the area.

**3. Bake the map into game data.** READY, medium.
Story: as the game I load one small JSON file that describes the whole map.
Approach: `tools/bake_map.py` (or Node) converts raw OSM to: road polygons (width by highway type), sidewalks and curbs, crosswalks, building footprints with height (`building:levels` or `height`, else a default), parks, and a routable road graph (split at intersections, one-way, lane offsets, `layer` kept). Keep every coordinate in metres from the map centre.
Accept: `data/map.json` loads in the game; a debug view draws the road graph and footprints correctly.

**4. Render the ground with GTA1-style textures.** READY, medium.
Story: as Brent the streets look like GTA1, not a diagram.
Approach: generate textures in code: asphalt (noise), paver sidewalks with grout lines, white curbs, yellow dashed centre lines, lane lines, crosswalk stripes. Paint the whole static ground once into a texture at load, draw that texture each frame.
Accept: a still frame side by side with the GTA1 reference at the same zoom looks like the same family; steady 60 fps.

**5. Buildings with roofs and wall faces (pseudo-3D).** READY, medium.
Story: as Brent the buildings feel tall: I see roofs and the window-covered wall faces shifting as the camera moves.
Approach: roof polygon offset from the footprint by height and camera position, wall quads between with a window pattern and darker shading; only draw buildings in view. Roof tones and patterns vary per building.
Accept: pan the camera over downtown and the buildings visibly lean and shift; still 60 fps.

**6. Map boundary barriers.** READY, small.
Story: as a player I can't drive off the map, and the edge looks intentional.
Approach: place visible barriers (jersey blocks, fences) across each boundary street, plus an invisible wall behind them; include them in collision.
Accept: every street leaving the box is blocked and looks deliberate.

**7. Drivable car.** READY, medium. Walk through: handling feel.
Story: as the player I start in a car on a downtown street and drive it with the keyboard.
Approach: code-drawn top-down car sprite, arrow keys and WASD, GTA1-style arcade handling (accelerate, brake and reverse, steer while moving, slight slide), tight zoomed camera that follows the car, a start position on a real street.
Accept: Brent drives a few blocks and says the handling feels right (we tune until he does); commit.

**8. Collisions.** READY, medium.
Story: as the player I can't drive through buildings or barriers; I stop or slide along them.
Approach: spatial index (RBush) over footprints and barriers, rotated-box vs polygon tests, slide along the wall, no damage.
Accept: no clipping through any building on the 9 blocks in a five-minute stress drive, including corners.

**9. Traffic.** READY, medium-large. Walk through: traffic rules.
Story: as the player I share the streets with believable cars.
Approach: code-drawn cars in several sizes and colours, spawn on the road graph at intervals, follow lanes, obey one-ways, slow and stop at intersections, keep distance from the car ahead, despawn out of view. Bumping the player just stops or slides, no damage.
Accept: a few minutes of driving with steady traffic and no deadlocks or cars driving through each other or through buildings.

**10. Pedestrians.** READY, medium. Walk through: how they walk and react.
Story: as the player I see people walking the sidewalks and crosswalks who react to my car.
Approach: small coloured sprites with two or three walk frames, paths along sidewalks and across crosswalks, scatter away from an approaching car, a pedestrian the car touches is nudged aside with no harm.
Accept: sidewalks feel populated; driving at a pedestrian makes them dodge; nothing sticks to the car.

**11. Offline packaging, attribution and airplane-mode test.** READY, small-medium.
Story: as Brent I can play on the plane with no internet.
Approach: production build with everything local, service worker cache, "© OpenStreetMap contributors" shown on screen, README with how to launch offline.
Accept: with Wi-Fi off and a cold browser, the game loads and plays for 10 minutes; a reboot-and-launch test passes.

**12. Tuning pass.** READY.
Story: as Brent the game feels good.
Approach: camera zoom and world scale against the GTA1 reference, driving feel, traffic density, frame rate on the Air (check it stays cool).
Accept: Brent plays for ten minutes and signs off.

## Later (not in the flight build)

- Step 4: exit the car, on foot, carjacking, shooting, missions.
- Step 5: police and wanted level.
- Sound and music (SFX first).
- Car damage levels.
- Real sprite art; Brent's ten real cars as drivable vehicles.
- Water, bridges, tunnels and the layer system on a bigger map (Lowry Hill tunnel, Mississippi, the lakes).
- More cities (Chicago, La Crosse and others) as swappable data sets.
- Deploy to Cloudflare at profitcapture.com.
