// Debug plot: draws the raw OSM data in the game's rotated local frame with the proposed box on top.
// Usage: node tools/plot_box.mjs  ->  debug/box.svg
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const cfg = JSON.parse(await readFile('data/map_config.json', 'utf8'));
const raw = JSON.parse(await readFile(cfg.raw, 'utf8'));

const { lat: lat0, lon: lon0 } = cfg.origin;
const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
const ky = 110540;
const th = (cfg.rotationDegrees * Math.PI) / 180;
const c = Math.cos(th), s = Math.sin(th);
const toLocal = (p) => {
  const x = (p.lon - lon0) * kx, y = (p.lat - lat0) * ky;
  return [x * c - y * s, x * s + y * c];
};

const VIEW = { x0: -420, x1: 300, y0: -330, y1: 370 };
const ptsOf = (w) => w.geometry.map(toLocal).map(([x, y]) => `${x.toFixed(1)},${(-y).toFixed(1)}`).join(' ');

const roadStyle = {
  motorway: ['#7a6f9b', 14], motorway_link: ['#7a6f9b', 8], primary: ['#c98a3a', 12], secondary: ['#5a7f8f', 10],
  tertiary: ['#5a7f8f', 9], unclassified: ['#5a7f8f', 8], residential: ['#5a7f8f', 8], pedestrian: ['#3d8f6b', 9],
  living_street: ['#5a7f8f', 7], service: ['#8d979e', 3], footway: ['#b9c0c5', 1.2], cycleway: ['#b9c0c5', 1.2],
  steps: ['#b9c0c5', 1.2],
};

let bld = '', road = '', walk = '';
for (const w of raw.elements) {
  if (w.type !== 'way' || !w.geometry) continue;
  if (w.tags?.building) bld += `<polygon points="${ptsOf(w)}"/>`;
  else if (w.tags?.highway) {
    const [col, wd] = roadStyle[w.tags.highway] ?? ['#8d979e', 2];
    const line = `<polyline points="${ptsOf(w)}" stroke="${col}" stroke-width="${wd}"/>`;
    if (wd <= 3) walk += line; else road += line;
  }
}

const b = cfg.box;
const cx = (b.xMin + b.xMax) / 2, cy = (b.yMin + b.yMax) / 2;
// centre block = between Nicollet Mall (x=-121) and Marquette (x=6), 8th (y=-51) and 7th (y=79)
const cb = { x0: -121, x1: 6, y0: -51, y1: 79 };

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEW.x0} ${-VIEW.y1} ${VIEW.x1 - VIEW.x0} ${VIEW.y1 - VIEW.y0}" width="1080" height="1050" font-family="Arial, sans-serif">
<rect x="${VIEW.x0}" y="${-VIEW.y1}" width="${VIEW.x1 - VIEW.x0}" height="${VIEW.y1 - VIEW.y0}" fill="#e9ecee"/>
<g fill="#cfd5d9" stroke="#b3bbc0" stroke-width="0.6">${bld}</g>
<g fill="none" stroke-linecap="round" stroke-linejoin="round">${walk}${road}</g>
<rect x="${b.xMin}" y="${-b.yMax}" width="${b.xMax - b.xMin}" height="${b.yMax - b.yMin}" fill="rgba(230,172,0,0.10)" stroke="#e6ac00" stroke-width="3" stroke-dasharray="10 6"/>
<rect x="${cb.x0}" y="${-cb.y1}" width="${cb.x1 - cb.x0}" height="${cb.y1 - cb.y0}" fill="rgba(230,172,0,0.28)" stroke="none"/>
<g font-size="13" font-weight="bold" fill="#1a2025">
  <text x="${b.xMin}" y="${-b.yMax - 8}" text-anchor="start">LaSalle Ave</text>
  <text x="-121" y="${-b.yMax - 8}" text-anchor="middle">Nicollet Mall</text>
  <text x="6" y="${-b.yMax - 8}" text-anchor="middle">Marquette Ave</text>
  <text x="${b.xMax}" y="${-b.yMax - 8}" text-anchor="end">2nd Ave S</text>
  <text x="${b.xMin - 8}" y="${-204 + 4}" text-anchor="end">S 6th St</text>
  <text x="${b.xMin - 8}" y="${-79 + 4}" text-anchor="end">S 7th St</text>
  <text x="${b.xMin - 8}" y="${51 + 4}" text-anchor="end">S 8th St</text>
  <text x="${b.xMin - 8}" y="${169 + 4}" text-anchor="end">S 9th St</text>
  <text x="${(cb.x0 + cb.x1) / 2}" y="${-(cb.y0 + cb.y1) / 2 + 4}" text-anchor="middle" fill="#8a5200">IDS Center block</text>
</g>
<text x="${VIEW.x0 + 12}" y="${-VIEW.y1 + 24}" font-size="16" fill="#1a2025" font-weight="bold">Proposed 3x3 blocks, ${Math.round(b.xMax - b.xMin)} m x ${Math.round(b.yMax - b.yMin)} m. Map rotated ${cfg.rotationDegrees} deg so streets run straight.</text>
</svg>`;

await mkdir('debug', { recursive: true });
await writeFile('debug/box.svg', svg);
console.log('Wrote debug/box.svg');
