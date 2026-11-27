// Keyfall sound: a sampled grand piano (Salamander Grand Piano V3, CC BY 3.0, Alexander Holm) and
// synthesized sound effects. Notes between the recorded ones are made by re-pitching the nearest recording.
(() => {
  "use strict";
  const NAMES = ["C", "Cs", "D", "Ds", "E", "F", "Fs", "G", "Gs", "A", "As", "B"];
  const RECORDED = [];                      // A0, C1, D#1, F#1, A1, ... A7, C8 (every 3 semitones)
  for (let m = 21; m <= 108; m += 3) RECORDED.push(m);
  const fileOf = m => `samples/${NAMES[m % 12]}${Math.floor(m / 12) - 1}.mp3`;

  let ac = null, out = null, sfxBus = null, reverb = null, pianoBus = null, bandBus = null, noiseBuf = null;
  const bandVoices = new Set();
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

  // a concert hall for the piano: a short gap, then a long, darkening, stereo tail (like the piano videos)
  function makeHall(seconds = 2.8, preDelay = 0.022) {
    const sr = ac.sampleRate, len = Math.round(sr * seconds), pre = Math.round(sr * preDelay), ir = ac.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let y = 0;
      for (let i = pre; i < len; i++) {
        const f = (i - pre) / (len - pre), a = 0.85 - 0.75 * f;          // the high notes die away first
        y += a * ((Math.random() * 2 - 1) - y);
        d[i] = y * Math.exp(-f * 6.2) * (i - pre < sr * 0.004 ? (i - pre) / (sr * 0.004) : 1);
      }
    }
    const c = ac.createConvolver(); c.buffer = ir; return c;
  }

  function init(context, destination) {             // again with a new context when the app had to restart the sound
    if (ac === context) return;
    ac = context; out = destination; voices.clear();
    // the piano: a little warmth in the low end, the direct sound, and the hall
    pianoBus = ac.createGain(); pianoBus.gain.value = 0.9;
    const warm = ac.createBiquadFilter(); warm.type = "lowshelf"; warm.frequency.value = 200; warm.gain.value = 2.5;
    const hall = makeHall(), hallWet = ac.createGain(); hallWet.gain.value = 0.85;
    pianoBus.connect(warm); warm.connect(out); warm.connect(hall); hall.connect(hallWet).connect(out);
    // the band behind you: its own level, a little of the same hall
    bandBus = ac.createGain(); bandBus.gain.value = 0.55;
    const bandHall = ac.createGain(); bandHall.gain.value = 0.35;
    bandBus.connect(out); bandBus.connect(bandHall).connect(hall);
    noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const nd = noiseBuf.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    bandVoices.clear();
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
    const t = ac.currentTime, src = ac.createBufferSource(), g = ac.createGain(), tone = ac.createBiquadFilter();
    src.buffer = buffers.get(s);
    src.playbackRate.value = Math.pow(2, (m - s) / 12);
    const level = 0.25 + 0.75 * Math.pow(vel, 1.4);
    g.gain.setValueAtTime(level, t);
    // soft notes are darker, loud ones bright (as on a real piano); low notes a little to the left, high to the right
    tone.type = "lowpass"; tone.Q.value = 0.5; tone.frequency.setValueAtTime(1400 + 15000 * vel * vel, t);
    let node = src.connect(tone).connect(g);
    if (ac.createStereoPanner) { const pan = ac.createStereoPanner(); pan.pan.value = Math.max(-0.4, Math.min(0.4, (m - 64) / 60)); node = node.connect(pan); }
    node.connect(pianoBus);
    src.start(t);
    voices.set(m, { src, g });
    src.onended = () => { if (voices.get(m) && voices.get(m).src === src) voices.delete(m); };
    return true;
  }
  function noteOff(m, release = 0.3) {
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

  // ---------- the band: drums, bass and strings, all synthesized ----------
  function noiseHit(t, { dur, gain, type, freq, q = 0.8, attack = 0.001 }) {
    const src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    src.buffer = noiseBuf; src.loop = true; f.type = type; f.frequency.value = freq; f.Q.value = q;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(bandBus); src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.05);
  }
  function tone(t, { type = "sine", from, to = from, glide = 0.1, dur, gain }) {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(from, t); if (to !== from) o.frequency.exponentialRampToValueAtTime(to, t + glide);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(bandBus); o.start(t); o.stop(t + dur + 0.05);
  }
  function held(t, nodes, g, end, release) {             // a voice that can be cut short (pause, a jump back)
    const v = { nodes, g };
    g.gain.setTargetAtTime(0.0001, end, release / 4);
    nodes.forEach(n => n.stop(end + release + 0.1));
    nodes[0].onended = () => bandVoices.delete(v);
    bandVoices.add(v);
  }
  const BAND = {
    kick: (t, v) => { tone(t, { from: 140, to: 42, glide: 0.11, dur: 0.38, gain: 0.95 * v }); noiseHit(t, { dur: 0.02, gain: 0.25 * v, type: "lowpass", freq: 2500 }); },
    snare: (t, v) => { noiseHit(t, { dur: 0.2, gain: 0.5 * v, type: "bandpass", freq: 1900, q: 0.7 }); tone(t, { type: "triangle", from: 210, to: 160, glide: 0.08, dur: 0.12, gain: 0.35 * v }); },
    hat: (t, v) => noiseHit(t, { dur: 0.045, gain: 0.22 * v, type: "highpass", freq: 7500 }),
    crash: (t, v) => noiseHit(t, { dur: 1.6, gain: 0.22 * v, type: "highpass", freq: 5200, attack: 0.004 }),
    bass: (t, v, midi, dur) => {
      const f = 440 * Math.pow(2, (midi - 69) / 12), o1 = ac.createOscillator(), o2 = ac.createOscillator(), lp = ac.createBiquadFilter(), g = ac.createGain();
      o1.type = "sawtooth"; o1.frequency.value = f; o2.type = "sine"; o2.frequency.value = f;
      lp.type = "lowpass"; lp.Q.value = 2; lp.frequency.setValueAtTime(900, t); lp.frequency.exponentialRampToValueAtTime(260, t + 0.25);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.42 * v, t + 0.008); g.gain.exponentialRampToValueAtTime(0.2 * v, t + 0.3);
      o1.connect(lp); o2.connect(lp); lp.connect(g).connect(bandBus); o1.start(t); o2.start(t);
      held(t, [o1, o2], g, t + dur, 0.12);
    },
    pad: (t, v, midi, dur) => {                         // strings: detuned saws, soft and slow
      const f = 440 * Math.pow(2, (midi - 69) / 12), lp = ac.createBiquadFilter(), g = ac.createGain(), nodes = [];
      lp.type = "lowpass"; lp.frequency.value = 1500; lp.Q.value = 0.3;
      for (const d of [-7, 6]) { const o = ac.createOscillator(); o.type = "sawtooth"; o.frequency.value = f; o.detune.value = d; o.connect(lp); o.start(t); nodes.push(o); }
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.06 * v, t + 0.35);
      lp.connect(g).connect(bandBus);
      held(t, nodes, g, t + dur, 0.5);
    },
  };
  function band(kind, when, vel = 1, midi = 0, dur = 0) { if (ac && bandBus && BAND[kind]) BAND[kind](Math.max(ac.currentTime, when), vel, midi, dur); }
  function bandStop() {
    if (!ac) return;
    const t = ac.currentTime;
    bandVoices.forEach(v => { try { v.g.gain.cancelScheduledValues(t); v.g.gain.setTargetAtTime(0.0001, t, 0.05); v.nodes.forEach(n => n.stop(t + 0.3)); } catch (e) {} });
    bandVoices.clear();
  }

  window.KeyfallSound = { init, noteOn, noteOff, sfx, band, bandStop, get loaded() { return buffers.size; }, total: RECORDED.length };
})();
