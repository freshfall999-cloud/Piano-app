// Turns a full song (singing, guitar, drums, 808s…) into a playable piano arrangement, the way "song to piano"
// apps do, instead of writing down every sound: find the beat, the chords and the main melody, then write
// right hand = melody, left hand = bass note + chord, all lined up on the beat.
// Input: Basic Pitch's notes and frame-by-frame pitch activations, and the recording's spectral flux.
(() => {
  const FPS = 22050 / 256, P = 88;
  const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

  // ---------- the beat (Ellis 2007 dynamic-programming beat tracker) ----------
  function env(flux) {                                     // onset strength: rises above the local average
    const n = flux.length, o = new Float32Array(n), W = Math.round(FPS * 0.4), pre = new Float64Array(n + 1);
    let sum = 0;
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + flux[i];
    for (let i = 0; i < n; i++) { const a = Math.max(0, i - W), b = Math.min(n, i + W); o[i] = Math.max(0, flux[i] - (pre[b] - pre[a]) / (b - a)); sum += o[i] * o[i]; }
    const sd = Math.sqrt(sum / n) || 1; for (let i = 0; i < n; i++) o[i] /= sd;
    return o;
  }
  function beats(flux) {
    const A = env(flux.all), Lo = env(flux.low), n = A.length;
    const ac = (o, Lf) => {                                  // how alike the song is with itself Lf frames later
      const L0 = Math.floor(Lf), w = Lf - L0; let a = 0, b = 0;
      for (let i = L0 + 1; i < n; i++) { a += o[i] * o[i - L0]; b += o[i] * o[i - L0 - 1]; }
      return ((1 - w) * a + w * b) / (n - L0);
    };
    // tempo: a beat that repeats (all sounds, and the kick drum and bass on their own), adds up to bars,
    // and splits evenly into sixteenths (hi-hats). Trap rhythms (3 + 3 + 2) alone would suggest 4/3 of the tempo.
    let best = -1, lag = FPS * 0.6;
    for (let bpm = 60; bpm <= 180; bpm += 0.5) {
      const L = 60 * FPS / bpm;
      const v = (ac(A, L) + ac(Lo, L) + 0.5 * (ac(A, 4 * L) + ac(Lo, 4 * L)) + ac(A, L / 4) + ac(A, L / 2))
        * Math.exp(-0.5 * (Math.log2(bpm / 95) / 0.7) ** 2);
      if (v > best) { best = v; lag = L; }
    }
    const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = A[i] + Lo[i];
    // the beats: strong onsets about one beat apart
    const C = new Float64Array(n), from = new Int32Array(n).fill(-1), alpha = 400;
    for (let t = 0; t < n; t++) {
      let m = 0, arg = -1;
      for (let p = Math.round(t - 2 * lag); p <= Math.round(t - lag / 2); p++) {
        if (p < 0) continue;
        const v = C[p] - alpha * Math.log((t - p) / lag) ** 2;
        if (arg < 0 || v > m) { m = v; arg = p; }
      }
      C[t] = o[t] + (arg >= 0 ? Math.max(0, m) : 0); from[t] = arg >= 0 && m > 0 ? arg : -1;
    }
    let t = n - 1; for (let i = Math.max(0, Math.round(n - lag)); i < n; i++) if (C[i] > C[t]) t = i;
    const out = [];
    while (t >= 0) { out.push(t / FPS); t = from[t]; }
    out.reverse();
    return { times: out, beat: lag / FPS };
  }

  // ---------- the chords: 12 major + 12 minor, from the pitches heard during each beat, smoothed over time ----------
  function chords(frames, bt) {
    const T = frames.length / P, nb = bt.length - 1, chroma = [], bass = [];
    for (let i = 0; i < nb; i++) {
      const a = Math.round(bt[i] * FPS), b = Math.min(T, Math.round(bt[i + 1] * FPS));
      const c = new Float64Array(12), lo = new Float64Array(12);
      for (let f = a; f < b; f++) for (let p = 0; p < P; p++) {
        const v = frames[f * P + p]; if (v < 0.2) continue;
        c[(p + 21) % 12] += v; if (p + 21 < 55) lo[(p + 21) % 12] += v;
      }
      chroma.push(c); bass.push(lo);
    }
    const tpl = [];
    for (let r = 0; r < 12; r++) for (const q of [0, 1]) tpl.push({ root: r, minor: q, pcs: [r, (r + (q ? 3 : 4)) % 12, (r + 7) % 12] });
    // how well each chord fits each beat
    const fit = chroma.map((c, i) => {
      const tot = c.reduce((a, v) => a + v, 0) || 1, btot = bass[i].reduce((a, v) => a + v, 0) || 1;
      return tpl.map(k => {
        let inside = 0; for (const pc of k.pcs) inside += c[pc];
        return inside / tot + 0.35 * c[k.root] / tot + 0.4 * bass[i][k.root] / btot;
      });
    });
    // Viterbi: changing chord costs a little, so chords hold steady through passing notes
    const S = tpl.length, stay = 0.25, V = [fit[0].slice()], back = [];
    for (let i = 1; i < nb; i++) {
      const prev = V[i - 1], bestPrev = prev.reduce((m, v, j) => v > prev[m] ? j : m, 0), row = [], bk = [];
      for (let k = 0; k < S; k++) {
        const keep = prev[k] + stay, change = prev[bestPrev];
        row.push(fit[i][k] + Math.max(keep, change)); bk.push(keep >= change ? k : bestPrev);
      }
      V.push(row); back.push(bk);
    }
    const seq = new Array(nb);
    let k = V[nb - 1].reduce((m, v, j) => v > V[nb - 1][m] ? j : m, 0);
    for (let i = nb - 1; i >= 0; i--) { seq[i] = tpl[k]; if (i > 0) k = back[i - 1][k]; }
    // a beat with almost nothing pitched (a drum break) has no chord
    return seq.map((k, i) => chroma[i].reduce((a, v) => a + v, 0) > 0.5 ? k : null);
  }

  // ---------- the melody: one line through the notes, preferring long, loud, held notes and small steps ----------
  function melody(notes, frames, opt = {}) {
    const COST = opt.cost ?? 0.18, HOLD = opt.hold ?? 0.6;
    const T = frames.length / P;
    const cand = notes.filter(n => n.midi >= 55 && n.midi <= 86 && n.end - n.start >= 0.08).map(n => {
      // a sung or held note keeps its strength; a plucked or struck one fades
      const a = Math.round(n.start * FPS), b = Math.min(T - 1, Math.round(n.end * FPS)), p = n.midi - 21;
      let first = 0, rest = 0, cnt = 0;
      for (let f = a; f <= b; f++) { const v = frames[f * P + p]; if (f < a + 3) first = Math.max(first, v); else { rest += v; cnt++; } }
      const hold = cnt ? Math.min(1, rest / cnt / Math.max(first, 0.05)) : 0.5;
      return { ...n, score: n.amp * Math.sqrt(n.end - n.start) * (0.2 + HOLD * hold) * (1 + (n.midi - 55) / 60) - COST };
    }).sort((x, y) => x.start - y.start);
    const best = new Float64Array(cand.length), from = new Int32Array(cand.length).fill(-1);
    let far = -1, fp = 0;                                    // the best line ending more than 4 s earlier (across a break)
    for (let j = 0; j < cand.length; j++) {
      while (fp < j && cand[fp].start < cand[j].start - 4) { if (far < 0 || best[fp] > best[far]) far = fp; fp++; }
      best[j] = cand[j].score;
      if (cand[j].score <= 0) { best[j] = -1e9; continue; }   // too weak to be worth a melody note
      if (far >= 0 && best[far] + cand[j].score - 0.1 > best[j]) { best[j] = best[far] + cand[j].score - 0.1; from[j] = far; }
      for (let i = j - 1; i >= 0 && cand[j].start - cand[i].start < 4; i--) {
        if (cand[i].start > cand[j].start - 0.07) continue;               // no two melody notes at once
        const jump = Math.abs(cand[j].midi - cand[i].midi), gap = Math.max(0, cand[j].start - cand[i].end);
        const v = best[i] + cand[j].score - 0.012 * jump * jump / 12 - 0.02 * gap;
        if (v > best[j]) { best[j] = v; from[j] = i; }
      }
    }
    const line = [];
    let j = best.reduce((m, v, i) => v > best[m] ? i : m, 0);
    // walk back from the best ending, then also keep the best chains before it
    while (j >= 0) { line.push(cand[j]); j = from[j]; }
    return line.reverse();
  }

  // ---------- put it together on the beat grid ----------
  function arrange(found, frames, flux, opt = {}) {
    const notes = found.map(([midi, start, dur, amp]) => ({ midi, start, end: start + dur, amp }));
    const { times, beat } = beats(flux);
    if (times.length < 8) return null;
    const seq = chords(frames, times);
    // the first beat of each bar: where chords change most often, and where the kick drum / bass hits hardest
    const lowEnv = env(flux.low), kick = times.map(t => { const f = Math.round(t * FPS); let m = 0; for (let i = f - 3; i <= f + 3; i++) m = Math.max(m, lowEnv[i] || 0); return m; });
    let phase = 0, most = -Infinity;
    for (let ph = 0; ph < 4; ph++) {
      let c = 0, k = 0, nb = 0;
      for (let i = 1; i < seq.length; i++) if ((i - ph) % 4 === 0) {
        nb++; k += kick[i];
        if (seq[i] && seq[i - 1] && (seq[i].root !== seq[i - 1].root || seq[i].minor !== seq[i - 1].minor)) c++;
      }
      const v = c / Math.max(1, nb) + 0.15 * k / Math.max(1, nb);
      if (v > most) { most = v; phase = ph; }
    }
    // a moment in the song → its place on the beat grid, snapped to a quarter of a beat
    const grid = t => {
      let i = 0; while (i < times.length - 2 && times[i + 1] <= t) i++;
      const span = times[i + 1] - times[i], pos = i + (t - times[i]) / span;
      return Math.round(pos * 4) / 4;
    };
    const at = pos => { const i = Math.min(times.length - 2, Math.max(0, Math.floor(pos))); return times[i] + (pos - i) * (times[i + 1] - times[i]); };
    const out = [];
    // right hand: the melody
    let lastPos = -1;
    for (const n of melody(notes, frames, opt)) {
      const p = grid(n.start); if (p <= lastPos) continue;
      let q = Math.max(p + 0.25, grid(n.end));
      out.push({ midi: n.midi, pos: p, len: q - p, left: 0, amp: Math.min(1, 0.5 + n.amp) }); lastPos = p;
    }
    out.forEach((n, i) => { const nx = out[i + 1]; n.len = nx ? Math.min(Math.max(n.len, Math.min(nx.pos - n.pos, 2)), nx.pos - n.pos) : n.len; });
    // left hand: bass note and the chord, at each chord change and at the start of every bar
    let i = 0;
    while (i < seq.length) {
      const k = seq[i]; let j = i + 1;
      while (j < seq.length && seq[j] === k && (j - phase) % 4 !== 0) j++;
      if (k) {
        let bassNote = 36 + k.root; if (bassNote < 40) bassNote += 12;       // E2 … D#3
        const third = (k.root + (k.minor ? 3 : 4)) % 12, fifth = (k.root + 7) % 12;
        // the chord as close to the middle of the left hand (around G3) as it fits
        const voicing = [k.root, third, fifth].map(pc => { let m = 48 + pc; if (m > 57) m -= 12; return m; }).sort((a, b) => a - b);
        out.push({ midi: bassNote, pos: i, len: j - i, left: 1, amp: 0.8 });
        for (const m of voicing) if (m > bassNote + 4) out.push({ midi: m, pos: i, len: j - i, left: 1, amp: 0.6 });
      }
      i = j;
    }
    out.sort((a, b) => a.pos - b.pos || a.midi - b.midi);
    // on an even grid of beats (the song's own small tempo wobbles smoothed out), starting at the first note
    const ivals = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b), B = ivals[ivals.length >> 1] || beat;
    const p0 = out[0].pos, r = x => Math.round(x * 1000) / 1000;
    return {
      notes: out.map(n => [n.midi, r((n.pos - p0) * B), r(Math.max(0.1, n.len * B) * 0.95), n.left, n.amp]),
      beat: r(B), bar0: r((((phase - p0) % 4) + 4) % 4 * B),
      chords: seq.map(k => k ? NAMES[k.root] + (k.minor ? "m" : "") : "-"),
    };
  }
  window.KeyfallArrange = { arrange, beats, chords, melody };
})();
