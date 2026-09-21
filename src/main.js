import Phaser from 'phaser';
import { WorldScene } from './scenes/WorldScene.js';
import { MapDebugScene } from './scenes/MapDebugScene.js';
import { World, fetchSource } from './world/world.js';
import { findStart } from './world/start.js';

// If the browser cannot give the game the graphics memory it needs (usually because several copies of the game or other
// heavy tabs are open), say so plainly instead of leaving a blank screen.
function graphicsHelp(e) {
  const m = String(e?.error?.message ?? e?.reason?.message ?? e?.message ?? '');
  if (!/framebuffer|webgl|context lost|out of memory/i.test(m) || document.getElementById('gfxhelp')) return;
  const d = document.createElement('div');
  d.id = 'gfxhelp';
  d.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#14181a;color:#e8ecee;font:16px/1.5 Menlo,monospace;text-align:center;padding:24px;z-index:99';
  d.innerHTML = '<div style="max-width:34em"><b style="color:#ffd24a;font-size:20px">SwapCityClassic could not get enough graphics memory</b><br><br>Close any other SwapCityClassic tabs (each one keeps about 700 MB of textures) and other heavy tabs, then reload this page.</div>';
  document.body.appendChild(d);
}
addEventListener('error', graphicsHelp);
addEventListener('unhandledrejection', graphicsHelp);

// index.html?debug opens the map-data debug view instead of the game world.
const debug = new URLSearchParams(location.search).has('debug');

// A hidden or minimised window can report a size of 0 x 0, and a zero-sized canvas makes the graphics setup fail. Wait until the
// window has a real size, then start.
function whenSized(go) {
  if (innerWidth > 0 && innerHeight > 0) { go(); return; }
  const onSize = () => { if (innerWidth > 0 && innerHeight > 0) { removeEventListener('resize', onSize); go(); } };
  addEventListener('resize', onSize);
}

// The city: the road graph and city limit (city.json) load first; the tiles around the start are ready before the game begins.
const CITY = 'city'; // served at /city/ (see vite.config.js); the tiles are fetched from there as the car drives
async function loadCity() {
  let city, source;
  if (__EMBED_CITY__) { // the single-file offline build carries the downtown data inside
    ({ city, source } = (await import('./embeddedCity.js')).embeddedCity());
  } else {
    const r = await fetch(`${CITY}/city.json`);
    if (!r.ok) throw new Error(`could not load ${CITY}/city.json (${r.status})`);
    city = await r.json();
    const rr = await fetch(`${CITY}/roofs.json`).catch(() => null); // roof photos per tile, if the city was baked with them
    const roofs = rr && rr.ok ? await rr.json().catch(() => null) : null;
    city.meta.roofPhotos = roofs;
    source = fetchSource(CITY, roofs);
  }
  const world = new World(city, source);
  const start = findStart(world);
  await world.preload(start.x, start.y);
  return world;
}

// Exposed so the game can be inspected and driven from the browser console while testing.
whenSized(async () => {
  let world;
  try { world = await loadCity(); } catch (e) {
    document.body.insertAdjacentHTML('beforeend', `<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#14181a;color:#e8ecee;font:16px Menlo,monospace;text-align:center;padding:24px;z-index:99">Could not load the city data: ${e.message}</div>`);
    return;
  }
  window.__game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    transparent: true, // the Google Earth canvas shows through when that look is on
    render: { mipmapFilter: 'LINEAR_MIPMAP_LINEAR' },
    scale: {
      mode: Phaser.Scale.RESIZE,
      width: '100%',
      height: '100%',
    },
    callbacks: { preBoot: (game) => game.registry.set('world', world) },
    scene: [debug ? MapDebugScene : WorldScene],
  });
});
