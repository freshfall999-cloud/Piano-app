// MuScriptor (Kyutai & Mirelo, 2026) — multi-instrument transcription — run in the browser with ONNX Runtime Web.
// Code: MIT (github.com/muscriptor/muscriptor); this file ports its inference loop and token decoding to JavaScript.
// Weights: CC BY-NC 4.0, gated on Hugging Face: they are never part of this app. Each person downloads them with their
// own Hugging Face token (after accepting the licence), straight from huggingface.co to their device, where they're
// cached. The ONNX graph here (vendor/models/musc_small.onnx) holds no weights: every weight refers by name to a
// tensor in the official model.safetensors.
/* global ort */
const SR = 16000, SEG = 5 * SR, NFFT = 2048, HOP = 160, MELS = 512, MAXGEN = 2000;
const say = (type, value) => self.postMessage({ type, value });
const pause = () => new Promise(r => setTimeout(r, 0));

// ---------- the weights: model.safetensors ----------
function parseSafetensors(buf) {
  const dv = new DataView(buf), n = Number(dv.getBigUint64(0, true));
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, n)));
  const base = 8 + n, t = {};
  for (const [k, v] of Object.entries(head)) {
    if (k === "__metadata__") continue;
    if (v.dtype !== "F32") throw new Error("unexpected weight type " + v.dtype);
    const [a, b] = v.data_offsets;
    t[k] = { shape: v.shape, bytes: new Uint8Array(buf, base + a, b - a) };
  }
  return t;
}
const f32 = w => w.bytes.byteOffset % 4 === 0 ? new Float32Array(w.bytes.buffer, w.bytes.byteOffset, w.bytes.length / 4) : new Float32Array(w.bytes.slice().buffer);
async function download(url, token, cacheName) {
  // kept on the device after the first time (it's big): streamed straight into storage, then read back once,
  // so the file is only held in memory one time
  let cache = null;
  try { cache = await caches.open(cacheName); const hit = await cache.match(url); if (hit) return await hit.arrayBuffer(); } catch (e) { cache = null; }
  const r = await fetch(url, token ? { headers: { Authorization: "Bearer " + token } } : {});
  if (r.status === 401 || r.status === 403) throw new Error("hf-auth");
  if (!r.ok) throw new Error("download " + r.status);
  const total = +r.headers.get("content-length") || 0;
  let got = 0, last = 0;
  const count = new TransformStream({ transform(chunk, ctl) {
    got += chunk.length; ctl.enqueue(chunk);
    if (performance.now() - last > 400) { last = performance.now(); say("download", total ? got / total : 0); }
  } });
  const body = r.body.pipeThrough(count);
  if (cache) {
    try {
      await cache.put(url, new Response(body, { headers: { "content-type": "application/octet-stream" } }));
      const back = await cache.match(url); if (back) return await back.arrayBuffer();
    } catch (e) { throw new Error("couldn't store the model on this device (" + (e.message || e) + ")"); }
  }
  // no storage: read it into one buffer
  const out = new Uint8Array(total || 450e6), rd = body.getReader(); let at = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; out.set(value, at); at += value.length; }
  return out.buffer.slice(0, at);
}

