// Tunable numbers for the feel of the game. The defaults are the approved ones; the settings panel (press T)
// changes them live and remembers them in this browser (localStorage), so tuning also works on the plane.

export const DEFAULTS = {
  zoomNear: 20, zoomFar: 12, lookahead: 0.45,
  vMax: 20, accel: 7.5, grip: 9, handbrakeGrip: 1.3, turnMax: 2.6,
  camHeight: 300, cars: 16, peds: 80,
};

export const SPEC = [
  { group: 'Camera', items: [
    { key: 'zoomNear', label: 'Zoom when slow', unit: 'px/m', min: 8, max: 70, step: 1, hint: 'higher = closer' },
    { key: 'zoomFar', label: 'Zoom at top speed', unit: 'px/m', min: 5, max: 50, step: 1, hint: 'lower = sees further ahead' },
    { key: 'lookahead', label: 'Look ahead', unit: 's', min: 0, max: 1.2, step: 0.05, hint: 'how far the view leads the car' },
  ] },
  { group: 'Driving', items: [
    { key: 'vMax', label: 'Top speed', unit: 'm/s', min: 8, max: 40, step: 1, hint: '20 = 72 km/h' },
    { key: 'accel', label: 'Acceleration', unit: 'm/s2', min: 3, max: 16, step: 0.5, hint: 'punch off the line' },
    { key: 'grip', label: 'Tyre grip', unit: '', min: 3, max: 20, step: 0.5, hint: 'lower = more slide' },
    { key: 'handbrakeGrip', label: 'Handbrake grip', unit: '', min: 0.3, max: 6, step: 0.1, hint: 'lower = bigger powerslide' },
    { key: 'turnMax', label: 'Steering rate', unit: 'rad/s', min: 1.2, max: 4.5, step: 0.1, hint: 'how sharply it turns' },
  ] },
  { group: 'World', items: [
    { key: 'camHeight', label: 'Camera height', unit: 'm', min: 60, max: 700, step: 10, hint: 'lower = buildings loom more; taller ones pass the lens' },
    { key: 'cars', label: 'Traffic', unit: 'cars', min: 0, max: 40, step: 1, hint: 'cars on the map' },
    { key: 'peds', label: 'Crowd', unit: 'people', min: 0, max: 200, step: 5, hint: 'people around you' },
  ] },
];

export const CAMERA_PRESETS = {
  'GTA1 tight': { zoomNear: 34, zoomFar: 20, lookahead: 0.35 },
  'Current': { zoomNear: 20, zoomFar: 12, lookahead: 0.45 },
  'Wide': { zoomNear: 14, zoomFar: 9, lookahead: 0.5 },
};

const KEY = 'swapcityclassic.settings.v1';
const clean = (o) => {
  const out = {};
  for (const g of SPEC) for (const it of g.items) {
    const v = Number(o?.[it.key]);
    out[it.key] = Number.isFinite(v) ? Math.min(it.max, Math.max(it.min, v)) : DEFAULTS[it.key];
  }
  return out;
};

export function loadSettings() {
  try { return clean(JSON.parse(localStorage.getItem(KEY) ?? '{}')); } catch { return { ...DEFAULTS }; }
}
export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private window etc.: still works, just not remembered */ }
}
