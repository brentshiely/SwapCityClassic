// The pistol: a hitscan shot (the bullet arrives at once). It travels along a line until it meets a building wall or a person, whichever is
// first. Pure maths (the wall test is a function you pass in), so it can be tested in Node.

export const PISTOL = { range: 48, interval: 0.24, clip: 12, reload: 1.4, victimRadius: 0.5 };

export class Pistol {
  constructor() { this.ammo = PISTOL.clip; this.cool = 0; this.reloading = 0; this.shots = 0; }

  update(dt) {
    this.cool = Math.max(0, this.cool - dt);
    if (this.reloading > 0) { this.reloading -= dt; if (this.reloading <= 0) this.ammo = PISTOL.clip; }
  }

  /** can a shot go off now? */
  ready() { return this.cool <= 0 && this.reloading <= 0; }

  /** fire; returns false if not ready. Starts a reload when the clip is empty. */
  fire() {
    if (!this.ready()) return false;
    this.ammo--; this.cool = PISTOL.interval; this.shots++;
    if (this.ammo <= 0) this.reloading = PISTOL.reload;
    return true;
  }
}

/**
 * Trace a shot from (x, y) along `angle`. `blocked(x, y)` says whether a point is inside a wall; `targets` are things with {x, y} (people);
 * returns { x, y, dist, target } where (x, y) is where the bullet ends and `target` the person hit (or null).
 */
export function hitscan(x, y, angle, blocked, targets, range = PISTOL.range, radius = PISTOL.victimRadius) {
  const dx = Math.cos(angle), dy = Math.sin(angle);
  let wall = range;
  for (let d = 0.5; d <= range; d += 0.5) if (blocked(x + dx * d, y + dy * d)) { wall = d; break; }
  let best = null, bd = wall;
  for (const t of targets) {
    const rx = t.x - x, ry = t.y - y, along = rx * dx + ry * dy;
    if (along < 0 || along > bd) continue;
    const off = Math.abs(-rx * dy + ry * dx);
    if (off > radius) continue;
    const hitAt = along - Math.sqrt(Math.max(0, radius * radius - off * off));
    if (hitAt < bd) { bd = Math.max(0, hitAt); best = t; }
  }
  return { x: x + dx * bd, y: y + dy * bd, dist: bd, target: best };
}
