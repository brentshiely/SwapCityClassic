# SwapCityClassic

A top-down, GTA1-style driving game on real OpenStreetMap streets of downtown Minneapolis.
Runs entirely in the browser with no internet. Built for the flight to India, 2026-09-28.

The story board is `design/BACKLOG.md` (the drag-to-reorder version lives in the Claude Artifact).

## Run

    npm install
    npm run dev       # dev server with hot reload
    npm run build     # writes dist/index.html, one self-contained file
    npm run preview   # serve the build over http

`dist/index.html` needs nothing else: double-click it, or open it from Finder, with Wi-Fi off.
