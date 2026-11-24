// Keyfall sound: a sampled grand piano (Salamander Grand Piano V3, CC BY 3.0, Alexander Holm) and
// synthesized sound effects. Notes between the recorded ones are made by re-pitching the nearest recording.
(() => {
  "use strict";
  const NAMES = ["C", "Cs", "D", "Ds", "E", "F", "Fs", "G", "Gs", "A", "As", "B"];
  const RECORDED = [];                      // A0, C1, D#1, F#1, A1, ... A7, C8 (every 3 semitones)
  for (let m = 21; m <= 108; m += 3) RECORDED.push(m);
  const fileOf = m => `samples/${NAMES[m % 12]}${Math.floor(m / 12) - 1}.mp3`;

  let ac = null, out = null, sfxBus = null, reverb = null;
  const buffers = new Map(), voices = new Map();
  let loading = false;

  function decode(data) {                   // older Safari only has the callback form
    return new Promise((ok, fail) => {
      const p = ac.decodeAudioData(data, ok, fail);
      if (p && p.then) p.then(ok, fail);
    });
  }
  function load() {
    if (loading) return;
    loading = true;
    // middle of the keyboard first, so the notes people use most sound right away
    const order = RECORDED.slice().sort((a, b) => Math.abs(a - 62) - Math.abs(b - 62));
    let i = 0;
    const next = () => {
      if (i >= order.length) return;
      const m = order[i++];
      fetch(fileOf(m)).then(r => r.ok ? r.arrayBuffer() : Promise.reject(r.status)).then(decode)
        .then(buf => buffers.set(m, buf)).catch(() => {}).then(next);
    };
    for (let k = 0; k < 4; k++) next();     // four downloads at a time
  }

  // a small generated room reverb: adds a soft glow to the effects
  function makeReverb(seconds = 1.6) {
    const len = Math.round(ac.sampleRate * seconds), ir = ac.createBuffer(2, len, ac.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    const c = ac.createConvolver(); c.buffer = ir; return c;
  }

  function init(context, destination) {
    if (ac) return;
    ac = context; out = destination;
    reverb = makeReverb();
    const wet = ac.createGain(); wet.gain.value = 0.35;
    reverb.connect(wet).connect(out);
    sfxBus = ac.createGain(); sfxBus.gain.value = 0.55;
    sfxBus.connect(out); sfxBus.connect(reverb);
    load();
  }

  // ---------- piano ----------
  function nearest(m) {
    let best = null;
    for (const s of buffers.keys()) if (best === null || Math.abs(s - m) < Math.abs(best - m)) best = s;
    return best !== null && Math.abs(best - m) <= 6 ? best : null;
  }
  function noteOn(m, vel = 0.8) {
    if (!ac) return false;
    const s = nearest(m);
    if (s === null) return false;           // not loaded yet: the caller falls back to its own synth
    noteOff(m, 0.03);
    const t = ac.currentTime, src = ac.createBufferSource(), g = ac.createGain();
    src.buffer = buffers.get(s);
    src.playbackRate.value = Math.pow(2, (m - s) / 12);
    const level = 0.25 + 0.75 * Math.pow(vel, 1.4);
    g.gain.setValueAtTime(level, t);
    src.connect(g).connect(out);
    src.start(t);
    voices.set(m, { src, g });
    src.onended = () => { if (voices.get(m) && voices.get(m).src === src) voices.delete(m); };
    return true;
  }
  function noteOff(m, release = 0.18) {
    const v = voices.get(m);
    if (!v) return;
    voices.delete(m);
    const t = ac.currentTime;
    v.g.gain.cancelScheduledValues(t);
    v.g.gain.setValueAtTime(v.g.gain.value, t);
    v.g.gain.setTargetAtTime(0, t, release / 3);
    try { v.src.stop(t + release * 2 + 0.05); } catch (e) {}
  }

  // ---------- effects ----------
  // a bell: FM synthesis (a sine modulated by another sine whose depth fades), like a glockenspiel
  function bell(freq, when, { gain = 0.25, dur = 1.4, ratio = 3.5, index = 2.2 } = {}) {
    const t = ac.currentTime + when;
    const car = ac.createOscillator(), mod = ac.createOscillator(), mg = ac.createGain(), g = ac.createGain();
    car.frequency.value = freq; mod.frequency.value = freq * ratio;
    mg.gain.setValueAtTime(freq * index, t); mg.gain.exponentialRampToValueAtTime(freq * 0.05, t + dur * 0.6);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    mod.connect(mg).connect(car.frequency); car.connect(g).connect(sfxBus);
    car.start(t); mod.start(t); car.stop(t + dur + 0.05); mod.stop(t + dur + 0.05);
  }
  function noise(when, { dur = 0.08, gain = 0.2, type = "bandpass", from = 2000, to = 2000, q = 1.5 } = {}) {
    const t = ac.currentTime + when, len = Math.round(ac.sampleRate * dur);
    const buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    src.buffer = buf; f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(sfxBus); src.start(t);
  }
  function thud(when, { freq = 150, gain = 0.35 } = {}) {
    const t = ac.currentTime + when, o = ac.createOscillator(), g = ac.createGain();
    o.type = "sine"; o.frequency.setValueAtTime(freq, t); o.frequency.exponentialRampToValueAtTime(freq * 0.55, t + 0.16);
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.connect(g).connect(sfxBus); o.start(t); o.stop(t + 0.22);
  }
  const hz = m => 440 * Math.pow(2, (m - 69) / 12);
  const EFFECTS = {
    click: () => noise(0, { dur: 0.03, gain: 0.12, from: 3500, to: 2500, q: 2 }),
    open: () => noise(0, { dur: 0.22, gain: 0.08, type: "bandpass", from: 600, to: 3200, q: 0.8 }),
    tick: () => noise(0, { dur: 0.05, gain: 0.25, from: 1800, to: 1500, q: 6 }),
    go: () => { noise(0, { dur: 0.06, gain: 0.3, from: 2600, to: 2400, q: 6 }); bell(hz(84), 0.01, { gain: 0.12, dur: 0.6 }); },
    perfect: () => bell(hz(96), 0, { gain: 0.05, dur: 0.35, index: 1.2 }),
    wrong: () => { thud(0); noise(0, { dur: 0.09, gain: 0.08, type: "lowpass", from: 900, to: 300, q: 0.7 }); },
    streak: () => [76, 79, 84, 88].forEach((m, i) => bell(hz(m), i * 0.07, { gain: 0.14, dur: 1.1 })),
    star: n => bell(hz([79, 84, 91][n] || 91), 0, { gain: 0.2, dur: 1.4 }),
    complete: () => {
      [72, 76, 79, 84, 88, 91, 96].forEach((m, i) => bell(hz(m), i * 0.08, { gain: 0.16, dur: 1.8 }));
      noise(0.1, { dur: 1.2, gain: 0.05, type: "highpass", from: 3000, to: 9000, q: 0.5 });
    },
    trained: () => [72, 79, 84].forEach((m, i) => bell(hz(m), i * 0.09, { gain: 0.12, dur: 0.9 })),
  };
  function sfx(name, arg) { if (ac && EFFECTS[name]) EFFECTS[name](arg); }

  window.KeyfallSound = { init, noteOn, noteOff, sfx, get loaded() { return buffers.size; }, total: RECORDED.length };
})();
