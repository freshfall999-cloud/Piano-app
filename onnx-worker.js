// More piano note finders, run with ONNX Runtime Web in a background worker:
//  · ByteDance's "high-resolution piano transcription" (Kong et al. 2020, Apache 2.0; weights CC BY 4.0)
//  · the same network re-trained by Queen Mary University of London and Yamaha for other pianos and rooms
//    (Edwards, Dixon, Benetos, Maezawa & Kusaka 2024; weights CC BY 4.0)
//  · Transkun (Yujia Yan & Zhiyao Duan, MIT)
//  · Sony's hFT-Transformer (Toyama et al. 2023; code MIT, weights CC BY-NC-SA 4.0: non-commercial use)
// The models were converted from PyTorch to ONNX; their weights are stored as 16-bit floats (half the download)
// and turned back into 32-bit floats here. The note-processing code below is a JavaScript port of each project's
// Python code (ByteDance: Apache 2.0; Transkun and Sony's hFT-Transformer: MIT); see THIRD_PARTY_NOTICES.md. Everything around the networks (cutting the song into pieces,
// the spectrum Transkun listens to, turning the networks' output into notes) follows the original Python code.
/* global ort */
let base = "";
const say = (type, value) => self.postMessage({ type, value });

// ---------- loading ----------
async function fetchBuf(path, label) {
  const r = await fetch(base + path);
  if (!r.ok) throw new Error("couldn't download " + path);
  const total = +r.headers.get("content-length") || 0;
  if (!total || !r.body) return new Uint8Array(await r.arrayBuffer());
  const out = new Uint8Array(total), rd = r.body.getReader();
  let got = 0, last = 0;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    out.set(value, got); got += value.length;
    if (label && performance.now() - last > 300) { last = performance.now(); say("download", { label, f: got / total }); }
  }
  return out;
}
const F16 = (() => {                                       // 16-bit float → 32-bit float, by table
  const t = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
    t[h] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
  }
  return t;
})();
function halfToFloat(u8) {
  const h = new Uint16Array(u8.buffer, u8.byteOffset, u8.byteLength >> 1), f = new Float32Array(h.length);
  for (let i = 0; i < h.length; i++) f[i] = F16[h[i]];
  return f;
}
let providers = null;
async function session(name, label) {
  const graph = await fetchBuf("models/" + name + ".onnx");
  const weights = halfToFloat(await fetchBuf("models/" + name + ".f16", label));
  const opts = { externalData: [{ path: name + ".f32", data: new Uint8Array(weights.buffer) }], graphOptimizationLevel: "all" };
  if (!providers) {                                        // the graphics chip if the browser offers it, else the processor
    providers = ["wasm"];
    try { if (self.navigator.gpu && await navigator.gpu.requestAdapter()) providers = ["webgpu", "wasm"]; } catch (e) {}
  }
  try { return await ort.InferenceSession.create(graph, { ...opts, executionProviders: providers }); }
  catch (e) { if (providers[0] !== "webgpu") throw e; providers = ["wasm"]; return await ort.InferenceSession.create(graph, { ...opts, executionProviders: providers }); }
}
const pause = () => new Promise(r => setTimeout(r, 0));

