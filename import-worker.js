// Turns a recording into notes with Spotify's Basic Pitch, away from the screen: the page stays smooth while it works,
// and when it's done the whole worker (and all the memory it used) is thrown away.
// The song goes through the model two seconds at a time and every piece of memory is freed straight after,
// so a long song needs no more memory than a short one (the model's own helper kept every piece, which made iPads crash).
/* global tf, BasicPitchLib */
self.window = self;                                   // basic-pitch.js looks for window.tf
const RATE = 22050, HOP = 256, WIN = RATE * 2 - HOP, TRIM = 15, PAD = 30 * HOP, STEP = WIN - PAD, PITCHES = 88;
function makeFFT(n) {                                     // radix-2 FFT, in place
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
self.onmessage = async ({ data }) => {
  try {
    importScripts(data.base + "tf.min.js", data.base + "tf-backend-wasm.min.js", data.base + "basic-pitch/basic-pitch.js");
    try { tf.wasm.setWasmPaths(data.base); await tf.setBackend("wasm"); } catch (e) { await tf.setBackend("cpu"); }
    await tf.ready();
    const model = await tf.loadGraphModel(data.base + "basic-pitch/model.json");
    const samples = data.samples;
    // the same windows as Basic Pitch's own helper: half an overlap of silence first, then 2-second windows
    const total = Math.floor(samples.length * (Math.floor(RATE / HOP) / RATE));
    const frames = new Float32Array(total * PITCHES), onsets = new Float32Array(total * PITCHES);
    const win = new Float32Array(WIN);
    const padded = samples.length + PAD / 2, windows = Math.ceil(padded / STEP);
    let done = 0, lastPost = 0;
    for (let w = 0; w < windows && done < total; w++) {
      const start = w * STEP - PAD / 2;               // where this window starts in the real audio
      win.fill(0);
      const a = Math.max(0, start), b = Math.min(samples.length, start + WIN);
      if (b > a) win.set(samples.subarray(a, b), a - start);
      const out = tf.tidy(() => {
        const o = model.execute(tf.tensor3d(win, [1, WIN, 1]), ["Identity_1", "Identity_2"]);
        return o.map(t => { const n = t.shape[1]; return t.slice([0, TRIM, 0], [1, n - 2 * TRIM, PITCHES]); });
      });
      const [f, o] = await Promise.all(out.map(t => t.data()));
      out.forEach(t => t.dispose());
      const rows = Math.min(f.length / PITCHES, total - done);
      frames.set(f.subarray(0, rows * PITCHES), done * PITCHES);
      onsets.set(o.subarray(0, rows * PITCHES), done * PITCHES);
      done += rows;
      const now = performance.now();
      if (now - lastPost > 250) { lastPost = now; self.postMessage({ type: "progress", value: done / total }); }
    }
    model.dispose();
    // notes from the model's guesses. Thresholds tuned on recordings with known notes: strict for solo piano,
    // looser for full songs, where singing, guitar and 808 bass reach the model more faintly through the mix
    const F = [], O = [];
    for (let i = 0; i < done; i++) { F.push(frames.subarray(i * PITCHES, (i + 1) * PITCHES)); O.push(onsets.subarray(i * PITCHES, (i + 1) * PITCHES)); }
    const { outputToNotesPoly, noteFramesToTime } = BasicPitchLib;
    const notes = noteFramesToTime(outputToNotesPoly(F, O, data.onset ?? 0.7, data.frame ?? 0.45, 7, true, null, null, false, 11))
      .map(n => [n.pitchMidi, n.startTimeSeconds, n.durationSeconds, n.amplitude]);
    // for making a piano arrangement: how sharply the sound changes, frame by frame (finds the beat, drums included)
    let flux = null;
    if (data.arrange) {
      const N = 1024, half = N / 2, n = Math.floor(samples.length / HOP), win = new Float32Array(N), re = new Float64Array(N), im = new Float64Array(N);
      for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
      const fft = makeFFT(N), prev = new Float32Array(half);
      flux = new Float32Array(n); var low = new Float32Array(n);
      for (let t = 0; t < n; t++) {
        for (let i = 0; i < N; i++) { const k = t * HOP + i - half; re[i] = k >= 0 && k < samples.length ? samples[k] * win[i] : 0; im[i] = 0; }
        fft(re, im);
        let f = 0;
        let g = 0;
        for (let k = 1; k < half; k++) { const m = Math.log1p(100 * Math.hypot(re[k], im[k])); if (m > prev[k]) { f += m - prev[k]; if (k <= 12) g += m - prev[k]; } prev[k] = m; }
        flux[t] = f; low[t] = g;                               // (bins up to ~250 Hz: kick drum and bass)
      }
    }
    self.postMessage({ type: "done", notes, raw: data.keepRaw || data.arrange ? { frames: frames.subarray(0, done * PITCHES), onsets } : null, flux: flux && { all: flux, low } });
  } catch (e) {
    self.postMessage({ type: "error", message: String(e && e.message || e) });
  }
};
