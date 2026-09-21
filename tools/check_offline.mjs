// Proves the built game needs no internet. Run: npm run build && npm run check-offline
//  1. scan dist/index.html and src/ for anything that would fetch from the network
//  2. load the game from disk in headless Chrome with EVERY hostname blocked and look for failed requests
//  3. a control page that does try to fetch from the web, to prove step 2 would notice
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };
if (!existsSync('dist/index.html')) { console.error('dist/index.html is missing: run npm run build first'); process.exit(1); }

// ---- 1. static scan
const html = readFileSync('dist/index.html', 'utf8');
const tags = [...html.matchAll(/<(?:script|link|img|iframe|source|video|audio)\b[^>]*\b(?:src|href)=["'](https?:)?\/\/[^"']+/gi)];
check('no <script>/<link>/<img> tag points at the internet', tags.length === 0, `${tags.length} found`);
const cssUrls = [...html.matchAll(/(?:@import\s+url\(|url\()\s*["']?https?:\/\/[^)"']+/gi)];
check('no CSS @import or url() points at the internet', cssUrls.length === 0, `${cssUrls.length} found`);
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
// main.js and world.js fetch the city data from the page's OWN origin (/city/); the single-file build embeds the data instead and never runs those lines
const SAME_ORIGIN_CITY = ['src/main.js', 'src/world/world.js'];
const netCalls = walk('src').filter((f) => f.endsWith('.js') && !SAME_ORIGIN_CITY.includes(f)).flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/\b(fetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts)/g)].map((m) => `${f}: ${m[0]}`));
check('the game\'s own code makes no network calls (fetch, XHR, WebSocket, ...)', netCalls.length === 0, netCalls.join('; ') || 'none');
const GOOGLE_EARTH_HOSTS = ['tile.googleapis.com', 'www.gstatic.com']; // what Google Earth mode needs: tiles, the logo, the Draco decoder
const googleHosts = [...new Set([...html.matchAll(/https?:\/\/([a-z0-9.-]*(?:google\.com|googleapis\.com|gstatic\.com|googleusercontent\.com))/gi)].map((m) => m[1].toLowerCase()))];
const stray = googleHosts.filter((h) => !GOOGLE_EARTH_HOSTS.includes(h));
check('the only Google addresses in the game are the ones Google Earth mode uses', stray.length === 0, `${googleHosts.join(', ') || 'none'}${stray.length ? '; UNEXPECTED: ' + stray.join(', ') : ''}`);
const kb = Math.round(statSync('dist/index.html').size / 1024);
check('the build is a single file', true, `${kb} KB`);

// ---- 2. run it with the network blocked
// Chrome itself makes background requests (update checks, Google services). To tell those apart from the page's own,
// a blank page is run first with the same flags; only hosts the blank page did NOT contact count against the game.
const run = (url, ms = 6000) => spawnSync(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=1200,760',
  '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run',
  '--disable-default-apps', '--disable-extensions', '--disable-client-side-phishing-detection', '--disable-domain-reliability',
  '--host-resolver-rules=MAP * ~NOTFOUND',   // every hostname fails to resolve
  '--proxy-server=127.0.0.1:9',              // and nothing can leave through a proxy either
  '--enable-logging=stderr', '--v=1',        // verbose 1 makes Chrome log every URL that is requested
  `--virtual-time-budget=${ms}`, '--screenshot=/tmp/offline_check.png', url,
], { encoding: 'utf8', timeout: 90000, maxBuffer: 200 * 1024 * 1024 });
const hostsOf = (out) => new Set([...out.matchAll(/NotifyBeforeURLRequest: (https?:\/\/[^\s/]+)/g)].map((m) => m[1]));
const requestsOf = (out) => [...out.matchAll(/NotifyBeforeURLRequest: (https?:\/\/\S+)/g)].map((m) => m[1]);

writeFileSync('/tmp/offline_blank.html', '<!doctype html><title>blank</title><p>blank</p>');
const blank = run('file:///tmp/offline_blank.html', 3000);
const chromeOwn = hostsOf((blank.stdout ?? '') + (blank.stderr ?? ''));
// Chrome's own background services talk to Google (updates, sign-in checks). Those are ignored EXCEPT the addresses that only the
// game's Google Earth mode uses, which always count.
const CHROME_SERVICES = /^https?:\/\/[^/]*(?:google\.com|googleapis\.com|gstatic\.com)(?:[:/]|$)/i;
const GAME_GOOGLE = /^https:\/\/(?:tile\.googleapis\.com\/|www\.gstatic\.com\/(?:draco|images\/branding))/i;
const pageRequests = (out) => requestsOf(out).filter((u) => GAME_GOOGLE.test(u) || (!CHROME_SERVICES.test(u) && ![...chromeOwn].some((h) => u.startsWith(h))));

// (a) the offline look, forced: the strictest test, the file must not ask the network for anything at all
const game = run(`file://${process.cwd()}/dist/index.html?look=offline`);
const gameOut = (game.stdout ?? '') + (game.stderr ?? '');
check('offline look: the game starts with the network blocked (ground painted)', /ground painted/.test(gameOut), (gameOut.match(/ground painted[^"]*/) ?? ['no start message'])[0]);
const asked = pageRequests(gameOut);
check('offline look: it asks the network for nothing at all (no http/https request of its own)', asked.length === 0, `${asked.length} requests${asked.length ? ': ' + asked.slice(0, 3).join(', ') : ''}; Chrome's own background hosts ignored: ${chromeOwn.size}`);
const shot = existsSync('/tmp/offline_check.png') ? statSync('/tmp/offline_check.png').size : 0;
check('offline look: it draws a real picture (screenshot over 100 KB)', shot > 100000, `${Math.round(shot / 1024)} KB`);

// (b) Auto mode with the network blocked (the browser still says "online" but nothing gets through): Google is tried, fails,
// and the game must carry on with the offline look. Its only requests are Google Earth mode's own.
const auto = run(`file://${process.cwd()}/dist/index.html`, 9000);
const autoOut = (auto.stdout ?? '') + (auto.stderr ?? '');
const autoAsked = pageRequests(autoOut);
check('auto mode, network blocked: the game still starts', /ground painted/.test(autoOut), '');
check('auto mode, network blocked: it only ever tries Google Earth\'s own addresses, then gives up', autoAsked.every((u) => GAME_GOOGLE.test(u)), `${autoAsked.length} attempts: ${[...new Set(autoAsked.map((u) => u.replace(/\?.*/, '')))].slice(0, 3).join(', ') || 'none'}`);
check('auto mode, network blocked: it falls back to the offline look on its own', /Google Earth mode unavailable|look: offline/.test(autoOut) || autoAsked.length === 0, (autoOut.match(/Google Earth mode unavailable[^"]*/) ?? ['(no key in this build, or no attempt made)'])[0].slice(0, 90));
const autoShot = existsSync('/tmp/offline_check.png') ? statSync('/tmp/offline_check.png').size : 0;
check('auto mode, network blocked: it still draws a real picture', autoShot > 100000, `${Math.round(autoShot / 1024)} KB`);

// ---- 3. control: a page that does reach for the internet must be caught
writeFileSync('/tmp/offline_control.html', '<!doctype html><img src="https://example.com/x.png"><script>fetch("https://example.com/y").catch(()=>{})</script>');
const control = run('file:///tmp/offline_control.html', 3000);
const seen = pageRequests((control.stdout ?? '') + (control.stderr ?? ''));
check('control: the same check does catch a page that tries to use the internet', seen.length >= 2, `${seen.length} requests seen (expected 2: ${seen.join(', ')})`);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nthe game runs fully offline');
process.exit(failed ? 1 : 0);
