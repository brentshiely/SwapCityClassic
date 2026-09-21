// The numbers behind the sound. Run: node tools/test_audio.mjs
import { engine, skid, crash, siren, stepsPerSecond, midiHz, MUSIC } from '../src/audio/params.js';

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };

const idle = engine(0, 67, 0), cruise = engine(25, 67, 0.5), top = engine(67, 67, 1);
check('the engine gets higher and louder with speed', idle.freq < cruise.freq && cruise.freq < top.freq && idle.gain < top.gain, `${idle.freq.toFixed(0)} < ${cruise.freq.toFixed(0)} < ${top.freq.toFixed(0)} Hz`);
check('an idling engine is quiet but not silent', idle.gain > 0.03 && idle.gain < 0.12);
check('more throttle is louder at the same speed', engine(20, 67, 1).gain > engine(20, 67, 0).gain);
check('nothing is out of range at the extremes', [engine(200, 67, 5), engine(-5, 67, -1)].every((e) => e.freq > 20 && e.freq < 400 && e.gain >= 0 && e.gain < 0.5 && e.roar >= 0 && e.roar <= 0.2));
check('no tyre noise driving straight', skid(0, 30, false) === 0);
check('sliding sideways squeals', skid(6, 20, false) > 0.1);
check('the handbrake at speed squeals, standing still does not', skid(0, 20, true) > 0.1 && skid(0, 1, true) === 0);
check('a bump is silent, a crash is loud', crash(1) === null && crash(20).gain > crash(4).gain && crash(30).gain <= 1);
check('a harder crash has a deeper thump', crash(25).freq < crash(4).freq);
check('the siren is silent far away and loud up close', siren(300) === 0 && siren(10) > siren(80) && siren(80) > siren(150) && siren(3) < 0.2);
check('people walk with a rhythm, and quicker when running', stepsPerSecond(0) === 0 && stepsPerSecond(6.8) > stepsPerSecond(3.4));
check('the music notes are in tune (A4 = 440 Hz, an octave doubles)', Math.abs(midiHz(69) - 440) < 1e-9 && Math.abs(midiHz(81) - 880) < 1e-9);
check('the chord loop has four bars of triads with a bass note each', MUSIC.chords.length === 4 && MUSIC.chords.every((c) => c.length === 3) && MUSIC.bass.length === 4);
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
