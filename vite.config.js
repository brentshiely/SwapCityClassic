import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { existsSync, readFileSync } from 'node:fs';

// The build is one self-contained index.html so it opens straight from disk (file://) with no server and no internet.
//
// Google Earth mode needs a Google Maps Platform key (Map Tiles API). It is read here from secrets/google_maps_key.txt
// (gitignored) and baked into the built file only, so the file is for its owner and should not be shared. Without the
// key file the game still builds and simply never offers Google mode.
const keyFile = process.env.GOOGLE_MAPS_KEY_FILE || 'secrets/google_maps_key.txt';
const googleKey = existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : '';

// The city data (data/city, or data/city_dt made from the downtown map by tools/map_to_city.mjs) is served at /city/ while developing
// and previewing; a deployed build serves the same files from its own /city/ folder. Other cities (tools/add_city.mjs, a manifest at
// data/cities/manifest.json) are Minneapolis-sized-down data sets served at /city/<slug>/ from data/cities/<slug>/.
const cityDir = process.env.CITY_DIR || (existsSync('data/city/city.json') ? 'data/city' : 'data/city_dt');
const serveCity = () => {
  const handler = (req, res, next) => {
    if (!req.url.startsWith('/city/')) return next();
    const rest = decodeURIComponent(req.url.slice(6).split('?')[0]);
    const m = /^([a-z0-9_-]+)\/(.+)$/.exec(rest);
    const file = rest === 'manifest.json' ? 'data/cities/manifest.json'
      : m && existsSync(`data/cities/${m[1]}`) ? `data/cities/${m[1]}/${m[2]}` : `${cityDir}/${rest}`;
    if (!existsSync(file) || file.includes('..')) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(readFileSync(file));
  };
  return { name: 'serve-city', configureServer(s) { s.middlewares.use(handler); }, configurePreviewServer(s) { s.middlewares.use(handler); } };
};

export default defineConfig({
  base: './',
  plugins: [viteSingleFile(), serveCity()],
  define: { __GOOGLE_KEY__: JSON.stringify(googleKey), __EMBED_CITY__: JSON.stringify(process.env.EMBED_CITY === '1') },
  build: { chunkSizeWarningLimit: 6000 },
});
