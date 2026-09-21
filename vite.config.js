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

export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  define: { __GOOGLE_KEY__: JSON.stringify(googleKey) },
  build: { chunkSizeWarningLimit: 6000 },
});
