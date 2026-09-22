// Code-drawn top-down sprites for the traffic: four body types in a palette of muted colours.
// Same style as the player's red sedan. Sprite forward = +x (right). Placeholder art, like the rest.

const PPM = 24; // texture pixels per metre
const PAD = 6;

const parse = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const shade = (hex, k) => { const [r, g, b] = parse(hex).map((v) => Math.max(0, Math.min(255, Math.round(v * k)))); return `rgb(${r},${g},${b})`; };

function newCanvas(length, width) {
  const w = Math.round(length * PPM), h = Math.round(width * PPM);
  const c = document.createElement('canvas');
  c.width = w + PAD * 2; c.height = h + PAD * 2;
  const g = c.getContext('2d');
  g.translate(PAD, PAD);
  return { c, g, w, h };
}

function drawBody({ g, w, h }, type, color) {
  const rr = (x, y, ww, hh, r) => { g.beginPath(); g.roundRect(x, y, ww, hh, r); };
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, shade(color, 1.18)); grad.addColorStop(0.5, color); grad.addColorStop(1, shade(color, 0.78));
  rr(0, 0, w, h, type === 'van' ? 8 : 11); g.fillStyle = grad; g.fill();
  g.lineWidth = 1.6; g.strokeStyle = shade(color, 0.35); g.stroke();
  const glass = '#1c2b3a', dark = 'rgba(30,10,10,0.45)';

  if (type === 'van') {
    g.fillStyle = shade(color, 0.93); rr(w * 0.08, 4, w * 0.62, h - 8, 5); g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.22)'; g.lineWidth = 1; g.stroke();
    g.beginPath(); g.moveTo(w * 0.39, 6); g.lineTo(w * 0.39, h - 6); g.stroke(); // roof seam
    g.fillStyle = glass; g.beginPath(); g.moveTo(w * 0.72, 5); g.lineTo(w * 0.83, 8); g.lineTo(w * 0.83, h - 8); g.lineTo(w * 0.72, h - 5); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.25)'; g.beginPath(); g.moveTo(w * 0.05, 5); g.lineTo(w * 0.05, h - 5); g.stroke(); // rear doors
  } else if (type === 'pickup') {
    g.fillStyle = '#3a3d40'; rr(w * 0.04, 5, w * 0.34, h - 10, 3); g.fill(); // load bed
    g.strokeStyle = shade(color, 0.6); g.lineWidth = 2; g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(w * 0.06, 8, w * 0.3, h - 16);
    g.fillStyle = glass; g.beginPath(); g.moveTo(w * 0.62, 5); g.lineTo(w * 0.72, 8); g.lineTo(w * 0.72, h - 8); g.lineTo(w * 0.62, h - 5); g.closePath(); g.fill();
    g.fillStyle = shade(color, 0.92); rr(w * 0.42, 5, w * 0.2, h - 10, 5); g.fill(); // cab roof
    g.fillStyle = glass; g.fillRect(w * 0.40, 8, 3, h - 16); // rear cab window
  } else {
    // compact and sedan share a layout; the compact is a little more upright
    const r0 = type === 'compact' ? 0.27 : 0.31, r1 = type === 'compact' ? 0.62 : 0.60;
    g.fillStyle = glass;
    g.beginPath(); g.moveTo(w * 0.60, 5); g.lineTo(w * 0.70, 8); g.lineTo(w * 0.70, h - 8); g.lineTo(w * 0.60, h - 5); g.closePath(); g.fill();
    g.beginPath(); g.moveTo(w * 0.30, 6); g.lineTo(w * 0.24, 9); g.lineTo(w * 0.24, h - 9); g.lineTo(w * 0.30, h - 6); g.closePath(); g.fill();
    g.fillStyle = shade(color, 0.9); rr(w * r0, 5, w * (r1 - r0), h - 10, 6); g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 1; g.stroke();
  }
  g.fillStyle = 'rgba(160,200,230,0.3)'; g.fillRect(w * 0.615, 10, 3, h - 20);
  // bumpers, mirrors, lights
  g.fillStyle = dark; g.fillRect(w - 5, 5, 3, h - 10); g.fillRect(2, 5, 3, h - 10);
  g.fillStyle = shade(color, 0.6); g.fillRect(w * 0.60, -2, 6, 4); g.fillRect(w * 0.60, h - 2, 6, 4);
  g.fillStyle = '#fff2b0'; g.fillRect(w - 7, 4, 5, 6); g.fillRect(w - 7, h - 10, 5, 6);
  g.fillStyle = '#5a0d0d'; g.fillRect(2, 4, 4, 6); g.fillRect(2, h - 10, 4, 6);
}

/** Make a texture for every body type in every colour, plus each type's shadow and brake lights. */
export function makeNpcTextures(scene, types, colors) {
  for (const t of types) {
    const s = newCanvas(t.length, t.width);
    s.g.fillStyle = 'rgba(0,0,0,0.38)'; s.g.beginPath(); s.g.roundRect(0, 0, s.w, s.h, 11); s.g.fill();
    scene.textures.addCanvas(`npc_shadow_${t.name}`, s.c);

    const b = newCanvas(t.length, t.width);
    b.g.shadowColor = 'rgba(255,60,40,0.9)'; b.g.shadowBlur = 8;
    b.g.fillStyle = '#ff3a2a'; b.g.fillRect(2, 4, 4, 6); b.g.fillRect(2, b.h - 10, 4, 6);
    scene.textures.addCanvas(`npc_brake_${t.name}`, b.c);

    colors.forEach((color, i) => {
      const body = newCanvas(t.length, t.width);
      drawBody(body, t.name, color);
      scene.textures.addCanvas(`npc_${t.name}_${i}`, body.c);
    });
  }
}

export const spriteSize = (t) => [(t.length * PPM + PAD * 2) / PPM, (t.width * PPM + PAD * 2) / PPM];
