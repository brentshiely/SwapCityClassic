// Build the game and put ONE file, ready to carry, in release/. Usage: npm run package
import { execSync } from 'node:child_process';
import { mkdirSync, copyFileSync, writeFileSync, statSync } from 'node:fs';

// the single file carries the downtown city data inside (data/city_dt, from tools/map_to_city.mjs), so it needs no server and no internet
execSync('node tools/map_to_city.mjs && npm run build', { stdio: 'inherit', env: { ...process.env, EMBED_CITY: '1' } });
mkdirSync('release', { recursive: true });
copyFileSync('dist/index.html', 'release/SwapCityClassic.html');
const kb = Math.round(statSync('release/SwapCityClassic.html').size / 1024);
writeFileSync('release/HOW TO PLAY.txt', `SwapCityClassic - how to play (works with NO internet)

1. Double-click SwapCityClassic.html (or drag it onto Google Chrome).
   Use Chrome or Safari. It is one file (${kb} KB): nothing else needs to be copied with it.
2. Drive: arrow keys or WASD. Space = handbrake. R = restart the car.
   E gets you out of the car; on foot: WASD/arrows walk, Shift runs, Space or a mouse click shoots the pistol (aim with the mouse),
   E beside your car gets back in, E beside somebody else's car takes it (they run). Yellow rings are phones: stand in one and press M
   to take a job (a pink ring and arrow show where to go); M again abandons it. Cash and finished jobs are remembered.
   Crimes (shooting, killing, taking a car) earn stars; police cars chase you; if they catch you standing still you are BUSTED (a fine,
   your car is gone, back to the start). Lose them for a while and the stars fade.
   Crashes damage the car (smoke, then fire, then it explodes; the health is under your cash); a green ring is a Pay 'n' Spray
   ($100: repairs it and shakes off the police). Sound is made in the game: X mutes it, N turns the music on and off, H is the horn; volumes are in the T panel.
   The top of the screen shows the street you are on, your heading and the next street; the compass rose
   shows where true north is (the map is turned 30 degrees, so north is NOT straight up).
   T opens the SETTINGS panel: sliders for camera zoom, top speed, grip, traffic and crowd size.
   Changes are instant and remembered in that browser. "Reset all" restores the defaults.
   Two-finger scroll / pinch only matter in the "?free" camera mode.
3. Scenery: when the computer is ONLINE the game shows live Google Earth imagery under the cars (Google logo and
   credits bottom-right). OFFLINE it shows its own drawn city instead, automatically. G switches by hand, or use the
   Scenery choice in the T panel: Auto / Google Earth / Offline. Every launch that uses Google is one billed session, so:
   keep ONE tab open. No more than 40 Google launches a day are allowed in one browser (the HUD shows the count);
   after that it plays offline until tomorrow.
   Our own streets are drawn over Google's picture (T panel: "Our streets over Google") so real parked and moving
   cars in the photos are covered. Things high above the street in Google's picture (signal arms, wires, signs, tree tops, skyways) are drawn over
   the cars, so you drive under them (T panel: "Google overhead above cars"). Google's imagery is streamed live and never saved. ?look=offline forces the offline look.
4. Optional address-bar extras, added after the file name:
   ?cars=30   more traffic        ?peds=150  a bigger crowd
   ?notraffic no traffic          ?nopeds    no people
   ?free      free-look camera    ?debug     map data view

If the screen says it could not get enough graphics memory: close other SwapCityClassic tabs
(each keeps about 700 MB of textures) and reload. Keep just ONE tab open.

Map data (c) OpenStreetMap contributors, ODbL. See LICENSES.md in the project.
Built ${new Date().toISOString().slice(0, 10)}.
`);
console.log(`\nPackaged release/SwapCityClassic.html (${kb} KB) and release/HOW TO PLAY.txt`);
