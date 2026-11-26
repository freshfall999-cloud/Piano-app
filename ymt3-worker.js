// YourMT3+ (Sungkyun Chang, Emmanouil Benetos, Holger Kirchhoff, Simon Dixon; MLSP 2024) — multi-instrument
// transcription — in the browser with ONNX Runtime Web. Weights: Apache-2.0 (huggingface.co/mimbres/YourMT3,
// checkpoint YPTF.MoE+Multi noPS), via the unofficial ONNX export huggingface.co/ONLY4DarkKnight/YourMT3-plus-onnx
// (Apache-2.0), stored here as 16-bit floats. The decoding loop follows that export's ort_infer.py; the token → note
// code is a port of the authors' event2note.py / note2event.py (amt/src, Apache-2.0 on the HF Space).
/* global ort */
const SR = 16000, SEG = 32767, CH = 13, LAYERS = 8, H = 6, DK = 64, MAXLEN = 256, EOS = 1, TPS = 100;
const say = (type, value) => self.postMessage({ type, value });
const pause = () => new Promise(r => setTimeout(r, 0));
let base = "";

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
// ---------- the model's input: log magnitude spectrogram of a 2.05 s piece, scaled to 0…1 ----------
const NF = 2048, HOPS = 300, T_ENC = 110;
let fft2048 = null; const WIN = new Float64Array(NF);
for (let i = 0; i < NF; i++) WIN[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NF);
function spectrogram(seg) {
  fft2048 = fft2048 || makeFFT(NF);
  const out = new Float64Array(T_ENC * 1024), re = new Float64Array(NF), im = new Float64Array(NF);
  const at = i => { let k = i - 1024; if (k < 0) k = -k; if (k >= SEG) k = 2 * (SEG - 1) - k; return seg[k]; };
  let mx = -Infinity, mn = Infinity;
  for (let t = 0; t < T_ENC; t++) {
    for (let j = 0; j < NF; j++) { re[j] = at(t * HOPS + j) * WIN[j]; im[j] = 0; }
    fft2048(re, im);
    for (let k = 1; k <= 1024; k++) { const v = Math.log(Math.hypot(re[k], im[k]) + 1e-5); out[t * 1024 + k - 1] = v; if (v > mx) mx = v; if (v < mn) mn = v; }
  }
  const f = new Float32Array(T_ENC * 1024);
  for (let i = 0; i < f.length; i++) f[i] = (out[i] - mn) / (mx - mn + 0.008);
  return f;
}

// ---------- loading (weights stored as 16-bit floats) ----------
async function fetchBuf(path, label) {
  // GitHub Pages sends these files compressed: the size it reports is the compressed one, and the bytes that
  // arrive (already unpacked by the browser) are more. So collect whatever arrives instead of trusting that size.
  const r = await fetch(base + path);
  if (!r.ok) throw new Error("couldn't download " + path);
  const size = +r.headers.get("content-length") || 0, packed = !!r.headers.get("content-encoding");
  if (!r.body) return new Uint8Array(await r.arrayBuffer());
  const rd = r.body.getReader(), parts = [];
  let got = 0, last = 0;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    parts.push(value); got += value.length;
    if (label && performance.now() - last > 300) { last = performance.now(); say("download", { label, f: size && !packed ? Math.min(1, got / size) : null, mb: got / 1e6 }); }
  }
  if (parts.length === 1) { const v = parts[0]; return v.byteOffset === 0 && v.byteLength === v.buffer.byteLength ? v : v.slice(); }   // (a whole buffer of its own)
  const out = new Uint8Array(got); let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
const F16 = (() => { const t = new Float32Array(65536); for (let h = 0; h < 65536; h++) { const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
  t[h] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15); } return t; })();