// ---------- ByteDance: 10-second pieces, half overlapping; regression outputs → notes ----------
async function bytedance(audio, name = "bytedance", label = "ByteDance model") {
  const s = await session(name, label);
  const SEG = 160000, len = audio.length, padded = Math.ceil(len / SEG) * SEG;
  const x = new Float32Array(padded); x.set(audio);
  const starts = []; for (let p = 0; p + SEG <= padded; p += SEG / 2) starts.push(p);
  const keys = ["onset", "offset", "frame", "velocity"], P = 88;
  const parts = { onset: [], offset: [], frame: [], velocity: [] };
  for (let i = 0; i < starts.length; i++) {
    const out = await s.run({ audio: new ort.Tensor("float32", x.slice(starts[i], starts[i] + SEG), [1, SEG]) });
    // keep the middle half of each piece (the first piece keeps its start, the last its end), as the original does
    const n = starts.length, frames = n === 1 ? 1001 : 1000, a = n === 1 || i === 0 ? 0 : 250, b = n === 1 || i === n - 1 ? frames : 750;
    for (const k of keys) parts[k].push(out[k].data.slice(a * P, b * P));
    for (const k of keys) out[k].dispose && out[k].dispose();
    say("progress", (i + 1) / starts.length);
    await pause();
  }
  const join = k => { const L = parts[k].reduce((a, p) => a + p.length, 0), o = new Float32Array(L); let at = 0; for (const p of parts[k]) { o.set(p, at); at += p.length; } return o; };
  const reg = { onset: join("onset"), offset: join("offset"), frame: join("frame"), velocity: join("velocity") };
  const T = reg.frame.length / P;
  // a peak in the regression curve that clears the threshold and rises/falls steadily on both sides is an onset/offset;
  // its exact time comes from the neighbouring values
  function binarize(r, thr, nb) {
    const on = new Uint8Array(T * P), shift = new Float32Array(T * P);
    for (let k = 0; k < P; k++) for (let n = nb; n < T - nb; n++) {
      const v = i => r[i * P + k];
      if (!(v(n) > thr)) continue;
      let mono = true;
      for (let i = 0; i < nb; i++) { if (v(n - i) < v(n - i - 1)) mono = false; if (v(n + i) < v(n + i + 1)) mono = false; }
      if (!mono) continue;
      on[n * P + k] = 1;
      shift[n * P + k] = v(n - 1) > v(n + 1) ? (v(n + 1) - v(n - 1)) / (v(n) - v(n + 1)) / 2 : (v(n + 1) - v(n - 1)) / (v(n) - v(n - 1)) / 2;
    }
    return [on, shift];
  }
  const [onB, onS] = binarize(reg.onset, 0.3, 2), [offB, offS] = binarize(reg.offset, 0.3, 4);
  const notes = [];
  for (let k = 0; k < P; k++) {
    let bgn = null, gone = null, offAt = null;
    const push = (fin, offShift) => notes.push([k + 21, (bgn + onS[bgn * P + k]) / 100, (fin + offShift) / 100, Math.floor(reg.velocity[bgn * P + k] * 128)]);
    for (let i = 0; i < T; i++) {
      if (onB[i * P + k]) {
        if (bgn) { push(Math.max(i - 1, 0), 0); gone = offAt = null; }
        bgn = i;
      }
      if (bgn && i > bgn) {
        if (reg.frame[i * P + k] <= 0.1 && !gone) gone = i;
        if (offB[i * P + k] && !offAt) offAt = i;
        if (gone) {
          const fin = offAt && offAt - bgn > gone - offAt ? offAt : gone;
          push(fin, offS[fin * P + k]); bgn = gone = offAt = null;
        }
        if (bgn && (i - bgn >= 600 || i === T - 1)) { push(i, offS[i * P + k]); bgn = gone = offAt = null; }
      }
    }
  }
  return notes;
}

