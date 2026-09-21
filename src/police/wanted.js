// The wanted level: crimes add "heat", heat is shown as 0 to 5 stars, and it cools off when the police have not been near for a while.
// Pure logic, no Phaser.

export const HEAT = { shot: 4, kill: 30, jack: 22, policeHit: 20 }; // what each crime adds
export const STAR_AT = [0, 20, 60, 120, 200, 300]; // heat needed for 0..5 stars
export const MAX_HEAT = 340;
const COOL_AFTER = 7; // seconds with no police close before the heat starts to fall
const COOL_RATE = 6; // heat per second while lying low
const CLOSE = 70; // metres: a police car this near keeps the heat on

export class Wanted {
  constructor() { this.heat = 0; this.unseen = 0; }

  get stars() { let s = 0; for (let i = 1; i < STAR_AT.length; i++) if (this.heat >= STAR_AT[i]) s = i; return s; }

  add(kind, times = 1) { this.heat = Math.min(MAX_HEAT, this.heat + (HEAT[kind] ?? 0) * times); this.unseen = 0; }

  clear() { this.heat = 0; this.unseen = 0; }

  /** @param nearestPolice metres to the closest police car (Infinity if none) */
  update(dt, nearestPolice) {
    if (this.heat <= 0) return;
    if (nearestPolice < CLOSE) { this.unseen = 0; this.heat = Math.max(0, this.heat - 0.4 * dt); return; } // a slow simmer even in sight
    this.unseen += dt;
    if (this.unseen > COOL_AFTER) this.heat = Math.max(0, this.heat - COOL_RATE * dt);
  }
}
