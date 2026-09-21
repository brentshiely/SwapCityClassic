import { Navigator } from '../world/navigation.js';

// Top-centre pill: the street you are on (both streets at a junction), where you are heading in words,
// the next cross street ahead, and a compass rose. The rose shows where TRUE north is on the screen (the map is
// turned 30 degrees so the streets run straight, so north is not straight up) and a needle for your direction.
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); parent?.appendChild(e); return e; };

export class NavHud {
  constructor(map) {
    this.nav = new Navigator(map);
    this.rot = map.meta.rotationDegrees;
    const root = this.root = document.createElement('div');
    root.id = 'nav';
    const svg = el('svg', { viewBox: '-32 -32 64 64', width: 64, height: 64, 'aria-hidden': 'true' });
    el('circle', { r: 30, fill: 'rgba(8,10,12,0.55)', stroke: '#6a7680', 'stroke-width': 1.5 }, svg);
    for (let i = 0; i < 16; i++) { // tick marks every 22.5 degrees, longer at the four points
      const a = ((i * 22.5 - this.rot) * Math.PI) / 180, r0 = i % 4 === 0 ? 24.5 : 27, r1 = 29;
      el('line', { x1: Math.sin(a) * r0, y1: -Math.cos(a) * r0, x2: Math.sin(a) * r1, y2: -Math.cos(a) * r1, stroke: '#8a959c', 'stroke-width': i % 4 === 0 ? 1.4 : 0.8 }, svg);
    }
    for (const [label, bearing] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
      const a = ((bearing - this.rot) * Math.PI) / 180;
      const t = el('text', { x: Math.sin(a) * 17.5, y: -Math.cos(a) * 17.5 + 3.6, 'text-anchor': 'middle', 'font-size': label === 'N' ? 11 : 9, 'font-weight': 700, fill: label === 'N' ? '#ff6a58' : '#c9d1d6', 'font-family': 'Arial, sans-serif' }, svg);
      t.textContent = label;
    }
    this.needle = el('g', {}, svg);
    el('polygon', { points: '0,-15 4.2,3 0,0.5 -4.2,3', fill: '#ffd24a', stroke: '#1a1400', 'stroke-width': 0.6 }, this.needle);
    el('circle', { r: 1.6, fill: '#1a1400' }, this.needle);
    root.appendChild(svg);
    const txt = document.createElement('div'); txt.className = 'txt';
    this.street = document.createElement('div'); this.street.className = 'street';
    this.sub = document.createElement('div'); this.sub.className = 'sub';
    txt.append(this.street, this.sub);
    root.appendChild(txt);
    document.body.appendChild(root);
    this.last = '';
  }

  update(car) {
    const r = this.nav.locate(car);
    this.needle.setAttribute('transform', `rotate(${(r.bearing - this.rot).toFixed(1)})`);
    const street = r.atJunction ?? r.street;
    let sub = `heading ${r.compass}  ${Math.round(r.bearing)}°`;
    if (r.next) {
      const m = Math.round(r.next.dist / 5) * 5;
      sub += r.next.edge ? `  ·  edge of the map ${m > 5 ? 'in ' + m + ' m' : 'now'}` : `  ·  next: ${r.next.name} ${m > 5 ? 'in ' + m + ' m' : 'now'}`;
    }
    const key = street + '|' + sub;
    if (key !== this.last) { this.last = key; this.street.textContent = street; this.sub.textContent = sub; }
  }
}