// ---------- Transkun: 16-second pieces every 8 seconds; a semi-Markov model picks each key's notes ----------
const FS = 44100, HOP = 1024, WIN = 4096, NB = WIN / 2 + 1, MELS = 229, CH = 6;
const PITCH = [-64, -67]; for (let m = 21; m <= 108; m++) PITCH.push(m);
let fft = null;
function makeFFT(n) {                                     // radix-2 FFT, in place
  const rev = new Uint32Array(n), bits = Math.log2(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = -Math.sin(2 * Math.PI * i / n); }
  return (re, im) => {
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let s = 0; s < n; s += size) for (let k = 0; k < half; k++) {
        const wr = cos[k * step], wi = sin[k * step], a = s + k, b = a + half;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  };
}
function cbMean(logit) {                                   // mean of a continuous Bernoulli distribution (as PyTorch computes it)
  const p = 1 / (1 + Math.exp(-logit));
  if (p > 0.499 && p < 0.501) { const x = p - 0.5; return 0.5 + (1 / 3 + 16 / 45 * x * x) * x; }
  return p / (2 * p - 1) + 1 / (Math.log1p(-p) - Math.log(p));
}
async function transkun(audio) {
  const ctxS = await session("transkun_ctx", "Transkun model"), scoreS = await session("transkun_score"), attrS = await session("transkun_attr");
  const wins = new Float32Array((await fetchBuf("models/transkun_windows.f32")).buffer.slice(0));
  const mel = JSON.parse(new TextDecoder().decode(await fetchBuf("models/transkun_mel.json"))).mel;
  fft = fft || makeFFT(WIN);
  const padBegin = 8, padN = Math.ceil(padBegin * FS);
  const x = new Float32Array(audio.length + 2 * padN); x.set(audio, padN);
  const step = Math.ceil(8 * FS / HOP) * HOP, segN = Math.ceil(16 * FS), T = Math.ceil(segN / HOP) + 1, lastFrame = Math.round(segN / HOP);
  let startPos = new Array(PITCH.length).fill(Math.floor(padBegin * FS / HOP));
  const byPitch = new Map(), re = new Float64Array(WIN), im = new Float64Array(WIN), frameDur = HOP / FS;
  const nSeg = Math.ceil(x.length / step);
  for (let si = 0, i0 = 0; i0 < x.length; si++, i0 += step) {
    const beginTime = i0 / FS - padBegin;
    // frames (half a window of silence first), normalised to zero mean and unit spread
    const seg = new Float32Array(segN); seg.set(x.subarray(i0, Math.min(i0 + segN, x.length)));
    const padded = new Float32Array((T - 1) * HOP + WIN); padded.set(seg, WIN / 2);
    let sum = 0, sum2 = 0;
    for (let t = 0; t < T; t++) for (let j = 0; j < WIN; j++) { const v = padded[t * HOP + j]; sum += v; sum2 += v * v; }
    const cnt = T * WIN, mean = sum / cnt, sd = Math.sqrt(Math.max(0, (sum2 - sum * sum / cnt) / (cnt - 1))) + 1e-8;
    // spectrum through 6 analysis windows → 229 mel bands, log-scaled: features [1, T, 229, 6]
    const feats = new Float32Array(T * MELS * CH), pw = new Float64Array(NB), eps = 1e-5, le = Math.log(eps);
    for (let t = 0; t < T; t++) for (let c = 0; c < CH; c++) {
      for (let j = 0; j < WIN; j++) { re[j] = (padded[t * HOP + j] - mean) / sd * wins[c * WIN + j]; im[j] = 0; }
      fft(re, im);
      for (let k = 0; k < NB; k++) pw[k] = (re[k] * re[k] + im[k] * im[k]) / WIN;    // "ortho" scaling, squared
      for (let m = 0; m < MELS; m++) {
        const [lo, w] = mel[m]; let acc = 0;
        for (let q = 0; q < w.length; q++) acc += pw[lo + q] * w[q];
        feats[(t * MELS + m) * CH + c] = (Math.log(acc + eps) - le) / -le;
      }
    }
    const { ctx } = await ctxS.run({ features: new ort.Tensor("float32", feats, [1, T, MELS, CH]) });
    const D = ctx.dims[3], C = ctx.data;                    // [1, 90, T, D]
    // best set of non-overlapping notes for each key (semi-Markov Viterbi, scored backwards from the end)
    const paths = new Array(PITCH.length);
    const CHUNK = 10;
    for (let s0 = 0; s0 < PITCH.length; s0 += CHUNK) {
      const n = Math.min(CHUNK, PITCH.length - s0);
      const part = new ort.Tensor("float32", C.subarray(s0 * T * D, (s0 + n) * T * D), [1, n, T, D]);
      const { score } = await scoreS.run({ ctx: part });
      const S = score.data;                                 // [n, T(end), T(begin)]
      for (let p = 0; p < n; p++) {
        const sAt = (e, b) => S[(p * T + e) * T + b];
        const q = new Float64Array(T), ptr = new Int32Array(T);
        q[T - 1] = sAt(T - 1, T - 1) > 0 ? sAt(T - 1, T - 1) : 0;
        for (let b = T - 2; b >= 0; b--) {
          let best = q[b + 1], sel = -1;                    // skip this frame (the "noise" score is zero)
          for (let e = b + 1; e < T; e++) { const v = q[e] + sAt(e, b); if (v > best) { best = v; sel = e; } }
          ptr[b] = sel;
          const d = sAt(b, b); q[b] = best + (d > 0 ? d : 0);
        }
        const res = [];
        let j = startPos[s0 + p];
        while (j < T - 1) {
          if (sAt(j, j) > 0) res.push([j, j]);
          if (ptr[j] < 0) j++; else { res.push([j, ptr[j]]); j = ptr[j]; }
        }
        if (sAt(T - 1, T - 1) > 0) res.push([T - 1, T - 1]);
        paths[s0 + p] = res;
      }
      score.dispose && score.dispose();
      await pause();
    }
    // loudness and exact start/end of every interval, from the features at its two ends
    const list = [];
    for (let s = 0; s < PITCH.length; s++) if (s !== 1) for (const iv of paths[s]) list.push([s, iv[0], iv[1]]);   // keys, and the sustain pedal (not the soft pedal)
    let vel = [], of = [];
    if (list.length) {
      const inp = new Float32Array(list.length * 3 * D);
      list.forEach(([s, a, b], r) => {
        const A = (s * T + a) * D, B = (s * T + b) * D, o = r * 3 * D;
        for (let d = 0; d < D; d++) { const u = C[A + d], v = C[B + d]; inp[o + d] = u; inp[o + D + d] = v; inp[o + 2 * D + d] = u * v; }
      });
      const out = await attrS.run({ x: new ort.Tensor("float32", inp, [list.length, 3 * D]) });
      vel = out.velocity.data; of = out.of.data;
    }
    ctx.dispose && ctx.dispose();
    const next = new Array(PITCH.length).fill(0), events = [];
    let r = 0;
    for (let s = 0; s < PITCH.length; s++) {
      if (s === 1) continue;
      let lastEnd = 0, lastP = 0;
      for (const [a, b] of paths[s]) {
        let v = 0, vb = -Infinity;
        for (let k = 0; k < 128; k++) if (vel[r * 128 + k] > vb) { vb = vel[r * 128 + k]; v = k; }
        const o0 = Math.max(-0.5, Math.min(0.5, (cbMean(of[r * 4]) - 0.5) / 0.99)), o1 = Math.max(-0.5, Math.min(0.5, (cbMean(of[r * 4 + 1]) - 0.5) / 0.99));
        const hasOn = a > 0 || of[r * 4 + 2] > 0, hasOff = b < lastFrame || of[r * 4 + 3] > 0;
        let start = Math.max((a + o0) * frameDur, lastEnd), end = Math.max((b + o1) * frameDur, start + 1e-8);
        lastEnd = end;
        events.push({ pitch: PITCH[s], start, end, vel: v, hasOn, hasOff });
        if (hasOff) lastP = b;
        r++;
      }
      next[s] = Math.max(lastP - step / HOP, 0);
    }
    startPos = next;
    events.sort((a, b) => a.start - b.start || a.end - b.end || a.pitch - b.pitch);
    // join notes that carry on from the previous piece
    for (const e of events) {
      e.start = Math.max(e.start + beginTime, 0); e.end = Math.max(e.end + beginTime, e.start);
      const l = byPitch.get(e.pitch) || [];
      if (l.length && e.start < l[l.length - 1].end) {
        if (e.hasOn) l[l.length - 1] = e;
        else { const p = l[l.length - 1]; p.hasOff = e.hasOff; p.end = Math.max(e.end, p.end); }
        continue;
      }
      if (e.hasOn) { l.push(e); byPitch.set(e.pitch, l); }
    }
    say("progress", Math.min(1, (si + 1) / nSeg));
    await pause();
  }
  let all = [];
  for (const l of byPitch.values()) { if (l.length) l[l.length - 1].hasOff = true; all.push(...l); }
  all = all.filter(n => n.hasOff).sort((a, b) => a.start - b.start || a.end - b.end || a.pitch - b.pitch);
  const lastOf = new Map();                                 // a key can't sound twice at once
  all.forEach((n, i) => { const j = lastOf.get(n.pitch); if (j !== undefined && all[j].end > n.start) all[j].end = n.start; lastOf.set(n.pitch, i); });
  all = all.filter(n => n.start < n.end);
  return { notes: all.filter(n => n.pitch > 0).map(n => [n.pitch, n.start, n.end, n.vel]), pedal: all.filter(n => n.pitch === -64).map(n => [n.start, n.end]) };
}