let gpuOk = null;
// A session that runs on the graphics chip when it can, and moves to the processor for good if the graphics chip
// fails (ONNX Runtime's WebGPU can't run every step, e.g. an expert layer that gets no input).
async function session(name, label, processorOnly = false) {
  const graph = await fetchBuf("models/" + name + ".onnx");
  const h16 = await fetchBuf("models/" + name + ".f16", label), h = new Uint16Array(h16.buffer, h16.byteOffset, h16.byteLength >> 1);
  const w = new Float32Array(h.length); for (let i = 0; i < h.length; i++) w[i] = F16[h[i]];
  const create = eps => ort.InferenceSession.create(graph, { externalData: [{ path: name + ".f32", data: new Uint8Array(w.buffer) }], graphOptimizationLevel: "all", executionProviders: eps });
  if (gpuOk === null) { gpuOk = false; try { gpuOk = !!(self.navigator.gpu && await navigator.gpu.requestAdapter()); } catch (e) {} }
  let onGpu = gpuOk && !processorOnly, s;
  try { s = await create(onGpu ? ["webgpu", "wasm"] : ["wasm"]); } catch (e) { if (!onGpu) throw e; onGpu = false; s = await create(["wasm"]); }
  return {
    get backend() { return onGpu ? "webgpu" : "wasm"; },
    async run(feeds) {
      if (!onGpu) return await s.run(feeds);
      // on the graphics chip: give up on it if it errors, hangs (some iPads), or hands back broken numbers
      const toCpu = async why => { console.warn(name + ": graphics chip " + why + ", using the processor"); onGpu = false; try { s.release && s.release(); } catch (e) {} s = await create(["wasm"]); return await s.run(feeds); };
      let out;
      try { out = await Promise.race([s.run(feeds), new Promise((_, no) => setTimeout(() => no(new Error("timed out")), 120000))]); }
      catch (e) { return await toCpu("failed (" + (e && e.message || e) + ")"); }
      for (const t of Object.values(out)) {
        const d = t.data; if (!d || !d.length || typeof d[0] !== "number") continue;
        for (let i = 0; i < d.length; i += Math.max(1, d.length >> 12)) if (!Number.isFinite(d[i])) return await toCpu("gave broken numbers");
      }
      return out;
    },
  };
}

// ---------- greedy decoding of the 13 instrument channels of one piece (as ort_infer.decode_batch) ----------
async function decodePiece(step, ck, cv) {
  let n = CH, alive = Array.from({ length: n }, (_, i) => i), S = 64;
  const out = Array.from({ length: n }, () => []);
  let pk = Array.from({ length: LAYERS }, () => new Float32Array(n * H * DK * S)), pv = Array.from({ length: LAYERS }, () => new Float32Array(n * H * S * DK));
  let ids = new BigInt64Array(n), CK = ck, CV = cv;
  for (let pos = 0; pos < MAXLEN; pos++) {
    const N = alive.length;
    if (pos >= S) {                                         // the cache doubles when full
      const S2 = S * 2;
      for (let l = 0; l < LAYERS; l++) {
        const a = new Float32Array(N * H * DK * S2), b = new Float32Array(N * H * S2 * DK);
        for (let r = 0; r < N * H; r++) {
          for (let d = 0; d < DK; d++) a.set(pk[l].subarray((r * DK + d) * S, (r * DK + d + 1) * S), (r * DK + d) * S2);
          b.set(pv[l].subarray(r * S * DK, (r + 1) * S * DK), r * S2 * DK);
        }
        pk[l] = a; pv[l] = b;
      }
      S = S2;
    }
    const feeds = { ids: new ort.Tensor("int64", ids, [N]), pos: new ort.Tensor("int64", BigInt64Array.from([BigInt(pos)]), [1]) };
    for (let l = 0; l < LAYERS; l++) {
      feeds["pk_" + l] = new ort.Tensor("float32", pk[l], [N, H, DK, S]); feeds["pv_" + l] = new ort.Tensor("float32", pv[l], [N, H, S, DK]);
      feeds["ck_" + l] = CK[l]; feeds["cv_" + l] = CV[l];
    }
    const res = await step.run(feeds);
    const nxt = res.next_id.data;
    for (let l = 0; l < LAYERS; l++) {
      const nk = res["nk_" + l].data, nv = res["nv_" + l].data;
      for (let r = 0; r < N * H; r++) for (let d = 0; d < DK; d++) {
        pk[l][(r * DK + d) * S + pos] = nk[r * DK + d];
        pv[l][(r * S + pos) * DK + d] = nv[r * DK + d];
      }
    }
    const done = [];
    for (let j = 0; j < N; j++) { const t = Number(nxt[j]); out[alive[j]].push(t); done.push(pos >= 1 && t === EOS); }
    if (done.every(Boolean)) break;
    ids = BigInt64Array.from(nxt, v => BigInt(v));
    if (done.some(Boolean)) {                               // drop finished rows (their results are no longer used)
      const keep = done.map((d, j) => d ? -1 : j).filter(j => j >= 0), K = keep.length;
      alive = keep.map(j => alive[j]); ids = BigInt64Array.from(keep, j => ids[j]);
      const pick = (arr, per) => { const o = new Float32Array(K * per); keep.forEach((j, q) => o.set(arr.subarray(j * per, (j + 1) * per), q * per)); return o; };
      pk = pk.map(a => pick(a, H * DK * S)); pv = pv.map(a => pick(a, H * S * DK));
      CK = CK.map(t => { const per = t.data.length / N; return new ort.Tensor("float32", pick(t.data, per), [K, ...t.dims.slice(1)]); });
      CV = CV.map(t => { const per = t.data.length / N; return new ort.Tensor("float32", pick(t.data, per), [K, ...t.dims.slice(1)]); });
    }
    if (pos % 16 === 0) await pause();
  }
  // up to the first end token after the first step, without trailing padding
  return out.map(t => { const r = []; for (let i = 0; i < t.length; i++) { r.push(t[i]); if (i >= 1 && t[i] === EOS) break; } while (r.length && r[r.length - 1] === 0) r.pop(); return r; });
}

