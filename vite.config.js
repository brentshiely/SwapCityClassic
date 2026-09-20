import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// The build is one self-contained index.html so it opens straight from disk
// (file://) with no server and no internet, e.g. on the plane.
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  build: { chunkSizeWarningLimit: 2000 },
});