// ---------- Sony hFT-Transformer: log-mel frames (16 ms) in blocks of 128 with 32 frames of context each side ----------
async function sony(audio) {
  const s = await session("sony", "Sony model");
  const mel = JSON.parse(new TextDecoder().decode(await fetchBuf("models/sony_mel.json"))).mel;
  const N = 2048, H = 256, NBIN = N / 2 + 1, MB = 256, P = 88, hopSec = H / 16000;
  const f = makeFFT(N), win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);     // periodic Hann, as PyTorch makes it
  // centred frames: half a window of silence on each side
  const x = new Float32Array(audio.length + N); x.set(audio, N / 2);
  const F = 1 + Math.floor(audio.length / H), feat = new Float32Array(F * MB);
  const re = new Float64Array(N), im = new Float64Array(N), pw = new Float64Array(NBIN);
  for (let t = 0; t < F; t++) {
    for (let j = 0; j < N; j++) { re[j] = x[t * H + j] * win[j]; im[j] = 0; }
    f(re, im);
    for (let k = 0; k < NBIN; k++) pw[k] = re[k] * re[k] + im[k] * im[k];
    for (let m = 0; m < MB; m++) { const [lo, w] = mel[m]; let a = 0; for (let q = 0; q < w.length; q++) a += pw[lo + q] * w[q]; feat[t * MB + m] = Math.log(a + 1e-8); }
    if (t % 2000 === 0) await pause();
  }
  const MIN = Math.fround(Math.log(1e-8)), BLK = 128, MAR = 32, W = BLK + 2 * MAR;
  const L = Math.ceil(F / BLK) * BLK, rows = MAR + L + MAR;
  const inp = new Float32Array(rows * MB).fill(MIN); inp.set(feat, MAR * MB);
  const on = new Float32Array(L * P), off = new Float32Array(L * P), mpe = new Float32Array(L * P), vel = new Float32Array(L * P);
  const spec = new Float32Array(MB * W);
  for (let i = 0; i < F; i += BLK) {
    for (let r = 0; r < W; r++) for (let b = 0; b < MB; b++) spec[b * W + r] = inp[(i + r) * MB + b];
    const o = await s.run({ spec: new ort.Tensor("float32", spec, [1, MB, W]) });
    on.set(o.onset.data, i * P); off.set(o.offset.data, i * P); mpe.set(o.frame.data, i * P); vel.set(o.velocity.data, i * P);
    say("progress", Math.min(1, (i + BLK) / F));
    await pause();
  }
  // notes: peaks of the onset curve (with sub-frame timing), ended by the offset curve or the frame curve, whichever is first
  const T = L, notes = [];
  const peaks = (a, j) => {
    const out = [];
    for (let i = 0; i < T; i++) {
      const v = a[i * P + j];
      if (v < 0.5) continue;
      let left = true, right = true;
      for (let ii = i - 1; ii >= 0; ii--) { const u = a[ii * P + j]; if (v > u) { left = true; break; } if (v < u) { left = false; break; } }
      for (let ii = i + 1; ii < T; ii++) { const u = a[ii * P + j]; if (v > u) { right = true; break; } if (v < u) { right = false; break; } }
      if (!left || !right) continue;
      let time = i * hopSec;
      if (i > 0 && i < T - 1) {
        const pv = a[(i - 1) * P + j], nx = a[(i + 1) * P + j];
        if (pv > nx) time = i * hopSec - hopSec * 0.5 * (pv - nx) / (v - nx);
        else if (pv < nx) time = i * hopSec + hopSec * 0.5 * (nx - pv) / (v - pv);
      }
      out.push({ loc: i, time });
    }
    return out;
  };
  for (let j = 0; j < P; j++) {
    const ons = peaks(on, j), offs = peaks(off, j), mine = [];
    let tOff = 0, tMpe = 0;
    ons.forEach((o, k) => {
      const locNext = k + 1 < ons.length ? ons[k + 1].loc : T, tNext = k + 1 < ons.length ? ons[k + 1].time : (T - 1) * hopSec;
      let locOff = o.loc + 1, hasOff = false;
      for (const q of offs) if (o.loc < q.loc) { locOff = q.loc; tOff = q.time; hasOff = true; break; }
      if (locOff > locNext) { locOff = locNext; tOff = tNext; }
      let locMpe = o.loc + 1, hasMpe = false;
      for (let ii = o.loc + 1; ii < locNext; ii++) if (mpe[ii * P + j] < 0.5) { locMpe = ii; hasMpe = true; tMpe = ii * hopSec; break; }
      const v = Math.trunc(vel[o.loc * P + j]);
      const end = !hasOff && !hasMpe ? tNext : hasOff && !hasMpe ? tOff : !hasOff ? tMpe : locOff <= locMpe ? tOff : tMpe;
      if (v > 0) {
        mine.push([j + 21, o.time, end, v]);
        const a = mine[mine.length - 2], b = mine[mine.length - 1];
        if (a && b[1] < a[2]) a[2] = b[1];
      }
    });
    notes.push(...mine);
  }
  return notes.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

self.onmessage = async ({ data }) => {
  try {
    base = data.base;
    importScripts(base + "ort/ort.webgpu.min.js");
    ort.env.wasm.wasmPaths = base + "ort/";
    ort.env.wasm.numThreads = 1;                            // (several threads need a page setting GitHub Pages can't give)
    const r = data.model === "transkun" ? await transkun(data.samples) : data.model === "sony" ? await sony(data.samples)
      : data.model === "qmul" ? await bytedance(data.samples, "qmul", "Queen Mary / Yamaha model") : await bytedance(data.samples);
    const { notes, pedal } = Array.isArray(r) ? { notes: r, pedal: null } : r;
    self.postMessage({ type: "done", notes, pedal, backend: providers && providers[0] });
  } catch (e) {
    self.postMessage({ type: "error", message: String(e && (e.stack || e.message) || e) });
  }
};