// ---------- audio → the model's log-mel spectrogram (5-second pieces, 100 frames a second) ----------
function makeFFT(n) {
  const rev = new Uint32Array(n), bits = Math.log2(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = -Math.sin(2 * Math.PI * i / n); }
  return (re, im) => {
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const h = size >> 1, step = n / size;
      for (let s = 0; s < n; s += size) for (let k = 0; k < h; k++) {
        const wr = cos[k * step], wi = sin[k * step], a = s + k, b = a + h;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  };
}
function melOf(chunk, win, bands, fft) {                   // centred STFT with reflected edges, magnitude, mel, log
  const F = 1 + Math.floor(chunk.length / HOP), half = NFFT / 2, out = new Float32Array(F * MELS);
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT), mag = new Float64Array(half + 1);
  const at = i => { let k = i - half; if (k < 0) k = -k; if (k >= chunk.length) k = 2 * (chunk.length - 1) - k; return chunk[k]; };
  for (let t = 0; t < F; t++) {
    for (let j = 0; j < NFFT; j++) { re[j] = at(t * HOP + j) * win[j]; im[j] = 0; }
    fft(re, im);
    for (let k = 0; k <= half; k++) mag[k] = Math.hypot(re[k], im[k]);
    for (let m = 0; m < MELS; m++) { const [lo, w] = bands[m]; let a = 0; for (let q = 0; q < w.length; q++) a += mag[lo + q] * w[q]; out[t * MELS + m] = Math.log(a + 1e-6); }
  }
  return { mel: out, frames: F };
}

// ---------- the token decoder (MuScriptor's OpenNoteTracker) ----------
class Tracker {
  constructor(vocab) { this.v = vocab; this.open = new Map(); this.seek = 0; this.next = null; this.started = false; this.notes = []; this.reset(); }
  reset() { this.startTick = Math.round(this.seek * 100); this.tick = this.startTick; this.program = null; this.velocity = null; this.prologue = true; this.skip = false; this.tie = new Set(); }
  endAll(t) { for (const [k, n] of this.open) { n.end = t; this.notes.push(n); } this.open.clear(); }
  boundary(seek, next) { if (this.started && this.prologue) this.endAll(this.seek); this.seek = seek; this.next = next; this.reset(); this.started = true; }
  feed(id) {
    const [type, value] = this.v[id];
    if (this.prologue) {
      if (type === "tie") {
        this.prologue = false; this.velocity = null;
        for (const [k, n] of [...this.open]) if (!this.tie.has(k)) { n.end = this.seek; this.notes.push(n); this.open.delete(k); }
      } else if (type === "shift") { this.prologue = false; this.skip = true; this.endAll(this.seek); }
      else if (type === "program") this.program = value;
      else if (type === "pitch" && this.program !== null) this.tie.add(this.program + ":" + value);
      return;
    }
    if (this.skip) return;
    if (type === "shift") { if (value > 0) this.tick = this.startTick + value; }
    else if (type === "program") this.program = value;
    else if (type === "velocity") this.velocity = value;
    else if (type === "drum") {
      const t = this.tick / 100;
      if (this.next === null || t < this.next) this.notes.push({ program: -1, pitch: value, start: t, end: t + 0.01, drum: true });
    } else if (type === "pitch") {
      if (this.program === null || this.velocity === null) return;
      const t = this.tick / 100;
      if (this.next !== null && t >= this.next) return;
      const k = this.program + ":" + value, o = this.open.get(k);
      if (o) { o.end = t; this.notes.push(o); this.open.delete(k); }
      if (this.velocity > 0) this.open.set(k, { program: this.program, pitch: value, start: t });
    }
  }
  finish() {
    if (this.started && this.prologue) this.endAll(this.seek);
    else { for (const [k, n] of this.open) { n.end = n.start + 0.01; this.notes.push(n); } this.open.clear(); }
  }
  openKeys() { return [...this.open.keys()].map(k => k.split(":").map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]); }
}
function tieTokens(keys, index) {                           // the tie prologue: notes still sounding from the last piece
  const out = []; let prog = null;
  for (const [p, pitch] of keys) { if (p !== prog) { out.push(index.get("program:" + p)); prog = p; } out.push(index.get("pitch:" + pitch)); }
  out.push(index.get("tie:0"));
  return out;
}

