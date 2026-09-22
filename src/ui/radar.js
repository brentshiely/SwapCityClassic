// The radar: a round map in the corner, north-up like the main view (the map is turned so the streets run straight, and so does the radar),
// showing the streets and water around the player and where to go: the current objective (pink, with an arrow on the rim when it is beyond
// the range), the phone to answer (yellow) and paint shops (green).

const SIZE = 176, RANGE = 380; // pixels, metres from the middle to the rim
const BASE = SIZE * 1.7; // the street picture is drawn this big (in CSS pixels), so it can slide a good way before it is redrawn

export class Radar {
  constructor(world) {
    this.world = world;
    this.c = document.createElement('canvas');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.c.width = this.c.height = SIZE * dpr;
    this.c.style.cssText = `position:fixed;left:14px;bottom:64px;width:${SIZE}px;height:${SIZE}px;border-radius:50%;pointer-events:none;box-shadow:0 0 0 2px rgba(220,226,230,0.55), 0 3px 10px rgba(0,0,0,0.5);`;
    document.body.appendChild(this.c);
    this.g = this.c.getContext('2d');
    this.g.scale(dpr, dpr);
    this.t = 0; this.base = null; this.baseAt = null;
  }

  /** the streets and water, redrawn only when the player has moved a fair way (they are the same picture between) */
  drawBase(x, y) {
    const b = document.createElement('canvas'), dpr = this.c.width / SIZE;
    b.width = b.height = Math.round(BASE * dpr);
    const g = b.getContext('2d');
    g.scale(dpr, dpr);
    const S = SIZE / 2 / RANGE, Rm = (BASE / 2) / S; // metres from the middle to the edge of the picture
    g.translate(BASE / 2, BASE / 2); g.scale(S, S); g.translate(-x, -y);
    g.fillStyle = 'rgba(38,46,50,1)'; g.fillRect(x - Rm, y - Rm, 2 * Rm, 2 * Rm);
    // water
    g.fillStyle = 'rgba(52,96,128,1)';
    for (const w of this.world.waterIn(x - Rm, y - Rm, x + Rm, y + Rm)) {
      g.beginPath();
      for (const ring of [w.outer, ...w.holes]) { g.moveTo(ring[0][0], ring[0][1]); for (let i = 1; i < ring.length; i++) g.lineTo(ring[i][0], ring[i][1]); g.closePath(); }
      g.fill('evenodd');
    }
    // streets: freeways brighter and wider
    g.lineJoin = 'round'; g.lineCap = 'round';
    const edges = this.world.edgesNear(x, y, Rm).filter((e) => (e.layer | 0) >= 0);
    const draw = (list, color, width) => {
      g.strokeStyle = color; g.lineWidth = width / S;
      g.beginPath();
      for (const e of list) { g.moveTo(e.points[0][0], e.points[0][1]); for (let i = 1; i < e.points.length; i++) g.lineTo(e.points[i][0], e.points[i][1]); }
      g.stroke();
    };
    const big = (e) => /^(motorway|trunk)/.test(e.highway ?? '');
    draw(edges.filter((e) => !big(e) && (e.lanes ?? 2) < 4), 'rgba(150,160,166,0.9)', 1.1);
    draw(edges.filter((e) => !big(e) && (e.lanes ?? 2) >= 4), 'rgba(196,204,208,0.95)', 1.7);
    draw(edges.filter(big), 'rgba(255,214,120,0.95)', 2.3);
    this.base = b; this.baseAt = { x, y };
  }

  /**
   * @param s { x, y, heading, target: {x, y} | null, phone: {x, y} | null, shops: [{x, y}], t }
   */
  update(dt, s) {
    this.t += dt;
    if (!this.baseAt || Math.hypot(s.x - this.baseAt.x, s.y - this.baseAt.y) > RANGE * 0.3) this.drawBase(s.x, s.y);
    const g = this.g, S = SIZE / 2 / RANGE, half = SIZE / 2;
    g.clearRect(0, 0, SIZE, SIZE);
    g.save();
    g.beginPath(); g.arc(half, half, half - 1, 0, Math.PI * 2); g.clip();
    // the base picture, shifted by how far the player has moved since it was drawn
    const dpr = this.c.width / SIZE;
    g.drawImage(this.base, half - BASE / 2 - (s.x - this.baseAt.x) * S, half - BASE / 2 - (s.y - this.baseAt.y) * S, BASE, BASE);
    g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(0, 0, SIZE, SIZE);
    g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 1;
    g.beginPath(); g.arc(half, half, half * 0.5, 0, Math.PI * 2); g.stroke();
    const at = (p) => ({ x: half + (p.x - s.x) * S, y: half + (p.y - s.y) * S });
    // a blip inside the radar as a dot; outside, an arrow on the rim
    const blip = (p, color, r, arrow) => {
      const a = at(p), dx = a.x - half, dy = a.y - half, d = Math.hypot(dx, dy);
      if (d <= half - 6) { g.fillStyle = color; g.beginPath(); g.arc(a.x, a.y, r, 0, Math.PI * 2); g.fill(); g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 1; g.stroke(); return; }
      if (!arrow) return;
      const ang = Math.atan2(dy, dx), rx = half + Math.cos(ang) * (half - 8), ry = half + Math.sin(ang) * (half - 8);
      g.save(); g.translate(rx, ry); g.rotate(ang);
      g.fillStyle = color; g.strokeStyle = 'rgba(0,0,0,0.7)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(7, 0); g.lineTo(-5, 5.5); g.lineTo(-2, 0); g.lineTo(-5, -5.5); g.closePath(); g.fill(); g.stroke();
      g.restore();
    };
    for (const p of s.shops) blip(p, '#5fd48a', 3.2, false);
    if (s.phone) blip(s.phone, '#ffd84a', 4, true);
    if (s.target) { const pulse = 1 + 0.25 * Math.sin(this.t * 6); blip(s.target, '#ff5a9a', 4.6 * pulse, true); }
    // the player: a white arrow facing the way the car points
    g.save(); g.translate(half, half); g.rotate(s.heading);
    g.fillStyle = '#ffffff'; g.strokeStyle = 'rgba(0,0,0,0.8)'; g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(6.5, 0); g.lineTo(-4.5, 4.5); g.lineTo(-2, 0); g.lineTo(-4.5, -4.5); g.closePath(); g.fill(); g.stroke();
    g.restore();
    g.restore();
    // the distance to the objective, under the radar's rim
    if (s.target) {
      const d = Math.round(Math.hypot(s.target.x - s.x, s.target.y - s.y));
      g.fillStyle = 'rgba(14,18,20,0.75)'; g.fillRect(half - 30, SIZE - 20, 60, 16);
      g.fillStyle = '#ff9ac0'; g.font = '700 11px Menlo, monospace'; g.textAlign = 'center'; g.fillText(d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${d} m`, half, SIZE - 8);
    }
  }
}
