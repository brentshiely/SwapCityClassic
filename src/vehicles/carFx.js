import { DAMAGE } from './damage.js';

// Smoke and fire from a damaged car, and the blast when it explodes: small particle systems drawn with one Graphics object.
export class CarFx {
  constructor(scene) {
    this.g = scene.add.graphics().setDepth(7.5);
    this.p = []; // smoke and flame particles
    this.blast = null; // { x, y, t }
    this.acc = 0;
  }

  /** @param car the car (x, y, heading); @param dmg its CarDamage; @param visible false when the car is a wreck or gone */
  update(dt, car, dmg, visible) {
    if (visible && !dmg.exploded && dmg.smoke > 0) {
      this.acc += dt * (14 + 30 * dmg.smoke);
      const cs = Math.cos(car.heading), sn = Math.sin(car.heading);
      while (this.acc >= 1) {
        this.acc -= 1;
        const jx = (Math.random() - 0.5) * 0.7, jy = (Math.random() - 0.5) * 0.7;
        const x = car.x + cs * 1.5 - sn * jy, y = car.y + sn * 1.5 + cs * jy;
        if (dmg.onFire && Math.random() < 0.5) this.p.push({ x, y, vx: jx * 0.6, vy: jy * 0.6, r: 0.35, t: 0, life: 0.45, fire: true });
        else this.p.push({ x, y, vx: jx * 0.5 + (Math.random() - 0.5) * 0.8, vy: jy * 0.5 - 0.6, r: 0.4, t: 0, life: 1.6 + Math.random(), fire: false, dark: dmg.onFire ? 0.16 : 0.32 });
      }
    }
    const g = this.g;
    g.clear();
    for (const q of this.p) {
      q.t += dt; q.x += q.vx * dt; q.y += q.vy * dt;
      const k = q.t / q.life;
      if (q.fire) { g.fillStyle(k < 0.4 ? 0xffd24a : 0xff6a1a, 0.8 * (1 - k)); g.fillCircle(q.x, q.y, q.r * (1 + k * 0.6)); }
      else { const c = Math.round(255 * q.dark); g.fillStyle((c << 16) | (c << 8) | c, 0.6 * (1 - k)); g.fillCircle(q.x, q.y, q.r * (1 + k * 3.2)); }
    }
    this.p = this.p.filter((q) => q.t < q.life);
    if (this.blast) {
      const b = this.blast; b.t += dt;
      const k = b.t / 0.7;
      if (k >= 1) this.blast = null;
      else {
        g.fillStyle(0xfff0b0, 0.9 * (1 - k)); g.fillCircle(b.x, b.y, 2.5 + 7 * k);
        g.fillStyle(0xff8a20, 0.7 * (1 - k)); g.fillCircle(b.x, b.y, 1.5 + 5.5 * k);
        g.fillStyle(0x3a3a3a, 0.4 * (1 - k * k)); g.fillCircle(b.x, b.y - 2 * k, 3 + 8 * k);
      }
    }
  }

  explode(x, y) { this.blast = { x, y, t: 0 }; for (let i = 0; i < 30; i++) this.p.push({ x, y, vx: (Math.random() - 0.5) * 9, vy: (Math.random() - 0.5) * 9, r: 0.5, t: 0, life: 1.2 + Math.random(), fire: i % 3 === 0, dark: 0.12 }); }
}

export const BLAST_RADIUS = 9;
export { DAMAGE };
