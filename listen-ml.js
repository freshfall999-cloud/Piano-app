// Keyfall AI listening: Spotify's Basic Pitch model (a trained neural network, Apache 2.0) run on the
// microphone about four times a second. The last 2 seconds of sound go to a background worker that runs the
// model; its "a key was struck here" output becomes strikes with the time they happened.
(() => {
  "use strict";
  const SR = 22050, WIN = 43844, FRAMES = 172, HOP = 256, FPS = SR / HOP;
  const TAIL = 12;                        // the newest frames lack sound after them (the model needs context): wait

  const ml = {
    state: "off",                         // off | loading | on | failed
    backend: "", msPerRun: 0, workerReady: false,
    onsetAt: new Float64Array(128),       // performance.now() time of the latest strike of each key
    onsetConf: new Float32Array(128),
    sustain: new Float32Array(128),       // how strongly each key is sounding in the newest settled frames
  };
  let ring = new Float32Array(WIN * 2), filled = 0, lastSampleAt = 0, total = 0, clock0 = 0, bg = 0;
  let node = null, running = false, lastFrameTime = 0, srcRate = 48000, phase = 0, lp = [];

  // ---------- microphone samples → 22,050 a second ----------
  function makeLowpass(rate) {            // a short windowed-sinc low-pass filter, cut at 10 kHz
    const taps = 31, fc = 10000 / rate, h = [];
    for (let i = 0; i < taps; i++) {
      const k = i - (taps - 1) / 2, sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
      h.push(sinc * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (taps - 1))));
    }
    const sum = h.reduce((a, b) => a + b, 0);
    return h.map(v => v / sum);
  }
  const hist = new Float32Array(64); let histN = 0;
  function store(v) {
    if (filled === ring.length) { ring.copyWithin(0, WIN); filled = ring.length - WIN; }
    ring[filled++] = v; total++;
  }
  function push(input) {
    const step = srcRate / SR, taps = lp.length;
    for (let i = 0; i < input.length; i++) {
      hist[histN++ & 63] = input[i];
      phase += 1;
      if (phase >= step) {
        phase -= step;
        let y = 0;
        for (let k = 0; k < taps; k++) y += lp[k] * hist[(histN - 1 - k) & 63];
        store(y);
      }
    }
    // Time by counting samples. Sound can arrive late in bursts, so the clock at arrival jumps around, but the
    // sample count is exact: anchor once, never let the estimate run ahead of the real clock, nudge for drift.
    const now = performance.now(), est = clock0 + total / SR * 1000;
    if (!clock0) clock0 = now - total / SR * 1000;
    else if (now < est) clock0 -= est - now;
    else clock0 += Math.min(2, (now - est) * 0.002);
    lastSampleAt = clock0 + total / SR * 1000;
  }

  // ---------- reading the model's verdicts ----------
  // frames/onsets: 172 × 88 (flat) for a 2-second window of sound that ended at endAt
  function strikes(chunk, endAt, frames, onsets) {
    const F = (i, p) => frames[i * 88 + p], O = (i, p) => onsets[i * 88 + p];
    const frameTime = i => endAt - ((WIN / SR) - (i + 0.5) / FPS) * 1000;       // when frame i happened
    if (!lastFrameTime) lastFrameTime = frameTime(FRAMES - TAIL - 30);         // first run: skip the half-empty start
    // loudness of each frame's slice, against the room's background: the model can imagine faint low notes
    // in near-silence, so a strike must come with real sound
    const rms = new Float32Array(FRAMES);
    for (let i = 0; i < FRAMES; i++) { let e = 0; const a = Math.min(WIN - 512, i * HOP); for (let k = a; k < a + 512; k++) e += chunk[k] * chunk[k]; rms[i] = Math.sqrt(e / 512); }
    const lowest = Float32Array.from(rms).sort()[Math.floor(FRAMES * 0.1)] + 1e-6;
    bg = !bg || lowest < bg ? lowest : bg * 1.02;                                // falls fast, rises slowly
    for (let i = 1; i < FRAMES - TAIL; i++) {
      const t = frameTime(i);
      if (t <= lastFrameTime) continue;
      for (let p = 0; p < 88; p++) {
        const o = O(i, p);
        if (o < 0.5 || o < O(i - 1, p) || o < O(i + 1, p)) continue;             // a peak in the strike map
        if (Math.max(F(i, p), F(i + 1, p), F(i + 2, p)) < 0.3) continue;         // and the key really sounds
        if (Math.max(rms[i], rms[i + 1], rms[i + 2]) < bg * 4) continue;         // with real sound, not hiss
        // a key that was already sounding needs a clear new strike (a ringing note can seem to "re-strike"
        // when another key is played)
        if (Math.max(F(Math.max(0, i - 4), p), F(Math.max(0, i - 3), p)) >= 0.4 && o < 0.85) continue;
        const m = p + 21;
        if (t - ml.onsetAt[m] < 150) continue;                                    // same strike, seen again
        ml.onsetAt[m] = t; ml.onsetConf[m] = o;
      }
    }
    for (let p = 0; p < 88; p++) ml.sustain[p + 21] = F(FRAMES - TAIL - 1, p);
    lastFrameTime = Math.max(lastFrameTime, frameTime(FRAMES - TAIL - 1));
  }

  // ---------- the model runs in a background worker, one window at a time ----------
  let worker = null, workerStart = null, busy = false, lastRun = 0, pending = null, timer = 0;
  function startWorker() {
    if (workerStart) return workerStart;
    workerStart = new Promise((ok, fail) => {
      worker = new Worker("ml-worker.js?v=2");
      worker.onmessage = ({ data }) => {
        if (data.type === "ready") { ml.workerReady = true; ml.backend = data.backend; ok(); }
        else if (data.type === "result") {
          busy = false;
          ml.msPerRun = ml.msPerRun ? ml.msPerRun * 0.8 + data.ms * 0.2 : data.ms;
          if (pending && running && data.id === pending.id) strikes(pending.chunk, pending.endAt, data.frames, data.onsets);
          pending = null;
        } else if (data.type === "error") { busy = false; if (!ml.workerReady) fail(new Error(data.message)); console.warn("AI listening:", data.message); }
      };
      worker.onerror = e => { if (!ml.workerReady) fail(e); };
      worker.postMessage({ type: "init", base: new URL("vendor/", location.href).href });
    });
    workerStart.catch(() => { workerStart = null; worker = null; });
    return workerStart;
  }
  function tick() {
    if (!running || busy || filled < WIN || performance.now() - lastRun < 200) return;
    busy = true; lastRun = performance.now();
    const chunk = ring.slice(filled - WIN, filled);
    pending = { id: lastRun, chunk, endAt: lastSampleAt };
    worker.postMessage({ type: "run", id: lastRun, samples: chunk.slice() });
  }

  // ---------- capture: an AudioWorklet on the audio thread never drops sound while the page is busy ----------
  const TAP = `class Tap extends AudioWorkletProcessor {
    constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
    process(inputs) { const ch = inputs[0] && inputs[0][0];
      if (ch) for (let i = 0; i < ch.length; i++) { this.buf[this.n++] = ch[i]; if (this.n === 2048) { this.port.postMessage(this.buf.slice(0)); this.n = 0; } }
      return true; } }
  registerProcessor("keyfall-tap", Tap);`;
  ml.start = async (ac, source) => {
    if (running) return;
    ml.state = "loading";
    try { await startWorker(); } catch (e) { ml.state = "failed"; console.warn("AI listening unavailable:", e); return; }
    srcRate = ac.sampleRate; lp = makeLowpass(srcRate); filled = 0; total = 0; clock0 = 0; bg = 0; phase = 0; lastFrameTime = 0;
    ml.onsetAt.fill(0);
    const mute = ac.createGain(); mute.gain.value = 0;
    try {
      if (!ml.tapLoaded) { await ac.audioWorklet.addModule(URL.createObjectURL(new Blob([TAP], { type: "application/javascript" }))); ml.tapLoaded = true; }
      node = new AudioWorkletNode(ac, "keyfall-tap");
      node.port.onmessage = e => push(e.data);
    } catch (e) {                                                    // older browsers: a large buffer limits gaps
      node = ac.createScriptProcessor(16384, 1, 1);
      node.onaudioprocess = e => { push(e.inputBuffer.getChannelData(0)); e.outputBuffer.getChannelData(0).fill(0); };
    }
    source.connect(node); node.connect(mute).connect(ac.destination);
    running = true; ml.state = "on";
    timer = setInterval(tick, 40);
  };
  ml.stop = () => {
    running = false; clearInterval(timer); busy = false; pending = null;
    if (node) { try { node.disconnect(); } catch (e) {} node = null; }
    if (ml.state !== "failed") ml.state = "off";
  };

  // ---------- for turning recordings into notes on the main thread: load the model's library ----------
  const loadScript = src => new Promise((ok, fail) => {
    if ([...document.scripts].some(s => s.src.endsWith(src))) return ok();
    const el = document.createElement("script"); el.src = src; el.onload = ok; el.onerror = () => fail(new Error(src));
    document.head.append(el);
  });
  ml.prepare = async () => {
    await loadScript("vendor/tf.min.js");
    await loadScript("vendor/tf-backend-wasm.min.js");
    tf.wasm.setWasmPaths(new URL("vendor/", location.href).href);
    if (tf.getBackend() !== "wasm") { try { await tf.setBackend("wasm"); await tf.ready(); } catch (e) {} }
    await startWorker().catch(() => {});                            // warm up live listening too
  };

  // ---------- for automated tests: feed 22,050 Hz samples directly with a given clock ----------
  ml._test = {
    feed(samples, at) { for (const v of samples) store(v); lastSampleAt = at; },
    run: () => new Promise(async r => {
      await startWorker();
      if (filled < WIN) return r();
      const chunk = ring.slice(filled - WIN, filled), endAt = lastSampleAt;
      const h = ({ data }) => {
        if (data.type === "error") { worker.removeEventListener("message", h); r(); }
        if (data.type === "result" && data.id === -1) { worker.removeEventListener("message", h); strikes(chunk, endAt, data.frames, data.onsets); r(); }
      };
      worker.addEventListener("message", h);
      worker.postMessage({ type: "run", id: -1, samples: chunk.slice() });
    }),
    reset() { filled = 0; total = 0; clock0 = 0; bg = 0; lastFrameTime = 0; ml.onsetAt.fill(0); },
  };
  window.KeyfallML = ml;
})();
