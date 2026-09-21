// Car damage: hits take health, health shows as four levels (fine, dented, smoking, burning), a damaged car is weaker, a burning one explodes.
// Pure logic, no Phaser.

export const DAMAGE = {
  minHit: 2.5, // m/s of speed lost in one moment that counts as a hit (a bump does nothing)
  fireBelow: 22, // health under this: on fire
  burnRate: 2.2, // health lost per second while burning
  explodeDelay: 1.2, // seconds between health reaching zero and the blast
};

export class CarDamage {
  constructor() { this.reset(); }

  reset() { this.hp = 100; this.exploded = false; this.dying = 0; this.hits = 0; }

  /** 0 fine, 1 dented, 2 smoking, 3 burning */
  get level() { return this.hp > 75 ? 0 : this.hp > 50 ? 1 : this.hp > DAMAGE.fireBelow ? 2 : 3; }

  /** how much of its performance the car still has */
  get power() { return [1, 0.97, 0.88, 0.7][this.level]; }
  get grip() { return [1, 1, 0.94, 0.85][this.level]; }

  /** the speed lost in one moment (m/s); returns the health it cost */
  hit(speedLost) {
    if (this.exploded || speedLost < DAMAGE.minHit) return 0;
    const cost = Math.min(70, 1.3 * (speedLost - DAMAGE.minHit + 1) ** 1.35);
    this.hp = Math.max(0, this.hp - cost);
    this.hits++;
    return cost;
  }

  /** every frame; returns true on the frame the car blows up */
  update(dt) {
    if (this.exploded) return false;
    if (this.level === 3 && this.hp > 0) this.hp = Math.max(0, this.hp - DAMAGE.burnRate * dt);
    if (this.hp <= 0) {
      this.dying += dt;
      if (this.dying >= DAMAGE.explodeDelay) { this.exploded = true; return true; }
    }
    return false;
  }

  /** a paint shop */
  repair() { this.hp = 100; this.dying = 0; }

  /** how thick the smoke is, 0..1 (none when fine) */
  get smoke() { return [0, 0, 0.45, 1][this.level]; }
  get onFire() { return this.level === 3; }
}
