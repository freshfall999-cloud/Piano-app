// Turns a recording into notes with Spotify's Basic Pitch, away from the screen: the page stays smooth while it works,
// and when it's done the whole worker (and all the memory it used) is thrown away.
// The song goes through the model two seconds at a time and every piece of memory is freed straight after,
// so a long song needs no more memory than a short one (the model's own helper kept every piece, which made iPads crash).
/* global tf, BasicPitchLib */
self.window = self;                                   // basic-pitch.js looks for window.tf
const RATE = 22050, HOP = 256, WIN = RATE * 2 - HOP, TRIM = 15, PAD = 30 * HOP, STEP = WIN - PAD, PITCHES = 88;
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
    // notes from the model's guesses (thresholds tuned on piano recordings with known notes)
    const F = [], O = [];
    for (let i = 0; i < done; i++) { F.push(frames.subarray(i * PITCHES, (i + 1) * PITCHES)); O.push(onsets.subarray(i * PITCHES, (i + 1) * PITCHES)); }
    const { outputToNotesPoly, noteFramesToTime } = BasicPitchLib;
    const notes = noteFramesToTime(outputToNotesPoly(F, O, 0.7, 0.45, 7, true, null, null, false, 11))
      .map(n => [n.pitchMidi, n.startTimeSeconds, n.durationSeconds, n.amplitude]);
    self.postMessage({ type: "done", notes, raw: data.keepRaw ? { frames, onsets } : null });
  } catch (e) {
    self.postMessage({ type: "error", message: String(e && e.message || e) });
  }
};
