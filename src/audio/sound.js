import { engine, skid, crash, siren, stepsPerSecond, MUSIC, midiHz } from './params.js';

// Sound, all made in code (Web Audio): engine, tyre squeal, crashes, footsteps, a siren (unused for now) and a small music loop.
// Browsers only let a page make sound after the player has pressed a key or clicked, so the audio context is created on the first one.

export class Sound {
  constructor() {
    this.ctx = null;
    this.sfx = 0.8; this.music = 0.35; this.muted = false;
    this.stepT = 0; this.lastState = null;
    const start = () => { this.start(); removeEventListener('keydown', start); removeEventListener('pointerdown', start); };
    addEventListener('keydown', start); addEventListener('pointerdown', start);
  }

  start() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain(); this.master.gain.value = 0.9; this.master.connect(ctx.destination);
    this.sfxBus = ctx.createGain(); this.sfxBus.connect(this.master);
    this.musicBus = ctx.createGain(); this.musicBus.connect(this.master);
    // shared white noise
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    const noise = () => { const n = ctx.createBufferSource(); n.buffer = buf; n.loop = true; n.start(); return n; };
    // engine: two detuned sawtooth voices through a low-pass, plus road noise
    this.eng = { o1: ctx.createOscillator(), o2: ctx.createOscillator(), lp: ctx.createBiquadFilter(), g: ctx.createGain() };
    this.eng.o1.type = 'sawtooth'; this.eng.o2.type = 'square'; this.eng.lp.type = 'lowpass'; this.eng.lp.frequency.value = 420; this.eng.g.gain.value = 0;
    this.eng.o1.connect(this.eng.lp); this.eng.o2.connect(this.eng.lp); this.eng.lp.connect(this.eng.g); this.eng.g.connect(this.sfxBus);
    this.eng.o1.start(); this.eng.o2.start();
    this.road = { n: noise(), lp: ctx.createBiquadFilter(), g: ctx.createGain() };
    this.road.lp.type = 'lowpass'; this.road.lp.frequency.value = 500; this.road.g.gain.value = 0;
    this.road.n.connect(this.road.lp); this.road.lp.connect(this.road.g); this.road.g.connect(this.sfxBus);
    // tyre squeal: band-passed noise
    this.sq = { n: noise(), bp: ctx.createBiquadFilter(), g: ctx.createGain() };
    this.sq.bp.type = 'bandpass'; this.sq.bp.frequency.value = 1500; this.sq.bp.Q.value = 6; this.sq.g.gain.value = 0;
    this.sq.n.connect(this.sq.bp); this.sq.bp.connect(this.sq.g); this.sq.g.connect(this.sfxBus);
    // siren: a triangle wave swept up and down (nothing plays it yet, kept for a future ambulance or fire truck)
    this.si = { o: ctx.createOscillator(), lfo: ctx.createOscillator(), lg: ctx.createGain(), g: ctx.createGain() };
    this.si.o.type = 'triangle'; this.si.o.frequency.value = 900; this.si.lfo.frequency.value = 0.65; this.si.lg.gain.value = 330; this.si.g.gain.value = 0;
    this.si.lfo.connect(this.si.lg); this.si.lg.connect(this.si.o.frequency); this.si.o.connect(this.si.g); this.si.g.connect(this.sfxBus);
    this.si.o.start(); this.si.lfo.start();
    this.applyVolumes();
    this.musicStep = 0; this.nextBeat = ctx.currentTime + 0.5;
  }

  applyVolumes() {
    if (!this.ctx) return;
    const m = this.muted ? 0 : 1;
    this.sfxBus.gain.setTargetAtTime(this.sfx * m, this.ctx.currentTime, 0.05);
    this.musicBus.gain.setTargetAtTime(this.music * m, this.ctx.currentTime, 0.05);
  }

  setVolumes(sfx, music) { this.sfx = sfx; this.music = music; this.applyVolumes(); }
  toggleMute() { this.muted = !this.muted; this.applyVolumes(); return this.muted; }

  // ---- one-shot sounds
  burst(gain, freq, dur, type = 'noise') {
    const ctx = this.ctx; if (!ctx) return;
    const t = ctx.currentTime, g = ctx.createGain();
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    if (type === 'noise') {
      const n = ctx.createBufferSource(); n.buffer = this.noiseBuf; n.playbackRate.value = 0.6 + Math.random() * 0.5;
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq * 4;
      n.connect(f); f.connect(g); n.start(t, Math.random(), dur + 0.05);
    } else {
      const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * 0.4), t + dur);
      o.connect(g); o.start(t); o.stop(t + dur + 0.02);
    }
    g.connect(this.sfxBus);
  }

  crashHit(speedLost) { const c = crash(speedLost); if (c) { this.burst(c.gain * c.noise, c.freq * 6, 0.35); this.burst(c.gain, c.freq, 0.3, 'sine'); } }
  step() { this.burst(0.06, 260, 0.05); }
  horn() { this.burst(0.25, 420, 0.5, 'square'); }

  /**
   * every frame. s = { inCar, speed, vMax, throttle, sideSpeed, handbrake, walkSpeed, sirenDistance, dt }
   */
  update(s) {
    const ctx = this.ctx; if (!ctx) return;
    const t = ctx.currentTime;
    const e = s.inCar ? engine(s.speed, s.vMax, s.throttle) : { freq: 40, gain: 0, roar: 0 };
    this.eng.o1.frequency.setTargetAtTime(e.freq, t, 0.06); this.eng.o2.frequency.setTargetAtTime(e.freq * 0.5, t, 0.06);
    this.eng.lp.frequency.setTargetAtTime(300 + e.freq * 6, t, 0.08);
    this.eng.g.gain.setTargetAtTime(e.gain, t, 0.06);
    this.road.g.gain.setTargetAtTime(e.roar, t, 0.1); this.road.lp.frequency.setTargetAtTime(300 + s.speed * 30, t, 0.1);
    this.sq.g.gain.setTargetAtTime(s.inCar ? skid(s.sideSpeed, s.speed, s.handbrake) : 0, t, 0.04);
    this.sq.bp.frequency.setTargetAtTime(1300 + Math.min(1400, s.speed * 45), t, 0.05);
    this.si.g.gain.setTargetAtTime(siren(s.sirenDistance), t, 0.15);
    // footsteps
    const sps = s.inCar ? 0 : stepsPerSecond(s.walkSpeed);
    this.stepT -= s.dt;
    if (sps > 0 && this.stepT <= 0) { this.step(); this.stepT = 1 / sps; }
    this.musicTick();
  }

  // ---- music: chords on a triangle "pad", a bass on a sine, and an eighth-note arpeggio
  musicTick() {
    const ctx = this.ctx;
    if (!this.music || this.muted) { this.nextBeat = Math.max(this.nextBeat, ctx.currentTime); return; }
    const eighth = 60 / MUSIC.bpm / 2;
    while (this.nextBeat < ctx.currentTime + 0.25) {
      const step = this.musicStep++, bar = Math.floor(step / 8) % 4, pos = step % 8, chord = MUSIC.chords[bar], t = this.nextBeat;
      const note = (m, type, gain, dur, bus = this.musicBus) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = type; o.frequency.value = midiHz(m);
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g); g.connect(bus); o.start(t); o.stop(t + dur + 0.05);
      };
      if (pos === 0) { for (const m of chord) note(m, 'triangle', 0.09, eighth * 7.5); note(MUSIC.bass[bar], 'sine', 0.22, eighth * 3.6); }
      if (pos === 4) note(MUSIC.bass[bar], 'sine', 0.16, eighth * 3);
      const arp = chord[[0, 1, 2, 1, 0, 2, 1, 2][pos]] + 12;
      note(arp, 'square', 0.028, eighth * 0.9);
      this.nextBeat += eighth;
    }
  }
}
