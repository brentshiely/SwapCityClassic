// Arcade car handling, GTA1 style. Pure maths, no Phaser: metres, seconds, radians.
// World frame: x right, y down, heading 0 = facing +x, positive heading turns clockwise on screen.

export const CAR = {
  length: 4.5,
  width: 1.9,
  vMax: 20, // m/s, about 72 km/h
  accel: 7.5, // m/s^2 from a standstill, tapering to zero at vMax
  brake: 22, // m/s^2
  reverseMax: 7, // m/s, about 25 km/h
  reverseAccel: 4,
  coast: 2.2, // m/s^2 of rolling drag with no throttle
  airDrag: 0.004, // m/s^2 per (m/s)^2
  grip: 9, // 1/s: how fast sideways speed is killed (higher = less slide)
  gripKeep: 0.7, // share of the sideways speed the tyres remove that becomes speed along the car instead of being lost
  handbrakeGrip: 1.3,
  handbrakeDecel: 5,
  turnMax: 2.6, // rad/s at low speed
  steerRise: 6, // 1/s: how quickly the wheel turns toward the input
  steerReturn: 9,
};

export class Car {
  constructor(x = 0, y = 0, heading = 0) {
    this.reset(x, y, heading);
  }

  reset(x, y, heading) {
    this.x = x; this.y = y; this.heading = heading;
    this.vx = 0; this.vy = 0;
    this.steer = 0; // -1..1, smoothed
    this.yawRate = 0;
    // read-only results of the last step, for the view and the skid marks
    this.forwardSpeed = 0; this.sideSpeed = 0; this.braking = false; this.handbraking = false;
  }

  get speed() { return Math.hypot(this.vx, this.vy); }

  /** input: { throttle: 0..1, brake: 0..1, steer: -1..1, handbrake: bool } */
  step(input, dt) {
    const C = CAR;

    // wheel position eases toward the input
    const target = input.steer;
    const rate = Math.abs(target) > Math.abs(this.steer) || Math.sign(target) !== Math.sign(this.steer) ? C.steerRise : C.steerReturn;
    const d = target - this.steer;
    this.steer += Math.sign(d) * Math.min(Math.abs(d), rate * dt);

    // velocity in the car's own frame before turning
    let f = Math.cos(this.heading), s = Math.sin(this.heading);
    let vf = this.vx * f + this.vy * s;

    // yaw: only while moving, gentler when fast, reversed when backing up
    const turn = C.turnMax * Math.min(1, Math.abs(vf) / 2.5) * (1 - 0.5 * Math.min(1, Math.abs(vf) / C.vMax));
    this.yawRate = this.steer * turn * Math.sign(vf) * (input.handbrake ? 1.4 : 1);
    this.heading += this.yawRate * dt;

    // re-express the (unchanged) world velocity in the new frame: the difference is the slide
    f = Math.cos(this.heading); s = Math.sin(this.heading);
    vf = this.vx * f + this.vy * s;
    let vl = this.vx * -s + this.vy * f;

    // throttle, brake, reverse, drag
    this.braking = false;
    if (input.throttle > 0 && vf > -0.5) {
      vf += C.accel * input.throttle * Math.max(0, 1 - (vf / C.vMax) ** 2) * dt;
    } else if (input.throttle > 0) {
      vf += C.brake * dt; this.braking = true; // pressing forward while rolling backward
    }
    if (input.brake > 0) {
      if (vf > 0.5) { vf = Math.max(0, vf - C.brake * input.brake * dt); this.braking = true; }
      else vf = Math.max(-C.reverseMax, vf - C.reverseAccel * input.brake * dt);
    }
    if (input.throttle === 0 && input.brake === 0) {
      const drag = (C.coast + C.airDrag * vf * vf) * dt;
      vf -= Math.sign(vf) * Math.min(Math.abs(vf), drag);
    }
    this.handbraking = !!input.handbrake && Math.abs(vf) > 0.5;
    if (this.handbraking) {
      vf -= Math.sign(vf) * Math.min(Math.abs(vf), C.handbrakeDecel * dt);
      this.braking = true;
    }
    // sideways grip: the slide fades out exponentially, and most of what is removed is not lost but
    // carried into the direction the car now points (so a drift ends in a car still moving, like GTA)
    const removed = vl * (1 - Math.exp(-(input.handbrake ? C.handbrakeGrip : C.grip) * dt));
    vl -= removed;
    vf += Math.abs(removed) * C.gripKeep * (vf >= 0 ? 1 : -1);

    vf = Math.min(vf, C.vMax * 1.02);
    this.vx = vf * f - vl * s;
    this.vy = vf * s + vl * f;
    this.forwardSpeed = vf; this.sideSpeed = vl;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
  }
}
