// Google Magenta's Onsets and Frames (the "best quality" note finder), run away from the screen so the page stays smooth.
// It runs in its own worker, so its older TensorFlow.js never mixes with the app's, and all its memory goes when it's done.
/* global mm */
self.window = self;
// Magenta asks for an audio context while loading (for features we don't use); the audio here arrives ready at 16 kHz.
self.WorkerGlobalScope = undefined;
self.OfflineAudioContext = function () { return { sampleRate: 16000, createBuffer() { throw new Error("no audio here"); } }; };
self.document = { createElement() { throw new Error("no page here"); } };   // so TensorFlow.js knows it is in a browser
importScripts("vendor/magenta/magentamusic.js");
let model = null;
self.onmessage = async ({ data }) => {
  try {
    if (!model) {
      model = new mm.OnsetsAndFrames("vendor/magenta/onsets_frames/");
      await model.initialize();
      const backend = mm.tf.getBackend();
      // without the graphics chip it would take ages: let the page use its own fallback instead
      if (backend !== "webgl" && !data.anyBackend) { self.postMessage({ type: "error", message: "backend " + backend }); return; }
    }
    // 20 seconds at a time; neighbours overlap by 2 seconds and keep only the notes that start in their middle part
    const samples = data.samples, rate = 16000, SEG = 20, EDGE = 2, len = samples.length, step = (SEG - 2 * EDGE) * rate, out = [];
    for (let s0 = 0; s0 < len; s0 += step) {
      const a = Math.max(0, s0 - EDGE * rate), b = Math.min(len, s0 + step + EDGE * rate), part = samples.subarray(a, b);
      const buf = { sampleRate: rate, numberOfChannels: 1, length: part.length, duration: part.length / rate, getChannelData: () => part };
      const ns = await model.transcribeFromAudioBuffer(buf);
      const from = s0 / rate, to = s0 + step >= len ? Infinity : (s0 + step) / rate;
      for (const n of ns.notes) {
        const start = (n.startTime || 0) + a / rate;
        if (start >= from - (s0 ? 0 : 1) && start < to) out.push([n.pitch, start, (n.endTime || 0) + a / rate, n.velocity || 80]);
      }
      self.postMessage({ type: "progress", value: Math.min(1, (s0 + step) / len) });
    }
    self.postMessage({ type: "done", notes: out });
  } catch (e) {
    self.postMessage({ type: "error", message: String(e && (e.stack || e.message) || e) });
  }
};
