import Phaser from 'phaser';

// Keyboard (arrows or WASD) turned into the input the car physics wants.
// `?autopilot` plays a short scripted drive instead, so the handling can be tested without hands.
export class DriveInput {
  constructor(scene) {
    const kb = scene.input.keyboard;
    this.keys = kb.addKeys({ up: 'UP', down: 'DOWN', left: 'LEFT', right: 'RIGHT', w: 'W', s: 'S', a: 'A', d: 'D', space: 'SPACE', r: 'R' });
    this.autopilot = new URLSearchParams(location.search).has('autopilot');
    this.t = 0;
  }

  /** true once when R is pressed */
  resetPressed() { return Phaser.Input.Keyboard.JustDown(this.keys.r); }

  read(dt) {
    if (this.autopilot) return this.script((this.t += dt));
    const k = this.keys;
    const steer = (k.right.isDown || k.d.isDown ? 1 : 0) - (k.left.isDown || k.a.isDown ? 1 : 0);
    return { throttle: k.up.isDown || k.w.isDown ? 1 : 0, brake: k.down.isDown || k.s.isDown ? 1 : 0, steer, handbrake: k.space.isDown };
  }

  // idle 0.5 s, accelerate up the street, handbrake-turn right at the 7th Street junction, then straighten out
  script(t) {
    const between = (a, b) => t >= a && t < b;
    return {
      throttle: between(0.5, 3.6) || between(4.6, 9) ? 1 : 0,
      brake: 0,
      steer: between(3.5, 4.3) ? 1 : 0,
      handbrake: between(3.5, 4.2),
    };
  }
}