// ---------- spectral flux at 22,050 Hz for the beat finder in arrange.js ----------
function fluxOf(samples) {
  const N = 1024, H = 256, half = N / 2, n = Math.floor(samples.length / H), win = new Float32Array(N), re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const fft = makeFFT(N), prev = new Float32Array(half), all = new Float32Array(n), low = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    for (let i = 0; i < N; i++) { const k = t * H + i - half; re[i] = k >= 0 && k < samples.length ? samples[k] * win[i] : 0; im[i] = 0; }
    fft(re, im);
    let f = 0, g = 0;
    for (let k = 1; k < half; k++) { const m = Math.log1p(100 * Math.hypot(re[k], im[k])); if (m > prev[k]) { f += m - prev[k]; if (k <= 12) g += m - prev[k]; } prev[k] = m; }
    all[t] = f; low[t] = g;
  }
  return { all, low };
}

self.onmessage = async ({ data }) => {
  try {
    importScripts(data.base + "ort/ort.webgpu.min.js");
    ort.env.wasm.wasmPaths = data.base + "ort/";
    ort.env.wasm.numThreads = 1;
    const meta = await (await fetch(data.base + "models/musc_" + data.size + ".json")).json();
    const vocab = await (await fetch(data.base + "models/musc_vocab.json")).json();
    say("status", "download");
    const W = parseSafetensors(await download(data.weightsUrl, data.token, "keyfall-muscriptor"));
    say("status", "load");
    // the graph, with each weight handed over by name (no copies made here)
    const graph = new Uint8Array(await (await fetch(data.base + "models/musc_" + data.size + ".onnx")).arrayBuffer());
    const externalData = meta.weights.map(k => { if (!W[k]) throw new Error("missing weight " + k); return { path: k, data: W[k].bytes }; });
    let providers = ["wasm"];
    try { if (self.navigator.gpu && await navigator.gpu.requestAdapter()) providers = ["webgpu", "wasm"]; } catch (e) {}
    const L = meta.layers, D = meta.dim, H = meta.heads, d = D / H, CARD = meta.card;
    // on the graphics chip, the model's memory of what it has written (the key/value cache) stays there between steps
    // instead of being copied out and back in for every token
    const onGpu = {}; for (let l = 0; l < L; l++) for (const kv of "kv") onGpu[`present_${kv}${l}`] = "gpu-buffer";
    let sess;
    try { sess = await ort.InferenceSession.create(graph, { executionProviders: providers, externalData, ...(providers[0] === "webgpu" ? { preferredOutputLocation: onGpu } : {}) }); }
    catch (e) { if (providers[0] !== "webgpu") throw e; console.warn("webgpu failed, using the processor:", e); providers = ["wasm"]; sess = await ort.InferenceSession.create(graph, { executionProviders: providers, externalData }); }
    // the few weights used outside the graph, copied out so the big download can be let go
    const own = k => f32(W[k]).slice();
    const emb = own("emb.weight"), proj = own("condition_provider.conditioners.self_wav.output_proj.weight");
    const projB = own("condition_provider.conditioners.self_wav.output_proj.bias");
    const win = own("condition_provider.conditioners.self_wav.mel_spec_transform.spectrogram.window");
    const ds = f32(W["condition_provider.conditioners.dataset_name.embed.weight"]).slice(D, 2 * D);        // "no dataset"
    const ig = f32(W["condition_provider.conditioners.instrument_group.embed.weight"]).slice(D, 2 * D);    // "any instruments"
    const bands = (() => {                                    // the mel filter bank, as a short list per band
      const fb = f32(W["condition_provider.conditioners.self_wav.mel_spec_transform.mel_scale.fb"]), out = [];   // [1025, 512]
      for (let m = 0; m < MELS; m++) {
        let lo = -1, hi = -1; for (let k = 0; k <= NFFT / 2; k++) if (fb[k * MELS + m] !== 0) { if (lo < 0) lo = k; hi = k; }
        out.push(lo < 0 ? [0, []] : [lo, Array.from({ length: hi - lo + 1 }, (_, q) => fb[(lo + q) * MELS + m])]);
      }
      return out;
    })();
    for (const k in W) delete W[k];                          // (the session has its own copy of the weights now)
    externalData.length = 0;
    const index = new Map(vocab.map(([t, v], i) => [t + ":" + v, i])), EOS = vocab.findIndex(([t]) => t === "EOS");
    const fft = makeFFT(NFFT), samples = data.samples, nChunks = Math.ceil(samples.length / SEG);
    const tracker = new Tracker(vocab), stream = [];
    const embRow = id => emb.subarray(id * D, (id + 1) * D);
    say("status", "run");
    const t0 = performance.now();
    for (let c = 0; c < nChunks; c++) {
      const chunk = new Float32Array(SEG); chunk.set(samples.subarray(c * SEG, Math.min(samples.length, (c + 1) * SEG)));
      const seek = c * 5, next = c + 1 < nChunks ? (c + 1) * 5 : null;
      tracker.boundary(seek, next); stream.push(["B", seek]);
      // the audio prefix: log-mel frames projected to the model's width (the frame past the 5 s is masked), then the two class tokens
      const { mel, frames } = melOf(chunk, win, bands, fft), valid = SEG / HOP;
      const prefix = frames + 2, prompt = c > 0 ? tieTokens(tracker.openKeys(), index) : [];
      const toks = [CARD, ...prompt], T = prefix + toks.length, x = new Float32Array(T * D);
      for (let t = 0; t < frames; t++) {
        if (t >= valid) continue;
        const row = mel.subarray(t * MELS, (t + 1) * MELS), o = t * D;
        for (let j = 0; j < D; j++) { let a = projB[j]; const w = j * MELS; for (let q = 0; q < MELS; q++) a += proj[w + q] * row[q]; x[o + j] = a; }
      }
      x.set(ds, frames * D); x.set(ig, (frames + 1) * D);
      toks.forEach((id, i) => x.set(embRow(id), (prefix + i) * D));
      for (const id of prompt) { tracker.feed(id); stream.push(id); }
      let feeds = { x: new ort.Tensor("float32", x, [1, T, D]), pos0: new ort.Tensor("int64", BigInt64Array.from([0n]), [1]) };
      for (let l = 0; l < L; l++) for (const kv of "kv") feeds[`past_${kv}${l}`] = new ort.Tensor("float32", new Float32Array(0), [1, 0, H, d]);
      let pos = T, held = [];
      for (let g = toks.length - 1; g < MAXGEN; g++) {
        const out = await sess.run(feeds);
        for (const t of held) t.dispose && t.dispose();       // last step's cache, now replaced
        held = [];
        const lg = out.logits.data; let best = 0;
        for (let i = 1; i < CARD; i++) if (lg[i] > lg[best]) best = i;
        if (best === EOS) break;
        tracker.feed(best); stream.push(best);
        feeds = { x: new ort.Tensor("float32", embRow(best).slice(), [1, 1, D]), pos0: new ort.Tensor("int64", BigInt64Array.from([BigInt(pos)]), [1]) };
        for (let l = 0; l < L; l++) for (const kv of "kv") { const t = out[`present_${kv}${l}`]; feeds[`past_${kv}${l}`] = t; held.push(t); }
        pos++;
        if (g % 50 === 0) { say("progress", { chunk: c, chunks: nChunks, tokens: g, secs: (performance.now() - t0) / 1000 }); await pause(); }
      }
      for (const t of held) t.dispose && t.dispose();
      say("progress", { chunk: c + 1, chunks: nChunks, tokens: 0, secs: (performance.now() - t0) / 1000 });
    }
    tracker.finish();
    const notes = tracker.notes.filter(n => n.end > n.start).map(n => [n.pitch, n.start, n.end, n.drum ? -1 : n.program]);
    const flux = data.samples22 ? fluxOf(data.samples22) : null;
    self.postMessage({ type: "done", notes, stream: data.keepStream ? stream : null, flux, backend: providers[0] });
  } catch (e) {
    self.postMessage({ type: "error", message: String(e && (e.message || e)) });
  }
};
