import { SKINS, CLOTHES } from './pedSim.js';

// Code-drawn top-down pedestrians: shoulders in a clothing colour, a head, arms and feet that swap
// between two frames as they walk. Facing +x. Placeholder art, like the cars.

const PPM = 32; // texture pixels per metre
const SIZE = 44; // texture size in pixels
export const PED_SPRITE_M = SIZE / PPM;

const parse = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const shade = (hex, k) => { const [r, g, b] = parse(hex).map((v) => Math.max(0, Math.min(255, Math.round(v * k)))); return `rgb(${r},${g},${b})`; };
const HAIR = ['#2a1d14', '#4a3222', '#1a1a1a', '#8a6a3a', '#b8b8b0'];

export function pedTextureKey(scene, clothes, skin, frame, hair) {
  const key = `ped_${clothes}_${skin}_${hair}_${frame}`;
  if (scene.textures.exists(key)) return key;
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const g = c.getContext('2d');
  g.translate(SIZE / 2, SIZE / 2);
  const m = (v) => v * PPM;
  const oval = (x, y, rx, ry, fill, stroke) => { g.beginPath(); g.ellipse(m(x), m(y), m(rx), m(ry), 0, 0, Math.PI * 2); g.fillStyle = fill; g.fill(); if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1; g.stroke(); } };
  const s = frame === 0 ? 1 : -1; // which foot is forward
  const cloth = CLOTHES[clothes], skinCol = SKINS[skin];
  // feet
  oval(0.2 * s, 0.11, 0.11, 0.06, '#1b1b1b'); oval(-0.2 * s, -0.11, 0.11, 0.06, '#1b1b1b');
  // arms swing opposite to the feet
  oval(-0.14 * s, 0.27, 0.15, 0.065, shade(cloth, 0.8)); oval(0.14 * s, -0.27, 0.15, 0.065, shade(cloth, 0.8));
  oval(-0.27 * s, 0.27, 0.05, 0.05, skinCol); oval(0.27 * s, -0.27, 0.05, 0.05, skinCol);
  // torso and head
  oval(0, 0, 0.14, 0.26, cloth, shade(cloth, 0.5));
  oval(0.01, 0, 0.13, 0.13, HAIR[hair]);
  oval(0.04, 0, 0.115, 0.115, skinCol);
  scene.textures.addCanvas(key, c);
  return key;
}

export function makePedShadow(scene) {
  if (scene.textures.exists('ped_shadow')) return;
  const c = document.createElement('canvas');
  c.width = 40; c.height = 24;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(0,0,0,0.32)';
  g.beginPath(); g.ellipse(20, 12, 15, 8, 0, 0, Math.PI * 2); g.fill();
  scene.textures.addCanvas('ped_shadow', c);
}
