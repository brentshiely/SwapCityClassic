// What the game sounds like, as numbers: how loud and how high each sound is for the state of the car, the people and the police.
// Pure maths (no Web Audio), so it can be tested in Node; sound.js turns these into actual sound.

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** the engine: pitch and loudness follow the speed, a little more when the throttle is down */
export function engine(speed, vMax, throttle) {
  const r = clamp01(speed / Math.max(1, vMax));
  throttle = clamp01(throttle);
  // a low idle rising with speed, with gear-change "steps" so it does not just glide
  const gear = Math.min(4, Math.floor(r * 5));
  const within = r * 5 - gear;
  const freq = 48 + 34 * within + gear * 9 + r * 40;
  return { freq, gain: 0.06 + 0.10 * throttle + 0.06 * r, roar: clamp01(r * 1.3) * 0.16 }; // roar = road/wind noise
}

/** tyre squeal: when the car slides sideways or the handbrake is on */
export function skid(sideSpeed, speed, handbrake) {
  const slide = clamp01((Math.abs(sideSpeed) - 1.8) / 5);
  const brake = handbrake && speed > 4 ? clamp01(speed / 15) * 0.9 : 0;
  return Math.max(slide * clamp01(speed / 8), brake) * 0.22;
}

/** a crash: how hard the car hit, from the speed it lost in one moment (m/s) */
export function crash(speedLost) {
  if (speedLost < 2.5) return null;
  const k = clamp01((speedLost - 2.5) / 22);
  return { gain: 0.25 + 0.65 * k, freq: 150 - 80 * k, noise: 0.4 + 0.6 * k };
}

/** the siren of the nearest police car: heard from 160 m, loud up close */
export function siren(distance) {
  if (!(distance < 160)) return 0;
  const near = 1 - clamp01((distance - 8) / 152);
  return near * near * 0.16;
}

/** how often a walking person's footsteps sound (per second); none when standing */
export function stepsPerSecond(speed) { return speed < 0.4 ? 0 : 1.6 + speed * 0.5; }

/** a shot's loudness: everyone hears it, the player most */
export const SHOT = { gain: 0.55, freq: 900 };

// ---- the music: a small generative loop in a minor key (A minor, Am - F - C - G), 88 beats per minute
export const MUSIC = {
  bpm: 88,
  chords: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]], // MIDI notes: root position triads
  bass: [45, 41, 36, 43],
};
export const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
