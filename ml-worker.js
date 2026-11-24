// Runs the Basic Pitch model off the main thread, so the screen and the sound never wait for it.
/* global tf */
let model = null;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === "init") {
      importScripts(data.base + "tf.min.js", data.base + "tf-backend-wasm.min.js");
      tf.wasm.setWasmPaths(data.base);
      await tf.setBackend("wasm"); await tf.ready();
      model = await tf.loadGraphModel(data.base + "basic-pitch/model.json");
      const x = tf.zeros([1, 43844, 1]);
      for (let i = 0; i < 2; i++) { const o = model.execute(x, ["Identity_1", "Identity_2"]); await Promise.all(o.map(t => t.data())); o.forEach(t => t.dispose()); }
      x.dispose();
      self.postMessage({ type: "ready", backend: tf.getBackend() });
    } else if (data.type === "run") {
      const t0 = performance.now();
      const out = tf.tidy(() => model.execute(tf.tensor3d(data.samples, [1, 43844, 1]), ["Identity_1", "Identity_2"]));
      const [frames, onsets] = await Promise.all(out.map(t => t.data()));
      out.forEach(t => t.dispose());
      self.postMessage({ type: "result", id: data.id, frames, onsets, ms: performance.now() - t0 }, [frames.buffer, onsets.buffer]);
    }
  } catch (e) {
    self.postMessage({ type: "error", message: String(e && e.message || e) });
  }
};
