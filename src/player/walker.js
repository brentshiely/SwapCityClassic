// The player on foot: a small circle that walks and runs, turns to face where it goes, and is stopped by walls (buildings, the shore, the
// city limit, rails) exactly as the car is. Pure maths, no Phaser, so it can be tested in Node.

export const FOOT = { walk: 3.4, run: 6.8, accel: 22, radius: 0.42 }; // m/s, m/s, m/s^2, m

export class Walker {
  constructor(x = 0, y = 0, heading = 0) {
    this.x = x; this.y = y; this.heading = heading;
    this.vx = 0; this.vy = 0; this.layer = 0;
    this.dist = 0; // metres walked, for the two-frame walking animation
  }

  get speed() { return Math.hypot(this.vx, this.vy); }

  /** @param input {x, y, run}: x and y are -1..1 (a direction on the screen, y down), run holds Shift */
  step(input, dt) {
    let ix = input.x, iy = input.y;
    const l = Math.hypot(ix, iy);
    if (l > 1) { ix /= l; iy /= l; }
    const top = input.run ? FOOT.run : FOOT.walk;
    const wx = ix * top, wy = iy * top; // the velocity wanted
    const dx = wx - this.vx, dy = wy - this.vy, d = Math.hypot(dx, dy), a = FOOT.accel * dt;
    if (d <= a || d < 1e-9) { this.vx = wx; this.vy = wy; } else { this.vx += (dx / d) * a; this.vy += (dy / d) * a; }
    this.x += this.vx * dt; this.y += this.vy * dt;
    this.dist += this.speed * dt;
    if (l > 0.1) this.heading = Math.atan2(iy, ix);
  }
}