// ---------- tokens → notes (ported from YourMT3's event2note.py and note2event.py) ----------
const pyRound = x => { const f = Math.floor(x), d = x - f; return d > 0.5 ? f + 1 : d < 0.5 ? f : (f % 2 === 0 ? f : f + 1); };
function event2noteEvent(events, start) {
  let tieIndex = null, program = null; const ties = [], last = [];
  for (let i = 0; i < events.length; i++) {
    const [type, value] = events[i];
    if (type === "tie") { tieIndex = i; break; }
    if (type === "shift") break;
    if (type === "program") program = value;
    else if (type === "pitch" && program !== null) { ties.push({ drum: false, program, time: null, velocity: 1, pitch: value }); last.push(program + ":" + value); }
  }
  if (tieIndex === null) return [[], [], []];
  const rest = events.slice(tieIndex + 1), nes = [];
  let velocity = null; const startTick = pyRound(start * TPS); let tick = startTick;
  for (const [type, value] of rest) {
    if (type === "shift") { if (value <= 0 || value > 1000) continue; tick = startTick + value; }
    else if (type === "drum") nes.push({ drum: true, program: 128, time: tick / TPS, velocity: 1, pitch: value });
    else if (type === "program") program = value;
    else if (type === "velocity") velocity = value;
    else if (type === "pitch") {
      if (program === null || velocity === null) continue;
      const k = program + ":" + value;
      if (velocity > 0) last.push(k);
      else if (last.includes(k)) last.splice(last.indexOf(k), 1);
      else continue;
      nes.push({ drum: false, program, time: tick / TPS, velocity, pitch: value });
    } else if (type === "EOS") break;
  }
  nes.sort((a, b) => a.time - b.time || a.drum - b.drum || a.program - b.program || a.velocity - b.velocity || a.pitch - b.pitch);
  return [nes, ties, last];
}
const MIN_OFF = 0.01;
function noteEvent2note(nes) {
  const notes = [], active = new Map();
  nes.sort((a, b) => a.time - b.time || a.drum - b.drum || a.pitch - b.pitch || a.velocity - b.velocity || a.program - b.program);
  for (const ne of nes) {
    if (ne.time === null) continue;
    if (ne.drum) { if (ne.velocity === 1) notes.push({ drum: true, program: 128, onset: ne.time, offset: ne.time + MIN_OFF, pitch: ne.pitch, velocity: 1 }); continue; }
    const k = ne.pitch + ":" + ne.program, a = active.get(k);
    if (ne.velocity === 1) { if (a) { active.delete(k); notes.push({ drum: false, program: a.program, onset: a.time, offset: ne.time, pitch: a.pitch, velocity: a.velocity }); } active.set(k, ne); }
    else if (ne.velocity === 0 && a) { active.delete(k); notes.push({ drum: false, program: a.program, onset: a.time, offset: ne.time, pitch: a.pitch, velocity: a.velocity }); }
  }
  for (const ne of active.values()) if (ne.velocity === 1 && ne.time !== null) notes.push({ drum: false, program: ne.program, onset: ne.time, offset: ne.time + MIN_OFF, pitch: ne.pitch, velocity: 1 });
  for (const n of notes) if (n.offset - n.onset > 10) n.offset = n.onset + MIN_OFF;
  return tidy(notes);
}
function tidy(notes) {                                       // validate_notes + trim_overlapping_notes
  for (const n of notes) { if (n.onset > n.offset) n.offset = Math.max(n.offset, n.onset + MIN_OFF); else if (!n.drum && n.offset - n.onset < 0.01) n.offset = n.onset + MIN_OFF; }
  const byKey = new Map();
  for (const n of notes) { const k = n.pitch + ":" + n.program + ":" + n.drum; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(n); }
  const out = [];
  for (const list of byKey.values()) {
    list.sort((a, b) => a.onset - b.onset);
    for (let i = 1; i < list.length; i++) if (list[i - 1].offset > list[i].onset) list[i - 1].offset = list[i].onset;
    out.push(...list.filter(n => n.onset < n.offset));
  }
  return out.sort((a, b) => a.onset - b.onset || a.drum - b.drum || a.program - b.program || a.velocity - b.velocity || a.pitch - b.pitch);
}
function channelNotes(segments, vocab) {                     // merge_zipped_note_events_and_ties_to_notes, one channel
  const merged = []; let prevLast = null;
  segments.forEach(({ tokens, start }) => {
    const events = tokens.filter(t => t !== 0).map(t => vocab[t]);
    const [nes, ties, last] = event2noteEvent(events, start);
    if (prevLast !== null) {
      const tied = new Set(ties.map(t => t.program + ":" + t.pitch));
      for (const k of prevLast) if (!tied.has(k)) { const [p, pitch] = k.split(":").map(Number); merged.push({ drum: false, program: p, time: start, velocity: 0, pitch }); }
    }
    merged.push(...nes); prevLast = last;
  });
  return noteEvent2note(merged);
}

