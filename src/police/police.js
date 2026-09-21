import { Wanted } from './wanted.js';

// The police: at 1 star a patrol car comes, more stars bring more cars, all racing along the streets toward the player (TrafficSim's
// `police` cars route to `traffic.target`). A car that gets close and stays there arrests ("busts") the player. Lose them for a while and the
// stars fade; at 0 stars the cars drive off out of sight.

export const FORCE = [0, 1, 2, 3, 5, 6]; // police cars for 0..5 stars
const BUST_RANGE = 3.4; // metres
const BUST_TIME = 2.2; // seconds close and (nearly) still
const SPAWN_EVERY = 3.5; // seconds between new cars
const STAND_DOWN = 12; // seconds at 0 stars before the cars leave

export class PoliceManager {
  /** @param traffic the TrafficSim; the police cars are cars of it with `police` set */
  constructor(traffic) {
    this.traffic = traffic;
    this.wanted = new Wanted();
    this.cool = 0; this.close = 0; this.idle = 0;
    this.nearest = Infinity;
    this.busted = 0;
  }

  get cars() { return this.traffic.cars.filter((c) => c.police && !c.dead); }

  /**
   * @param player {x, y, vx, vy, layer, inCar}
   * @param view what the player can see (cars appear outside it)
   * @returns 'busted' on the frame the player is arrested, else null
   */
  update(dt, player, view) {
    const t = this.traffic, w = this.wanted, cars = this.cars;
    t.target = w.stars > 0 ? { x: player.x, y: player.y } : null;
    let nearest = Infinity;
    for (const c of cars) nearest = Math.min(nearest, Math.hypot(c.x - player.x, c.y - player.y));
    this.nearest = nearest;
    w.update(dt, nearest);

    // the force: more cars for more stars; they are called in from out of sight
    const want = FORCE[w.stars];
    this.cool -= dt;
    if (cars.length < want && this.cool <= 0) {
      if (t.spawnPolice(player.x, player.y, view)) this.cool = SPAWN_EVERY; else this.cool = 1; // no street free right now: try again soon
    }
    // stand down: with no stars the cars leave once nobody can see them
    if (w.stars === 0) {
      this.idle += dt;
      if (this.idle > STAND_DOWN) for (const c of cars) if (!t.visible(c.x, c.y, view, 30)) c.dead = true;
    } else this.idle = 0;

    // arrest: a police car close to a player who is on foot or nearly stopped
    const speed = Math.hypot(player.vx ?? 0, player.vy ?? 0), still = !player.inCar || speed < 4;
    const near = w.stars > 0 && cars.some((c) => (c.layer | 0) === (player.layer | 0) && Math.hypot(c.x - player.x, c.y - player.y) < BUST_RANGE + (player.inCar ? 1.6 : 0.6) && c.v < 6);
    this.close = near && still ? this.close + dt : Math.max(0, this.close - dt * 1.5);
    if (this.close > BUST_TIME) { this.close = 0; this.busted++; return 'busted'; }
    return null;
  }

  /** after an arrest: the police go, the stars clear */
  reset() { for (const c of this.cars) c.dead = true; this.wanted.clear(); this.close = 0; this.traffic.target = null; }
}
