// Build the game and put ONE file, ready to carry, in release/. Usage: npm run package
import { execSync } from 'node:child_process';
import { mkdirSync, copyFileSync, writeFileSync, statSync } from 'node:fs';

execSync('npm run build', { stdio: 'inherit' });
mkdirSync('release', { recursive: true });
copyFileSync('dist/index.html', 'release/SwapCityClassic.html');
const kb = Math.round(statSync('release/SwapCityClassic.html').size / 1024);
writeFileSync('release/HOW TO PLAY.txt', `SwapCityClassic - how to play (works with NO internet)

1. Double-click SwapCityClassic.html (or drag it onto Google Chrome).
   Use Chrome or Safari. It is one file (${kb} KB): nothing else needs to be copied with it.
2. Drive: arrow keys or WASD. Space = handbrake. R = restart.
   T opens the SETTINGS panel: sliders for camera zoom, top speed, grip, traffic and crowd size.
   Changes are instant and remembered in that browser. "Reset all" restores the defaults.
   Two-finger scroll / pinch only matter in the "?free" camera mode.
3. Optional address-bar extras, added after the file name:
   ?cars=30   more traffic        ?peds=150  a bigger crowd
   ?notraffic no traffic          ?nopeds    no people
   ?free      free-look camera    ?debug     map data view

Map data (c) OpenStreetMap contributors, ODbL. See LICENSES.md in the project.
Built ${new Date().toISOString().slice(0, 10)}.
`);
console.log(`\nPackaged release/SwapCityClassic.html (${kb} KB) and release/HOW TO PLAY.txt`);
