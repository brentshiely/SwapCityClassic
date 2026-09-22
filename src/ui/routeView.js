import { RoutePlanner, distanceFromRoute } from '../navigation/route.js';

// Draws the suggested way to the current objective as a glowing line laid over the streets, the way a GPS highlights a route.
// The line is recomputed only when it is actually needed (the objective changed, the driver strayed off it, or a while has
// passed since the target moved a good distance), never every frame: a route can touch thousands of graph nodes.

const RECOMPUTE_STRAY = 35; // metres off the line before it is recomputed (the driver took a different street)
const RECOMPUTE_EVERY = 4; // seconds, a ceiling so a slow drift back onto the line still gets a fresh route eventually
const RETARGET_DIST = 12; // metres the target has to move before that alone forces a new route (a walking target, not a fixed spot)
const COLOR = 0xff5a9a, COLOR_DIM = 0x8a3a5a; // the same pink as the objective ring, so the line and the target read as one thing
const WIDTH = 2.6;

export class RouteView {
  constructor(scene, world) {
    this.scene = scene;
    this.planner = new RoutePlanner(world);
    this.g = scene.add.graphics().setDepth(0.6); // over the road, under the markings' usual reading height (buildings sit much higher)
    this.route = null;
    this.target = null;
    this.since = 0;
    this.t = 0;
  }

  /** call every frame; target is {x, y} or null to clear the line */
  update(dt, x, y, target) {
    this.t += dt;
    if (!target) { if (this.route) { this.route = null; this.g.clear(); } this.target = null; return; }
    const moved = this.target && Math.hypot(target.x - this.target.x, target.y - this.target.y) > RETARGET_DIST;
    const stray = this.route ? distanceFromRoute(this.route, x, y) : Infinity;
    this.since += dt;
    if (!this.route || moved || stray > RECOMPUTE_STRAY || this.since > RECOMPUTE_EVERY) {
      this.target = { x: target.x, y: target.y };
      this.route = this.planner.find(x, y, target.x, target.y);
      this.since = 0;
    }
    this.draw();
  }

  draw() {
    const g = this.g;
    g.clear();
    if (!this.route || this.route.points.length < 2) return;
    const pts = this.route.points;
    const pulse = 0.75 + 0.25 * Math.sin(this.t * 3);
    g.lineStyle(WIDTH + 1.6, COLOR_DIM, 0.35);
    g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.strokePath();
    g.lineStyle(WIDTH, COLOR, 0.85 * pulse);
    g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.strokePath();
    // an arrowhead part-way along each street segment, showing the direction of travel
    let sinceArrow = 999;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
      sinceArrow += len;
      if (len < 0.5 || sinceArrow < 26) continue;
      sinceArrow = 0;
      const ux = dx / len, uy = dy / len, mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      g.fillStyle(COLOR, 0.9 * pulse);
      g.fillTriangle(mx + ux * 2.2, my + uy * 2.2, mx - ux * 1.4 - uy * 1.6, my - uy * 1.4 + ux * 1.6, mx - ux * 1.4 + uy * 1.6, my - uy * 1.4 - ux * 1.6);
    }
  }
}