// ---------- spectral flux at 22,050 Hz for the beat finder in arrange.js ----------
function fluxOf(samples) {
  const N = 1024, Hh = 256, half = N / 2, n = Math.floor(samples.length / Hh), win = new Float32Array(N), re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const fft = makeFFT(N), prev = new Float32Array(half), all = new Float32Array(n), low = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    for (let i = 0; i < N; i++) { const k = t * Hh + i - half; re[i] = k >= 0 && k < samples.length ? samples[k] * win[i] : 0; im[i] = 0; }
    fft(re, im);
    let f = 0, g = 0;
    for (let k = 1; k < half; k++) { const m = Math.log1p(100 * Math.hypot(re[k], im[k])); if (m > prev[k]) { f += m - prev[k]; if (k <= 12) g += m - prev[k]; } prev[k] = m; }
    all[t] = f; low[t] = g;
  }
  return { all, low };
}

self.onmessage = async ({ data }) => {
  try {
    base = data.base;
    importScripts(base + "ort/ort.webgpu.min.js");
    ort.env.wasm.wasmPaths = base + "ort/"; ort.env.wasm.numThreads = 1;
    const meta = await (await fetch(base + "models/ymt3_vocab.json")).json();
    // the encoder on the processor (its expert layers trip up WebGPU); the step-by-step decoder on the graphics chip if there is one
    const enc = await session("ymt3_encoder", "YourMT3+ model (1 of 2)", true), step = await session("ymt3_decoder", "YourMT3+ model (2 of 2)");
    const audio = data.samples, n = Math.max(1, Math.ceil(audio.length / SEG)), rows = [];
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      const seg = new Float32Array(SEG); seg.set(audio.subarray(i * SEG, Math.min(audio.length, (i + 1) * SEG)));
      const kv = await enc.run({ spec: new ort.Tensor("float32", spectrogram(seg), [1, T_ENC, 1024]) });
      const ck = [], cv = []; for (let l = 0; l < LAYERS; l++) { ck.push(kv["ck_" + l]); cv.push(kv["cv_" + l]); }
      rows.push(await decodePiece(step, ck, cv));
      say("progress", { piece: i + 1, pieces: n, secs: (performance.now() - t0) / 1000 });
    }
    let notes = [];
    for (let c = 0; c < CH; c++) notes.push(...channelNotes(rows.map((r, i) => ({ tokens: r[c], start: SEG * i / SR })), meta.events));
    notes = tidy(notes);                                     // mix_notes
    const out = notes.map(nn => [nn.pitch, nn.onset, nn.offset, nn.drum ? -1 : nn.program]);
    const flux = data.samples22 ? fluxOf(data.samples22) : null;
    self.postMessage({ type: "done", notes: out, programs: meta.programs, tokens: data.keepTokens ? rows : null, flux, backend: step.backend });
  } catch (e) {
    self.postMessage({ type: "error", message: String(e && (e.message || e)) });
  }
};
