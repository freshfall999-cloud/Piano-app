(() => {
  "use strict";
  let LOW = 48, HIGH = 84;            // C3..C6
  const LOOKAHEAD = 2.6;                // seconds of music visible above the hit line
  let HIT_WINDOW = 0.22, PERFECT = 0.08;   // (Extra extra hard: 0.13 and 0.05)
  const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const isBlack = m => [1, 3, 6, 8, 10].includes(m % 12);

  // Computer keyboard: bottom row = C3 octave, top rows = C4 upward.
  const KEYMAP = {};
  [..."zsxdcvgbhnjm"].forEach((k, i) => KEYMAP[k] = 48 + i);
  [..."q2w3er5t6y7ui9o0p[=]"].forEach((k, i) => KEYMAP[k] = 60 + i);
  const KEYLABEL = {};
  for (const k in KEYMAP) KEYLABEL[KEYMAP[k]] = k.toUpperCase();

  const $ = id => document.getElementById(id);
  const canvas = $("stage"); let ctx = canvas.getContext("2d");   // (let: the printable sheet music draws through it too)
  const ui = {
    song: $("song"), mode: $("mode"), hand: $("hand"), speed: $("speed"), speedVal: $("speedVal"),
    labels: $("labels"), start: $("start"), restart: $("restart"), score: $("score"),
    streak: $("streak"), mic: $("mic"), sens: $("sens"), dClef: $("dClef"), dLedger: $("dLedger"), dAcc: $("dAcc"), dNames: $("dNames"), acc: $("acc"), midi: $("midi"), hint: $("hint"), results: $("results"),
    ready: $("ready"), pause: $("pause"), micText: $("micText"), micLvl: $("micLvl"), prog: $("progFill"), streakBox: $("streakBox"),
    ignoreTalk: $("ignoreTalk"), finder: $("finder"), level: $("level"), view: $("view"), listener: $("listener"), pedal: $("pedal"), sfx: $("sfx"), fx3d: $("fx3d"), look: $("look"), sharp: $("sharp"), scoreBox: $("score").parentNode,
  };

  const HINT = ui.hint.textContent;
  const appleMobile = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  // ---------- Audio ----------
  let ac = null, master = null;
  const voices = new Map();
  // iPads stop a page's sound now and then: a call, Siri, another app, the screen locking, the microphone turning on
  // or off, a cable plugged in. The sound is then "interrupted" or "suspended", or (an iPad bug) says it's running
  // but is stuck. So: wake it at every touch and when the page comes back, and if it won't wake, start a new one.
  function makeAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    const old = ac;
    try { ac = new AC({ latencyHint: "interactive" }); } catch (e) { ac = new AC(); }
    master = ac.createDynamicsCompressor();
    master.connect(ac.destination);
    voices.clear(); sampled.clear();
    if (window.KeyfallSound) KeyfallSound.init(ac, master);
    ac.onstatechange = () => { if (ac.state !== "running" && ac.state !== "closed" && !document.hidden) setTimeout(() => wakeAudio(false), 200); };
    audioCheck.t = -1; audioCheck.stuck = 0;
    if (old) {
      try { if (old.state !== "closed") old.close().catch(() => {}); } catch (e) {}
      if (mic.on) toggleMic().then(() => toggleMic());   // the microphone was wired to the old sound: connect it again
    }
    return ac;
  }
  function audio() {
    if (!ac || ac.state === "closed") makeAudio();
    if (ac && ac.state !== "running") { try { const r = ac.resume(); if (r && r.catch) r.catch(() => {}); } catch (e) {} }
    return ac;
  }
  const audioCheck = { t: -1, stuck: 0, failed: false };
  function wakeAudio(gesture) {
    if (!ac) return;
    if (gesture && (audioCheck.failed || ac.state === "closed")) { audioCheck.failed = false; makeAudio(); }   // a touch may start a new one
    if (ac.state === "running") return;
    const was = ac;
    try { const r = ac.resume(); if (r && r.catch) r.catch(() => {}); } catch (e) {}
    setTimeout(() => { if (ac === was && ac.state !== "running") { audioCheck.failed = true; if (gesture) makeAudio(); } }, 500);
  }
  ["pointerdown", "touchend", "keydown"].forEach(t => window.addEventListener(t, () => wakeAudio(true), { capture: true, passive: true }));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) wakeAudio(false); });
  window.addEventListener("pageshow", () => wakeAudio(false));
  setInterval(() => {                                // running, but the clock doesn't move: stuck
    if (!ac || document.hidden) return;
    if (ac.state !== "running") { wakeAudio(false); return; }
    if (ac.currentTime === audioCheck.t) { if (++audioCheck.stuck >= 2) { audioCheck.failed = true; audioCheck.stuck = 0; } }
    else audioCheck.stuck = 0;
    audioCheck.t = ac.currentTime;
  }, 1500);
  // sound plays even with the iPad's silent switch on, and the microphone's audio mode is undone when it's off
  const audioMode = type => { if (navigator.audioSession) try { if (navigator.audioSession.type !== type) navigator.audioSession.type = type; } catch (e) {} };
  audioMode("playback");
  const sampled = new Set();
  function noteOn(midi, vel = 0.8) {
    if (!audio()) return;
    noteOff(midi);
    if (window.KeyfallSound && KeyfallSound.noteOn(midi, vel)) { sampled.add(midi); return; }   // recorded grand piano
    const t = ac.currentTime, f = 440 * Math.pow(2, (midi - 69) / 12);
    const gain = ac.createGain(), lp = ac.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(Math.min(f * 8, 9000), t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(f * 2, 400), t + 1.2);
    const peak = 0.28 * vel;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(peak, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(peak * 0.35, t + 0.4);
    gain.gain.exponentialRampToValueAtTime(0.0008, t + 4);
    const oscs = [["triangle", 1, 1], ["sine", 2, 0.35], ["sine", 3, 0.12]].map(([type, mult, g]) => {
      const o = ac.createOscillator(), og = ac.createGain();
      o.type = type; o.frequency.value = f * mult; og.gain.value = g;
      o.connect(og).connect(lp); o.start(t); o.stop(t + 4.1);
      return o;
    });
    lp.connect(gain).connect(master);
    voices.set(midi, { gain, oscs });
  }
  function noteOff(midi) {
    if (sampled.delete(midi)) { KeyfallSound.noteOff(midi); return; }
    const v = voices.get(midi);
    if (!v) return;
    voices.delete(midi);
    const t = ac.currentTime;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setTargetAtTime(0, t, 0.06);
    v.oscs.forEach(o => { try { o.stop(t + 0.4); } catch (e) {} });
  }

  const reduceMotion = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  function sfx(name, arg) {
    if (!window.KeyfallSound || !ui.sfx.checked || !audio()) return;
    if (mic.on && (state === "running" || drill || train)) return;
    KeyfallSound.sfx(name, arg);
  }

  // ---------- Songs ----------
  function toMidi(name) {
    const m = /^([A-G])([#b]?)(\d)$/.exec(name);
    if (!m) throw new Error("Bad note " + name);
    let n = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]];
    if (m[2] === "#") n++; else if (m[2] === "b") n--;
    return n + 12 * (+m[3] + 1);
  }
  function parseTrack(str, hand, beat, out, bars) {
    let t = 0, lastTok = [];
    for (const tok of (str || "").split(/\s+/)) {
      if (tok === "|" && bars) bars.push(t);
      if (!tok || tok === "|") continue;
      const [names, d] = tok.split(":");
      const dur = (d ? parseFloat(d) : 1) * beat;
      if (names === "~") lastTok.forEach(n => n.dur += dur);       // tie: lengthen the previous notes
      else {
        lastTok = [];
        if (names !== "R") for (const n of names.split("+")) {
          const note = { midi: toMidi(n), start: t, dur, hand, state: "pending", played: false };
          lastTok.push(note); out.push(note);
        }
      }
      t += dur;
    }
    return t;
  }
  function loadSong(def, level = "hard") {
    let notes = [], beat = 60 / def.bpm, bars = [], end, cut = t => t;
    if (def.notes) {                     // imported song: [midi, start, duration, isLeft, loudness]
      for (const [midi, start, dur, left, amp] of def.notes)
        notes.push({ midi, start, dur, amp, hand: left ? "left" : "right", state: "pending", played: false });
      notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
      if (def.beat) {                    // an arrangement: it knows its beat and where the bars start
        beat = def.beat;
        end = Math.max(...notes.map(n => n.start + n.dur));
        for (let t = def.bar0 || 0; t < end; t += beat * 4) bars.push(t);
      } else {
        beat = guessBeat(notes);
        cut = closeGaps(notes, beat);
        end = Math.max(...notes.map(n => n.start + n.dur));
        for (let t = 0; t < end; t += beat * 4) bars.push(t);
      }
    } else {
      const lb = [];
      end = Math.max(parseTrack(def.right, "right", beat, notes, bars), parseTrack(def.left, "left", beat, notes, lb));
      if (!bars.length) bars = lb;
    }
    notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
    if (def.notes && !def.beat) notes = tidyRecording(notes);
    notes = arrange(notes, level, beat);
    notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
    // if both hands strike the same key at the same moment, keep one note
    const uniq = notes.filter((n, i) => !(i && notes[i - 1].midi === n.midi && Math.abs(notes[i - 1].start - n.start) < 1e-6));
    const barList = bars.filter(b => b > 0.01 && b < end - 0.01);
    const pedal = ui.pedal.value === "off" ? [] : pedalOf(def, barList, end, beat, cut);
    // a recording without pedal marks: let its notes ring on to the next one instead
    if (def.notes && !def.beat && !(def.pedal && def.pedal.length)) letRing(uniq, beat);
    const handy = playable(uniq);
    return { def, notes: handy, end, beat, bars: barList, pedal };
  }
  // When the sustain pedal is down: [[down, up], ...] in song time. From the file (MIDI pedal, or the pedal
  // Transkun hears in a recording), or for built-in pieces that are played with pedal: re-pedalled every bar
  // (or every beat), lifted at each bar line and pressed again just after the new bass note.
  function pedalOf(def, bars, end, beat, cut) {
    if (Array.isArray(def.pedal)) return def.pedal.map(([a, b]) => [cut(a), cut(b)]).filter(([a, b]) => b > a + 0.05);
    if (!def.pedal) return [];
    const edges = def.pedal === "beat" ? Array.from({ length: Math.ceil(end / beat) }, (_, i) => i * beat) : [0, ...bars];
    const out = [];
    edges.forEach((t, i) => {
      if (def.pedalSkip && def.pedalSkip.includes(i)) return;
      const next = i + 1 < edges.length ? edges[i + 1] : end + 1.5;
      out.push([t + 0.04, next]);
    });
    return out;
  }
  // A recording can go quiet for a while (a long pause, a silent stretch, notes the finder couldn't hear):
  // shorten any silence longer than 4 beats (at least 2.5 s) to 2 beats, so the song doesn't stop dead.
  function closeGaps(notes, beat) {
    const long = Math.max(2.5, beat * 4), cuts = [];
    let shift = 0, prev = null;
    for (const n of notes) {
      const s = n.start;
      if (prev !== null && s - prev > long) { cuts.push([prev + beat * 2, s]); shift += s - prev - beat * 2; }
      prev = s; n.start = s - shift; n.dur = Math.min(n.dur, long);
    }
    // the same shortening for anything else on the song's clock (the pedal): a moment inside a removed stretch
    // moves to where the stretch was cut
    return t => { let d = 0; for (const [a, b] of cuts) { if (t >= b) d += b - a; else if (t > a) d += t - a; } return t - d; };
  }
  // The note finder hears where a key's sound fades, which with the pedal down is long before the next note:
  // played back as heard it sounds choppy, with little silences. Let each note ring on to the next note
  // in the same hand (up to 2 beats), as a pianist's fingers or pedal would.
  function letRing(notes, beat) {
    for (const hand of ["left", "right"]) {
      const hs = notes.filter(n => n.hand === hand);
      let j = 0;
      for (const n of hs) {
        while (j < hs.length && hs[j].start <= n.start + 0.03) j++;
        if (j < hs.length) n.dur = Math.max(n.dur, Math.min(hs[j].start - n.start, beat * 2));
      }
    }
  }
  // ---------- A note finder's raw notes, made readable ----------
  // On a busy recording (an orchestra, a band) a piano note finder hears every instrument as piano: dozens of keys at
  // once, faint echoes, the same key struck twice in a blink. Keep what a pianist would play: per hand at most four
  // keys at a time within an octave (the melody on top of the right hand, the bass at the bottom of the left, then
  // the loudest), drop faint ghost notes and merge quick repeats.
  function tidyRecording(notes) {
    if (notes.length < 2) return notes;
    const amps = notes.map(n => n.amp ?? 1).sort((a, b) => a - b), loud = amps[Math.floor(amps.length * 0.9)] || 1;
    const out = [], lastOf = new Map();
    for (let i = 0; i < notes.length;) {
      let j = i; while (j < notes.length && notes[j].start - notes[i].start < 0.05) j++;
      const g = notes.slice(i, j); i = j;
      const top = Math.max(...g.map(n => n.amp ?? 1));
      const keepable = g.filter(n => g.length === 1 || ((n.amp ?? 1) >= top * 0.22 && (n.amp ?? 1) >= loud * 0.08));
      for (const hand of ["right", "left"]) {
        const hs = keepable.filter(n => n.hand === hand).sort((a, b) => a.midi - b.midi);
        if (!hs.length) continue;
        const anchor = hand === "right" ? hs[hs.length - 1] : hs[0];
        const rest = hs.filter(n => n !== anchor && Math.abs(n.midi - anchor.midi) <= 12 && n.midi !== anchor.midi)
          .sort((a, b) => (b.amp ?? 1) - (a.amp ?? 1)).slice(0, 3);
        for (const n of [anchor, ...rest]) {
          const prev = lastOf.get(n.midi);
          if (prev && n.start - prev.start < 0.09) { prev.dur = Math.max(prev.dur, n.start + n.dur - prev.start); continue; }   // a stutter
          lastOf.set(n.midi, n); out.push(n);
        }
      }
    }
    return out.sort((a, b) => a.start - b.start || a.midi - b.midi);
  }
  // ---------- Playable by real hands ----------
  // Every chord is split between the hands so neither stretches more than an octave or plays more than five keys.
  // The split stays as written when that already works; otherwise the notes are shared out again (the lowest
  // notes to the left hand, the highest to the right, close to where each hand just was). A note neither hand can
  // reach moves by an octave to a hand that can (same harmony), or is left out. A note still held when its hand has
  // to move further than it can reach is let go at that moment (the pedal, if down, keeps it sounding).
  const SPAN = 12, MAX_KEYS = 5;
  function playable(notes) {
    const span = g => g.length ? g[g.length - 1].midi - g[0].midi : 0;
    const centre = g => g.length ? (g[0].midi + g[g.length - 1].midi) / 2 : null;
    const out = [], held = { left: [], right: [] }, last = { left: null, right: null }, lastT = { left: -9, right: -9 };
    for (let i = 0; i < notes.length;) {
      let j = i; while (j < notes.length && notes[j].start - notes[i].start < 0.04) j++;
      const t = notes[i].start;
      let ch = notes.slice(i, j).sort((a, b) => a.midi - b.midi).filter((n, k, a) => !k || a[k - 1].midi !== n.midi);
      i = j;
      // the best split: lowest k notes to the left hand, the rest to the right
      const trySplit = ch => {
        let best = null;
        for (let k = 0; k <= ch.length; k++) {
          const L = ch.slice(0, k), R = ch.slice(k);
          if (span(L) > SPAN || span(R) > SPAN || L.length > MAX_KEYS || R.length > MAX_KEYS) continue;
          let cost = 0;
          L.forEach(n => { if (n.hand !== "left") cost += 2; }); R.forEach(n => { if (n.hand !== "right") cost += 2; });
          for (const [hand, g] of [["left", L], ["right", R]]) {
            if (!g.length || last[hand] === null) continue;
            const move = Math.abs(centre(g) - last[hand]);
            cost += move / 24;
            if (t - lastT[hand] < 0.16 && move > 14) cost += 3;   // a leap too far for the time: better for the other hand
          }
          if (!best || cost < best.cost) best = { cost, L, R };
        }
        return best;
      };
      let pick = trySplit(ch);
      if (!pick) {                                         // too wide or too many: keep the melody and the bass, fit the rest in
        const top = ch[ch.length - 1], bot = ch[0];
        const R = [top], L = [bot], have = new Set([top.midi, bot.midi]);
        const middle = ch.slice(1, -1).reverse();            // highest first: the notes nearest the melody matter most
        for (const n of middle) {
          const tries = [0, -12, 12, -24, 24, -36, 36].map(d => n.midi + d);   // as written first, then octaves nearby
          const spot = [[R, top.midi - SPAN, top.midi], [L, bot.midi, bot.midi + SPAN]];
          let done = false;
          for (const m of tries) {
            for (const [g, lo, hi] of spot) {
              if (done || g.length >= MAX_KEYS || m < lo || m > hi || have.has(m)) continue;
              n.midi = m; g.push(n); have.add(m); done = true;
            }
            if (done) break;
          }
        }
        L.sort((a, b) => a.midi - b.midi); R.sort((a, b) => a.midi - b.midi);
        pick = { L, R };
      }
      for (const [hand, g] of [["left", pick.L], ["right", pick.R]]) {
        if (!g.length) continue;
        g.forEach(n => { n.hand = hand; out.push(n); });
        // notes this hand is still holding that would make the stretch too wide: let go now
        const still = held[hand].filter(h => h.start + h.dur > t + 0.05 && !g.includes(h));
        for (const h of still) {
          const lo = Math.min(h.midi, g[0].midi), hi = Math.max(h.midi, g[g.length - 1].midi);
          if (hi - lo > SPAN || still.length + g.length > MAX_KEYS) h.dur = Math.max(0.05, t - h.start - 0.01);
        }
        held[hand] = [...still.filter(h => h.start + h.dur > t + 0.05), ...g];
        last[hand] = centre(g); lastT[hand] = t;
      }
    }
    return out.sort((a, b) => a.start - b.start || a.midi - b.midi);
  }
  // a recording has no written tempo: take the typical time between notes as the beat (between 0.35 and 0.9 s)
  function guessBeat(notes) {
    const on = [];
    for (const n of notes) if (!on.length || n.start - on[on.length - 1] > 0.08) on.push(n.start);
    const gaps = on.slice(1).map((t, i) => t - on[i]).sort((a, b) => a - b);
    let b = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0.5;
    while (b < 0.35) b *= 2;
    while (b > 0.9) b /= 2;
    return b;
  }
  // ---------- Difficulty: every song comes in four versions ----------
  //  easy: the melody alone · medium: melody + one bass note · hard: as written (or as transcribed)
  //  extra: fuller — melody in octaves, bass in octaves (or a bass line added to one-hand songs)
  function arrange(notes, level, beat) {
    if (level === "hard" || !notes.length) return notes;
    if (level === "insane") return insane(arrange(notes, "extra", beat), beat);
    const groups = [];
    for (const n of notes) { const g = groups[groups.length - 1]; if (g && n.start - g[0].start < 0.05) g.push(n); else groups.push([n]); }
    const top = l => l.reduce((a, b) => b.midi > a.midi ? b : a), low = l => l.reduce((a, b) => b.midi < a.midi ? b : a);
    const out = [];
    if (level === "extra") {
      const oneHand = !notes.some(n => n.hand === "left");
      const have = new Set(notes.map(n => n.midi + "@" + n.start));
      const add = (n, midi, hand, dur = n.dur) => {
        if (midi < 21 || have.has(midi + "@" + n.start)) return;
        have.add(midi + "@" + n.start); out.push({ ...n, midi, hand, dur, vel: 0.75, state: "pending", played: false });
      };
      let lastBass = -1e9;
      for (const g of groups) {
        out.push(...g);
        const r = g.filter(n => n.hand === "right"), l = g.filter(n => n.hand === "left");
        if (r.length && r.length < 3) { const t = top(r); add(t, t.midi >= 67 ? t.midi - 12 : t.midi + 12, "right"); }   // melody in octaves
        if (l.length && l.length < 3) { const b = low(l); if (b.midi - 12 >= 28) add(b, b.midi - 12, "left"); }
        else if (oneHand && r.length && g[0].start - lastBass >= beat * 2 - 0.02) {
          let m = top(r).midi - 24;
          while (m < 36) m += 12;
          while (m > 52) m -= 12;
          add(top(r), m, "left", beat * 1.9); lastBass = g[0].start;
        }
      }
      return out;
    }
    let last = -1e9;
    for (const g of groups) {
      const loud = Math.max(...g.map(n => n.amp ?? 1));
      const keep = g.length === 1 ? g : g.filter(n => (n.amp ?? 1) >= loud * 0.35 && n.dur >= 0.08);
      const r = keep.filter(n => n.hand === "right"), l = keep.filter(n => n.hand === "left");
      // easy: no ornaments either (a note within 0.12 s of the previous melody note)
      if (r.length && (level === "medium" || g[0].start - last >= 0.12)) { out.push({ ...top(r) }); last = g[0].start; }
      if (level === "medium" && l.length) out.push({ ...low(l) });
    }
    return out;
  }

  // Extra extra hard: the Extra hard version, and then, following the song's own chords (found from the notes
  // that sound over each bass note: the major or minor triad that fits them best, its root preferably the bass):
  //  · the right hand plays octave chords: under each melody note of a beat or longer that belongs to the chord, the chord
  //    note a third or sixth below fills the octave (passing notes stay plain)
  //  · the left hand never rests: between its notes it runs in half beats (whole beats in fast songs) in an
  //    Alberti pattern, bottom-top-middle-top of the chord, kept above the low muddy register
  //  · the added notes are played softer, so the melody still leads
  //  (and the timing to hit a note is much stricter: set when the song starts)
  const TRIADS = [];
  for (let r = 0; r < 12; r++) for (const [q, iv] of [["maj", [0, 4, 7]], ["min", [0, 3, 7]]]) TRIADS.push({ root: r, q, pcs: iv.map(i => (r + i) % 12) });
  function chordOf(notes, a, b, bassPc) {
    const w = new Array(12).fill(0);
    for (const n of notes) { const o = Math.min(b, n.start + n.dur) - Math.max(a, n.start); if (o > 0) w[n.midi % 12] += o * (n.midi < 60 ? 1.3 : 1); }
    w[bassPc] += (b - a) * 1.5;
    let best = null;
    for (const t of TRIADS) {
      let sc = 0;
      for (let pc = 0; pc < 12; pc++) sc += t.pcs.includes(pc) ? w[pc] : -0.8 * w[pc];
      if (t.root === bassPc) sc += (b - a) * 0.6;
      if (!best || sc > best.sc) best = { ...t, sc };
    }
    return best;
  }
  function insane(notes, beat) {
    const out = notes.slice(), have = new Set(notes.map(n => n.midi + "@" + n.start.toFixed(3)));
    const add = (ref, midi, hand, start, dur, vel) => {
      const k = midi + "@" + start.toFixed(3);
      if (midi < 21 || midi > 108 || have.has(k)) return;
      have.add(k); out.push({ ...ref, midi, hand, start, dur, vel, state: "pending", played: false });
    };
    const end = Math.max(...notes.map(n => n.start + n.dur));
    const groups = [];
    for (const n of notes) { const g = groups[groups.length - 1]; if (g && n.start - g[0].start < 0.05) g.push(n); else groups.push([n]); }
    // the chord over each left-hand note, until the next one
    const lg = groups.map(g => g.filter(n => n.hand === "left")).filter(g => g.length);
    const spans = lg.map((g, i) => {
      const bass = g.reduce((a, b) => b.midi < a.midi ? b : a);
      const next = i + 1 < lg.length ? lg[i + 1][0].start : end;
      return { bass, a: bass.start, b: Math.max(next, bass.start + 0.05), chord: chordOf(notes, bass.start, Math.max(next, bass.start + 0.05), bass.midi % 12) };
    });
    const chordAt = t => { let c = null; for (const s of spans) { if (s.a > t + 0.03) break; c = s; } return c && t < c.b + beat * 2 ? c.chord : null; };
    // right hand: octave chords
    for (const g of groups) {
      const r = g.filter(n => n.hand === "right");
      if (!r.length || r.length >= 4) continue;
      const mel = r.reduce((a, b) => b.midi > a.midi ? b : a);
      if (mel.dur < beat * 0.9) continue;                        // quicker notes and runs stay in plain octaves
      const ch = chordAt(mel.start);
      if (!ch || !ch.pcs.includes(mel.midi % 12)) continue;       // a passing note: leave it plain
      let pick = null;
      for (const d of [3, 4, 8, 9, 5]) {                          // a third or sixth below sounds sweetest
        const m = mel.midi - d;
        if (ch.pcs.includes(m % 12) && !r.some(n => n.midi === m)) { pick = m; break; }
      }
      if (pick !== null) add(mel, pick, "right", mel.start, mel.dur, 0.55);
    }
    // left hand: an Alberti pattern over each bass note
    const step = beat >= 0.42 ? beat / 2 : beat;
    for (const { bass, a, b, chord } of spans) {
      let low = bass.midi;
      while (low < 45) low += 12;                                  // (low notes this quick turn to mud)
      while (low > 57) low -= 12;
      const above = pc => { let m = low + 1; while (m % 12 !== pc) m++; return m; };
      const ups = chord.pcs.filter(pc => pc !== low % 12).map(above).sort((x, y) => x - y);
      if (ups.length < 2) continue;
      const pattern = [low, ups[ups.length - 1], ups[0], ups[ups.length - 1]];   // bottom, top, middle, top
      const stop = Math.min(b, a + beat * 4, end) - 0.06;
      for (let k = 1, t = a + step; t < stop; k++, t += step) add(bass, pattern[k % 4], "left", t, step * 0.95, 0.5);
    }
    return out;
  }

  // ---------- MIDI file import ----------
  function parseMidi(buf) {
    const d = new DataView(buf);
    let p = 0;
    const str = n => { let s = ""; for (let i = 0; i < n; i++) s += String.fromCharCode(d.getUint8(p++)); return s; };
    const vlq = () => { let v = 0, b; do { b = d.getUint8(p++); v = (v << 7) | (b & 127); } while (b & 128); return v; };
    if (str(4) !== "MThd") throw new Error("That is not a MIDI file.");
    const hl = d.getUint32(p); p += 4;
    const ntr = d.getUint16(p + 2), div = d.getUint16(p + 4); p += hl;
    if (div & 0x8000) throw new Error("This MIDI file uses a timing format that isn't supported.");
    const tempos = [], tracks = [], pedals = [];
    for (let t = 0; t < ntr && p < d.byteLength; t++) {
      const id = str(4), len = d.getUint32(p); p += 4;
      const end = p + len;
      if (id !== "MTrk") { p = end; continue; }
      let tick = 0, status = 0;
      const open = {}, notes = [];
      let pedAt = null, name = "", program = -1;
      while (p < end) {
        tick += vlq();
        if (d.getUint8(p) & 0x80) status = d.getUint8(p++);
        if (status === 0xff) {
          const type = d.getUint8(p++), l = vlq();
          if (type === 0x51) tempos.push([tick, (d.getUint8(p) << 16) | (d.getUint8(p + 1) << 8) | d.getUint8(p + 2)]);
          if (type === 0x03 && !name) for (let i = 0; i < l; i++) name += String.fromCharCode(d.getUint8(p + i));
          p += l;
        } else if (status === 0xf0 || status === 0xf7) { const l = vlq(); p += l; }
        else {
          const cmd = status & 0xf0, ch = status & 15, a = d.getUint8(p++);
          const b = cmd === 0xc0 || cmd === 0xd0 ? 0 : d.getUint8(p++);
          if (ch === 9) continue;                                   // drums
          if (cmd === 0xc0 && program < 0) program = a;
          if (cmd === 0xb0 && a === 64) {                           // sustain pedal
            if (b >= 64 && pedAt === null) pedAt = tick;
            else if (b < 64 && pedAt !== null) { pedals.push([pedAt, tick]); pedAt = null; }
            continue;
          }
          if (cmd === 0x90 && b > 0) (open[a] = open[a] || []).push(tick);
          else if (cmd === 0x80 || cmd === 0x90) {
            const s = open[a] && open[a].shift();
            if (s !== undefined && a >= 21 && a <= 108) notes.push({ midi: a, t0: s, t1: tick });
          }
        }
      }
      p = end;
      if (notes.length) { notes.name = name; notes.program = program; tracks.push(notes); }
    }
    if (!tracks.length) throw new Error("No notes found in that file.");
    tempos.sort((a, b) => a[0] - b[0]);
    const segs = [{ tick: 0, sec: 0, us: 500000 }];
    for (const [tick, us] of tempos) {
      const l = segs[segs.length - 1];
      segs.push({ tick, sec: l.sec + (tick - l.tick) * l.us / div / 1e6, us });
    }
    const sec = tick => { let g = segs[0]; for (const x of segs) { if (x.tick > tick) break; g = x; } return g.sec + (tick - g.tick) * g.us / div / 1e6; };
    const avg = tr => tr.reduce((a, n) => a + n.midi, 0) / tr.length;
    // a whole band (from MuScriptor or any multi-instrument MIDI): make a two-hand piano part of it
    const piano = tr => tr.program < 8 && !/voc|vox|voice|sing|lead|melod|bass|guit|gtr|synth|string/i.test(tr.name);
    if (tracks.filter(tr => !piano(tr)).length >= 2 && window.KeyfallArrange) {
      const bt = []; for (let k = 0; sec(k * div) < 3600; k++) { bt.push(sec(k * div)); if (tracks.every(tr => tr.every(n => n.t1 < k * div))) break; }
      const arr = KeyfallArrange.pianoReduce(tracks.map(tr => ({ name: tr.name, program: tr.program, notes: tr.map(n => ({ midi: n.midi, start: sec(n.t0), end: sec(n.t1) })) })), bt);
      if (arr) return arr;
    }
    // hands: the track with the highest average pitch is the right hand; one track is split at middle C
    const top = tracks.reduce((a, b) => avg(b) > avg(a) ? b : a);
    const out = [];
    for (const tr of tracks) for (const n of tr)
      out.push([n.midi, sec(n.t0), Math.max(sec(n.t1) - sec(n.t0), 0.05), tracks.length > 1 ? +(tr !== top) : +(n.midi < 60)]);
    const t0 = Math.min(...out.map(n => n[1]));
    out.forEach(n => { n[1] = Math.round((n[1] - t0) * 1000) / 1000; n[2] = Math.round(n[2] * 1000) / 1000; });
    const pedal = pedals.map(([a, b]) => [Math.max(0, sec(a) - t0), sec(b) - t0].map(x => Math.round(x * 1000) / 1000))
      .filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
    return { notes: out, pedal };
  }
  const saveImported = () => { try { localStorage.setItem("keyfall:imported", JSON.stringify(SONGS.filter(s => s.notes))); } catch (e) {} };
  try { SONGS.push(...(JSON.parse(localStorage.getItem("keyfall:imported")) || []).map(s => ({ ...s, title: s.title.replace(/_+/g, " ").replace(/\s+/g, " ").trim() }))); } catch (e) {}

  // ---------- Game state ----------
  let song = null, state = "idle";      // idle | running | paused | done
  let time = 0, score = 0, streak = 0, bestStreak = 0, hits = 0, perfects = 0, misses = 0, wrong = 0;
  const down = new Set(), autoDown = new Map(), pedalRing = new Set(), flashes = [];
  let rec = null;                        // ⏺ recording your own song: { t0, notes, open, pedal, pedalAt }

  const mode = () => ui.mode.value;
  let wantHand = "both";
  const isUser = n => mode() !== "listen" && (ui.hand.value === "both" || n.hand === ui.hand.value);

  function reset() {
    song = loadSong(SONGS[ui.song.value], ui.level.value);
    HIT_WINDOW = ui.level.value === "insane" ? 0.13 : 0.22; PERFECT = ui.level.value === "insane" ? 0.05 : 0.08;
    sheet = null;
    const hasL = song.notes.some(n => n.hand === "left"), hasR = song.notes.some(n => n.hand === "right");
    for (const o of ui.hand.options) o.disabled = (o.value !== "right" && !hasL) || (o.value !== "left" && !hasR);
    const want = ui.hand.querySelector(`[value="${wantHand}"]`);
    ui.hand.value = !want.disabled ? wantHand : hasL && hasR ? "both" : hasL ? "left" : "right";
    // fit the on-screen keyboard to the song (never smaller than C3..C6)
    const lo = Math.min(...song.notes.map(n => n.midi)), hi = Math.max(...song.notes.map(n => n.midi));
    LOW = Math.min(48, Math.floor(lo / 12) * 12); HIGH = Math.max(84, Math.ceil(hi / 12) * 12);
    layout();
    time = -2; score = streak = bestStreak = hits = perfects = misses = wrong = 0;
    autoDown.forEach((_, m) => noteOff(m)); autoDown.clear(); pedalRing.forEach(m => noteOff(m)); pedalRing.clear();
    state = "idle"; ui.start.textContent = "Start"; ui.results.hidden = true;
    ui.restart.hidden = true; ui.pause.hidden = true;
    const def = SONGS[ui.song.value];
    $("readyTitle").textContent = def.title;
    $("readySub").textContent = [def.by, def.model ? "made with " + def.model : "", def.level, def.left || (def.notes && def.notes.some(n => n[3])) ? "two hands" : "one hand", def.pedal && def.pedal.length ? "pedal" : ""].filter(Boolean).join(" · ");
    ui.ready.hidden = !$("home").hidden || !!drill || !!train || !!rec;
    updateHud();
  }
  function start() {
    audio();
    if (state === "done" || !song) reset();
    state = "running"; ui.hint.hidden = true; ui.ready.hidden = true; ui.pause.hidden = false;
  }
  function pause() {
    state = "paused"; ui.start.textContent = "Resume"; ui.restart.hidden = false; ui.pause.hidden = true;
    ui.ready.hidden = !!drill || !!train || !!rec || !$("home").hidden;
    autoDown.forEach((_, m) => noteOff(m)); autoDown.clear(); pedalRing.forEach(m => noteOff(m)); pedalRing.clear();
  }
  function toggle() { state === "running" ? pause() : start(); }

  function updateHud() {
    ui.score.textContent = score;
    ui.streak.textContent = streak;
    ui.streakBox.classList.toggle("hot", streak >= 5);
    const total = hits + misses + wrong;
    ui.acc.textContent = total ? Math.round(100 * hits / total) + "%" : "–";
  }
  let streakAt = 0;
  const particles = [], beams = [], wrongs = [];
  // 3D hit effects (three.js), loaded only when switched on; the flat sparks are used otherwise
  let fx = null, fxLoading = null;
  function setFx(on) {
    if (!on || reduceMotion) { if (fx) { fx.dispose(); fx = null; } return; }
    if (fx || fxLoading) return;
    fxLoading = import("./fx3d.js?v=6").then(m => {
      fxLoading = null;
      if (!ui.fx3d.checked) return;
      fx = m.createFx(canvas); fx.resize(W, H, pixelRatio());
    }).catch(e => { fxLoading = null; console.warn("3D effects unavailable:", e); ui.fx3d.checked = false; ui.fx3d.disabled = true; $("fx3dNote").textContent = "(not available on this device)"; });
  }
  function burst(midi, color, big) {
    if (midi < LOW || midi > HIGH || !keys.length) return;
    const k = keyOf(midi), x = k.x + k.w / 2, now = performance.now();
    beams.push({ x, w: k.w, color, t: now });
    if (reduceMotion) return;
    if (fx) { try { fx.burst(x, kbTop, color, big, k.w); return; } catch (e) { console.warn("3D effects off:", e); try { fx.dispose(); } catch (e2) {} fx = null; setTimeout(() => setFx(ui.fx3d.checked), 3000); } }
    const n = big ? 34 : 18;
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.9, v = 120 + Math.random() * (big ? 320 : 220);
      particles.push({ x: x + (Math.random() - 0.5) * k.w * 0.6, y: kbTop - 2, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        life: 450 + Math.random() * 450, t: now, r: 1.5 + Math.random() * (big ? 3 : 2.2), c: Math.random() < 0.35 ? "#ffffff" : color });
    }
    if (particles.length > 400) particles.splice(0, particles.length - 400);
  }
  function bump(el) { el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); }
  function registerHit(n, perfect) {
    n.state = "hit"; hits++; streak++; bestStreak = Math.max(bestStreak, streak);
    burst(n.midi, perfect ? (red ? "#ff7088" : "#8dffb0") : COLORS[n.hand] || "#39b6ff", streak >= 5 && streak % 5 === 0);
    bump(ui.scoreBox); if (streak > 1) bump(ui.streakBox);
    if (streak >= 5 && streak % 5 === 0) sfx("streak"); else if (perfect) sfx("perfect");
    if (streak >= 5 && streak % 5 === 0) streakAt = performance.now();
    if (perfect) perfects++;
    score += (perfect ? 100 : 50) + Math.min(streak, 50);
    flashes.push({ midi: n.midi, t: performance.now(), text: perfect ? "Perfect" : "Good" });
    updateHud();
  }
  function registerWrong(midi) {
    wrong++; streak = 0; updateHud(); sfx("wrong");
    if (midi != null) wrongs.push({ midi, t: performance.now() });
  }

  function nextGroup() {                 // earliest pending user notes (a chord shares a start)
    const first = song.notes.find(n => n.state === "pending" && isUser(n));
    return first ? song.notes.filter(n => n.state === "pending" && isUser(n) && n.start - first.start < 1e-6) : [];
  }

  function press(midi, vel, silent = false) {
    if (down.has(midi) || train) return;
    down.add(midi); if (!silent) noteOn(midi, vel);
    if (rec) { recOn(midi, vel); return; }
    if (drill) { drillAnswer(midi); return; }
    if (state !== "running" || mode() === "listen") return;
    if (mode() === "practice") {
      const g = nextGroup();
      if (!g.length || g[0].start - time > 0.35) return;
      const n = g.find(n => n.midi === midi);
      n ? registerHit(n, true) : registerWrong(midi);
    } else {
      let best = null;
      for (const n of song.notes)
        if (n.state === "pending" && n.midi === midi && isUser(n) && Math.abs(n.start - time) <= HIT_WINDOW &&
            (!best || Math.abs(n.start - time) < Math.abs(best.start - time))) best = n;
      best ? registerHit(best, Math.abs(best.start - time) <= PERFECT) : registerWrong(midi);
    }
  }
  function release(midi) {
    if (rec) recOff(midi);
    if (!down.delete(midi)) return;
    if (!autoDown.has(midi)) noteOff(midi);
  }

  function pedalDown(t) {
    if (!song || !song.pedal) return false;
    for (const [a, b] of song.pedal) { if (a > t) return false; if (t < b) return true; }
    return false;
  }
  let lastCount = null;
  function step(dt) {
    if (state !== "running") return;
    const before = time;
    time += dt * ui.speed.value / 100;
    if (before < 0) {
      const c = Math.ceil(-time);
      if (time >= 0) { sfx("go"); lastCount = null; } else if (c !== lastCount) { lastCount = c; sfx("tick"); }
    }
    if (mode() === "practice") {
      const g = nextGroup();
      if (g.length && time > g[0].start) time = g[0].start;   // wait for the player
    }
    for (const n of song.notes) {
      if (n.start > time) break;
      if (!isUser(n)) {
        if (!n.played) {
          n.played = true; n.state = "hit";
          if (!mic.on) noteOn(n.midi, 0.6 * (n.vel ?? 1));                // silent while listening: the microphone would hear it
          autoDown.set(n.midi, n.start + n.dur * 0.92); pedalRing.delete(n.midi);
        }
      } else if (mode() === "play" && n.state === "pending" && time > n.start + lateBy()) {
        n.state = "miss"; misses++; streak = 0; updateHud();
      }
    }
    // a note's key comes up when the note ends; with the pedal down only its sound rings on, until the pedal lifts
    const held = pedalDown(time);
    autoDown.forEach((end, m) => { if (time >= end) { autoDown.delete(m); if (held) pedalRing.add(m); else if (!down.has(m)) noteOff(m); } });
    if (!held && pedalRing.size) { pedalRing.forEach(m => { if (!down.has(m) && !autoDown.has(m)) noteOff(m); }); pedalRing.clear(); }
    if (time > song.end + 0.8) finish();
  }

  function finish() {
    state = "done"; ui.start.textContent = "Start"; ui.pause.hidden = true;
    if (mode() === "listen") { reset(); return; }
    const total = hits + misses + wrong, acc = total ? Math.round(100 * hits / total) : 0;
    const stars = acc >= 95 ? 3 : acc >= 80 ? 2 : acc >= 50 ? 1 : 0;
    const key = `keyfall:${song.def.title}:${mode()}:${ui.hand.value}`;
    let best = 0;
    try { best = +localStorage.getItem(key) || 0; if (score > best) localStorage.setItem(key, score); } catch (e) {}
    try { const k = "keyfall:stars:" + song.def.title; if (stars > (+localStorage.getItem(k) || 0)) localStorage.setItem(k, stars); } catch (e) {}
    $("resTitle").textContent = song.def.title;
    $("stars").innerHTML = [0, 1, 2].map(i => `<span class="${i < stars ? "on" : "off"}" style="animation-delay:${0.35 + i * 0.28}s">★</span>`).join("");
    sfx("complete");
    for (let i = 0; i < stars; i++) setTimeout(() => sfx("star", i), 350 + i * 280);
    if (!reduceMotion) for (let i = 0; i < 5; i++) setTimeout(() => burst(LOW + Math.floor(Math.random() * (HIGH - LOW)), ["#ffcc4d", "#8dffb0", "#39b6ff"][i % 3], true), i * 160);
    $("resBody").textContent = mode() === "play"
      ? `Score ${score} · Accuracy ${acc}% · ${perfects} perfect · ${misses} missed · ${wrong} wrong · best streak ${bestStreak}`
      : `Accuracy ${acc}% · ${wrong} wrong notes · best streak ${bestStreak}`;
    $("resBest").textContent = score > best ? "New best score!" : `Best: ${best}`;
    ui.results.hidden = false;
  }

  // ---------- Note practice: read a note on the staff, then play it ----------
  let drill = null;
  const SEMI = [0, 2, 4, 5, 7, 9, 11];
  function nextDrill() {
    const d = drill;
    d.clef = ui.dClef.value === "both" ? (Math.random() < 0.5 ? "treble" : "bass") : ui.dClef.value;
    const base = d.clef === "treble" ? 30 : 18;          // staff step of the bottom line (E4 / G2)
    const lo = ui.dLedger.checked ? base - 4 : base, hi = ui.dLedger.checked ? base + 12 : base + 8;
    let step;
    do step = lo + Math.floor(Math.random() * (hi - lo + 1)); while (step === d.step && d.clef === d.lastClef);
    if (window.__keyfallAsk && window.__keyfallAsk.length) {   // automated tests choose the question (natural notes)
      const m = window.__keyfallAsk.shift();
      step = (Math.floor(m / 12) - 1) * 7 + SEMI.indexOf(m % 12);
    }
    const letter = step % 7, oct = Math.floor(step / 7);
    let acc = 0;
    if (ui.dAcc.checked && Math.random() < 0.35) {
      acc = Math.random() < 0.5 ? 1 : -1;
      if ((acc > 0 && (letter === 2 || letter === 6)) || (acc < 0 && (letter === 0 || letter === 3))) acc = 0;
    }
    Object.assign(d, { step, acc, lastClef: d.clef, tries: 0, done: false, wrongKey: null,
      name: "CDEFGAB"[letter] + (acc > 0 ? "♯" : acc < 0 ? "♭" : "") + oct,
      target: { midi: 12 * (oct + 1) + SEMI[letter] + acc, start: 0, state: "pending" } });
    mic.usedAt[d.target.midi] = performance.now();      // a note heard before the question appeared doesn't answer it
  }
  function startDrill() {
    reset();
    drill = {};
    LOW = 36; HIGH = 84; layout();
    nextDrill();
    $("home").hidden = true; $("bar").classList.add("drill"); $("title").textContent = "Note practice"; ui.ready.hidden = true; ui.pause.hidden = true;
    ui.hint.textContent = "Find the note shown on the staff and play it."; ui.hint.hidden = false;
  }
  function drillAnswer(midi) {
    const d = drill;
    if (d.done) return;
    ui.hint.hidden = true;
    if (midi === d.target.midi) {
      hits++; streak++; bestStreak = Math.max(bestStreak, streak); score += 10;
      burst(midi, "#8dffb0", streak >= 5 && streak % 5 === 0); bump(ui.scoreBox); sfx(streak % 5 === 0 ? "streak" : "perfect");
      d.done = true; d.doneAt = performance.now();
      setTimeout(() => { if (drill === d) nextDrill(); }, 550);
    } else { wrong++; streak = 0; d.tries++; d.wrongKey = midi; d.wrongAt = performance.now(); sfx("wrong"); }
    updateHud();
  }
  function drawStaff() {
    const d = drill, now = performance.now();
    const sp = Math.max(10, Math.min(kbTop / 13, 24)), cx = W / 2, sw = Math.min(W * 0.7, 440), x0 = cx - sw / 2;
    const bottom = kbTop / 2 + 2 * sp, base = d.clef === "treble" ? 30 : 18;
    const yOf = st => bottom - (st - base) * sp / 2;
    ctx.strokeStyle = "#cfd3e6"; ctx.lineWidth = 1.5; ctx.fillStyle = "#cfd3e6";
    for (let i = 0; i < 5; i++) { ctx.beginPath(); ctx.moveTo(x0, bottom - i * sp); ctx.lineTo(x0 + sw, bottom - i * sp); ctx.stroke(); }
    ctx.fillRect(x0, bottom - 4 * sp, 2, 4 * sp); ctx.fillRect(x0 + sw - 2, bottom - 4 * sp, 2, 4 * sp);
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    ctx.font = `${sp * (d.clef === "treble" ? 5.6 : 3.9)}px "Noto Music", "Bravura", "Apple Symbols", "Segoe UI Symbol", "Noto Sans Symbols2", serif`;
    ctx.fillText(d.clef === "treble" ? "\u{1D11E}" : "\u{1D122}", x0 + sp * 2.2, d.clef === "treble" ? bottom + sp * 0.9 : bottom - sp * 0.75);
    ctx.font = "600 12px system-ui, sans-serif"; ctx.fillStyle = "#a3a8bd";
    ctx.fillText(d.clef === "treble" ? "TREBLE CLEF" : "BASS CLEF", cx, bottom - 4 * sp - sp * 3.6);
    // the note
    const nx = cx + sp, y = yOf(d.step);
    const bad = d.wrongKey !== null && now - d.wrongAt < 450;
    const col = d.done ? "#5fd38a" : bad ? "#ff6b7d" : "#ffffff";
    ctx.strokeStyle = "#cfd3e6";
    for (let st = base - 2; st >= d.step; st -= 2) { ctx.beginPath(); ctx.moveTo(nx - sp * 1.15, yOf(st)); ctx.lineTo(nx + sp * 1.15, yOf(st)); ctx.stroke(); }
    for (let st = base + 10; st <= d.step; st += 2) { ctx.beginPath(); ctx.moveTo(nx - sp * 1.15, yOf(st)); ctx.lineTo(nx + sp * 1.15, yOf(st)); ctx.stroke(); }
    ctx.fillStyle = ctx.strokeStyle = col;
    ctx.save(); ctx.translate(nx, y); ctx.rotate(-0.35); ctx.beginPath(); ctx.ellipse(0, 0, sp * 0.64, sp * 0.45, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    ctx.lineWidth = 2; ctx.beginPath();
    if (d.step - base < 4) { ctx.moveTo(nx + sp * 0.58, y - 2); ctx.lineTo(nx + sp * 0.58, y - sp * 3.4); }
    else { ctx.moveTo(nx - sp * 0.58, y + 2); ctx.lineTo(nx - sp * 0.58, y + sp * 3.4); }
    ctx.stroke();
    if (d.acc) { ctx.font = `${sp * 2}px system-ui, sans-serif`; ctx.textBaseline = "middle"; ctx.fillText(d.acc > 0 ? "♯" : "♭", nx - sp * 1.7, y + (d.acc > 0 ? 0 : -sp * 0.3)); ctx.textBaseline = "alphabetic"; }
    // feedback line under the staff
    ctx.font = "600 18px system-ui, sans-serif";
    const fy = Math.min(kbTop - 18, bottom + sp * 5.2);
    if (d.done) { ctx.fillStyle = "#5fd38a"; ctx.fillText("Correct — " + d.name, cx, fy); }
    else if (d.tries >= 2) { ctx.fillStyle = "#ffc14d"; ctx.fillText("This is " + d.name + " — the key is highlighted", cx, fy); }
    else if (d.tries === 1) { ctx.fillStyle = "#ff6b7d"; ctx.fillText("Not quite, try again", cx, fy); }
  }

  // ---------- Microphone listening ----------
  // How the app hears a real piano:
  //  * The spectrum is split into one band per piano key (semitone bands up to about 10 kHz).
  //  * A key counts as struck when the bands where its sound lives jump up together, stand clearly
  //    above the room's noise, and the jump isn't just a broadband thump.
  //  * Untrained, a key's sound is assumed to sit in three of its overtones. After "Train on my piano"
  //    each key listens on the bands where that key was actually heard through this microphone, in
  //    this room, against the room noise measured during training.
  //  * Every key is watched all the time, so a note played slightly early still counts, and once one
  //    note of a chord is heard the rest of the chord needs less evidence.
  //  * Pitch tracking (YIN) only drives the "Hearing:" readout.
  const BLO = 21, BHI = 124;                                         // bands A0 .. E9
  const HARM = [0, 12, 19, 24, 28, 31, 34, 36, 38, 40];               // band offsets of overtones 1..10
  const SENS = {
    low:    { gFloor: 20, gRise: 4,   tMargin: 9, tRise: 4,   tSoft: 30 },
    normal: { gFloor: 16, gRise: 3.5, tMargin: 6, tRise: 3,   tSoft: 40 },
    high:   { gFloor: 12, gRise: 3,   tMargin: 4, tRise: 2.5, tSoft: 50 },
  };
  const LATE = 0.35;                                                  // hearing lags the key press a little
  const mic = {
    on: false, analyser: null, stream: null, buf: null, spec: null, note: null, cand: null, count: 0, level: 0, yinAt: 0, bands: [],
    L: new Float32Array(128).fill(-200), F: new Float32Array(128), live: new Float32Array(128).fill(-200), spread: new Float32Array(128).fill(9),
    over: new Uint16Array(128), startAt: 0, FF: new Float32Array(128), J: new Uint8Array(128), lastStruck: new Float64Array(128),
    byRecent: new Uint8Array(130), acceptedAt: new Float64Array(128), sub: new Uint8Array(128), fund: new Uint8Array(128),
    sal: new Float32Array(130).fill(-200), hist: [],
    armed: new Uint8Array(128).fill(1), peak: new Float32Array(128), hitAt: new Float64Array(128),
    onsetAt: new Float64Array(128), softAt: new Float64Array(128), usedAt: new Float64Array(128),
    lowEv: new Uint8Array(128), upTone: new Uint8Array(128), own: new Uint8Array(128), seen: new Uint8Array(128), groupHitAt: 0, groupStart: null,
    ref: new Int16Array(128), pMin: new Float32Array(128), pMax: new Float32Array(128), pN: new Uint8Array(128), pk: new Float32Array(128), drop: new Float32Array(128),
    ref2: new Int16Array(128), ref3: new Int16Array(128), pk2: new Float32Array(128), drop2: new Float32Array(128),
  };
  const nm = m => NAMES[m % 12] + (Math.floor(m / 12) - 1);

  // training data: per key, the level and jump heard at each overtone band, plus the room's noise per band
  let calib = null, tmpl = [];
  function buildTemplates() {
    tmpl = [];
    if (!calib) return;
    for (const k in calib.keys) {
      const m = +k, t = calib.keys[k], sig = [];
      HARM.forEach((o, n) => {
        const b = m + o;
        if (b > BHI || t.lv[n] == null) return;
        const w = t.lv[n] - calib.noise[b];
        if (t.rs[n] >= 6 && w >= 10) sig.push({ b, lv: t.lv[n], w });
      });
      sig.sort((x, y) => y.w - x.w);
      if (sig.length) tmpl[m] = sig.slice(0, 8);
    }
  }
  try { calib = JSON.parse(localStorage.getItem("keyfall:calib")); } catch (e) {}
  if (!calib || calib.v !== 1 || !calib.keys || !calib.noise) calib = null;
  buildTemplates();
  const saveCalib = () => { try { localStorage.setItem("keyfall:calib", JSON.stringify(calib)); } catch (e) {} };
  const sens = () => SENS[ui.sens.value] || SENS.normal;
  const talkOn = () => ui.ignoreTalk.checked && !mic.line;   // a cable from the piano carries no talking
  const noiseAt = b => {                               // a level the room's noise rarely exceeds in this band
    const live = mic.live[b] + 2 * Math.sqrt(mic.spread[b]);
    return calib ? Math.max(calib.noise[b], live) : live;
  };
  const lvl = b => b >= BLO && b <= BHI ? mic.L[b] : -200;
  // a band holds a real tone (not the splash of a key's attack): it stands out from the bands around it.
  // Low bands are narrower than the analysis can resolve, so compare them with bands further away.
  const peaky = (b, d) => {
    if (b < 33) return true;
    const g = b >= 60 ? 1 : b >= 45 ? 2 : 3;
    return lvl(b) >= lvl(b - g) + d && lvl(b) >= lvl(b + g) + d;
  };

  async function toggleMic() {
    if (mic.on) {
      mic.stream.getTracks().forEach(t => t.stop());
      if (window.KeyfallML) KeyfallML.stop();
      try { mic.src && mic.src.disconnect(); } catch (e) {}
      mic.on = false; mic.note = null; ui.micText.textContent = "🎤 Listen: off"; ui.mic.classList.remove("primary");
      audioMode("playback"); setTimeout(() => wakeAudio(false), 300);
      return;
    }
    if (!audio() || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { ui.micText.textContent = "🎤 Mic unsupported"; return; }
    // ask for the raw microphone: voice processing (echo cancellation, noise suppression, auto gain) treats
    // a held piano note as noise and turns soft playing down
    const raw = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    const open = async id => {                         // id "": the default input
      const dev = id ? { deviceId: { exact: id } } : {};
      try { return await navigator.mediaDevices.getUserMedia({ audio: { ...Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, { exact: v }])), ...dev } }); }
      catch (e) { if (e && e.name === "NotAllowedError") throw e; return await navigator.mediaDevices.getUserMedia({ audio: { ...raw, ...dev } }); }
    };
    // the input picked in settings (a digital piano's USB cable, an audio interface), found again by its name
    const want = micWanted();
    // Safari on iPad sometimes lists a USB input but still records the built-in microphone; asking for a
    // play-and-record audio session first helps it switch (WebKit bug 211192)
    audioMode("play-and-record");
    let stream = null, id = want ? await findMic(want) : "";
    try {
      if (id === null) { stream = await open(""); id = await findMic(want) || ""; }   // names stay hidden until the microphone is allowed
      if (id) {
        if (stream) stream.getTracks().forEach(t => t.stop());
        try { stream = await open(id); } catch (e) { if (e && e.name === "NotAllowedError") throw e; stream = null; id = ""; }
      }
      if (!stream) stream = await open("");
    } catch (e) { ui.micText.textContent = "🎤 Mic blocked"; audioMode("playback"); return; }
    setTimeout(() => wakeAudio(false), 300);
    mic.stream = stream;
    mic.line = !!id && !BUILT_IN.test(want);           // a cable from the piano: clean sound, nobody talking into it
    const track = mic.stream.getAudioTracks()[0], st = track && track.getSettings ? track.getSettings() : {};
    mic.filtered = st.echoCancellation === true || st.noiseSuppression === true || st.autoGainControl === true;
    mic.analyser = ac.createAnalyser();
    mic.analyser.fftSize = 8192; mic.analyser.smoothingTimeConstant = 0;
    const micSource = ac.createMediaStreamSource(mic.stream);
    micSource.connect(mic.analyser);
    mic.src = micSource;
    if (window.KeyfallML && ui.listener.value === "ai") KeyfallML.start(ac, micSource);
    // Safari only processes nodes that lead to the speakers, so route through a silent gain
    const mute = ac.createGain(); mute.gain.value = 0;
    mic.analyser.connect(mute).connect(ac.destination);
    mic.buf = new Float32Array(mic.analyser.fftSize);
    mic.spec = new Float32Array(mic.analyser.frequencyBinCount);
    const hz = ac.sampleRate / mic.analyser.fftSize, nb = mic.analyser.frequencyBinCount;
    for (let k = BLO; k <= BHI; k++) {                 // FFT bins that belong to each key's band (±50 cents)
      const f = 440 * Math.pow(2, (k - 69) / 12);
      let i0 = Math.ceil(f * Math.pow(2, -1 / 24) / hz), i1 = Math.floor(f * Math.pow(2, 1 / 24) / hz);
      if (i1 < i0) i0 = i1 = Math.round(f / hz);
      mic.bands[k] = [i0, Math.min(i1, nb - 1)];
    }
    mic.hist = []; mic.live.fill(-200); mic.spread.fill(9); mic.over.fill(0); mic.roomDb = null; mic.startAt = performance.now();
    mic.on = true; ui.micText.textContent = "🎤 Listen: on"; ui.mic.classList.add("primary");
    fillMics();                                        // input names can be shown now
  }

  // ---------- Which input "🎤 Listen" uses (remembered by name: the device's id can change on an iPad) ----------
  const micSel = $("micDevice"), micNote = $("micDeviceNote"), micHelp = micNote ? micNote.textContent : "";
  const BUILT_IN = /built-?in|iphone|ipad|default|internal|mic|airpods|headset|bluetooth|webcam|camera/i;
  const micWanted = () => { try { return localStorage.getItem("keyfall:micDevice") || ""; } catch (e) { return ""; } };
  async function micInputs() {
    try { return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications"); }
    catch (e) { return []; }
  }
  // its id, "" if it isn't connected, or null if names are still hidden
  async function findMic(label) {
    const list = await micInputs();
    return list.some(d => d.label) ? (list.find(d => d.label === label) || {}).deviceId || "" : null;
  }
  async function fillMics() {
    if (!micSel) return;
    const want = micWanted(), list = await micInputs(), named = list.some(d => d.label);
    const opts = [new Option("Built-in microphone (default)", "")];
    if (named) list.forEach(d => d.label && opts.push(new Option(d.label, d.label)));
    const missing = !!want && named && !list.some(d => d.label === want);
    if (want && !opts.some(o => o.value === want)) opts.push(new Option(want + (missing ? " (not connected)" : ""), want));
    if (!named) { const o = new Option("Other inputs appear after you turn on 🎤 Listen once", "-"); o.disabled = true; opts.push(o); }
    micSel.replaceChildren(...opts);
    micSel.value = want;
    micNote.textContent = (missing ? `“${want}” isn't connected, using the built-in microphone. ` : "") + micHelp;
  }
  if (micSel) {
    micSel.onchange = async () => {
      try { localStorage.setItem("keyfall:micDevice", micSel.value); } catch (e) {}
      if (mic.on) { await toggleMic(); await toggleMic(); } else fillMics();   // switch inputs while listening
    };
    fillMics();
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener("devicechange", fillMics);
  }

  function detectPitch(x, sr) {
    const maxLag = Math.floor(sr / 62), minLag = Math.floor(sr / 2200), W = x.length - maxLag;
    const d = new Float32Array(maxLag + 1);
    let run = 0, tau = -1;
    for (let lag = 1; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i < W; i++) { const v = x[i] - x[i + lag]; sum += v * v; }
      run += sum;
      d[lag] = run ? sum * lag / run : 1;
    }
    for (let lag = minLag; lag < maxLag; lag++) if (d[lag] < 0.15) {
      while (lag + 1 < maxLag && d[lag + 1] < d[lag]) lag++;
      tau = lag; break;
    }
    if (tau < 0) return null;
    const a = d[tau - 1], b = d[tau], c = d[tau + 1], den = a - 2 * b + c;
    return sr / (tau + (den ? (a - c) / (2 * den) : 0));
  }

  function micHit(n, perfect) {
    mic.acceptedAt[n.midi] = performance.now();
    if (drill) drillAnswer(n.midi); else registerHit(n, perfect);
  }
  const lateBy = () => mic.on && window.KeyfallML && KeyfallML.state === "on" ? 0.9 : mic.on ? LATE : HIT_WINDOW;
  function micTargets() {              // notes the song is currently waiting to hear
    if (train) return [];
    if (drill) return drill.done ? [] : [drill.target];
    if (state !== "running" || mode() === "listen") return [];
    if (mode() === "practice") { const g = nextGroup(); return g.length && g[0].start - time <= 0.35 ? g : []; }
    return song.notes.filter(n => n.state === "pending" && isUser(n) && n.start - time <= HIT_WINDOW && time - n.start <= lateBy());
  }
  const micPerfect = (n, ago = 0) => mode() === "practice" || Math.abs(n.start - (time - ago / 1000 * ui.speed.value / 100)) <= PERFECT + 0.12;

  function micTick() {
    if (!mic.on) return;
    const now = performance.now(), sr = ac.sampleRate, S = sens();
    mic.analyser.getFloatTimeDomainData(mic.buf);
    const x = mic.buf.subarray(mic.buf.length - 4096);
    let e = 0;
    for (let i = 0; i < x.length; i++) e += x[i] * x[i];
    const rms = mic.level = Math.sqrt(e / x.length), db = mic.db = 20 * Math.log10(rms + 1e-9);
    mic.roomDb = mic.roomDb == null ? db : mic.roomDb + (db - mic.roomDb) * (db < mic.roomDb ? 0.05 : 0.002);

    // --- band levels (dB) for every key, and a slow estimate of each band's background level
    const spec = mic.spec, L = mic.L, F = mic.F, live = mic.live, hz = sr / mic.analyser.fftSize, nb = spec.length;
    mic.analyser.getFloatFrequencyData(spec);
    for (let k = BLO; k <= BHI; k++) {
      const [i0, i1] = mic.bands[k];
      let pk = -200;
      for (let i = i0; i <= i1; i++) if (spec[i] > pk) pk = spec[i];
      L[k] = pk;
    }
    for (let k = BLO; k <= BHI; k++) {
      // background level per band: a running mean and spread that ignore anything far above it (the notes)
      const pk = L[k], d = pk - live[k], sp = mic.spread;
      if (live[k] <= -199) { live[k] = pk; sp[k] = 9; }
      else if (now - mic.startAt < 1000) { live[k] += 0.1 * d; sp[k] = Math.max(1, sp[k] + 0.1 * (d * d - sp[k])); }   // settling in
      else if (d < 3 * Math.sqrt(sp[k]) + 3) {
        live[k] += (d < 0 ? 0.03 : 0.01) * d; sp[k] = Math.max(1, sp[k] + 0.01 * (d * d - sp[k])); mic.over[k] = 0;
      } else if (peaky(k, 3)) mic.over[k] = 0;           // a held note is a clear tone: never part of the background
      else if (++mic.over[k] > 120) {                     // a louder hiss for 2 seconds straight: that's the room now
        live[k] += 0.05 * d; sp[k] = Math.max(1, sp[k] + 0.05 * (d * d - sp[k]));
      }
    }
    // --- untrained salience: three overtones from 250 Hz up
    for (let m = 21; m <= 108; m++) {
      const f = 440 * Math.pow(2, (m - 69) / 12), h0 = Math.max(1, Math.ceil(250 / f));
      let acc = 0;
      for (let h = h0; h < h0 + 3; h++) {
        const b = Math.round(h * f / hz), tol = Math.max(1, Math.round(b * 0.012));
        let pk = -200;
        for (let k = b - tol; k <= b + tol && k < nb; k++) if (spec[k] > pk) pk = spec[k];
        acc += Math.pow(10, pk / 10);
      }
      mic.sal[m] = 10 * Math.log10(acc / 3 + 1e-20);
    }
    // --- how much each band jumped in the last 0.3 s, minus any jump shared by most bands (a thump)
    const hist = mic.hist;
    while (hist.length > 1 && now - hist[0].t > 300) hist.shift();
    for (let k = BLO; k <= BHI; k++) {
      let lo = L[k];
      for (const h of hist) if (h.L[k] < lo) lo = h.L[k];
      F[k] = L[k] - lo;
    }
    const sorted = Array.from(F.subarray(40, 111)).sort((a, b) => a - b), base = Math.max(0, sorted[Math.floor(sorted.length * 0.3)]);
    for (let k = BLO; k <= BHI; k++) F[k] = Math.max(0, F[k] - base);
    const FF = mic.FF;                                  // the jump within the last 80 ms only
    // a hammer strike: many bands jump at once, including those between the note's overtones (the attack's
    // splash). Strings beating only move the note's own overtones, a few at a time.
    const J = mic.J;                                    // which bands just jumped
    for (let k = BLO; k <= BHI; k++) {
      let lo = L[k];
      for (const h of hist) if (now - h.t <= 80 && h.L[k] < lo) lo = h.L[k];
      FF[k] = L[k] - lo;
      J[k] = k >= 40 && k <= 110 && FF[k] >= 3 && L[k] >= noiseAt(k) ? 1 : 0;
    }
    // did bands jump that are NOT this key's own overtones (or right beside them)? That's a fresh strike.
    const struck = m => {
      let n = 0;
      const own = new Uint8Array(130);
      for (const o of HARM) for (let d = -1; d <= 1; d++) if (m + o + d < 130) own[m + o + d] = 1;
      for (let k = 40; k <= 110; k++) if (J[k] && !own[k]) n++;
      if (n >= 6) return true;
      // a soft strike's splash can be lost in the room's hiss; then its own main tones must leap sharply
      // (by 6 dB within 80 ms: a re-strike does that, the slow swell of beating strings doesn't)
      let leaps = 0, audible = 0;
      for (const o of HARM.slice(0, 4)) {
        const b = m + o;
        if (b > BHI || L[b] < noiseAt(b) + 3) continue;
        audible++;
        if (FF[b] >= 5) leaps++;
      }
      return leaps >= Math.min(2, audible) && leaps > 0;
    };

    if (train) trainTick(now);
    else {
      // --- untrained floor: a low percentile of the spectrum between 200 Hz and 4 kHz
      const sample = [];
      for (let b = Math.round(200 / hz); b < 4000 / hz && b < nb; b += 4) sample.push(spec[b]);
      sample.sort((a, b) => a - b);
      const floor = Math.max(sample[Math.floor(sample.length * 0.3)], -160);
      // bands that belong to notes just accepted (or that the app itself is sounding): evidence there can't prove a
      // different key. Only accepted notes count, never a key the listener merely suspected.
      const byRecent = mic.byRecent; byRecent.fill(0);
      const waiting = new Set(micTargets().map(n => n.midi));
      const explains = k => now - mic.acceptedAt[k] < 600 || autoDown.has(k) || (waiting.has(k) && now - mic.onsetAt[k] < 300);
      for (let k = 21; k <= 108; k++) if (explains(k)) for (const o of HARM) if (k + o <= BHI) byRecent[k + o]++;
      const otherKey = (b, m) => byRecent[b] - (explains(m) && HARM.includes(b - m) ? 1 : 0) > 0;
      // did this key's own fundamental or 3rd overtone just start sounding, in a band no other key being played
      // explains? (A note still ringing from earlier doesn't count: its tone isn't fresh.)
      // (A repeated key is the exception: its tone rings on from its own previous strike.)
      const ownTone = m => [m, m + 19].some(b => b <= BHI && !otherKey(b, m) && (F[b] >= 3 || now - mic.acceptedAt[m] < 3000)
        && L[b] >= noiseAt(b) + S.tMargin * 0.6 && peaky(b, 2));
      // --- decide, for every key, whether it was just struck
      for (let m = 21; m <= 108; m++) {
        // untrained check: three overtones from 250 Hz up stand out and just jumped
        const s = mic.sal[m], level = s;
        let lo = s;
        for (const h of hist) if (h.s[m] < lo) lo = h.s[m];
        // A key still ringing from a recent strike swells and fades by itself (its strings beat against each
        // other), so striking it again only counts together with a fresh hammer strike heard across the spectrum.
        const ringing = now - mic.hitAt[m] < 3000;
        if (ringing && struck(m)) mic.lastStruck[m] = now;
        // (the strike must come after this key's previous counted strike, not be the same one seen again)
        const restrike = !ringing || (now - mic.lastStruck[m] < 200 && mic.lastStruck[m] - mic.hitAt[m] > 150);
        // ...and at least one of those overtones rose clearly above the background in its own frequency range
        // (a fan or traffic rumble is far louder in the low range than the treble, so one overall level isn't enough)
        let own = 0, ownSoft = 0;
        for (const o of HARM) {
          const b = m + o;
          if (b > BHI) break;
          if (L[b] >= noiseAt(b) + S.tMargin && F[b] >= S.gRise && peaky(b, 2)) own = 1;
          if (L[b] >= noiseAt(b) + S.tMargin * 0.6 && F[b] >= S.gRise * 0.5) ownSoft = 1;
        }
        let strict = restrike && own && s >= mic.sal[m - 1] + 4 && s >= mic.sal[m + 1] + 4 && s >= floor + S.gFloor && s - lo >= S.gRise;
        let soft = ownSoft && s >= mic.sal[m - 1] + 2 && s >= mic.sal[m + 1] + 2 && s >= floor + S.gFloor - 6 && s - lo >= S.gRise * 0.5;
        // trained check: the bands where this key was heard during training (either check is enough)
        const t = tmpl[m];
        if (t && !strict) {
          let tot = 0, got = 0, gotSoft = 0, n = 0;
          for (const { b, lv, w } of t) {
            const nz = noiseAt(b);
            if (lv < nz + S.tMargin + 3 || n >= 5) continue;   // buried under today's noise: rely on the other overtones
            n++; tot += w;
            if (L[b] >= nz + S.tMargin && L[b] >= lv - S.tSoft && F[b] >= S.tRise && peaky(b, 3)) got += w;
            if (L[b] >= nz + S.tMargin * 0.6 && F[b] >= S.tRise * 0.5 && peaky(b, 1.5)) gotSoft += w;
          }
          if (tot) { strict = restrike && got >= 0.6 * tot; soft = soft || gotSoft >= 0.5 * tot; }
        }
        if (!mic.armed[m]) {                             // a struck key listens again once it fades a little
          if (level > mic.peak[m]) mic.peak[m] = level;
          if ((now - mic.hitAt[m] > 250 && level < mic.peak[m] - 6) || now - mic.hitAt[m] > 400) mic.armed[m] = 1;
        }
        if (mic.armed[m]) {
          if (strict) {
            mic.onsetAt[m] = now; mic.armed[m] = 0; mic.peak[m] = level; mic.hitAt[m] = now;
            mic.lowEv[m] = mic.upTone[m] = mic.own[m] = mic.seen[m] = mic.sub[m] = mic.fund[m] = 0;
            // watch the two overtones (above 300 Hz, where pitch resolution is fine) that jumped most at this strike,
            // so the bands hold this note's sound rather than an earlier note's
            let best = -1, second = -1, third = -1;
            // prefer its strong lower overtones (1st to 6th) above 300 Hz; else lower ones; else any loud overtone
            for (const [lowOk, upto] of [[false, 6], [true, 6], [true, 10]]) {
              for (const o of HARM.slice(0, upto)) {
                const b = m + o;
                if (b > BHI) break;
                if ((!lowOk && b < 62) || L[b] < noiseAt(b) + 6) continue;
                if (best < 0 || F[b] > F[best]) { third = second; second = best; best = b; }
                else if (second < 0 || F[b] > F[second]) { third = second; second = b; }
                else if (third < 0 || F[b] > F[third]) third = b;
              }
              if (best >= 0) break;
            }
            mic.ref[m] = best; mic.ref2[m] = second; mic.ref3[m] = third; mic.pk2[m] = -200; mic.drop2[m] = 0; mic.pMin[m] = 1e9; mic.pMax[m] = -1e9; mic.pN[m] = 0; mic.pk[m] = -200; mic.drop[m] = 0;
          } else if (soft) mic.softAt[m] = now;
        }
        // wrong octave? A key an octave away shares many of this key's overtones, so watch the ones it doesn't
        // share during the first 0.2 s after a strike (the attack's splash hides them at first).
        if (now - mic.onsetAt[m] <= 200) {
          if (mic.seen[m] < 255) mic.seen[m]++;
          // a struck piano string holds its pitch; a speaking voice slides. Measure the exact pitch of the
          // watched overtone (peak bin, refined by fitting a parabola) whenever it is clearly loud.
          const rb = mic.ref[m];
          // a piano note fades slowly after its strike; a syllable of speech collapses within a tenth of a second
          if (rb > 0) {
            if (L[rb] > mic.pk[m]) mic.pk[m] = L[rb];
            else mic.drop[m] = Math.max(mic.drop[m], mic.pk[m] - L[rb]);
          }
          // ...judged on the combined sound of its three freshest overtones: beating strings dip one overtone
          // at a time, while a syllable of speech fades in all of them at once
          if (rb > 0) {
            let pw = 0;
            for (const b of [rb, mic.ref2[m], mic.ref3[m]]) if (b > 0) pw += Math.pow(10, L[b] / 10);
            const tot = 10 * Math.log10(pw);
            if (tot > mic.pk2[m]) mic.pk2[m] = tot;
            else mic.drop2[m] = Math.max(mic.drop2[m], mic.pk2[m] - tot);
          }
          if (rb >= 62 && L[rb] >= noiseAt(rb) + 20 && peaky(rb, 3)) {      // clearly loud only: noise jiggles a soft note's pitch
            const [i0, i1] = mic.bands[rb];
            let i = i0;
            for (let j = i0; j <= i1; j++) if (spec[j] > spec[i]) i = j;
            const a = spec[i - 1], c = spec[i + 1], den = a - 2 * spec[i] + c;
            const f = (i + (den < 0 ? 0.5 * (a - c) / den : 0)) * hz;
            const cents = 1200 * Math.log2(f / (440 * Math.pow(2, (rb - 69) / 12)));
            if (cents < mic.pMin[m]) mic.pMin[m] = cents;
            if (cents > mic.pMax[m]) mic.pMax[m] = cents;
            if (mic.pN[m] < 255) mic.pN[m]++;
          }
          const lo = m - 12, ref = Math.max(lvl(m), lvl(m + 12), lvl(m + 19), lvl(m + 24));
          const tone = b => b >= BLO && b <= BHI && F[b] >= 6 && L[b] >= noiseAt(b) + S.tMargin && peaky(b, 4);
          const there = b => b > BHI || (L[b] >= noiseAt(b) + S.tMargin * 0.6 && peaky(b, 2));
          const visible = b => b > BHI || noiseAt(b) + 15 < L[m + 12];
          // octave below: its fundamental and 3rd overtone (which this key lacks) sounded as well
          const clear = b => b >= BLO && b <= BHI && noiseAt(b) + 15 < ref;
          if (clear(lo) && clear(m + 7) && tone(lo) && tone(m + 7) && L[lo] >= ref - 15 && L[m + 7] >= ref - 25 && mic.lowEv[m] < 9) mic.lowEv[m]++;
          // octave above: the key above sounded, but this key's own fundamental and 3rd overtone never did
          if (m >= 36 && tone(m + 12) && visible(m) && visible(m + 19)) mic.upTone[m] = 1;
          // From A2 up a struck key's own lowest tone is clearly audible. If it stays silent, what was heard were
          // overtones of other keys (G4 is C3's 3rd overtone). After training, only where it was heard in training.
          const t = tmpl[m], fundHeard = !calib || !calib.keys[m] || calib.keys[m].lv[0] - calib.noise[m] >= 12;
          if (m >= 45 && fundHeard && t !== null && noiseAt(m) + 15 < ref) { if (mic.sub[m] < 255) mic.sub[m]++; if (there(m) && mic.fund[m] < 255) mic.fund[m]++; }
          // its own fundamental or 3rd overtone: sounding, and either not explained by another note being played
          // or freshly jumping now (a struck G4 over a ringing C3, whose 3rd overtone is that same G4)
          if ([m, m + 19].some(b => there(b) && (b > BHI || !otherKey(b, m) || F[b] >= 3)) && mic.own[m] < 255) mic.own[m]++;
        }
      }
      // --- match what was heard to the notes the song is waiting for
      const targets = micTargets();
      const AI = window.KeyfallML && KeyfallML.state === "on" && !train;
      if (AI && targets.length) {
        // the trained model reports each key it heard struck, with the time it happened (about 0.3 s later)
        const keepAI = drill || mode() === "practice" ? 1500 : 900;
        for (const n of targets) {
          const m = n.midi, at = KeyfallML.onsetAt[m];
          if (at > mic.usedAt[m] && now - at <= keepAI) {
            mic.usedAt[m] = at;
            // the signal checks still help when they measured the same strike: a voice slides in pitch and dies at
            // once; a key whose own lowest tone never sounded was really another key's overtones
            if (window.__aiLog) window.__aiLog.push({ m, conf: +KeyfallML.onsetConf[m].toFixed(2), dt: Math.round(mic.onsetAt[m] - at), pN: mic.pN[m], range: Math.round(mic.pMax[m] - mic.pMin[m]), drop2: +mic.drop2[m].toFixed(1), sub: mic.sub[m], fund: mic.fund[m], sus: +KeyfallML.sustain[m].toFixed(2) });
            const same = Math.abs(mic.onsetAt[m] - at) < 250;
            if (same) {
              if (talkOn() && ((mic.pN[m] >= 3 && mic.pMax[m] - mic.pMin[m] > 60) || mic.drop2[m] > 15)) continue;
              if (mic.sub[m] >= 3 && mic.fund[m] * 3 < mic.sub[m]) continue;
            }
            // struck piano keys get a sure verdict (0.9 or more); a less sure one needs the signal checks to have seen
            // the strike too (voices tend to score around 0.6)
            // (or the key still rings: a piano note keeps sounding, a syllable is already gone)
            if (KeyfallML.onsetConf[m] < 0.75 && !same && KeyfallML.sustain[m] < 0.45) continue;
            mic.acceptedAt[m] = now;
            if (drill) drillAnswer(m); else registerHit(n, micPerfect(n, now - at));
          }
        }
      } else if (targets.length) {
        const keep = drill || mode() === "practice" ? 800 : 250;
        // every note of the chord being played, including ones already heard, so C3 + C4 isn't mistaken for a lone C3
        const t0 = Math.min(...targets.map(n => n.start)), t1 = Math.max(...targets.map(n => n.start));
        const want = new Set(drill ? [drill.target.midi] : song.notes.filter(n => isUser(n) && n.start >= t0 - 1e-6 && n.start <= t1 + 1e-6).map(n => n.midi));
        const take = (n, from) => {
          const m = n.midi;
          mic.usedAt[m] = from;
          const talkFilter = talkOn() && from === mic.onsetAt[m];
          if (talkFilter && mic.pN[m] >= 3 && mic.pMax[m] - mic.pMin[m] > 60) return;   // pitch slid: a voice, not a piano
          // its sound died away at once: speech, not a struck string
          if (talkFilter && mic.drop2[m] > 15) return;
          if (from === mic.onsetAt[m] && mic.sub[m] >= 3 && mic.fund[m] * 3 < mic.sub[m]) return;   // its own lowest tone never sounded
          if ((mic.lowEv[m] >= 2 && !want.has(m - 12)) || (mic.upTone[m] && mic.own[m] * 3 < mic.seen[m])) return;   // wrong octave
          micHit(n, micPerfect(n, now - from)); mic.groupHitAt = now; mic.groupStart = n.start;
        };
        for (const n of targets) {
          const m = n.midi;
          const age = now - mic.onsetAt[m];
          const wait = talkOn() ? 170 : 120;
          if (mic.onsetAt[m] > mic.usedAt[m] && age >= wait && age <= keep + wait) take(n, mic.onsetAt[m]);
        }
        // the rest of a chord that was just heard: weaker evidence is enough for its other notes
        if (!drill && now - mic.groupHitAt <= keep) for (const n of micTargets()) {
          const m = n.midi;
          if (n.state !== "hit" && n.start === mic.groupStart && mic.softAt[m] > mic.usedAt[m] && now - mic.softAt[m] <= keep && ownTone(m)) {
            mic.lowEv[m] = 0;
            take(n, mic.softAt[m]);
          }
        }
      }
    }
    hist.push({ t: now, L: L.slice(), s: mic.sal.slice() });

    // --- pitch readout
    if (db < mic.roomDb + 6) { mic.note = mic.cand = null; mic.count = 0; return; }
    if (now - mic.yinAt < 50) return;
    mic.yinAt = now;
    const f = detectPitch(x, sr), midi = f ? Math.round(69 + 12 * Math.log2(f / 440)) : null;
    if (midi !== null && midi >= 21 && midi <= 108) {
      if (midi === mic.cand) mic.count++; else { mic.cand = midi; mic.count = 1; }
      if (mic.count >= 2) mic.note = midi;
    }
  }

  // ---------- Train on my piano: learn how every key sounds through this microphone ----------
  let train = null;
  async function startTraining() {
    if (!mic.on) await toggleMic();
    if (!mic.on) { $("trainStatus").textContent = "The microphone is needed for training. Allow it when Safari asks, then try again."; return; }
    if (state === "running") pause();
    train = { phase: "noise", t0: performance.now(), frames: [], i: 0, cap: null, rejects: 0, wait: 0, msg: "", okAt: 0, keys: [], log: [],
      data: { v: 1, noise: [], keys: Object.assign({}, calib ? calib.keys : {}), date: Date.now() } };
    for (let m = 21; m <= 108; m++) train.keys.push(m);
    LOW = 21; HIGH = 108; layout();
    $("home").hidden = true; $("bar").classList.add("train"); $("title").textContent = "Train on my piano"; ui.hint.hidden = true;
    ui.ready.hidden = true; ui.pause.hidden = true;
  }
  function trainTick(now) {
    const T = train, L = mic.L, F = mic.F;
    if (T.phase === "noise") {                          // 2 seconds of the room's own sound
      T.frames.push(L.slice());
      if (now - T.t0 >= 2000 && T.frames.length >= 10) {
        const noise = new Array(128).fill(-200);
        for (let k = BLO; k <= BHI; k++) {
          const v = T.frames.map(f => f[k]).sort((a, b) => a - b);
          noise[k] = Math.round(v[Math.floor(v.length * 0.9)] * 10) / 10;
        }
        T.data.noise = noise; T.phase = "keys"; T.frames = null; T.wait = now + 200;
      }
      return;
    }
    if (T.phase !== "keys" || now < T.wait) return;
    const m = T.keys[T.i], nz = T.data.noise;
    if (!T.cap) {                                       // wait for a strike: this key's bands jump, or several bands jump at once
      const jump = k => F[k] >= 8 && L[k] >= nz[k] + 8 && peaky(k, 3);
      let many = 0;
      for (let k = BLO; k <= BHI; k++) if (jump(k)) many++;
      if (!HARM.some(o => m + o <= BHI && jump(m + o)) && many < 4) return;
      T.cap = { t0: now, lv: HARM.map(() => -200), rs: HARM.map(() => 0), top: HARM.map(() => -200), lowL: -200 };
    }
    // jumps over the next 0.3 s; levels only once the attack's splash has left the analysis window
    const c = T.cap, settled = now - c.t0 >= 170;
    HARM.forEach((o, n) => {
      const b = m + o;
      if (b > BHI) return;
      c.rs[n] = Math.max(c.rs[n], F[b]);
      if (settled) c.lv[n] = Math.max(c.lv[n], L[b]);
    });
    if (settled) {
      for (let k = BLO; k <= BHI; k++) c.top[k] = Math.max(c.top[k] ?? -200, L[k] - nz[k]);
      if (m - 12 >= BLO) c.lowL = Math.max(c.lowL, L[m - 12]);
    }
    if (now - c.t0 < 300) return;
    T.cap = null; T.wait = now + 250;
    // was it this key? (its loudest band should be one of its overtones; low bands blur into their neighbours)
    const bands = [0, 12, 19, 24, 28, 31, 34, 36, 38, 40, 42, 43, 44, 46, 47, 48].map(o => m + o).filter(b => b <= BHI);
    let best = BLO;
    for (let k = BLO; k <= BHI; k++) if (c.top[k] > c.top[best]) best = k;
    const strongest = Math.max(...c.lv);
    const loud = HARM.some((o, n) => m + o <= BHI && c.rs[n] >= 6 && c.lv[n] >= nz[m + o] + 8);
    const near = best < 57 ? bands.some(b => Math.abs(b - best) <= 1) : bands.includes(best);
    const odd = Math.max(...[0, 2, 4].filter(n => m + HARM[n] <= BHI).map(n => c.lv[n])) >= strongest - 25;
    const lower = m - 12 >= BLO && c.lowL >= strongest - 12;
    const problem = !loud ? "quiet" : !near ? "other" : !odd ? "high" : lower ? "low" : "";
    if (problem) T.log.push(nm(m) + ":" + problem);
    if (problem && (problem === "quiet" || T.rejects < 2)) {
      T.rejects++;
      T.msg = { quiet: T.rejects >= 3 ? `Still too quiet. Play ${nm(m)} louder, move the iPad closer, or tap Skip key.` : `That was too quiet to learn from. Play ${nm(m)} a little harder.`,
        other: `That sounded like a different key. Play ${nm(m)}.`,
        high: `That sounded like a higher ${NAMES[m % 12]}. Play ${nm(m)}.`,
        low: `That sounded like a lower ${NAMES[m % 12]}. Play ${nm(m)}.` }[problem];
      return;
    }
    T.data.keys[m] = { lv: c.lv.map(v => Math.round(v * 10) / 10), rs: c.rs.map(v => Math.round(v * 10) / 10) };
    T.msg = problem ? "Saved it anyway. If that was the wrong key, tap Back one key." : "";
    T.okAt = now; T.rejects = 0; burst(m, "#5fd38a", false);
    calib = T.data; saveCalib(); buildTemplates();     // keep progress even if training stops halfway
    if (++T.i >= T.keys.length) finishTraining();
  }
  function finishTraining() {
    const T = train;
    if (!T) return;
    train = null;
    if (T.phase === "keys") { calib = T.data; saveCalib(); buildTemplates(); }
    $("bar").classList.remove("train");
    showHome();
  }
  function drawTraining() {
    const T = train, cx = W / 2, now = performance.now();
    ctx.textAlign = "center";
    ctx.fillStyle = "#2c3042"; ctx.fillRect(0, 0, W, 4);
    ctx.fillStyle = "#5fd38a"; ctx.fillRect(0, 0, W * T.i / T.keys.length, 4);
    const y = Math.max(70, kbTop * 0.32);
    if (!mic.on) {
      ctx.font = "600 22px system-ui, sans-serif"; ctx.fillStyle = "#ffc14d";
      ctx.fillText("The microphone is off. Tap 🎤 Listen to continue.", cx, y);
      return;
    }
    if (T.phase === "noise") {
      ctx.font = "700 30px system-ui, sans-serif"; ctx.fillStyle = "#e8eaf2";
      ctx.fillText("Stay quiet for a moment…", cx, y);
      ctx.font = "16px system-ui, sans-serif"; ctx.fillStyle = "#a3a8bd";
      ctx.fillText("Listening to your room's background sound", cx, y + 32);
      return;
    }
    const m = T.keys[T.i];
    ctx.font = "600 13px system-ui, sans-serif"; ctx.fillStyle = "#a3a8bd";
    ctx.fillText(`KEY ${T.i + 1} OF ${T.keys.length}`, cx, y - 46);
    ctx.font = "800 64px system-ui, sans-serif"; ctx.fillStyle = "#ffffff";
    ctx.fillText(nm(m), cx, y + 16);
    ctx.font = "17px system-ui, sans-serif"; ctx.fillStyle = "#cfd3e6";
    ctx.fillText("Play the green key once, firmly, and let it ring.", cx, y + 52);
    ctx.font = "600 17px system-ui, sans-serif";
    if (T.msg) { ctx.fillStyle = "#ffc14d"; ctx.fillText(T.msg, cx, y + 84); }
    else if (now - T.okAt < 700) { ctx.fillStyle = "#5fd38a"; ctx.fillText("Got it ✓  " + nm(T.keys[T.i - 1] ?? m), cx, y + 84); }
  }

  // ---------- Layout & drawing ----------
  let W = 0, H = 0, kbTop = 0, whiteW = 0, keys = [];
  // Sharpness: "Ultra" draws 1.5× more finely than the screen's own pixels in each direction (smoother edges and
  // finer sparkles), up to what an iPad's browser allows for one picture (about 16 million pixels; 8K is 33 million).
  // If the iPad can't keep up, it drops back to the screen's own pixels by itself.
  function pixelRatio() {
    const dpr = window.devicePixelRatio || 1, want = dpr * (ui.sharp.value === "ultra" ? 1.5 : 1);
    const r = canvas.getBoundingClientRect(), area = Math.max(1, r.width * r.height);
    return Math.max(1, Math.min(want, Math.sqrt(16e6 / area)));
  }
  function layout() {
    const dpr = pixelRatio(), r = canvas.getBoundingClientRect();
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.imageSmoothingQuality = "high";
    const sheetOn = song && !drill && !train && !rec && ui.view.value === "sheet";
    const kbH = sheetOn ? Math.max(80, Math.min(H * 0.19, 150)) : Math.max(90, Math.min(H * 0.26, 200));
    kbTop = H - kbH;
    if (fx) fx.resize(W, H, dpr);
    let whites = 0;
    grad = null;
    for (let m = LOW; m <= HIGH; m++) if (!isBlack(m)) whites++;
    whiteW = W / whites;
    keys = [];
    let wi = 0;
    for (let m = LOW; m <= HIGH; m++) {
      if (isBlack(m)) keys.push({ midi: m, black: true, x: wi * whiteW - whiteW * 0.3, w: whiteW * 0.6, h: kbH * 0.62 });
      else keys.push({ midi: m, black: false, x: wi++ * whiteW, w: whiteW, h: kbH });
    }
  }
  const keyOf = m => keys[m - LOW];
  const COLORS = { right: "#39b6ff", left: "#ffa23a" };
  const LIGHT = { "#39b6ff": "#8fd8ff", "#ffa23a": "#ffd08f", "#e2495b": "#ff8e9b" };
  const DARK = { "#39b6ff": "#1f86c9", "#ffa23a": "#d9761a", "#e2495b": "#b02a3b" };
  // How the falling notes look: glowing red on black (like piano videos), or the original blue and orange
  const LOOKS = { red: { right: "#ff2448", left: "#d10f3a" }, classic: { right: "#39b6ff", left: "#ffa23a" } };
  let red = true;
  function setLook(v) {
    red = v !== "classic"; Object.assign(COLORS, LOOKS[red ? "red" : "classic"]);
    ui.look.value = red ? "red" : "classic"; grad = null;
    try { localStorage.setItem("keyfall:look", ui.look.value); } catch (e) {}
  }

  function rrect(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  let grad = null;                                    // gradients that only change with the layout
  function gradients() {
    const g = {};
    g.bg = ctx.createLinearGradient(0, 0, 0, kbTop);
    g.bg.addColorStop(0, "#161a29"); g.bg.addColorStop(0.7, "#11141e"); g.bg.addColorStop(1, "#0c0e15");
    g.white = ctx.createLinearGradient(0, kbTop, 0, H);
    g.white.addColorStop(0, "#d9dce6"); g.white.addColorStop(0.06, "#ffffff"); g.white.addColorStop(0.85, "#f1f2f7"); g.white.addColorStop(1, "#c9ccd8");
    g.black = ctx.createLinearGradient(0, kbTop, 0, kbTop + (H - kbTop) * 0.62);
    g.black.addColorStop(0, "#0a0b10"); g.black.addColorStop(0.1, "#2a2d39"); g.black.addColorStop(0.88, "#14161d"); g.black.addColorStop(1, "#050608");
    g.lip = ctx.createLinearGradient(0, H - 10, 0, H);         // the white keys' front edge
    g.lip.addColorStop(0, "#d4d7e0"); g.lip.addColorStop(1, "#9ea2b0");
    g.face = ctx.createLinearGradient(0, kbTop + (H - kbTop) * 0.5, 0, kbTop + (H - kbTop) * 0.64);   // the black keys' sloped front
    g.face.addColorStop(0, "#2c2f3a"); g.face.addColorStop(1, "#4a4e5c");
    g.shade = ctx.createLinearGradient(0, kbTop, 0, kbTop + 14);
    g.shade.addColorStop(0, "rgba(0,0,0,.45)"); g.shade.addColorStop(1, "rgba(0,0,0,0)");
    return g;
  }
  function keyFill(color, k) {                        // a lit key: the colour, brighter at the top, with a soft sheen
    const gr = ctx.createLinearGradient(0, kbTop, 0, kbTop + k.h);
    gr.addColorStop(0, color); gr.addColorStop(0.75, color); gr.addColorStop(1, k.black ? (red ? "#3a0610" : "#0d2a3f") : "#ffffff");
    return gr;
  }

  // ---------- Sheet music view: a still page of music; the note to play lights up and pages turn by themselves ----------
  const WHITE_STEP = { 0: 0, 2: 1, 4: 2, 5: 3, 7: 4, 9: 5, 11: 6 };
  const LETTERS = "CDEFGAB";
  const MAJOR_P = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MINOR_P = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const KEY_OF = [0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5];          // sharps (+) or flats (−) of the major key on each note
  const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6], FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3];   // F C G D A E B  /  B E A D G C F
  const KEY_STEPS = { 1: [38, 35, 39, 36, 33, 37, 34], [-1]: [34, 37, 33, 36, 32, 35, 31] };   // where they sit on the treble staff
  function keySigOf(notes) {                                 // the key signature that suits the song best (Krumhansl's key profiles)
    if (notes.length < 12) return 0;
    const w = new Array(12).fill(0);
    for (const n of notes) w[n.midi % 12] += Math.min(n.dur, 1.5) + 0.2;
    const corr = (prof, t) => {
      let mx = 0, my = 0; for (let i = 0; i < 12; i++) { mx += w[i] / 12; my += prof[i] / 12; }
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < 12; i++) { const x = w[i] - mx, y = prof[(i - t + 12) % 12] - my; sxy += x * y; sxx += x * x; syy += y * y; }
      return sxy / Math.sqrt(sxx * syy || 1);
    };
    let best = -2, key = 0;
    for (let t = 0; t < 12; t++) {
      const a = corr(MAJOR_P, t), m = corr(MINOR_P, t);
      if (a > best) { best = a; key = KEY_OF[t]; }
      if (m > best) { best = m; key = KEY_OF[(t + 3) % 12]; }
    }
    return key;
  }
  let sheet = null;                                     // rebuilt when the song, difficulty or screen size changes
  // Writes the song as real sheet music: notes snapped to a sixteenth-note grid inside each bar, lengths that add up to the
  // bar, ties across beats and bar lines, rests in the gaps, beams joining eighths and sixteenths, a key signature and
  // accidentals (with naturals) that follow the rules of printed music.
  function buildSheet(print = null) {
    const notes = song.notes, beat = song.beat || 0.5, recording = !!song.def.notes;
    // ---- key and spelling ----
    const key = keySigOf(notes);
    const pcs = new Array(12).fill(0); notes.forEach(n => pcs[n.midi % 12]++);
    const flats = key < 0 || (key === 0 && pcs[10] > pcs[6] + pcs[8] + pcs[1]);
    const keyAlter = new Array(7).fill(0);
    if (key > 0) SHARP_ORDER.slice(0, key).forEach(l => keyAlter[l] = 1);
    if (key < 0) FLAT_ORDER.slice(0, -key).forEach(l => keyAlter[l] = -1);
    const spell = midi => {
      const pc = midi % 12, oct = Math.floor(midi / 12) - 1;
      if (pc in WHITE_STEP) return { step: oct * 7 + WHITE_STEP[pc], acc: 0 };
      return flats ? { step: oct * 7 + WHITE_STEP[pc + 1], acc: -1 } : { step: oct * 7 + WHITE_STEP[pc - 1], acc: 1 };
    };
    // ---- bars, each split into sixteenths ("ticks"); a bar keeps its own length, so tempo drift in a recording doesn't matter ----
    let bl = (song.bars || []).filter(b => b > 0.01);
    if (!bl.length) for (let t = beat * 4; t < song.end - 0.01; t += beat * 4) bl.push(t);
    const last = Math.max(song.end, ...notes.map(n => n.start + 0.05));
    const edges = [0, ...bl.filter(b => b < last - 0.01), last];
    const bars = [];
    let TT = 0;
    for (let i = 0; i < edges.length - 1; i++) {
      const t0 = edges[i], t1 = edges[i + 1], n = Math.max(1, Math.min(12, Math.round((t1 - t0) / beat)));
      bars.push({ t0, t1, n, ticks: n * 4, T0: TT, cols: [], full: {}, num: i + 1 }); TT += n * 4;
    }
    const barOfT = T => { let lo = 0, hi = bars.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (bars[m].T0 <= T) lo = m; else hi = m - 1; } return bars[lo]; };
    const barOfTime = t => { let lo = 0, hi = bars.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (bars[m].t0 <= t) lo = m; else hi = m - 1; } return bars[lo]; };
    // a recording's timing wobbles a little: snap to eighth notes unless a note is clearly on a sixteenth
    const toT = t => {
      const b = barOfTime(t), f = Math.max(0, Math.min(1, (t - b.t0) / (b.t1 - b.t0))) * b.ticks;
      let r = Math.round(f);
      if (recording && r % 2 && Math.abs(f - r) > 0.12) r = Math.round(f / 2) * 2;
      return b.T0 + r;
    };
    const timeOf = T => { const b = barOfT(Math.min(T, TT)); return b.t0 + (T - b.T0) / b.ticks * (b.t1 - b.t0); };
    // ---- chords: notes on one staff that start on the same sixteenth ----
    const chords = { t: [], b: [] }, byKey = new Map();
    for (const n of notes) {
      const staff = n.hand === "left" ? (n.midi > 64 ? "t" : "b") : (n.midi < 55 ? "b" : "t");
      const T = Math.min(TT - 1, toT(n.start)), k = staff + T;
      let c = byKey.get(k);
      if (!c) { c = { T, staff, items: [], all: [], start: n.start, endT: T + 1, pieces: [] }; byKey.set(k, c); chords[staff].push(c); }
      c.all.push(n); c.start = Math.min(c.start, n.start);
      c.endT = Math.max(c.endT, toT(n.start + n.dur));
      if (!c.items.some(i => i.n.midi === n.midi)) c.items.push({ n, ...spell(n.midi), ott: 0, name: "" });
    }
    // very low or very high stretches are written an octave nearer the staff under an 8vb / 8va bracket, instead of a
    // ladder of ledger lines; a whole chord moves together, and short gaps between such chords join the same bracket
    for (const [staff, dir] of [["b", -1], ["t", 1]]) {
      const cs = chords[staff].slice().sort((x, y) => x.T - y.T);
      const ext = c => dir < 0 ? Math.min(...c.items.map(i => i.n.midi)) : Math.max(...c.items.map(i => i.n.midi));
      const far = c => dir < 0 ? ext(c) < 36 : ext(c) > 88;
      const ok = c => dir < 0 ? Math.max(...c.items.map(i => i.n.midi)) + 12 <= 62 : Math.min(...c.items.map(i => i.n.midi)) - 12 >= 57;
      cs.forEach(c => c.ott = far(c) && ok(c) ? dir : 0);
      for (let i = 0; i < cs.length; i++) if (cs[i].ott) {
        let j = i + 1; while (j < cs.length && !cs[j].ott && cs[j].T - cs[i].T <= 16) j++;
        if (j < cs.length && cs[j].ott && cs[j].T - cs[i].T <= 16 && cs.slice(i + 1, j).every(ok)) for (let k = i + 1; k < j; k++) cs[k].ott = dir;
      }
      for (const c of cs) if (c.ott) c.items.forEach(it => { it.step -= dir * 7; it.ott = dir; });
    }
    for (const c of byKey.values()) {
      c.items.sort((a, b) => a.step - b.step);
      c.items.forEach(it => it.name = LETTERS[((it.step % 7) + 7) % 7]);
      // neighbouring notes of a chord sit on opposite sides of the stem
      for (let i = 1; i < c.items.length; i++) c.items[i].side = c.items[i].step - c.items[i - 1].step === 1 && !c.items[i - 1].side ? 1 : 0;
    }
    // ---- note values: split a length into the values a musician would write (tied where needed) ----
    const fits = (v, p, b, rest, loose = false) => {
      if (loose && !rest && v >= 2) {                     // pop-style: a held note may start off the beat (8th–quarter–8th)
        if (v === 16) return p === 0;
        if (v >= 8) return p % 4 === 0;
        return v === 3 ? p % 4 < 2 : p % 2 === 0;
      }
      if (v === 16) return !rest && p === 0;
      if (v === 12) return !rest && p === 0;
      if (v === 8) return p % 8 === 0 || (b.n % 2 === 1 && p % 4 === 0);
      if (v === 6) return !rest && (b.n % 2 === 0 ? p % 8 === 0 : p % 4 === 0);
      if (v === 4) return p % 4 === 0;
      if (v === 3) return !rest && p % 4 < 2;
      if (v === 2) return p % 2 === 0;
      return true;
    };
    const pieces = [];
    const emit = (a, e, staff, chord, loose = false) => {
      while (a < e) {
        const b = barOfT(a), p = a - b.T0, stop = Math.min(e, b.T0 + b.ticks);
        if (!chord && p === 0 && stop - a === b.ticks) { b.full[staff] = true; a = stop; continue; }   // a whole bar of rest
        let L = stop - a;
        while (L > 0) {
          const v = [16, 12, 8, 6, 4, 3, 2, 1].find(v => v <= L && fits(v, p + (stop - a - L), b, !chord, loose));
          const T = b.T0 + p + (stop - a - L);
          const pc = { T, v, staff, rest: !chord, chord, bar: b, p: T - b.T0 };
          pieces.push(pc); if (chord) chord.pieces.push(pc);
          L -= v;
        }
        a = stop;
      }
    };
    for (const staff of ["t", "b"]) {
      const cs = chords[staff].sort((x, y) => x.T - y.T);
      let cur = 0;
      cs.forEach((c, i) => {
        const next = i + 1 < cs.length ? cs[i + 1].T : TT;
        // a recording's held lengths are blurry (pedal, ringing strings): write each note as lasting until the next one
        let e = recording ? Math.min(next, c.T + 16) : Math.min(next, Math.max(c.endT, c.T + 1));
        if (cs[i + 1] === undefined && recording) e = Math.min(TT, Math.max(e, c.endT));
        if (c.T > cur) emit(cur, c.T, staff, null);
        e = Math.max(c.T + 1, e);
        if (recording) {                                   // keep a recording easy to read: one plain note value, no ties
          const b = barOfT(c.T), p = c.T - b.T0, L = Math.min(e, b.T0 + b.ticks) - c.T;
          e = c.T + [16, 12, 8, 6, 4, 3, 2, 1].find(v => v <= L && fits(v, p, b, false, true));
        }
        emit(c.T, e, staff, c, recording);
        cur = e;
      });
      if (cur < TT) emit(cur, TT, staff, null);
    }
    pieces.sort((x, y) => x.T - y.T || (x.staff < y.staff ? -1 : 1));
    for (const c of byKey.values()) c.pieces.forEach((pc, i) => { pc.cont = i > 0; pc.tie = i < c.pieces.length - 1 ? c.pieces[i + 1] : null; pc.prev = i ? c.pieces[i - 1] : null; });
    for (const pc of pieces) {
      const v = pc.v;
      Object.assign(pc, { open: v >= 8, stem: v < 16, dot: v === 12 || v === 6 || v === 3, flags: v === 1 ? 2 : v <= 3 ? 1 : 0,
        start: pc.cont || pc.rest ? timeOf(pc.T) : pc.chord.start, dur: timeOf(pc.T + v) - timeOf(pc.T) });
      if (!pc.rest) {
        const mid = pc.staff === "t" ? 34 : 22, its = pc.chord.items;
        pc.up = (its[0].step + its[its.length - 1].step) / 2 < mid;
      }
    }
    // ---- accidentals: the key signature holds for the whole song, an accidental for the rest of its bar ----
    for (const b of bars) for (const staff of ["t", "b"]) {
      const state = new Map();
      for (const pc of pieces) {
        if (pc.bar !== b || pc.staff !== staff || pc.rest) continue;
        pc.signs = pc.chord.items.map(it => {
          const now = state.has(it.step) ? state.get(it.step) : keyAlter[((it.step % 7) + 7) % 7];
          state.set(it.step, it.acc);
          return pc.cont || now === it.acc ? null : it.acc;
        });
      }
    }
    // ---- beams: eighths and sixteenths in the same beat are joined ----
    const beams = [];
    for (const staff of ["t", "b"]) {
      let run = [];
      const close = () => {
        if (run.length > 1) {
          const bm = { pieces: run };
          let lo = 0, cnt = 0; run.forEach(pc => pc.chord.items.forEach(it => { lo += it.step; cnt++; }));
          bm.up = lo / cnt < (staff === "t" ? 34 : 22);
          run.forEach(pc => { pc.beam = bm; pc.up = bm.up; });
          beams.push(bm);
        }
        run = [];
      };
      for (const pc of pieces) {
        if (pc.staff !== staff) continue;
        const prev = run[run.length - 1];
        const ok = !pc.rest && pc.v < 4;
        if (!ok) { close(); continue; }
        if (prev && (prev.bar !== pc.bar || Math.floor(prev.p / 4) !== Math.floor(pc.p / 4) || prev.T + prev.v !== pc.T)) close();
        run.push(pc);
      }
      close();
    }
    // ---- columns: everything that starts on the same sixteenth lines up ----
    for (const pc of pieces) {
      const b = pc.bar;
      let c = b.cols[b.cols.length - 1];
      if (!c || c.T !== pc.T) { c = { T: pc.T, t: timeOf(pc.T), groups: [] }; b.cols.push(c); }
      c.groups.push(pc); pc.col = c;
    }
    // ---- page layout: bars packed into lines (systems), lines stacked into pages ----
    const timeSig = (() => { const ns = bars.map(b => b.n).filter(n => n > 1).sort((x, y) => x - y); const n = ns.length ? ns[ns.length >> 1] : 4; return n >= 2 && n <= 7 ? n : 4; })();
    let top = 58, bottom = kbTop - 10;
    const h = bottom - top, LINE = 21.5;
    const left = print ? print.left : 10, right = print ? print.right : W - 10;
    function pack(sp) {
      const clefW = sp * (5.6 + Math.abs(key) * 0.95), tsW = sp * 2.8, x0 = left + sp * 2 + clefW, lineW = right - sp * 1.2 - x0;
      // widths: every note gets room for its head and accidental, longer notes get a little more
      const minW = sp * 3.6, pad = sp * 2.2, w = d => Math.max(minW, sp * (1.6 + 2.6 * Math.sqrt(Math.max(0.25, d))));
      for (const b of bars) {
        b.lead = b.cols.length && b.cols[0].T > b.T0 ? w((b.cols[0].T - b.T0) / 4) - sp * 1.5 : 0;
        b.cols.forEach((c, i) => {
          c.w = w(((i + 1 < b.cols.length ? b.cols[i + 1].T : b.T0 + b.ticks) - c.T) / 4);
          if (c.groups.some(g => g.signs && g.signs.some(x => x !== null))) c.w += sp * 0.9;   // room for a sharp/flat/natural
        });
        b.w = b.cols.length ? pad + b.lead + b.cols.reduce((a, c) => a + c.w, 0) : sp * 8;
      }
      const systems = [];
      let cur = null;
      for (const b of bars) {
        const room = lineW - (systems.length === 1 && cur === systems[0] ? tsW : 0);
        if (!cur || (cur.w + b.w > room && cur.bars.length)) { cur = { bars: [], w: 0 }; systems.push(cur); }
        cur.bars.push(b); cur.w += b.w;
      }
      return { sp, clefW, tsW, x0, lineW, pad, systems };
    }
    // size: the whole song on one page if it can be read there, otherwise as many lines per page as stay readable
    let pick = print ? { P: pack(print.sp), rows: 1 } : null, most = null;
    for (let want = 1; want <= 5 && !pick; want++) {
      const sz = Math.max(5, Math.min(12, W / 48, (h - 8) / (want * LINE)));
      if (sz < 8.2 && most) break;
      const P = pack(sz);
      if (P.systems.length <= want) pick = { P, rows: P.systems.length };
      else if (sz >= 8.2 || !most) most = { P, rows: Math.max(1, Math.floor((h - 8) / (LINE * sz))) };
    }
    if (!pick) pick = { P: most.P, rows: most.rows };
    else if (!print) for (let sz = Math.min(12, W / 48); sz > pick.P.sp + 0.2; sz -= 0.25) {   // a song that fits: print it as big as the page allows
      const P = pack(sz);
      if (P.systems.length * LINE * sz <= h - 8) { pick = { P, rows: P.systems.length }; break; }
    }
    pick.P = pack(pick.P.sp);                             // (the trial sizes above left their widths on the bars)
    const { sp, clefW, tsW, x0, lineW, pad, systems } = pick.P, rows = pick.rows;
    systems.forEach((s, i) => {
      const start = x0 + (i === 0 ? tsW : 0), width = lineW - (i === 0 ? tsW : 0);
      const k = i < systems.length - 1 || s.w > width * 0.65 ? width / s.w : Math.min(1.35, width / s.w);
      let x = start;
      s.anchors = [];
      for (const b of s.bars) {
        b.x = x; b.sys = i; let cx = x + (pad + b.lead) * k;
        s.anchors.push({ t: b.t0, x: x + sp * 0.9 });
        for (const c of b.cols) { c.x = cx + (c.w > 0 && c.groups.some(g => g.signs && g.signs.some(x => x !== null)) ? sp * 0.9 * k : 0); c.sys = i; s.anchors.push({ t: c.t, x: c.x }); cx += c.w * k; }
        x += b.w * k; b.end = x;
      }
      s.t0 = s.bars[0].t0; s.t1 = s.bars[s.bars.length - 1].t1; s.end = x;
      s.anchors.push({ t: s.t1, x: x - sp * 0.9 });
      // how far this line's notes reach above the treble staff and below the bass staff (in staff spaces)
      let hiT = 38, loB = 18;
      for (const b of s.bars) for (const c of b.cols) for (const g of c.groups) if (!g.rest) {
        const its = g.chord.items;
        if (g.staff === "t") hiT = Math.max(hiT, its[its.length - 1].step + (g.up ? 7 : 0) + (its.some(i => i.ott > 0) ? 4 : 0));
        else loB = Math.min(loB, its[0].step - (g.up ? 0 : 7) - (its.some(i => i.ott < 0) ? 4 : 0));
      }
      s.above = Math.max(3.6, (hiT - 38) / 2 + 1.6);
      s.below = Math.max(3.9, (18 - loB) / 2 + 1.6 + (song.pedal && song.pedal.length ? 2.6 : 0));
      const row = i % rows, slot = (h - 8) / rows;
      s.trebleTop = top + 4 + row * slot + (slot - 14 * sp) / 2 + sp * 0.4;
      s.trebleBottom = s.trebleTop + 4 * sp; s.bassTop = s.trebleBottom + 6 * sp; s.bassBottom = s.bassTop + 4 * sp;
    });
    sheet = { groups: pieces, beams, flats, key, timeSig, sp, top, bottom, left, right, clefW, systems, rows, pages: Math.ceil(systems.length / rows),
      page: 0, from: 0, turnAt: -1e9, W, kbTop };
  }
  function sheetSystemAt(t) {
    const sys = sheet.systems;
    for (let i = 0; i < sys.length; i++) if (t < sys[i].t1 - 0.02) return i;
    return sys.length - 1;
  }
  function sheetX(s, t) {                                // where time t sits along a line
    const a = s.anchors;
    if (t <= a[0].t) return a[0].x;
    for (let i = 1; i < a.length; i++) if (t <= a[i].t) {
      const p = a[i].t - a[i - 1].t > 1e-6 ? (t - a[i - 1].t) / (a[i].t - a[i - 1].t) : 1;
      return a[i - 1].x + (a[i].x - a[i - 1].x) * p;
    }
    return a[a.length - 1].x;
  }
  function drawSheet() {
    if (!sheet || sheet.W !== W || sheet.kbTop !== kbTop) buildSheet();
    const S = sheet, now = performance.now();
    // the page holding the line being played; turn it when that line moves on
    const curSys = sheetSystemAt(Math.max(0, time));
    const page = Math.floor(curSys / S.rows);
    if (page !== S.page) { S.from = S.page; S.page = page; S.turnAt = now; }
    // paper
    const pg = ctx.createLinearGradient(0, S.top, 0, S.bottom);
    pg.addColorStop(0, "#fbf8f1"); pg.addColorStop(1, "#ece6d8");
    ctx.shadowColor = "rgba(0,0,0,.45)"; ctx.shadowBlur = 18; ctx.shadowOffsetY = 4;
    ctx.fillStyle = pg; rrect(S.left, S.top, S.right - S.left, S.bottom - S.top, 14); ctx.fill();
    ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.save(); rrect(S.left, S.top, S.right - S.left, S.bottom - S.top, 14); ctx.clip();
    const p = reduceMotion ? 1 : Math.min(1, (now - S.turnAt) / 420);
    if (p < 1) {                                          // slide the old page out and the new one in
      const e = 1 - Math.pow(1 - p, 3), dir = S.page > S.from ? 1 : -1, span = S.right - S.left;
      ctx.save(); ctx.translate(-dir * e * span, 0); drawSheetPage(S.from, -1); ctx.restore();
      ctx.save(); ctx.translate(dir * (1 - e) * span, 0); drawSheetPage(S.page, curSys); ctx.restore();
    } else drawSheetPage(S.page, curSys);
    // page number
    if (S.pages > 1) {
      ctx.fillStyle = "rgba(38,42,54,.55)"; ctx.font = `600 ${Math.round(Math.max(11, S.sp * 1.25))}px system-ui, sans-serif`;
      ctx.textAlign = "right"; ctx.fillText(`Page ${S.page + 1} of ${S.pages}`, S.right - 14, S.top + 18);
    }
    ctx.restore();
  }
  let printing = null;                                     // set while drawing the printable sheet music
  function drawSheetPage(page, curSys, list = null) {
    const S = sheet, sp = S.sp, now = performance.now(), INK = printing ? "#000" : "#262a36";
    const target = new Set(!printing && mode() === "practice" && state !== "idle" ? nextGroup().filter(n => n.start - time < 0.02) : []);
    const labels = printing ? printing.labels : ui.labels.value === "notes";
    const rx = sp * (labels ? 0.78 : 0.62), ry = sp * (labels ? 0.56 : 0.44);
    const clefFont = k => `${sp * k}px "Noto Music", "Bravura", "Apple Symbols", "Segoe UI Symbol", "Noto Sans Symbols2", serif`;
    const lastSys = S.systems.length - 1;
    const lines = list || Array.from({ length: Math.max(0, Math.min(S.systems.length, (page + 1) * S.rows) - page * S.rows) }, (_, i) => page * S.rows + i);
    for (const si of lines) {
      const s = S.systems[si];
      const yOf = (staff, step) => staff === "t" ? s.trebleBottom - (step - 30) * sp / 2 : s.bassBottom - (step - 18) * sp / 2;
      const lx = S.left + sp * 2;
      // staff lines, brace, clefs
      ctx.strokeStyle = printing ? "#000" : "rgba(38,42,54,.75)"; ctx.lineWidth = printing ? Math.max(1, sp * 0.1) : 1;
      for (const b of [s.trebleBottom, s.bassBottom]) for (let i = 0; i < 5; i++) {
        const y = Math.round(b - i * sp) + 0.5; ctx.beginPath(); ctx.moveTo(lx, y); ctx.lineTo(s.end, y); ctx.stroke();
      }
      ctx.fillStyle = INK; ctx.fillRect(lx, s.trebleTop, 1.6, s.bassBottom - s.trebleTop);
      ctx.strokeStyle = INK; ctx.lineWidth = sp * 0.32; ctx.beginPath();
      const bx = lx - sp * 0.35, bm = (s.trebleTop + s.bassBottom) / 2;
      ctx.moveTo(bx, s.trebleTop); ctx.quadraticCurveTo(bx - sp * 0.8, (s.trebleTop + bm) / 2, bx - sp * 0.35, bm);
      ctx.quadraticCurveTo(bx - sp * 0.8, (bm + s.bassBottom) / 2, bx, s.bassBottom); ctx.stroke();
      ctx.textAlign = "center"; ctx.textBaseline = "alphabetic"; ctx.fillStyle = INK;
      ctx.font = clefFont(5.6); ctx.fillText("\u{1D11E}", lx + sp * 2.4, s.trebleBottom + sp * 0.9);
      ctx.font = clefFont(3.9); ctx.fillText("\u{1D122}", lx + sp * 2.4, s.bassBottom - sp * 0.75);
      // key signature on every line, time signature on the first
      const ks = Math.sign(S.key);
      ctx.font = `700 ${Math.round(sp * 2.1)}px system-ui, serif`; ctx.textBaseline = "middle";
      for (let i = 0; i < Math.abs(S.key); i++) {
        const x = lx + sp * (5.0 + i * 0.95), st = KEY_STEPS[ks][i];
        ctx.fillText(ks > 0 ? "♯" : "♭", x, yOf("t", st) + (ks > 0 ? 0 : -sp * 0.3));
        ctx.fillText(ks > 0 ? "♯" : "♭", x, yOf("b", st - 14) + (ks > 0 ? 0 : -sp * 0.3));
      }
      ctx.textBaseline = "alphabetic";
      if (si === 0) {
        ctx.font = `700 ${Math.round(sp * 2.85)}px Georgia, "Times New Roman", serif`;
        const x = lx + S.clefW + sp * 0.6;
        for (const y of [s.trebleTop, s.bassTop]) { ctx.fillText(String(S.timeSig), x, y + sp * 2); ctx.fillText("4", x, y + sp * 4); }
      }
      // bar number above the line
      ctx.fillStyle = "rgba(38,42,54,.5)"; ctx.font = `italic 600 ${Math.round(Math.max(9, sp * 1.05))}px system-ui, sans-serif`;
      ctx.textAlign = "left"; ctx.fillText(String(s.bars[0].num), lx, s.trebleTop - sp * 1.2);
      // bar lines (a double bar at the very end)
      // a bar with nothing for one hand gets a whole rest
      ctx.fillStyle = INK;
      for (const b of s.bars) for (const st of ["t", "b"]) if (b.full[st]) {
        const mid = (st === "t" ? s.trebleBottom : s.bassBottom) - 2 * sp;
        ctx.fillRect((b.x + b.end) / 2 - sp * 0.6, mid - sp, sp * 1.2, sp * 0.5);
      }
      ctx.fillStyle = printing ? "#000" : "rgba(38,42,54,.85)";
      const bw = printing ? Math.max(1.4, sp * 0.12) : 1.4;
      for (const b of s.bars) ctx.fillRect(Math.round(b.end) - bw, s.trebleTop, bw, s.bassBottom - s.trebleTop);
      if (si === lastSys) { ctx.fillRect(Math.round(s.end) - 4.5, s.trebleTop, 4.5, s.bassBottom - s.trebleTop); ctx.fillRect(Math.round(s.end) - 8.5, s.trebleTop, 1.4, s.bassBottom - s.trebleTop); }
      // sustain pedal: "Ped." where it goes down, a line while it's held, a tick where it lifts
      if (song.pedal && song.pedal.length) {
        let lowest = 18;                                   // below the lowest note of the line
        let ottLow = false;
        for (const b of s.bars) for (const c of b.cols) for (const g of c.groups) if (!g.rest && g.staff === "b") { lowest = Math.min(lowest, g.chord.items[0].step - (g.up ? 0 : 7)); if (g.chord.items.some(i => i.ott < 0)) ottLow = true; }
        if (ottLow) lowest -= 4;
        const py = Math.min(s.bassBottom + sp * (printing ? 4.4 : 3.8), Math.max(s.bassBottom + sp * 2.7, yOf("b", lowest) + sp * 1.9));
        ctx.strokeStyle = "rgba(38,42,54,.7)"; ctx.fillStyle = "rgba(38,42,54,.75)"; ctx.lineWidth = Math.max(1, sp * 0.12);
        ctx.font = `italic 700 ${Math.round(sp * 1.05)}px Georgia, serif`; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
        // a quick change of pedal is a notch in the line ("lift and press again"), not a new "Ped."
        const ped = [];                                     // (changes squeezed closer than a note's width merge into one)
        for (const [a, b] of song.pedal) {
          if (b <= s.t0 - 1 || a >= s.t1 + 1) continue;
          const l = ped[ped.length - 1];
          if (l && a - l[1] < 0.15 && sheetX(s, a) - sheetX(s, l[2]) < sp * 1.8) l[1] = b; else ped.push([a, b, a]);
        }
        let textEnd = -1e9, notchEnd = null;
        ped.forEach(([a, b], i) => {
          if (b <= s.t0 || a >= s.t1) return;
          const again = i > 0 && a - ped[i - 1][1] < 0.15, next = ped[i + 1] && ped[i + 1][0] - b < 0.15;
          let x0 = sheetX(s, Math.max(a, s.t0)), x1 = sheetX(s, Math.min(b, s.t1));
          if (a >= s.t0 && again) x0 = notchEnd !== null ? notchEnd : x0 + sp * 0.45;
          else if (a >= s.t0 && x0 - sp * 0.4 >= textEnd) { ctx.fillText("Ped.", x0 - sp * 0.4, py + sp * 0.4); x0 += sp * 2.6; textEnd = x0; }
          const end = b <= s.t1;
          if (end && next && b < s.t1 - 0.01) x1 -= sp * 0.45;
          if (x1 > x0) {
            ctx.beginPath(); ctx.moveTo(x0, py); ctx.lineTo(x1, py);
            if (end && next && b < s.t1 - 0.01) { ctx.lineTo(x1 + sp * 0.45, py - sp * 0.9); ctx.lineTo(x1 + sp * 0.9, py); notchEnd = x1 + sp * 0.9; }
            else if (end) ctx.lineTo(x1, py - sp * 0.9);
            ctx.stroke();
          }
        });
      }
      // the "you are here" marker on the line being played
      if (!printing && si === curSys && state !== "idle" && time >= s.t0 - 2) {
        const x = sheetX(s, Math.max(0, time)), y0 = s.trebleTop - sp * 2.2, hh = s.bassBottom - s.trebleTop + sp * 4.4;
        const band = ctx.createLinearGradient(x - sp * 2, 0, x + sp * 2, 0);
        band.addColorStop(0, "rgba(57,182,255,0)"); band.addColorStop(0.5, "rgba(57,182,255,.22)"); band.addColorStop(1, "rgba(57,182,255,0)");
        ctx.fillStyle = band; ctx.fillRect(x - sp * 2, y0, sp * 4, hh);
        ctx.shadowColor = "#39b6ff"; ctx.shadowBlur = 8; ctx.fillStyle = "rgba(31,134,201,.8)";
        ctx.fillRect(x - 1, y0, 2, hh); ctx.shadowBlur = 0;
      }
      // beams: where each beam runs (a straight line over the stems, never shorter than a short stem)
      const beamOf = new Map();
      for (const bm of S.beams) {
        const ps = bm.pieces;
        if (ps[0].col.sys !== si) continue;
        const dir = bm.up ? -1 : 1;
        const pts = ps.map(pc => {
          const its = pc.chord.items, near = bm.up ? its[its.length - 1].step : its[0].step, far = bm.up ? its[0].step : its[its.length - 1].step;
          return { x: pc.col.x + (bm.up ? rx * 0.92 : -rx * 0.92), yn: yOf(pc.staff, near), yf: yOf(pc.staff, far) };
        });
        const f = pts[0], l = pts[pts.length - 1], span = Math.max(1, l.x - f.x);
        let slope = ((l.yn + dir * sp * 3.3) - (f.yn + dir * sp * 3.3)) / span;
        slope = Math.max(-sp * 1.2 / span, Math.min(sp * 1.2 / span, slope));
        const need = ps.some(pc => pc.v === 1) ? sp * 3.1 : sp * 2.7;
        let y0 = f.yn + dir * sp * 3.3;
        for (const q of pts) {                              // push the beam out until every stem is long enough
          const y = y0 + slope * (q.x - f.x);
          if (dir < 0 && y > q.yn - need) y0 -= y - (q.yn - need);
          if (dir > 0 && y < q.yn + need) y0 += (q.yn + need) - y;
        }
        const geo = { at: x => y0 + slope * (x - f.x), dir, pts };
        ps.forEach((pc, i) => beamOf.set(pc, { geo, i }));
        // the beams themselves
        const th = sp * 0.48, col = printing ? INK : ps.every(pc => pc.chord.all.every(n => !isUser(n))) && mode() !== "listen" ? "#9aa0ae" : INK;
        ctx.fillStyle = col;
        const bar = (x1, x2, lvl) => {
          const o = -dir * lvl * sp * 0.78;
          ctx.beginPath(); ctx.moveTo(x1, geo.at(x1) + o); ctx.lineTo(x2, geo.at(x2) + o);
          ctx.lineTo(x2, geo.at(x2) + o - dir * th); ctx.lineTo(x1, geo.at(x1) + o - dir * th); ctx.closePath(); ctx.fill();
        };
        bar(f.x - 0.6, l.x + 0.6, 0);
        ps.forEach((pc, i) => {
          if (pc.v !== 1) return;
          const nx = ps[i + 1], pv = ps[i - 1];
          if (nx && nx.v === 1) bar(pts[i].x - 0.6, pts[i + 1].x + 0.6, 1);
          else if (!(pv && pv.v === 1)) {                   // a lone sixteenth: a short stub toward its neighbour
            const toRight = !!nx && !(pv && pv.v === 3);
            bar(toRight ? pts[i].x : pts[i].x - sp * 1.2, toRight ? pts[i].x + sp * 1.2 : pts[i].x, 1);
          }
        });
      }
      // notes and rests
      for (const b of s.bars) for (const c of b.cols) for (const g of c.groups) {
        const x = c.x;
        const mid = (g.staff === "t" ? s.trebleBottom : s.bassBottom) - 2 * sp;
        if (g.rest) {
          ctx.fillStyle = ctx.strokeStyle = INK; ctx.globalAlpha = !printing && g.start < time - 0.05 && state !== "idle" ? 0.6 : 1;
          if (g.v >= 8) ctx.fillRect(x - sp * 0.6, mid - sp * 0.5, sp * 1.2, sp * 0.5);      // half rest: sits on the middle line
          else {
            ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.beginPath();
            const P = (dx, dy) => [x + dx * sp, mid + dy * sp];
            if (g.v >= 4) {                                                              // quarter rest: the zigzag
              ctx.lineWidth = sp * 0.3;
              ctx.moveTo(...P(-0.35, -1.5)); ctx.lineTo(...P(0.35, -0.65)); ctx.lineTo(...P(-0.2, 0.1)); ctx.lineTo(...P(0.35, 0.85));
              ctx.quadraticCurveTo(...P(-0.55, 0.55), ...P(-0.05, 1.5)); ctx.stroke();
            } else {                                                                     // eighth / sixteenth rest: dots and a slanted stroke
              ctx.lineWidth = sp * 0.16;
              ctx.moveTo(...P(0.5, -0.75)); ctx.lineTo(...P(-0.05, g.v === 1 ? 1.5 : 1.0)); ctx.stroke();
              const hooks = g.v === 1 ? [-0.75, 0.25] : [-0.75];
              for (const hy of hooks) {
                const sx = 0.5 - (hy + 0.75) * 0.34;
                ctx.beginPath(); ctx.moveTo(...P(sx - 0.9, hy + 0.15)); ctx.quadraticCurveTo(...P(sx - 0.45, hy + 0.45), ...P(sx, hy)); ctx.stroke();
                ctx.beginPath(); ctx.arc(...P(sx - 0.85, hy + 0.1), sp * 0.26, 0, Math.PI * 2); ctx.fill();
              }
            }
            ctx.lineCap = "butt"; ctx.lineJoin = "miter";
          }
          ctx.globalAlpha = 1;
          continue;
        }
        const ch = g.chord, its = ch.items, bottomLine = g.staff === "t" ? 30 : 18;
        const isTarget = !g.cont && ch.all.some(n => target.has(n));
        const sounding = !printing && !g.cont && mode() !== "practice" && state !== "idle" && g.start <= time + 0.03 && time < g.start + Math.max(0.25, g.dur * 0.9);
        const past = !printing && !isTarget && !sounding && g.start < time - 0.05 && state !== "idle";
        ctx.strokeStyle = INK; ctx.lineWidth = printing ? Math.max(1.2, sp * 0.1) : 1.2; ctx.globalAlpha = past ? 0.6 : 1;
        const lo = its[0].step, hi = its[its.length - 1].step;
        for (let st = bottomLine - 2; st >= lo; st -= 2) { const y = yOf(g.staff, st); ctx.beginPath(); ctx.moveTo(x - rx * 1.7, y); ctx.lineTo(x + rx * 1.7, y); ctx.stroke(); }
        for (let st = bottomLine + 10; st <= hi; st += 2) { const y = yOf(g.staff, st); ctx.beginPath(); ctx.moveTo(x - rx * 1.7, y); ctx.lineTo(x + rx * 1.7, y); ctx.stroke(); }
        if (isTarget || sounding) {
          const pulse = reduceMotion ? 0.5 : 0.5 + 0.5 * Math.sin(now / 180);
          ctx.fillStyle = `rgba(57,182,255,${0.16 + 0.12 * pulse})`;
          rrect(x - rx * 2.4, yOf(g.staff, hi) - sp * 1.4, rx * 4.8, yOf(g.staff, lo) - yOf(g.staff, hi) + sp * 2.8, sp); ctx.fill();
        }
        let stemColor = INK, signCol = 0, lastSign = 1e9;
        for (let ii = its.length - 1; ii >= 0; ii--) {
          const it = its[ii], n = it.n, user = isUser(n), lit = isTarget && target.has(n) || (sounding && (user || mode() === "listen") && n.state !== "hit" && n.state !== "miss");
          const col = printing ? INK : n.state === "miss" && !g.cont ? "#d43c4f" : n.state === "hit" && user ? "#2e9d5f" : lit ? (n.hand === "left" ? "#d9761a" : "#1f86c9")
            : !user && mode() !== "listen" ? "#9aa0ae" : INK;
          if (ii === its.length - 1 || lit) stemColor = col;
          const hx = x + (it.side ? (g.up ? rx * 1.9 : -rx * 1.9) : 0), y = yOf(g.staff, it.step);
          if (lit) { ctx.shadowColor = col; ctx.shadowBlur = 12; }
          ctx.fillStyle = ctx.strokeStyle = col;
          ctx.save(); ctx.translate(hx, y); ctx.rotate(-0.33); ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
          if (g.open) { ctx.lineWidth = sp * 0.2; ctx.stroke(); } else ctx.fill();
          ctx.restore(); ctx.shadowBlur = 0;
          if (labels) {
            ctx.font = `800 ${Math.round(sp * 0.92)}px system-ui, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.fillStyle = g.open ? col : "#ffffff"; ctx.fillText(it.name, hx, y + 0.5); ctx.textBaseline = "alphabetic";
          }
          const sign = g.signs && g.signs[ii];
          if (sign !== null && sign !== undefined) {           // sharp, flat or natural; stacked ones step to the left
            signCol = lastSign - it.step < 6 ? signCol + 1 : 0; lastSign = it.step;
            const sx = x - rx * 2.3 - (its.some(i => i.side) && !g.up ? rx * 1.9 : 0) - signCol * sp * 1.05;
            ctx.fillStyle = col; ctx.font = `700 ${Math.round(sp * 2.1)}px system-ui, serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.fillText(sign > 0 ? "♯" : sign < 0 ? "♭" : "♮", sx, y + (sign < 0 ? -sp * 0.3 : 0)); ctx.textBaseline = "alphabetic";
          }
          if (g.dot) {
            const dx = x + rx * (its.some(i => i.side) && g.up ? 3.7 : 1.8);
            ctx.fillStyle = col; ctx.beginPath(); ctx.arc(dx + sp * 0.15, y - ((it.step - bottomLine) % 2 === 0 ? sp * 0.5 : 0), sp * 0.17, 0, Math.PI * 2); ctx.fill();
          }
          // ties: a curve to the same note in the next piece (or to the end of the line, picked up again on the next one)
          const tieDir = its.length > 1 ? (ii >= its.length / 2 ? -1 : 1) : (g.up ? 1 : -1);
          const tie = (x1, x2) => {
            const y1 = y + tieDir * sp * 0.45, hgt = tieDir * Math.min(sp * 1.1, sp * 0.4 + (x2 - x1) * 0.08);
            ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(x1, y1);
            ctx.quadraticCurveTo((x1 + x2) / 2, y1 + hgt * 1.25, x2, y1);
            ctx.quadraticCurveTo((x1 + x2) / 2, y1 + hgt * 1.25 - tieDir * sp * 0.28, x1, y1); ctx.fill();
          };
          if (g.tie) tie(hx + rx * 1.15 + (g.dot ? sp * 0.7 : 0), g.tie.col.sys === c.sys ? g.tie.col.x - rx * 1.15 : s.end - sp * 0.4);
          if (g.cont && g.prev.col.sys !== c.sys) tie(lx + S.clefW + sp * 0.6, hx - rx * 1.15);
        }
        if (g.stem) {
          const bm = beamOf.get(g);
          const sx = g.up ? x + rx * 0.92 : x - rx * 0.92;
          const yLo = yOf(g.staff, lo), yHi = yOf(g.staff, hi);
          const y0 = g.up ? yLo : yHi;
          const yEnd = bm ? bm.geo.at(sx) : g.up ? Math.min(yHi - sp * 3.4, mid) : Math.max(yLo + sp * 3.4, mid);
          ctx.strokeStyle = stemColor; ctx.lineWidth = Math.max(1.2, sp * 0.12);
          ctx.beginPath(); ctx.moveTo(sx, y0); ctx.lineTo(sx, yEnd); ctx.stroke();
          if (!bm) {
            ctx.lineWidth = Math.max(1.5, sp * 0.22);
            for (let f = 0; f < g.flags; f++) {
              const fy = yEnd + (g.up ? 1 : -1) * f * sp * 0.8;
              ctx.beginPath(); ctx.moveTo(sx, fy);
              ctx.bezierCurveTo(sx + sp * 0.2, fy + (g.up ? 1 : -1) * sp * 0.9, sx + sp * 1.3, fy + (g.up ? 1 : -1) * sp * 1.2, sx + sp * 0.9, fy + (g.up ? 1 : -1) * sp * 2.2);
              ctx.stroke();
            }
          }
        }
        ctx.globalAlpha = 1;
      }
      // 8va / 8vb: one dashed bracket over each stretch of notes written an octave nearer the staff
      for (const [st, dir] of [["b", -1], ["t", 1]]) {
        let run = null;
        const flush = () => {
          if (!run) return;
          const y = run.y + dir * -1 * 0;                     // (already placed clear of the notes)
          ctx.strokeStyle = ctx.fillStyle = INK; ctx.lineWidth = Math.max(1, sp * 0.1);
          ctx.font = `italic 700 ${Math.round(sp * 1.2)}px Georgia, serif`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
          const label = dir < 0 ? "8vb" : "8va", tw = ctx.measureText(label).width;
          ctx.fillText(label, run.x0 - sp * 0.8, y);
          ctx.setLineDash([sp * 0.5, sp * 0.45]); ctx.beginPath(); ctx.moveTo(run.x0 - sp * 0.8 + tw + sp * 0.3, y); ctx.lineTo(run.x1 + sp * 0.9, y); ctx.stroke(); ctx.setLineDash([]);
          ctx.beginPath(); ctx.moveTo(run.x1 + sp * 0.9, y); ctx.lineTo(run.x1 + sp * 0.9, y - dir * sp * 0.9); ctx.stroke();
          ctx.textBaseline = "alphabetic"; run = null;
        };
        for (const b of s.bars) for (const c of b.cols) {
          const gs = c.groups.filter(g => !g.rest && g.staff === st);
          if (!gs.length) continue;
          const hit = gs.some(g => g.chord.items.some(i => i.ott === dir));
          if (!hit) { flush(); continue; }
          let y = dir < 0 ? -Infinity : Infinity;
          for (const g of gs) {
            const its = g.chord.items;
            if (dir < 0) y = Math.max(y, yOf(st, its[0].step) + (g.up ? 0 : sp * 3.4) + sp * 1.5, s.bassBottom + sp * 1.6);
            else y = Math.min(y, yOf(st, its[its.length - 1].step) - (g.up ? sp * 3.4 : 0) - sp * 1.5, s.trebleTop - sp * 1.6);
          }
          if (run) { run.x1 = c.x; run.y = dir < 0 ? Math.max(run.y, y) : Math.min(run.y, y); }
          else run = { x0: c.x, x1: c.x, y };
        }
        flush();
      }
    }
  }

  // ---------- Printable sheet music: letter-size pages, black on white, as a PDF to download or to print ----------
  const PAGE_W = 1700, PAGE_H = 2200, MARGIN = 130, PSP = 13;       // 8.5 × 11 in at 200 dots an inch; staff 6.6 mm tall
  function printPages(labels, meta = {}) {
    const saved = { ctx, sheet, W, kbTop, printing };
    const pages = [];
    try {
      sheet = null; W = PAGE_W;
      buildSheet({ left: MARGIN - 20, right: PAGE_W - MARGIN, sp: PSP });
      const S = sheet, def = song.def, sp = PSP, slot = 21.5 * sp, head = 300, foot = 90;
      // the lines, page by page (the first page starts lower, under the title)
      let page = -1, y = Infinity, list = [];
      const layout = [];
      S.systems.forEach((sys, i) => {
        const bottom = PAGE_H - MARGIN - foot, need = Math.max(slot, (sys.above + 14 + sys.below + 1) * sp);   // room for its high and low notes
        if (y + need > bottom) { page++; y = MARGIN + (page === 0 ? head : 0); layout.push([]); }
        sys.trebleTop = y + Math.max(3.6, sys.above) * sp; sys.trebleBottom = sys.trebleTop + 4 * sp; sys.bassTop = sys.trebleBottom + 6 * sp; sys.bassBottom = sys.bassTop + 4 * sp;
        layout[page].push(i); y += need;
      });
      printing = { labels };
      const bpm = Math.round(60 / (song.beat || 0.5));
      layout.forEach((lines, pi) => {
        const cv = document.createElement("canvas"); cv.width = PAGE_W; cv.height = PAGE_H;
        ctx = cv.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, PAGE_W, PAGE_H);
        if (pi === 0) {
          ctx.fillStyle = "#000"; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
          ctx.font = `700 64px Georgia, "Times New Roman", serif`; ctx.fillText(meta.title || def.title, PAGE_W / 2, MARGIN + 70, PAGE_W - 2 * MARGIN);
          const level = { easy: "Easy", medium: "Medium", hard: "", extra: "Extra hard", insane: "Extra extra hard" }[ui.level.value] || "";
          ctx.font = `italic 30px Georgia, "Times New Roman", serif`;
          ctx.fillText([level && level + " version", "for piano"].filter(Boolean).join(" "), PAGE_W / 2, MARGIN + 120);
          ctx.textAlign = "right"; ctx.font = `30px Georgia, "Times New Roman", serif`;
          ctx.fillText(meta.by !== undefined ? meta.by : defaultBy(def), PAGE_W - MARGIN, MARGIN + 190, PAGE_W / 2 - MARGIN);
          const qy = MARGIN + 250, qx = MARGIN + 10;                     // the tempo: a quarter note = beats a minute
          ctx.save(); ctx.translate(qx, qy - 6); ctx.rotate(-0.33); ctx.beginPath(); ctx.ellipse(0, 0, 10, 7, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
          ctx.fillRect(qx + 7, qy - 46, 2.6, 40);
          ctx.textAlign = "left"; ctx.font = `700 30px Georgia, "Times New Roman", serif`;
          ctx.fillText("= " + bpm, qx + 26, qy);
        }
        drawSheetPage(null, -1, lines);
        ctx.fillStyle = "#555"; ctx.textAlign = "center"; ctx.font = `24px Georgia, "Times New Roman", serif`;
        ctx.fillText(`${pi + 1} / ${layout.length}`, PAGE_W / 2, PAGE_H - MARGIN + 40);
        pages.push(cv);
      });
    } finally {
      ({ ctx, sheet, W, kbTop, printing } = saved);
    }
    return pages;
  }
  // a PDF holding each page as a JPEG picture, written by hand (no library needed)
  function pdfFromPages(pages) {
    const enc = new TextEncoder(), chunks = [], offsets = [];
    let size = 0;
    const put = x => { const b = typeof x === "string" ? enc.encode(x) : x; chunks.push(b); size += b.length; };
    const obj = (n, body) => { offsets[n] = size; put(`${n} 0 obj\n`); body(); put("\nendobj\n"); };
    put("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
    const n = pages.length, kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(" ");
    obj(1, () => put("<< /Type /Catalog /Pages 2 0 R >>"));
    obj(2, () => put(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`));
    pages.forEach((cv, i) => {
      const jpg = atob(cv.toDataURL("image/jpeg", 0.9).split(",")[1]), img = new Uint8Array(jpg.length);
      for (let k = 0; k < jpg.length; k++) img[k] = jpg.charCodeAt(k);
      const p = 3 + i * 3, c = p + 1, im = p + 2, draw = "q 612 0 0 792 0 0 cm /Im0 Do Q";
      obj(p, () => put(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 ${im} 0 R >> >> /Contents ${c} 0 R >>`));
      obj(c, () => put(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`));
      obj(im, () => { put(`<< /Type /XObject /Subtype /Image /Width ${cv.width} /Height ${cv.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.length} >>\nstream\n`); put(img); put("\nendstream"); });
    });
    const xref = size, count = 3 + n * 3;
    put(`xref\n0 ${count}\n0000000000 65535 f \n`);
    for (let k = 1; k < count; k++) put(String(offsets[k]).padStart(10, "0") + " 00000 n \n");
    put(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(chunks, { type: "application/pdf" });
  }
  let printed = null, printedPdf = null;
  const defaultBy = def => def.notes ? (def.by === "Imported" ? "From a MIDI file" : "Arranged by Keyfall from a recording" + (def.model ? " (" + def.model + ")" : "")) : def.by || "";
  function openPrintView() {
    const view = $("printView"), box = $("printPages"), def = song.def, key = "keyfall:printname:" + def.title;
    // your own title and name on the page (remembered for this song)
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(key) || "{}") || {}; } catch (e) {}
    $("printTitle").value = saved.title || def.title;
    $("printBy").value = saved.by !== undefined ? saved.by : defaultBy(def);
    const meta = () => ({ title: $("printTitle").value.trim() || def.title, by: $("printBy").value.trim() });
    let typing = 0;
    $("printTitle").oninput = $("printBy").oninput = () => {
      try { localStorage.setItem(key, JSON.stringify(meta())); } catch (e) {}
      clearTimeout(typing); typing = setTimeout(render, 450);
    };
    const render = () => {
      box.textContent = "";
      printed = printPages($("printNames").checked, meta());
      for (const cv of printed) { const img = new Image(); img.src = cv.toDataURL("image/png"); img.alt = "Sheet music page"; box.append(img); }
      printedPdf = null;                                             // made shortly after, ready for Print / Download
      const these = printed;
      setTimeout(() => { if (printed === these && !printedPdf) printedPdf = pdfFromPages(printed); }, 700);
      $("printInfo").textContent = `${printed.length} page${printed.length > 1 ? "s" : ""} · ${{ easy: "Easy", medium: "Medium", hard: "Hard", extra: "Extra hard", insane: "Extra extra hard" }[ui.level.value]} version (change it on the start card)`;
    };
    $("printNames").onchange = render;
    $("printClose").onclick = () => { view.hidden = true; box.textContent = ""; printed = printedPdf = null; };
    const fileName = () => meta().title.replace(/[\\/:*?"<>|]+/g, " ").trim() + ".pdf";
    const pdf = () => printedPdf || (printedPdf = pdfFromPages(printed));
    $("printPdf").onclick = () => {
      const url = URL.createObjectURL(pdf()), a = document.createElement("a");
      a.href = url; a.download = fileName();
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    };
    // Printing the web page itself lets the browser add the website's address, the date and its own margins, and a
    // full-size page that no longer fits spills onto an extra sheet. So on an iPad or iPhone, Print hands the
    // finished PDF to the share sheet (tap Print there): exactly one sheet per page, nothing added. Elsewhere it
    // prints the page, sized to fit inside whatever margins the browser keeps.
    $("printNow").onclick = async () => {
      if (appleMobile && navigator.canShare) {
        const file = new File([pdf()], fileName(), { type: "application/pdf" });
        if (navigator.canShare({ files: [file] })) {
          try { await navigator.share({ files: [file] }); return; }
          catch (e) { if (e && e.name === "AbortError") return; console.warn("share:", e); }
        }
      }
      if (appleMobile) {                                              // no share sheet: open the PDF, print it from there
        const url = URL.createObjectURL(pdf());
        if (window.open(url, "_blank")) { setTimeout(() => URL.revokeObjectURL(url), 120000); return; }
      }
      window.print();
    };
    view.hidden = false;
    setTimeout(render, 30);
  }
  $("printBtn").onclick = () => { if (song) openPrintView(); };
  window.__keyfallPrint = { printPages, pdfFromPages };              // (for automated tests)

  const keyDepth = new Map();                        // how far down each key is (0 up … 1 down), eased
  let lastDraw = 0, drawDt = 0, ambient = 0;
  function draw() {
    if (!grad) grad = gradients();
    const now = performance.now();
    drawDt = lastDraw ? Math.min(0.05, (now - lastDraw) / 1000) : 0.016; lastDraw = now;
    ctx.fillStyle = red ? "#000" : grad.bg; ctx.fillRect(0, 0, W, kbTop);
    if (red) {                                        // light from the playing keys spills over the dark stage
      const n = sounding().size;
      ambient += ((n ? Math.min(1, 0.45 + n * 0.15) : 0) - ambient) * Math.min(1, drawDt * (n ? 10 : 2.5));
      if (ambient > 0.01) {
        const am = ctx.createLinearGradient(0, kbTop, 0, kbTop - kbTop * 0.4);
        am.addColorStop(0, `rgba(255,36,72,${0.16 * ambient})`); am.addColorStop(1, "rgba(255,36,72,0)");
        ctx.fillStyle = am; ctx.fillRect(0, kbTop * 0.6, W, kbTop * 0.4);
      }
    }
    // lane guides at each C
    ctx.strokeStyle = red ? "rgba(255,255,255,.045)" : "rgba(127,212,255,.06)"; ctx.lineWidth = 1;
    if (!(song && !drill && !train && !rec && ui.view.value === "sheet")) for (const k of keys) if (!k.black && k.midi % 12 === 0) {
      ctx.beginPath(); ctx.moveTo(k.x + 0.5, 0); ctx.lineTo(k.x + 0.5, kbTop); ctx.stroke();
    }
    // light beams rising from keys that were just hit
    for (let i = beams.length - 1; i >= 0; i--) {
      const bm = beams[i], a = (now - bm.t) / 420;
      if (a >= 1) { beams.splice(i, 1); continue; }
      const gr = ctx.createLinearGradient(0, kbTop, 0, kbTop - kbTop * 0.55);
      gr.addColorStop(0, bm.color); gr.addColorStop(1, "rgba(0,0,0,0)");
      ctx.globalAlpha = 0.45 * (1 - a); ctx.fillStyle = gr;
      ctx.fillRect(bm.x - bm.w * (0.5 + a * 0.4), kbTop - kbTop * 0.55, bm.w * (1 + a * 0.8), kbTop * 0.55);
    }
    ctx.globalAlpha = 1;
    // falling notes (or the sheet music)
    const sheetView = song && !drill && !train && !rec && ui.view.value === "sheet";
    if (sheetView) drawSheet();
    if (song && !drill && !train && !rec) {
      const pps = kbTop / LOOKAHEAD;
      if (!sheetView) for (const n of song.notes) {
        if (n.start - time > LOOKAHEAD) break;
        if (n.start + n.dur < time || n.midi < LOW || n.midi > HIGH) continue;
        const k = keyOf(n.midi), inset = k.black ? 0 : k.w * 0.14;
        const yb = kbTop - (n.start - time) * pps, h = Math.max(n.dur * pps - 3, 8);
        const user = isUser(n);
        ctx.globalAlpha = n.state === "hit" ? 0.35 : user || mode() === "listen" ? 1 : red ? 0.45 : 0.5;
        const base = n.state === "miss" ? "#e2495b" : COLORS[n.hand], x0 = k.x + inset, w0 = k.w - inset * 2;
        const near = user && n.state === "pending" && n.start - time < 0.35 && n.start + n.dur > time;
        if (red) {                                       // a glowing bar of red light: soft halo, bright core
          const a0 = ctx.globalAlpha, c = n.state === "miss" ? "#7a2a36" : base, top = Math.max(-20, yb - h);
          ctx.globalCompositeOperation = "lighter"; ctx.fillStyle = c;
          ctx.globalAlpha = a0 * 0.09; rrect(x0 - 8, top - 8, w0 + 16, yb - top + 16, 12); ctx.fill();
          ctx.globalAlpha = a0 * 0.2; rrect(x0 - 3.5, top - 3.5, w0 + 7, yb - top + 7, 9); ctx.fill();
          ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = a0;
          if (near) { ctx.shadowColor = c; ctx.shadowBlur = 24; }
          const gr = ctx.createLinearGradient(x0, 0, x0 + w0, 0);
          gr.addColorStop(0, c); gr.addColorStop(0.5, n.state === "miss" ? c : n.hand === "left" ? "#ff4a70" : "#ff5c76"); gr.addColorStop(1, c);
          ctx.fillStyle = gr; rrect(x0, yb - h, w0, h, Math.min(6, w0 / 2)); ctx.fill();
          ctx.shadowBlur = 0;
          if (n.state !== "miss") {                      // the white-hot middle
            const core = ctx.createLinearGradient(x0, 0, x0 + w0, 0);
            core.addColorStop(0.2, "rgba(255,210,220,0)"); core.addColorStop(0.5, "rgba(255,215,225,.45)"); core.addColorStop(0.8, "rgba(255,210,220,0)");
            ctx.fillStyle = core; rrect(x0 + 2, yb - h + 3, w0 - 4, Math.max(2, h - 6), 3); ctx.fill();
          }
          if (k.black) { ctx.fillStyle = "rgba(0,0,0,.18)"; rrect(x0, yb - h, w0, h, Math.min(6, w0 / 2)); ctx.fill(); }
        } else {
        if (near) { ctx.shadowColor = base; ctx.shadowBlur = 16; }
        const gr = ctx.createLinearGradient(x0, 0, x0 + w0, 0);
        gr.addColorStop(0, LIGHT[base] || base); gr.addColorStop(0.55, base); gr.addColorStop(1, DARK[base] || base);
        ctx.fillStyle = gr; rrect(x0, yb - h, w0, h, 6); ctx.fill();
        ctx.shadowBlur = 0;
        if (k.black) { ctx.fillStyle = "rgba(0,0,0,.25)"; ctx.fill(); }
        ctx.fillStyle = "rgba(255,255,255,.28)";           // glossy highlight down the left edge
        rrect(x0 + 2, yb - h + 2, Math.max(2, w0 * 0.22), h - 4, 3); ctx.fill();
        }
        const bw = k.w - inset * 2;
        if (user && bw >= 14 && h >= 18 && n.state !== "hit") {          // the note's name at the bottom of its bar
          ctx.fillStyle = "rgba(255,255,255,.92)"; ctx.textAlign = "center";
          ctx.font = `700 ${Math.max(9, Math.min(13, bw * 0.48))}px system-ui, sans-serif`;
          ctx.fillText(bw >= 24 ? nm(n.midi) : NAMES[n.midi % 12], k.x + k.w / 2, yb - 6);
        }
      }
      ctx.globalAlpha = 1;
      // practice mode: say which notes it is waiting for
      if (mode() === "practice" && state === "running") {
        const g = nextGroup();
        if (g.length && g[0].start - time < 0.02) {
          const txt = "Play " + g.map(n => nm(n.midi)).join(" + ");
          ctx.font = "700 20px system-ui, sans-serif";
          const tw = ctx.measureText(txt).width + 32, cx = W / 2, cy = 34;
          ctx.fillStyle = red ? "rgba(10,14,12,.88)" : "rgba(27,30,42,.92)"; rrect(cx - tw / 2, cy - 22, tw, 40, 20); ctx.fill();
          ctx.shadowColor = "#5fd38a"; ctx.shadowBlur = 12; ctx.strokeStyle = "#5fd38a"; ctx.lineWidth = 1.5; ctx.stroke(); ctx.shadowBlur = 0;
          ctx.fillStyle = "#a8f0c0"; ctx.textAlign = "center"; ctx.fillText(txt, cx, cy + 5);
        }
      }
    }
    // the sustain pedal, lit while it's down
    if (song && !drill && !train && !rec && song.pedal && song.pedal.length) {
      const on = state !== "idle" && pedalDown(time), x = W - 74, y = ui.view.value === "sheet" && sheet ? sheet.top - 30 : kbTop - 34;
      ctx.fillStyle = on ? "rgba(255,198,92,.95)" : "rgba(255,255,255,.08)";
      if (on) { ctx.shadowColor = "#ffc65c"; ctx.shadowBlur = 14; }
      rrect(x, y, 62, 24, 12); ctx.fill(); ctx.shadowBlur = 0;
      ctx.fillStyle = on ? "#2a1d05" : "rgba(255,255,255,.45)"; ctx.font = "italic 700 14px Georgia, serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("Ped.", x + 31, y + 12.5); ctx.textBaseline = "alphabetic";
    }
    // keyboard
    ctx.fillStyle = "#07080c"; ctx.fillRect(0, kbTop - 3, W, H - kbTop + 3);
    const target = new Set();
    if (song && state !== "idle" && mode() === "practice") nextGroup().forEach(n => {
      if (n.start - time < 0.01) target.add(n.midi);
    });
    if (drill && drill.tries >= 2 && !drill.done) target.add(drill.target.midi);
    if (train && train.phase === "keys") target.add(train.keys[train.i]);
    const lab = train ? "notes" : drill ? (ui.dNames.checked ? "notes" : "off") : ui.labels.value;
    const badKey = drill && drill.wrongKey !== null && performance.now() - drill.wrongAt < 450 ? drill.wrongKey : -1;
    ctx.textAlign = "center";
    for (const pass of [false, true]) for (const k of keys) {
      if (k.black !== pass) continue;
      const on = down.has(k.midi) || autoDown.has(k.midi) || mic.note === k.midi;
      const learned = train && train.data.keys[k.midi];
      const flash = wrongs.some(w => w.midi === k.midi && now - w.t < 350);
      // a played key moves down like a real one (no colour); hints still tint it: green = play this, red/grey = wrong key
      let d = keyDepth.get(k.midi) || 0;
      const want = on ? 1 : 0;
      if (d !== want) { d += (want - d) * Math.min(1, drawDt / 0.03); if (Math.abs(want - d) < 0.03) d = want; keyDepth.set(k.midi, d); }
      const hint = k.midi === badKey || flash ? (red ? "#b0b4c8" : "#ff6b7d") : target.has(k.midi) ? (pass ? "#2e9d5f" : "#8fe9b0")
        : learned ? (pass ? "#34507a" : "#cfe2fb") : null;
      const kx = k.x + (pass ? 0 : 1), kw = k.w - (pass ? 0 : 2);
      if (!pass) {
        const top = kbTop - 2 + d * 3, bottom = kbTop + k.h - 3 + d * 2, lip = 6 * (1 - d);   // the front edge shows until the key is down
        if (hint && target.has(k.midi)) { ctx.shadowColor = hint; ctx.shadowBlur = 14; }
        ctx.fillStyle = hint ? keyFill(hint, k) : grad.white;
        rrect(kx, top, kw, bottom - top, 5); ctx.fill();
        ctx.shadowBlur = 0;
        if (lip > 0.5) { ctx.fillStyle = grad.lip; ctx.fillRect(kx + 1, bottom - lip, kw - 2, lip); }
        if (d > 0) {                                     // down between its neighbours: in their shadow at the top and sides
          const sh = ctx.createLinearGradient(0, top, 0, top + k.h * 0.45);
          sh.addColorStop(0, `rgba(0,0,0,${0.42 * d})`); sh.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = sh; ctx.fillRect(kx, top, kw, k.h * 0.45);
          ctx.fillStyle = `rgba(0,0,0,${0.22 * d})`; ctx.fillRect(kx, top, 2, bottom - top); ctx.fillRect(kx + kw - 2, top, 2, bottom - top);
        } else if (!hint) { ctx.fillStyle = "rgba(0,0,0,.05)"; ctx.fillRect(kx + kw - 1, kbTop, 1, k.h - 3); }
      } else {
        const bh = k.h + d * 2, face = bh * (0.11 - 0.07 * d);                  // the sloped front shrinks as it goes down
        ctx.fillStyle = "rgba(0,0,0,.45)"; rrect(kx - 1.5, kbTop - 2, kw + 3, bh + 4, 3); ctx.fill();   // its shadow on the white keys
        ctx.fillStyle = hint ? keyFill(hint, k) : grad.black;
        rrect(kx, kbTop - 2 + d * 2, kw, bh, 3); ctx.fill();
        if (!hint) {
          ctx.fillStyle = `rgba(255,255,255,${0.13 - 0.07 * d})`;      // a polished bevel catching the light
          rrect(kx + kw * 0.14, kbTop + 4 + d * 3, kw * 0.72, (bh - face) * 0.82, 2); ctx.fill();
          ctx.fillStyle = grad.face; ctx.fillRect(kx + 1, kbTop - 2 + d * 2 + bh - face, kw - 2, face);
        }
        if (d > 0) { ctx.fillStyle = `rgba(0,0,0,${0.3 * d})`; rrect(kx, kbTop - 2 + d * 2, kw, bh, 3); ctx.fill(); }
      }
      if (lab === "off") continue;
      const text = lab === "keys" ? KEYLABEL[k.midi] : (pass ? "" : NAMES[k.midi % 12] + (k.midi % 12 === 0 ? Math.floor(k.midi / 12) - 1 : ""));
      if (!text || k.w < 11) continue;
      ctx.font = `${Math.max(9, Math.min(13, k.w * 0.55))}px system-ui, sans-serif`;
      ctx.fillStyle = pass ? "#9aa0b8" : "#5a6078";
      ctx.fillText(text, k.x + k.w / 2, kbTop + k.h - 10 + (keyDepth.get(k.midi) || 0) * 2);
    }
    ctx.fillStyle = grad.shade; ctx.fillRect(0, kbTop, W, 14);     // shadow under the rail
    // the hit line: a glowing rail the notes land on
    const rail = red ? "#ff2448" : "#7fd4ff";
    ctx.shadowColor = rail; ctx.shadowBlur = 12;
    ctx.fillStyle = rail; ctx.fillRect(0, kbTop - 3, W, 2);
    ctx.shadowBlur = 0;
    if (red) { ctx.fillStyle = "rgba(255,200,210,.55)"; ctx.fillRect(0, kbTop - 2.5, W, 1); }
    // a flare of light where each sounding key meets the notes: a hot core and a thin streak along the rail
    ctx.globalCompositeOperation = "lighter";
    for (const m of sounding()) {
      if (m < LOW || m > HIGH) continue;
      const k = keyOf(m), x = k.x + k.w / 2, y = kbTop - 3, r = Math.max(14, k.w * 1.7), c = COLORS[m < 60 ? "left" : "right"];
      const fl = ctx.createRadialGradient(x, y, 0, x, y, r);
      fl.addColorStop(0, "rgba(255,255,255,.9)"); fl.addColorStop(0.2, red ? "rgba(255,170,185,.6)" : "rgba(200,235,255,.6)");
      fl.addColorStop(0.5, c + "40"); fl.addColorStop(1, c + "00");
      ctx.fillStyle = fl; ctx.fillRect(x - r, y - r, r * 2, r * 2);
      const sw = Math.max(60, k.w * 5), st = ctx.createLinearGradient(x - sw, 0, x + sw, 0);
      st.addColorStop(0, c + "00"); st.addColorStop(0.5, "rgba(255,235,240,.75)"); st.addColorStop(1, c + "00");
      ctx.fillStyle = st; ctx.fillRect(x - sw, y - 1.5, sw * 2, 3);
    }
    ctx.globalCompositeOperation = "source-over";
    // sparks from hits
    for (let i = particles.length - 1; i >= 0; i--) {
      const pt = particles[i], a = (now - pt.t) / pt.life;
      if (a >= 1) { particles.splice(i, 1); continue; }
      const t = (now - pt.t) / 1000;
      const px = pt.x + pt.vx * t + (pt.g < 0 ? Math.sin(t * 2.5 + pt.y) * 14 : 0), py = pt.y + pt.vy * t + (pt.g ?? 260) * t * t, r = pt.r * (1 - a * 0.4);
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = (1 - a) * 0.35; ctx.fillStyle = pt.c;                 // soft halo
      ctx.beginPath(); ctx.arc(px, py, r * 3, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1 - a;                                                  // bright core
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    if (wrongs.length && now - wrongs[0].t > 400) wrongs.shift();
    if (drill) drawStaff();
    if (train) drawTraining();
    if (rec) drawRecording();
    // hit feedback

    ctx.textAlign = "center";
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i], a = (now - f.t) / 750;
      if (a >= 1 || f.midi < LOW || f.midi > HIGH) { flashes.splice(i, 1); continue; }
      const k = keyOf(f.midi), pop = 1 + 0.3 * Math.max(0, 1 - a * 6), perfect = f.text === "Perfect";
      const x = Math.min(W - 50, Math.max(50, k.x + k.w / 2)), y = kbTop - 44 - a * 46;
      ctx.globalAlpha = 1 - a * a * a;
      ctx.font = `800 ${Math.round(17 * pop)}px system-ui, sans-serif`;
      ctx.lineJoin = "round"; ctx.lineWidth = 4; ctx.strokeStyle = "rgba(0,0,0,.75)"; ctx.strokeText(f.text.toUpperCase(), x, y);
      ctx.shadowColor = red ? "#ff2448" : perfect ? "#5fd38a" : "#ffb02e"; ctx.shadowBlur = 14;
      ctx.fillStyle = red ? (perfect ? "#ffffff" : "#ffb3c0") : perfect ? "#c8ffd8" : "#ffe08a";
      ctx.fillText(f.text.toUpperCase(), x, y); ctx.shadowBlur = 0;
    }
    if (streak >= 5 && streakAt && now - streakAt < 1100) {
      const a = (now - streakAt) / 1100, pop = 1 + 0.35 * Math.max(0, 1 - a * 5);
      ctx.globalAlpha = a < 0.75 ? 1 : 1 - (a - 0.75) / 0.25;
      ctx.font = `900 ${Math.round(40 * pop)}px system-ui, sans-serif`;
      ctx.shadowColor = red ? "#ff2448" : "#ff9f43"; ctx.shadowBlur = 28;
      ctx.fillStyle = "#fff"; ctx.fillText(`${streak} IN A ROW`, W / 2, kbTop * 0.4);
      ctx.shadowBlur = 0; ctx.font = "700 15px system-ui, sans-serif"; ctx.fillStyle = red ? "#ff8a9c" : "#ffcc4d";
      ctx.fillText("🔥 STREAK", W / 2, kbTop * 0.4 - 46 * pop);
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    // microphone button: live level (how far the sound is above the room's background) and the note heard
    if (mic.on) {
      const above = (mic.db ?? -200) - (mic.roomDb ?? 0), lv = Math.max(0, Math.min(1, above / 40));
      ui.micLvl.style.width = (lv * 100).toFixed(1) + "%";
      const st = window.KeyfallML ? KeyfallML.state : "off";
      const t = st === "loading" ? "🎤 Loading AI…" : (mic.note != null ? "🎤 Hearing " + nm(mic.note) : "🎤 Listening") + (st === "on" ? " · AI" : "");
      if (ui.micText.textContent !== t) ui.micText.textContent = t;
      ui.mic.classList.toggle("warn", !!mic.filtered);
      ui.mic.title = mic.filtered ? "The device is filtering the microphone, which can hide soft notes" : "Listening to your piano. Tap to stop.";
    } else if (ui.micLvl.style.width !== "0%") ui.micLvl.style.width = "0%";
    ui.prog.style.width = song && !drill && !train && !rec ? Math.max(0, Math.min(100, time / song.end * 100)).toFixed(1) + "%" : "0%";
    // countdown / progress
    if (song && state !== "idle" && !train) {
      if (time < 0 && state === "running") {
        const c = Math.ceil(-time), f = -time - Math.floor(-time);         // each number pops in and fades
        ctx.font = `900 ${Math.round(70 + 40 * f)}px system-ui, sans-serif`; ctx.globalAlpha = 0.2 + 0.7 * f;
        ctx.shadowColor = red ? "#ff2448" : "#39b6ff"; ctx.shadowBlur = 30; ctx.fillStyle = "#fff";
        ctx.fillText(c, W / 2, kbTop / 2); ctx.shadowBlur = 0; ctx.globalAlpha = 1;
      }

    }
  }

  let last = performance.now();
  function sounding() {                               // keys making sound right now: yours and the app's
    const s = new Set(down); autoDown.forEach((_, m) => s.add(m)); return s;
  }
  function glitter(dt) {
    if (reduceMotion || !keys.length || !$("home").hidden || (song && ui.view.value === "sheet" && !drill && !train && !rec)) return;
    for (const m of sounding()) {
      if (m < LOW || m > HIGH) continue;
      const k = keyOf(m), x = k.x + k.w / 2, c = COLORS[m < 60 ? "left" : "right"];
      if (fx) { try { fx.emit(x, kbTop - 3, c, k.w, dt, 220, m); } catch (e) {} continue; }
      if (Math.random() < 14 * dt) particles.push({ x: x + (Math.random() - 0.5) * k.w * 0.8, y: kbTop - 4, vx: (Math.random() - 0.5) * 30,
        vy: -(40 + Math.random() * 90), g: -8, life: 900 + Math.random() * 900, t: performance.now(), r: 0.8 + Math.random() * 1.6, c: Math.random() < 0.45 ? "#ffffff" : c });
    }
  }
  const perf = { n: 0, sum: 0 };
  function frame(now) {
    micTick();
    const dt = Math.min((now - last) / 1000, 0.1);
    if (state === "running" && !document.hidden && ui.sharp.value === "ultra" && !perf.auto) {   // too slow for Ultra: drop back
      perf.n++; perf.sum += dt;
      if (perf.n >= 120) {
        if (perf.sum / perf.n > 1 / 40) { perf.auto = true; ui.sharp.value = "standard"; $("sharpNote").textContent = "(set to Standard: this device was too slow for Ultra)"; layout(); }
        perf.n = 0; perf.sum = 0;
      }
    }
    step(dt); last = now;
    glitter(dt);
    draw();
    requestAnimationFrame(frame);
  }

  // ---------- Input ----------
  window.addEventListener("keydown", e => {
    if (e.ctrlKey || e.metaKey || e.altKey || /^(SELECT|INPUT)$/.test(e.target.tagName) && e.key !== " ") return;
    if (e.key === " ") { e.preventDefault(); if (!e.repeat && $("home").hidden && !drill && !train && !rec) toggle(); return; }
    const m = KEYMAP[e.key.toLowerCase()];
    if (m === undefined) return;
    e.preventDefault();
    if (!e.repeat) press(m, 0.8);
  });
  window.addEventListener("keyup", e => {
    const m = KEYMAP[e.key.toLowerCase()];
    if (m !== undefined) release(m);
  });
  window.addEventListener("blur", () => [...down].forEach(release));

  const pointers = new Map();
  function keyAt(e) {
    const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (y < kbTop) return null;
    const hit = black => keys.find(k => k.black === black && x >= k.x && x < k.x + k.w && y < kbTop + k.h);
    const k = hit(true) || hit(false);
    return k ? k.midi : null;
  }
  function pointerMove(e) {
    if (!pointers.has(e.pointerId)) return;
    const m = keyAt(e), prev = pointers.get(e.pointerId);
    if (m === prev) return;
    if (prev !== null) release(prev);
    pointers.set(e.pointerId, m);
    if (m !== null) press(m, 0.8);
  }
  canvas.addEventListener("pointerdown", e => {
    e.preventDefault(); canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, null); pointerMove(e);
  });
  canvas.addEventListener("pointermove", pointerMove);
  const pointerUp = e => {
    const m = pointers.get(e.pointerId);
    if (m != null) release(m);
    pointers.delete(e.pointerId);
  };
  canvas.addEventListener("pointerup", pointerUp);
  canvas.addEventListener("pointercancel", pointerUp);

  // ---------- A digital piano (or any MIDI keyboard) plugged in by USB cable or Bluetooth ----------
  // Its keys count exactly like taps on the screen, but straight from the piano: no microphone guessing, every
  // key and how hard it was struck. The piano makes its own sound, so the app stays quiet unless asked
  // (a keyboard without speakers). Its sustain pedal holds the app's sound too.
  // Web MIDI: Chrome, Edge, Firefox and Android have it; Safari (iPad, iPhone, Mac) doesn't.
  const midiIn = { access: null, names: [], pedal: false, held: new Set(), micNoted: false, keys: 0, waitTimer: 0, poll: 0 };
  const midiSound = () => $("midiSound").checked;
  function midiStatus() {
    const st = $("midiState"), btn = $("midiConnect"), help = $("midiHelp");
    if (!navigator.requestMIDIAccess) {
      st.textContent = appleMobile || /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent)
        ? "Safari can't receive the keys from a digital piano: Apple hasn't added that (“Web MIDI”) to Safari, on iPad or anywhere."
        : "This browser can't receive the keys from a digital piano (it has no “Web MIDI”).";
      btn.hidden = true; $("midiSound").parentNode.hidden = true;
      help.innerHTML = MIDI_HELP_NONE;
    } else if (!midiIn.access) {
      st.textContent = "Plug your digital piano in (or pair it by Bluetooth), turn it on, then tap Connect.";
      btn.hidden = false; help.innerHTML = MIDI_HELP;
    } else {
      const names = midiIn.names.length ? midiIn.names : midiIn.keys ? ["your piano"] : [];
      const silent = names.length && !midiIn.keys && midiIn.waitTimer === -1;
      st.textContent = !names.length ? "No digital piano found yet: the iPad doesn't see it. Check the cable and the piano's settings below, then tap Look again."
        : silent ? "⚠️ Found " + names.join(", ") + ", but no keys have arrived from it yet."
        : "✅ Connected: " + names.join(", ") + (midiIn.keys ? ". Just play: every key counts, no microphone needed." : ". Play a key to check it works.");
      btn.hidden = !!names.length && !silent; btn.textContent = "Look again";
      help.innerHTML = !names.length ? MIDI_HELP + ROLAND_HELP : silent ? NO_KEYS_HELP + ROLAND_HELP : "";
    }
    const on = midiIn.names.length || midiIn.keys;
    ui.midi.textContent = on ? "🎹 Piano" : ""; ui.midi.hidden = !on; ui.midi.className = "stat midi";
    ui.midi.title = midiIn.names.join(", ");
  }
  const CABLE = "Connect the piano's <b>USB</b> port (often labelled “USB to Host”) with a USB cable: on an iPad with a USB-C port through Apple's " +
    "USB-C to USB Adapter, on one with a Lightning port through Apple's Lightning to USB 3 Camera Adapter. Some keyboards need their own power supply.";
  const MIDI_HELP = CABLE + " A Bluetooth MIDI piano can connect without a cable.";
  const NO_KEYS_HELP = "The keys only reach the app if the piano sends them out over USB. On a stage piano with zones or parts, " +
    "check that the part you play is set to send to USB (external), not only to its own sound. ";
  const ROLAND_HELP = "<br><b>Roland RD-2000 / RD-2000 EX:</b> 1) Use the square <b>USB COMPUTER</b> port (not USB MEMORY) and a data cable, not a charge-only one. " +
    "2) Press <b>MENU</b>, choose <b>System</b>, press <b>ENTER</b>, move to <b>USB Driver</b> and set it to <b>GENERIC</b> (the iPad can't use VENDOR), press <b>WRITE</b>, " +
    "then <b>turn the piano off and on again</b>. 3) The zone you play must be <b>EXT</b>: hold <b>SHIFT</b> and press that zone's <b>INT/EXT</b> button until it lights " +
    "<b>green</b> (unlit or red sends nothing). 4) Tap Look again here.";
  const MIDI_HELP_NONE = "Two ways round it:<br>• <b>Best:</b> get the free <b>MIDIWeb Browser</b> app (by 5of12) from the App Store, open this app's address in it, " +
    "and plug the piano in. That browser passes the piano's keys to web pages, by cable or Bluetooth. " + CABLE + "<br>• Or let the app <b>hear</b> the piano " +
    "through the cable: some digital pianos (for example Roland FP-30X, Yamaha P-225) also send their sound over USB. Plug it in, pick it under " +
    "“🎤 Listen through” above if it's listed, and tap 🎤 Listen. Safari doesn't always use the cable even when it lists it: if notes are missed " +
    "when the room is noisy, it is probably still using the iPad's microphone.";
  // One "message" from a MIDI browser app can hold several: a chord arrives as one packet, often with running status
  // ([0x90, 60, 90, 64, 90, 67, 90]), so the bytes are split into single messages first.
  function midiSplit(d) {
    const out = [];
    let status = 0;
    for (let i = 0; i < d.length;) {
      const b = d[i];
      if (b >= 0xf8) { i++; continue; }                                   // clock, active sensing
      if (b === 0xf0) { while (i < d.length && d[i] !== 0xf7) i++; i++; status = 0; continue; }   // system exclusive
      if (b >= 0xf1) { i += { 0xf1: 2, 0xf2: 3, 0xf3: 2 }[b] || 1; status = 0; continue; }
      if (b >= 0x80) { status = b; i++; } else if (!status) { i++; continue; }
      const len = (status & 0xe0) === 0xc0 ? 1 : 2;                          // program change / channel pressure: one data byte
      if (i + len > d.length) break;
      out.push([status, d[i], len > 1 ? d[i + 1] : 0]);
      i += len;
    }
    return out;
  }
  function midiMessage(data) {
    const cmd = data[0] & 0xf0, a = data[1], b = data[2];
    if (cmd === 0x90 && b > 0) {
      if (mic.on && !midiIn.micNoted) {                 // the piano is plugged in: the microphone would count every note twice
        midiIn.micNoted = true; toggleMic();
        $("midiState").textContent = "✅ Your digital piano is connected, so 🎤 Listen was turned off (it isn't needed).";
      }
      midiIn.held.delete(a);
      release(a);
      press(a, 0.3 + 0.7 * b / 127, !midiSound());
    } else if (cmd === 0x80 || cmd === 0x90) {
      if (rec) recOff(a);
      if (midiIn.pedal && midiSound()) { midiIn.held.add(a); down.delete(a); return; }   // the key is up, the pedal keeps it ringing
      release(a);
    } else if (cmd === 0xb0 && a === 64) {              // sustain pedal
      midiIn.pedal = b >= 64; recPedal(midiIn.pedal);
      if (!midiIn.pedal) { midiIn.held.forEach(m => { if (!down.has(m) && !autoDown.has(m)) noteOff(m); }); midiIn.held.clear(); }
    } else if (cmd === 0xb0 && (a === 123 || a === 120)) {   // all notes off
      [...down].forEach(release); midiIn.held.clear();
    }
  }
  function onMidi(e) {
    const d = e && e.data;
    if (!d || !d.length) return;
    for (const m of midiSplit(d)) {
      if ((m[0] & 0xf0) === 0x90 && m[2] > 0) {
        midiIn.keys++;
        $("midiLast").textContent = "🎹 Key received: " + NAMES[m[1] % 12] + (Math.floor(m[1] / 12) - 1) + (midiIn.keys > 1 ? " (" + midiIn.keys + " so far)" : "") + " – it works!";
        $("midiLast").hidden = false;
        if (midiIn.waitTimer) { clearTimeout(midiIn.waitTimer); midiIn.waitTimer = 0; }
        if (midiIn.keys === 1) midiStatus();
      }
      midiMessage(m);
    }
  }
  function hookMidi() {
    const names = [];
    midiIn.access.inputs.forEach(inp => {
      // listened to both ways, since some MIDI browser apps only fire one; once the listener has fired, the other is ignored
      if (!inp.keyfall) { inp.keyfall = true; try { inp.addEventListener("midimessage", e => { inp.kfListener = true; onMidi(e); }); } catch (e) {} try { inp.open && inp.open(); } catch (e) {} }
      inp.onmidimessage = e => { if (!inp.kfListener) onMidi(e); };
      const name = (inp.name || "MIDI keyboard").replace(/\s+/g, " ").trim();
      if (inp.state !== "disconnected" && !/^midiweb\b|network session|^iac\b/i.test(name)) names.push(name);   // the browser app's own (virtual) port isn't a piano
    });
    const was = midiIn.names.length;
    midiIn.names = [...new Set(names)];
    if (midiIn.names.length && !was) midiIn.micNoted = false;
    if (!midiIn.names.length && midiIn.waitTimer) { clearTimeout(midiIn.waitTimer); midiIn.waitTimer = 0; }
    if (midiIn.names.length && !midiIn.keys && !midiIn.waitTimer)       // no key after 25 s of being found: say what to check
      midiIn.waitTimer = setTimeout(() => { midiIn.waitTimer = -1; midiStatus(); }, 25000);
    clearInterval(midiIn.poll); midiIn.poll = 0;
    if (!midiIn.names.length) midiIn.poll = setInterval(() => midiIn.access && hookMidi(), 3000);   // in case plugging in isn't reported
    midiStatus();
  }
  async function connectMidi(auto) {
    if (!navigator.requestMIDIAccess || (midiIn.access && auto)) { midiStatus(); return; }
    try {
      midiIn.access = await navigator.requestMIDIAccess({ sysex: false });   // asked afresh on "Look again": some MIDI browser apps only list what was plugged in then
      midiIn.access.onstatechange = hookMidi;
      hookMidi();
      try { localStorage.setItem("keyfall:midi", "1"); } catch (e) {}
    } catch (e) {
      console.warn("MIDI:", e);
      if (!auto) $("midiState").textContent = "The browser didn't allow it (" + ((e && (e.name || e.message)) || "no reason given") + "). Allow MIDI devices for this site in the browser's settings, then tap Connect again.";
    }
  }
  $("midiConnect").onclick = () => { audio(); connectMidi(false); };
  try { $("midiSound").checked = localStorage.getItem("keyfall:midiSound") === "1"; } catch (e) {}
  $("midiSound").onchange = () => { try { localStorage.setItem("keyfall:midiSound", $("midiSound").checked ? "1" : "0"); } catch (e) {} };
  if (navigator.requestMIDIAccess) $("home").querySelector(".cards").after($("pianoBox"));   // a MIDI browser: the piano matters most, show it first
  midiStatus();
  // connect by itself when that won't pop up a question: allowed before, or a browser app that adds MIDI without asking
  (async () => {
    if (!navigator.requestMIDIAccess) return;
    let ok = false;
    try { ok = localStorage.getItem("keyfall:midi") === "1"; } catch (e) {}
    try { if ((await navigator.permissions.query({ name: "midi" })).state === "granted") ok = true; } catch (e) { ok = true; }
    if (ok) connectMidi(true);
  })();

  // ---------- UI wiring ----------
  function refreshOptions() { ui.song.length = 0; SONGS.forEach((s, i) => ui.song.add(new Option(s.title, i))); }
  refreshOptions();
  function songChanged() {
    const def = SONGS[ui.song.value], hasLeft = def.notes ? def.notes.some(n => n[3]) && def.notes.some(n => !n[3]) : !!def.left;
    wantHand = "both";                               // you play everything unless you choose one hand
    $("title").textContent = SONGS[ui.song.value].title;
    reset();
  }
  ui.song.onchange = songChanged;

  // ---------- ⏺ Record my own song: everything played becomes a falling-notes song ----------
  const recNow = () => performance.now() / 1000;
  function startRecording() {
    audio();
    if (state === "running") pause();
    rec = { t0: null, notes: [], open: new Map(), pedal: [], pedalAt: null };
    LOW = 21; HIGH = 108; layout();
    $("home").hidden = true; $("bar").classList.add("rec"); $("title").textContent = "⏺ Recording";
    ui.hint.hidden = true; ui.ready.hidden = true; ui.pause.hidden = true;
    if (midiIn.pedal) recPedal(true);
  }
  function recOn(midi, vel) {
    const t = recNow();
    if (rec.t0 === null) { rec.t0 = t; if (rec.pedalAt !== null) rec.pedalAt = t; }   // the song starts at the first note
    recOff(midi);
    const n = { midi, start: t, end: null, vel: Math.max(0.1, Math.min(1, vel ?? 0.8)) };
    rec.open.set(midi, n); rec.notes.push(n);
  }
  function recOff(midi) {
    const n = rec.open.get(midi);
    if (n) { n.end = recNow(); rec.open.delete(midi); }
  }
  function recPedal(on) {
    if (!rec) return;
    if (on && rec.pedalAt === null) rec.pedalAt = rec.t0 === null ? 0 : recNow();
    else if (!on && rec.pedalAt !== null) { if (rec.t0 !== null) rec.pedal.push([rec.pedalAt || rec.t0, recNow()]); rec.pedalAt = null; }
  }
  function stopRecording() {
    const R = rec;
    if (!R) return;
    const t = recNow();
    R.open.forEach(n => n.end = t); recPedal(false);
    rec = null; $("bar").classList.remove("rec");
    [...down].forEach(release);
    if (R.notes.length) {
      let count = SONGS.filter(s => /^My song \d+$/.test(s.title)).length + 1;
      while (SONGS.some(s => s.title === "My song " + count)) count++;
      let name = prompt(`Recorded ${R.notes.length} notes. Name your song:`, "My song " + count);
      if (name === null && confirm("Throw this recording away?")) { showHome(); return; }
      name = (name || "").trim().replace(/\s+/g, " ").slice(0, 60) || "My song " + count;
      const r3 = x => Math.round(x * 1000) / 1000;
      const notes = R.notes.map(n => [n.midi, r3(n.start - R.t0), r3(Math.max(0.05, n.end - n.start)), +(n.midi < 60), Math.round(n.vel * 100) / 100]);
      const beat = guessBeat(R.notes.map(n => ({ start: n.start - R.t0 })));
      const def = { title: name, by: "Recorded by you", level: "My songs", notes, beat, bar0: 0 };
      const pedal = R.pedal.map(([a, b]) => [r3(Math.max(0, a - R.t0)), r3(b - R.t0)]).filter(([a, b]) => b > a);
      if (pedal.length) def.pedal = pedal;
      SONGS.push(def); saveImported(); refreshOptions();
      ui.song.value = SONGS.length - 1; ui.level.value = "hard";
      $("importMsg").textContent = `Saved “${name}” (${notes.length} notes) in My songs. Open it to see your notes fall.`;
      sfx("trained");
    }
    showHome(); songChanged();
  }
  function drawRecording() {
    const R = rec, now = recNow(), pps = kbTop / LOOKAHEAD;
    for (let i = R.notes.length - 1; i >= 0; i--) {         // what you play rises up from the keys
      const n = R.notes[i], end = n.end ?? now;
      if (now - end > LOOKAHEAD) { if (now - n.start > LOOKAHEAD * 4) break; continue; }
      if (n.midi < LOW || n.midi > HIGH) continue;
      const k = keyOf(n.midi), y0 = kbTop - (now - n.start) * pps, y1 = kbTop - (now - end) * pps;
      ctx.fillStyle = COLORS[n.midi < 60 ? "left" : "right"]; ctx.globalAlpha = 0.35 + 0.6 * n.vel;
      const pad = k.black ? 1 : 2;
      ctx.fillRect(k.x + pad, Math.max(0, y0), k.w - pad * 2, Math.max(3, y1 - Math.max(0, y0)));
    }
    ctx.globalAlpha = 1; ctx.textAlign = "center"; ctx.fillStyle = "#e8eaf2";
    ctx.font = "700 26px system-ui, sans-serif";
    const y = Math.max(60, kbTop * 0.22);
    if (R.t0 === null) {
      ctx.fillText("Play anything: recording starts with your first note.", W / 2, y);
      ctx.font = "16px system-ui, sans-serif"; ctx.fillStyle = "#a3a8bd";
      ctx.fillText("Tap ⏹ Stop recording when you're done, and it becomes a falling-notes song.", W / 2, y + 30);
    } else {
      const s = Math.floor(now - R.t0), blink = Math.floor(now * 2) % 2;
      const txt = `Recording ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} · ${R.notes.length} notes`, tw = ctx.measureText(txt).width;
      ctx.fillStyle = blink ? "#ff4d5e" : "#7a2630"; ctx.beginPath(); ctx.arc(W / 2 + 14 - tw / 2 - 20, y - 9, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#e8eaf2";
      ctx.fillText(txt, W / 2 + 14, y);
    }
  }
  $("recBtn").onclick = startRecording;
  $("recStop").onclick = stopRecording;

  // ---------- Song library screen ----------
  function showHome() {
    if (train) { finishTraining(); return; }
    if (rec) { stopRecording(); return; }
    if (state === "running") pause();
    const learned = calib ? Object.keys(calib.keys).length : 0;
    $("trainStatus").textContent = learned ? `Trained on ${learned} of 88 keys. Tap to train again.` : "Play each key once so the microphone learns how your piano sounds.";
    if (drill) { drill = null; $("bar").classList.remove("drill"); ui.hint.textContent = HINT; songChanged(); }
    const list = $("list");
    list.textContent = "";
    for (const level of ["My songs", "Easy", "Medium", "Hard"]) {
      if (level === "My songs" && !SONGS.some(s => s.notes)) continue;
      const h = document.createElement("h2"); h.textContent = level; list.append(h);
      const grid = document.createElement("div"); grid.className = "grid"; list.append(grid);
      SONGS.forEach((s, i) => {
        if (s.level !== level) return;
        let stars = 0;
        try { stars = +localStorage.getItem("keyfall:stars:" + s.title) || 0; } catch (e) {}
        const b = document.createElement("button"); b.className = "song " + level.toLowerCase().replace(" ", "");
        const t = document.createElement("span"); t.className = "t"; t.textContent = s.title;
        const by = document.createElement("span"); by.className = "by"; by.textContent = s.by + (s.left ? " · two hands" : "");
        if (s.notes) {
          const x = document.createElement("span"); x.className = "del"; x.textContent = "✕"; x.title = "Remove this song";
          x.onclick = ev => { ev.stopPropagation(); SONGS.splice(SONGS.indexOf(s), 1); saveImported(); refreshOptions(); songChanged(); showHome(); };
          const rn = document.createElement("span"); rn.className = "ren"; rn.textContent = "✎ Rename"; rn.setAttribute("role", "button"); rn.title = "Rename this song";
          rn.onclick = ev => {
            ev.stopPropagation();
            const name = prompt("Name this song:", s.title);
            if (name === null || !name.trim()) return;
            const was = s.title;
            s.title = name.trim().replace(/\s+/g, " ").slice(0, 60);
            try { const k = "keyfall:stars:", v = localStorage.getItem(k + was); if (v) { localStorage.setItem(k + s.title, v); localStorage.removeItem(k + was); } } catch (e) {}
            saveImported(); refreshOptions(); songChanged(); showHome();
          };
          b.append(x, rn);
        }
        const st = document.createElement("span"); st.className = "st";
        for (let k = 0; k < 3; k++) { const x = document.createElement("i"); x.textContent = "★"; if (k < stars) x.className = "on"; st.append(x); }
        b.append(t, by);
        if (s.model) { const md = document.createElement("span"); md.className = "mdl"; md.textContent = "Made with " + s.model; b.append(md); }
        b.append(st);
        b.style.setProperty("--i", grid.children.length);
        b.onclick = () => { ui.song.value = i; $("home").hidden = true; songChanged(); sfx("open"); };
        grid.append(b);
      });
    }
    $("home").hidden = false; ui.ready.hidden = true; ui.pause.hidden = true;
  }
  $("back").onclick = showHome;
  $("drillBtn").onclick = startDrill;
  $("trainBtn").onclick = startTraining;
  $("tDone").onclick = finishTraining;
  $("tSkip").onclick = () => { const T = train; if (!T || T.phase !== "keys") return; T.cap = null; T.msg = ""; T.rejects = 0; if (++T.i >= T.keys.length) finishTraining(); };
  $("tBack").onclick = () => {
    const T = train; if (!T || T.phase !== "keys" || !T.i) return;
    T.i--; delete T.data.keys[T.keys[T.i]]; T.cap = null; T.msg = ""; T.rejects = 0; T.okAt = 0;
    calib = T.data; saveCalib(); buildTemplates();
  };
  try { const v = localStorage.getItem("keyfall:sens"); if (SENS[v]) ui.sens.value = v; } catch (e) {}
  ui.sens.onchange = () => { try { localStorage.setItem("keyfall:sens", ui.sens.value); } catch (e) {} };
  ui.dClef.onchange = ui.dLedger.onchange = ui.dAcc.onchange = () => { if (drill) nextDrill(); };
  // ---------- Recording → notes (Basic Pitch or Onsets and Frames, run on this device) ----------
  // notes struck together (within 50 ms)
  function clusters(notes) {
    const out = [];
    for (const n of notes) { const c = out[out.length - 1]; if (c && n.start - c[0].start < 0.05) c.push(n); else out.push([n]); }
    return out;
  }
  // Left or right hand: notes far apart in a chord are split at the widest gap; otherwise a split point that follows
  // the music (starting at middle C) decides, so a melody that dips below middle C stays in the right hand.
  function assignHands(notes) {
    let split = 60;
    for (const c of clusters(notes)) {
      const ps = c.map(n => n.midi).sort((a, b) => a - b);
      let cut = null;
      if (ps[ps.length - 1] - ps[0] >= 12) {
        let gap = -1;
        for (let i = 1; i < ps.length; i++) if (ps[i] - ps[i - 1] > gap) { gap = ps[i] - ps[i - 1]; cut = (ps[i] + ps[i - 1]) / 2; }
        split = split * 0.6 + cut * 0.4;
      }
      for (const n of c) n.left = +(n.midi < (cut ?? split));
    }
  }
  let lastFail = "", usedModel = "";
  // the note finder's name as shown on the song afterwards ("Made with …")
  const MODEL_NAMES = { best: "Google Onsets and Frames", transkun: "Transkun", tkaug: "Transkun V2 Aug", qmul: "Queen Mary / Yamaha",
    bytedance: "ByteDance", sony: "Sony hFT-Transformer", standard: "Spotify Basic Pitch", arrange: "Songs → piano version (Basic Pitch)",
    demucs: "Demucs + ByteDance", ymt3: "YourMT3+", muscriptor: "MuScriptor", song: "Spotify Basic Pitch (songs)" };
  async function transcribe(file, progress) {
    progress("Reading the recording…");
    usedModel = MODEL_NAMES[ui.finder.value] || "";
    let data;
    try { data = await file.arrayBuffer(); }
    catch (e) { throw new Error("couldn't open the file (" + (e && (e.name || e.message)) + "). If it's in iCloud Drive, open it in the Files app first so it downloads, then try again"); }
    let decoded = await decodeAudio(data);
    if (decoded.duration > 12 * 60) throw new Error("That recording is longer than 12 minutes. Try a shorter one.");
    let kept = null;
    if (ui.finder.value === "best") {
      try { kept = await bestNotes(await resample(decoded, 16000), progress); }
      catch (e) { console.warn("best-quality finder failed:", e); progress("The best-quality finder didn't work on this device; using the standard one…"); }
      finally { freeBest(); }
    } else if (ui.finder.value === "demucs") {
      // Demucs pulls the piano out of the song (on 44.1 kHz stereo), then ByteDance's model writes out its notes
      const [left, right] = await resampleStereo(decoded, 44100); decoded = null;
      const piano = await demucsPiano(left, right, progress);
      const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const buf = new OAC(1, piano.length, 44100).createBuffer(1, piano.length, 44100); buf.getChannelData(0).set(piano);
      kept = await onnxNotes("bytedance", await resample(buf, 16000), progress);
      if (!kept.length) throw new Error("No piano notes were found in that recording (Demucs found no piano in it).");
    } else if (ONNX_MODELS[ui.finder.value]) {
      const m = ui.finder.value;
      const samples = await resample(decoded, m === "transkun" || m === "tkaug" ? 44100 : 16000);
      decoded = null;                                       // (free the full recording while the model works; the file is still here)
      try { kept = await onnxNotes(m, samples, progress); }
      catch (e) {
        console.warn(m + " finder failed:", e); progress("That note finder didn't work on this device; using the standard one…");
        lastFail = (e && e.message) || String(e);
        decoded = await decodeAudio(data);
      }
    }
    if (ui.finder.value === "muscriptor") {
      const token = hfToken();
      if (!token) throw new Error("MuScriptor needs your Hugging Face token first (see Note recognition above).");
      const s16 = await resample(decoded, 16000), s22 = await resample(decoded, 22050); decoded = null;
      const r = await muscNotes(s16, s22, token, progress);
      const a = bandToPiano(r.notes, r.flux);
      if (!Array.isArray(a)) return a;
      kept = a;
    }
    if (ui.finder.value === "ymt3") {
      const s16 = await resample(decoded, 16000), s22 = await resample(decoded, 22050); decoded = null;
      const r = await ymt3Notes(s16, s22, progress);
      const names = r.programs || {};
      const a = bandToPiano(r.notes, r.flux, p => (names[p] && names[p][1]) || "program " + p);
      if (!Array.isArray(a)) return a;
      kept = a;
    }
    if (ui.finder.value === "arrange") {
      // a full song → a piano arrangement: melody in the right hand, bass and chords in the left, on the beat
      const mono = await resample(decoded, 22050); decoded = null;
      const found = await standardNotes(mono, progress, { onset: 0.5, frame: 0.25, arrange: true });
      progress("Finding the beat, the chords and the melody…");
      await new Promise(r => setTimeout(r, 30));
      const a = KeyfallArrange.arrange(found.map(n => [n.midi, n.start, n.end - n.start, n.amp]), found.raw.frames, found.flux);
      if (a && a.notes.length) return { notes: a.notes, pedal: null, beat: a.beat, bar0: a.bar0 };
    }
    if (!kept) {
      usedModel = ui.finder.value === "song" ? MODEL_NAMES.song : MODEL_NAMES.standard;   // (also when the chosen finder failed)
      const mono = await resample(decoded, 22050); decoded = null; kept = await standardNotes(mono, progress, ui.finder.value === "song" ? { onset: 0.5, frame: 0.25 } : {}); }
    if (!kept.length) throw new Error("No piano notes were found in that recording.");
    assignHands(kept);
    const t0 = kept[0].start, loud = Math.max(...kept.map(n => n.amp)), r = x => Math.round(x * 1000) / 1000;
    const pedal = kept.pedal ? kept.pedal.map(([a, b]) => [r(Math.max(0, a - t0)), r(b - t0)]).filter(([a, b]) => b > a) : null;
    return { notes: kept.map(n => [n.midi, r(n.start - t0), r(n.end - n.start), n.left, Math.round(n.amp / loud * 100) / 100]), pedal };
  }
  async function resampleStereo(decoded, rate) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const off = new OAC(2, Math.ceil(decoded.duration * rate), rate), src = off.createBufferSource();
    src.buffer = decoded; src.connect(off.destination); src.start();
    const r = await off.startRendering();
    return [r.getChannelData(0), r.numberOfChannels > 1 ? r.getChannelData(1) : r.getChannelData(0)];
  }
  async function demucsPiano(left, right, progress) {
    progress("Getting Demucs ready (55 MB, only the first time)…");
    return await new Promise((ok, fail) => {
      const wk = new Worker("onnx-worker.js?v=11");
      wk.onmessage = ({ data }) => {
        if (data.type === "download") progress(`Downloading Demucs… ${data.value.f != null ? Math.round(data.value.f * 100) + "%" : Math.round(data.value.mb) + " MB"} (only the first time)`);
        else if (data.type === "progress") progress(`Pulling the piano out of the song with Demucs… ${Math.round(data.value * 100)}%`);
        else { wk.terminate(); data.type === "done" ? ok(data.piano) : fail(new Error(data.message)); }
      };
      wk.onerror = e => { wk.terminate(); fail(new Error(e.message || "worker")); };
      wk.postMessage({ model: "demucs", left, right, base: new URL("vendor/", location.href).href, lowMemory: appleMobile });
    });
  }
  // Turn the file's bytes into sound. First with the page's audio context; if that fails (iOS sometimes refuses
  // while the sound system is interrupted or busy), with a separate offline one. Each try gets its own copy of the
  // bytes, because decoding uses them up.
  async function decodeAudio(data) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext, errs = [];
    const tries = [() => audio(), () => new OAC(2, 44100, 44100), () => new OAC(1, 44100, 48000)];
    for (const make of tries) {
      try {
        const ctx = make(); if (!ctx) continue;
        return await new Promise((ok, fail) => {
          const pr = ctx.decodeAudioData(data.slice(0), ok, e => fail(e || new Error("unknown")));
          if (pr && pr.then) pr.then(ok, fail);
        });
      } catch (e) { errs.push((e && (e.name || e.message)) || "unknown"); }
    }
    console.warn("decoding failed:", errs);
    const err = new Error("decode"); err.detail = errs.join(", "); throw err;
  }
  // the recording in mono at the rate a note finder listens at (the phone's own audio code does the work)
  async function resample(decoded, rate) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const off = new OAC(1, Math.ceil(decoded.duration * rate), rate), src = off.createBufferSource();
    src.buffer = decoded; src.connect(off.destination); src.start();
    return (await off.startRendering()).getChannelData(0);
  }
  // Google Magenta's Onsets and Frames: made only for piano, the most accurate on our test recordings (99% of notes,
  // almost no extra ones) but slower, and a 60 MB download the first time
  // It runs in a hidden frame of its own: it brings an older TensorFlow.js that must not mix with the one used here.
  let oafFrame = null, oafEl = null;
  function bestFrame() {
    if (oafFrame) return oafFrame;
    oafFrame = new Promise((ok, fail) => {
      const f = oafEl = document.createElement("iframe");
      f.hidden = true; f.src = "oaf.html?v=2";
      f.onload = () => f.contentWindow.ready ? ok(f.contentWindow) : fail(new Error("frame"));
      f.onerror = () => fail(new Error("frame"));
      document.body.append(f);
    });
    oafFrame.catch(() => { oafFrame = null; });
    return oafFrame;
  }
  function freeBest() {                                  // the model holds 60 MB: let it go until the next recording
    if (oafEl) oafEl.remove();
    oafEl = null; oafFrame = null;
  }
  async function bestNotes(samples, progress) {
    progress("Downloading the best-quality note finder (60 MB, only the first time)…");
    const say = f => progress(`Finding every note with the best-quality finder… ${Math.round(f * 100)}%`);
    let notes;
    try {
      // first choice: a worker, so the screen stays smooth
      notes = await new Promise((ok, fail) => {
        const wk = new Worker("oaf-worker.js?v=2");
        wk.onmessage = ({ data }) => {
          if (data.type === "progress") say(data.value);
          else { wk.terminate(); data.type === "done" ? ok(data.notes.map(([pitch, start, end, velocity]) => ({ pitch, start, end, velocity }))) : fail(new Error(data.message)); }
        };
        wk.onerror = e => { wk.terminate(); fail(new Error(e.message || "worker")); };
        wk.postMessage({ samples });
      });
    } catch (e) {
      // older iPads can't use the graphics chip from a worker: run it on the page, a piece at a time
      console.warn("best-quality worker unavailable:", e);
      const w = await bestFrame();
      await w.ready();
      say(0);
      notes = await w.transcribe(samples, 16000, say);
    }
    return notes.filter(n => n.pitch >= 21 && n.pitch <= 108 && n.end - n.start >= 0.03)
      .map(n => ({ midi: n.pitch, start: n.start, end: n.end, amp: n.velocity / 127 }))
      .sort((a, b) => a.start - b.start || a.midi - b.midi);
  }
  // Transkun or ByteDance's piano model, with ONNX Runtime in a worker (onnx-worker.js)
  const ONNX_MODELS = { transkun: ["Transkun", 27], tkaug: ["Transkun V2 Aug", 27], qmul: ["Queen Mary / Yamaha", 86], bytedance: ["ByteDance", 86], sony: ["Sony", 11] };
  async function onnxNotes(model, samples, progress) {
    const [name, mb] = ONNX_MODELS[model];
    progress(`Getting the ${name} note finder ready (${mb} MB, only the first time)…`);
    const notes = await new Promise((ok, fail) => {
      const wk = new Worker("onnx-worker.js?v=11");
      wk.onmessage = ({ data }) => {
        if (data.type === "download") progress(`Downloading the ${data.value.label}… ${data.value.f != null ? Math.round(data.value.f * 100) + "%" : Math.round(data.value.mb) + " MB"} (only the first time)`);
        else if (data.type === "progress") progress(`Finding every note with ${name}… ${Math.round(data.value * 100)}%`);
        else { wk.terminate(); data.type === "done" ? ok(data) : fail(new Error(data.message)); }
      };
      wk.onerror = e => { wk.terminate(); fail(new Error(e.message || "worker")); };
      const job = { model, samples, base: new URL("vendor/", location.href).href, lowMemory: appleMobile };
      try { wk.postMessage(job, [samples.buffer]); } catch (e) { wk.postMessage(job); }   // hand the sound over instead of copying it
    });
    const kept = notes.notes.filter(([p, s, e]) => p >= 21 && p <= 108 && e - s >= 0.03)
      .map(([midi, start, end, vel]) => ({ midi, start, end, amp: Math.max(0.05, vel / 127) }))
      .sort((a, b) => a.start - b.start || a.midi - b.midi);
    kept.pedal = notes.pedal || null;                       // Transkun also hears the sustain pedal
    return kept;
  }
  // A whole band's notes ([pitch, start, end, program], drums as program -1) → a piano part: an arrangement
  // (melody right hand, bass + chords left) when there are other instruments, or the notes as they are for piano.
  function bandToPiano(notes, flux, nameOf = p => "program " + p) {
    const tracks = new Map();
    for (const [pitch, start, end, program] of notes) {
      if (program < 0 || pitch < 21 || pitch > 108) continue;                    // drums aren't played on the piano
      if (!tracks.has(program)) tracks.set(program, { name: nameOf(program), program, notes: [] });
      tracks.get(program).notes.push({ midi: pitch, start, end: Math.max(end, start + 0.05) });
    }
    const all = [...tracks.values()];
    if (!all.length) throw new Error("No notes were found in that recording.");
    if (!all.every(t => t.program < 8) && flux) {
      const a = KeyfallArrange.pianoReduce(all, KeyfallArrange.beats(flux).times);
      if (a && a.notes.length) return a;
    }
    return all.flatMap(t => t.notes.map(n => ({ midi: n.midi, start: n.start, end: n.end, amp: 0.8 }))).sort((a, b) => a.start - b.start || a.midi - b.midi);
  }
  // YourMT3+ (Chang, Benetos, Kirchhoff, Dixon) in ymt3-worker.js: every instrument, no account needed
  async function ymt3Notes(s16, s22, progress) {
    progress("Getting YourMT3+ ready (95 MB, only the first time)…");
    return await new Promise((ok, fail) => {
      const wk = new Worker("ymt3-worker.js?v=5");
      wk.onmessage = ({ data }) => {
        if (data.type === "download") progress(`Downloading the ${data.value.label}… ${data.value.f != null ? Math.round(data.value.f * 100) + "%" : Math.round(data.value.mb) + " MB"} (only the first time)`);
        else if (data.type === "progress") {
          const { piece, pieces, secs } = data.value, left = Math.round(secs / piece * (pieces - piece) / 60);
          progress(`Writing out every instrument with YourMT3+… ${Math.round(piece / pieces * 100)}% (about ${left < 1 ? 1 : left} min left)`);
        } else { wk.terminate(); data.type === "done" ? ok(data) : fail(new Error(data.message)); }
      };
      wk.onerror = e => { wk.terminate(); fail(new Error(e.message || "worker")); };
      wk.postMessage({ samples: s16, samples22: s22, base: new URL("vendor/", location.href).href });
    });
  }
  // MuScriptor (Kyutai & Mirelo) in musc-worker.js. Its weights are gated on Hugging Face: each person downloads them
  // with their own token, straight from huggingface.co to their device, where they're kept for next time.
  const hfToken = () => { try { return localStorage.getItem("keyfall:hftoken") || ""; } catch (e) { return ""; } };
  async function muscNotes(s16, s22, token, progress) {
    progress("Getting MuScriptor ready…");
    return await new Promise((ok, fail) => {
      const wk = new Worker("musc-worker.js?v=2");
      wk.onmessage = ({ data }) => {
        if (data.type === "download") progress(`Downloading MuScriptor… ${Math.round(data.value * 100)}% (412 MB, only the first time)`);
        else if (data.type === "status") progress(data.value === "download" ? "Getting MuScriptor (412 MB the first time, then it's kept on this iPad)…" : data.value === "load" ? "Loading MuScriptor…" : "Writing out every instrument…");
        else if (data.type === "progress") {
          const { chunk, chunks, secs } = data.value, left = chunk ? Math.round(secs / chunk * (chunks - chunk) / 60) : null;
          progress(`Writing out every instrument with MuScriptor… ${Math.round(chunk / chunks * 100)}%` + (left !== null ? ` (about ${left < 1 ? "1" : left} min left)` : ""));
        } else {
          wk.terminate();
          if (data.type === "done") ok(data);
          else fail(new Error(data.message === "hf-auth" ? "Hugging Face didn't accept that token: check it, and that you accepted MuScriptor's licence on its model page." : data.message));
        }
      };
      wk.onerror = e => { wk.terminate(); fail(new Error(e.message || "worker")); };
      const test = window.__muscTest || {};                 // (automated tests use a small stand-in model)
      wk.postMessage({ size: test.size || "small", samples: s16, samples22: s22, token, weightsUrl: test.url || "https://huggingface.co/MuScriptor/muscriptor-small/resolve/main/model.safetensors", base: new URL("vendor/", location.href).href });
    });
  }
  // Spotify's Basic Pitch, in a worker of its own (import-worker.js) so the screen stays smooth
  async function standardNotes(samples, progress, tune) {
    progress("Finding the notes… 0%");
    const base = new URL("vendor/", location.href).href;
    const res = await new Promise((ok, fail) => {
      const wk = new Worker("import-worker.js?v=4");
      wk.onmessage = ({ data }) => {
        if (data.type === "progress") progress(`Finding the notes… ${Math.round(data.value * 100)}%`);
        else { wk.terminate(); if (data.type === "done") { if (data.raw) window.__bpRaw = data.raw; ok(data); } else fail(new Error(data.message)); }
      };
      wk.onerror = e => { wk.terminate(); fail(new Error(e.message || "worker")); };
      wk.postMessage({ base, samples, keepRaw: !!window.__keepBpRaw, ...tune });
    });
    const found = res.notes;
    // keep real piano notes: very short blips and very quiet echoes go, and a key "struck" twice within 80 ms is one strike.
    // (The thresholds already split notes only at real strikes, so repeated notes stay separate.)
    const loud = Math.max(...found.map(n => n[3]), 0);
    const kept = [], lastOf = {};
    for (const [midi, s0, dur, amp] of found.filter(n => n[0] >= 21 && n[0] <= 108 && n[2] >= 0.06 && n[3] >= loud * 0.12)
      .sort((x, y) => x[1] - y[1])) {
      const prev = lastOf[midi], s1 = s0 + dur;
      if (prev && s0 - prev.start < 0.08) { prev.end = Math.max(prev.end, s1); continue; }
      const k = { midi, start: s0, end: s1, amp };
      kept.push(k); lastOf[midi] = k;
    }
    if (tune && tune.arrange) { kept.raw = res.raw; kept.flux = res.flux; }
    return kept;
  }

  $("file").onchange = async ev => {
    const f = ev.target.files[0], msg = $("importMsg");
    ev.target.value = "";
    if (!f) return;
    const head = new Uint8Array(await f.slice(0, 4).arrayBuffer());
    const isMidi = String.fromCharCode(...head) === "MThd";          // what's in the file, not what it's called
    const title = f.name.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "My song";
    try {
      let got;
      if (isMidi) got = parseMidi(await f.arrayBuffer());
      else {
        $("importBtn").classList.add("busy");
        setFx(false);                                     // (give the graphics memory to the note finder)
        lastFail = "";
        const crumb = step => { try { localStorage.setItem("keyfall:importing", JSON.stringify({ finder: ui.finder.options[ui.finder.selectedIndex].text, step, at: Date.now() })); } catch (e) {} };
        crumb("starting");
        let lastCrumb = 0, lastKind = "";
        got = await transcribe(f, t => {
          msg.textContent = t;
          const kind = t.replace(/[\d.]+\s*(%|MB|min)/g, "");             // a new step is always noted; a step's % at most every 2 s
          if (kind !== lastKind || performance.now() - lastCrumb > 2000) { lastKind = kind; lastCrumb = performance.now(); crumb(t); }
        });
      }
      const notes = got.notes;
      SONGS.push({ title, by: got.beat ? "Piano arrangement" : isMidi ? "Imported" : "From a recording", level: "My songs", notes,
        ...(isMidi ? {} : { model: usedModel }),
        ...(got.pedal && got.pedal.length ? { pedal: got.pedal } : {}), ...(got.beat ? { beat: got.beat, bar0: got.bar0 } : {}) });
      saveImported(); refreshOptions();
      msg.textContent = `Added “${title}” (${notes.length} notes). Pick Easy, Medium, Hard, Extra hard or Extra extra hard when you open it.` +
        (lastFail ? ` (The chosen note finder failed — “${lastFail.slice(0, 120)}” — so the standard one was used.)` : "");
      sfx("trained");
      showHome();
    } catch (e) {
      console.warn("import failed:", e);
      const m = (e && e.message) || "";
      msg.textContent = /MIDI|notes|minutes|load|Hugging Face/.test(m) ? m
        : isMidi ? "Couldn't read that file. It needs to be a .mid file."
        : m === "decode" ? "Couldn't read that recording (" + (e.detail || "no details") + "). Try an MP3, M4A or WAV file."
        : "That note finder ran into a problem (" + m.slice(0, 160) + "). Try another “MP3 → notes” choice, and tell Claude what it said.";
    } finally {
      $("importBtn").classList.remove("busy");
      try { localStorage.removeItem("keyfall:importing"); } catch (e) {}
      setFx(ui.fx3d.checked);
    }
  };
  // if the page was closed in the middle of finding notes (an iPad does that when a tab uses too much memory), say so
  try {
    const was = JSON.parse(localStorage.getItem("keyfall:importing") || "null");
    localStorage.removeItem("keyfall:importing");
    if (was && Date.now() - was.at < 86400000)
      $("importMsg").textContent = `Last time the app closed while “${was.finder}” was working (${String(was.step).slice(0, 90)}). The iPad probably ran out of memory: try a shorter recording, close other apps and tabs, or pick another “MP3 → notes” choice.`;
  } catch (e) {}
  ui.mode.onchange = reset;
  ui.hand.onchange = () => { wantHand = ui.hand.value; reset(); };
  ui.speed.oninput = () => ui.speedVal.textContent = ui.speed.value + "%";
  ui.start.onclick = () => { sfx("click"); toggle(); };
  try { if (localStorage.getItem("keyfall:sfx") === "0") ui.sfx.checked = false; } catch (e) {}
  ui.sfx.onchange = () => { try { localStorage.setItem("keyfall:sfx", ui.sfx.checked ? "1" : "0"); } catch (e) {} };
  if (reduceMotion) { ui.fx3d.checked = false; ui.fx3d.disabled = true; $("fx3dNote").textContent = "(off: your device asks for less motion)"; }
  try { if (localStorage.getItem("keyfall:fx3d") === "0") ui.fx3d.checked = false; } catch (e) {}
  try { setLook(localStorage.getItem("keyfall:look") || "red"); } catch (e) { setLook("red"); }
  ui.look.onchange = () => setLook(ui.look.value);
  try { const v = localStorage.getItem("keyfall:sharp"); if (v && v !== ui.sharp.value) { ui.sharp.value = v; layout(); } } catch (e) {}
  ui.sharp.onchange = () => { perf.auto = false; $("sharpNote").textContent = ""; try { localStorage.setItem("keyfall:sharp", ui.sharp.value); } catch (e) {} layout(); };
  ui.fx3d.onchange = () => { try { localStorage.setItem("keyfall:fx3d", ui.fx3d.checked ? "1" : "0"); } catch (e) {} setFx(ui.fx3d.checked); };
  setTimeout(() => setFx(ui.fx3d.checked), 1200);
  ui.pause.onclick = toggle;
  try { if (localStorage.getItem("keyfall:ignoreTalk") === "0") ui.ignoreTalk.checked = false; } catch (e) {}
  try { const v = localStorage.getItem("keyfall:level"); if (v && ui.level.querySelector(`[value="${v}"]`)) ui.level.value = v; } catch (e) {}
  try { const v = localStorage.getItem("keyfall:view"); if (v === "sheet") ui.view.value = v; } catch (e) {}
  try { const v = localStorage.getItem("keyfall:finder"); if (["standard", "best", "song", "arrange", "muscriptor", "ymt3", "transkun", "tkaug", "bytedance", "qmul", "sony", "demucs"].includes(v)) ui.finder.value = v; } catch (e) {}
  ui.finder.onchange = () => { try { localStorage.setItem("keyfall:finder", ui.finder.value); } catch (e) {} showModelNotes(); };
  // ---------- Note recognition: which model hears the piano, and which turns recordings into notes ----------
  const MODEL_NOTES = {
    ai: "Recommended. A trained AI model decides which keys you played, with extra checks so talking and echoes don't count. Small download the first time.",
    simple: "Starts instantly and works on any device, but talking, echoes and loud rooms fool it more often.",
    best: "Recommended for piano recordings. Made just for piano: found 99% of the notes in our tests, with almost no wrong ones. Slower, and downloads 60 MB the first time.",
    transkun: "Solo piano recordings, most accurate in our tests: on 20 test recordings it found 99.4% of the notes with zero wrong ones. Slowest (a few minutes for a song) and downloads 27 MB the first time; it may be too heavy for older iPads. It ignores singing and drums, so use the Songs setting for those.",
    demucs: "Songs that have a piano in them (pop ballads, covers, band songs): Meta's Demucs (6-stem) first separates the song into drums, bass, singing, guitar, piano and other, then ByteDance's piano model writes out just the piano's notes. Slow (several minutes for a song), downloads 55 MB + 86 MB the first time. Also finds the sustain pedal. If a song has no piano (like most hip-hop), it finds little or nothing: use “Songs → piano version” or MuScriptor for those.",
    tkaug: "Solo piano recordings made on a phone or in a room: Transkun V2 trained with data augmentation (many recording conditions). In its author's tests on pianos it never heard, it found more notes than the regular version (92% vs 88.5% of note starts). Slow, downloads 27 MB the first time.",
    qmul: "Solo piano recordings, made for real-world recordings: ByteDance's model re-trained by Queen Mary University of London and Yamaha on many pianos and rooms, so it adds far fewer wrong notes: on 20 test recordings it found 99.6% of the notes with 41 wrong ones (ByteDance's original: 289). Also finds the sustain pedal (with ByteDance's pedal model). Slow, downloads 86 MB the first time.",
    sony: "Solo piano recordings: Sony's hFT-Transformer. Found 99.5% of the notes in our tests but added octave echoes (265 wrong notes in 20 recordings). The slowest of all; downloads 11 MB the first time.",
    bytedance: "Solo piano recordings: ByteDance's model (made by TikTok's research team). Found 99.4% of the notes in our tests but added octave echoes (289 wrong notes in 20 recordings); the Queen Mary / Yamaha version of it is better. Also finds the sustain pedal. Slow, downloads 86 MB the first time. Not for songs with singing: it mostly ignores other instruments.",
    ymt3: "YourMT3+ (Queen Mary University of London and others), a well-known model that writes out every instrument in a song, singing and drums included; Keyfall turns that into a two-hand piano part. Free and no account needed. Slow (several minutes or more for a song) and downloads 95 MB the first time. In our test it was very precise (almost no wrong notes) but missed some of our synthetic singing and 808 bass.",
    muscriptor: "Kyutai's MuScriptor, the most accurate model for full songs: it writes out every instrument, singing included, and Keyfall turns that into a two-hand piano part (the singer in the right hand, bass and chords in the left). It runs on this iPad, but it's big and slow: a 412 MB download the first time (then kept), and several minutes or more per song; older iPads may not manage it. Its makers ask each person to use their own free Hugging Face account: set it up once below. (Free for personal, non-commercial use, for music you have the right to transcribe.)",
    arrange: "Recommended for songs with singing and beats, like hip-hop and pop: instead of writing down every sound, it finds the beat, the chords and the main melody and makes a piano version (melody in the right hand, bass and chords in the left, lined up on the beat), like a piano cover. Takes seconds.",
    song: "Best for songs with singing, guitar, drums or 808s, like hip-hop and pop: it hears every instrument, not just piano. Takes seconds. On a 4-minute hip-hop song it followed the music better than any of the piano models, and on our test song it found 30 of 32 sung notes. Expect some extra notes from the other instruments.",
    standard: "For piano recordings, when you want it quick: takes seconds. Found about 91% of the notes in our tests: it can miss a note played twice in a row, or add one.",
  };
  // whether each model's licence allows it in a business (selling the app, ads, a paid service)
  const NON_COMMERCIAL = { sony: "Sony's licence", muscriptor: "MuScriptor's licence" };
  const bizNote = m => m === "simple" ? "" : NON_COMMERCIAL[m] ? ` ⚠️ Personal use only: ${NON_COMMERCIAL[m]} doesn't allow business (commercial) use.`
    : m === "ymt3" ? " ✅ Its licence (Apache 2.0) allows business use, but part of what it was trained on was for non-commercial use only: check before using it in a business."
    : " ✅ Its licence allows business use (with credit to its makers, as in the app's notices).";
  function showModelNotes() {
    $("listenerNote").textContent = MODEL_NOTES[ui.listener.value] + bizNote(ui.listener.value);
    $("finderNote").textContent = MODEL_NOTES[ui.finder.value] + bizNote(ui.finder.value);
    $("muscBox").hidden = ui.finder.value !== "muscriptor";
    $("hfState").textContent = hfToken() ? "✓ Your Hugging Face token is saved on this iPad." : "";
  }
  try { const v = localStorage.getItem("keyfall:listener") || (localStorage.getItem("keyfall:ai") === "0" ? "simple" : ""); if (v === "ai" || v === "simple") ui.listener.value = v; } catch (e) {}
  ui.listener.onchange = () => {
    try { localStorage.setItem("keyfall:listener", ui.listener.value); } catch (e) {}
    showModelNotes();
    if (mic.on && window.KeyfallML) { if (ui.listener.value === "ai") KeyfallML.start(ac, mic.src); else KeyfallML.stop(); }   // switch while listening
  };
  showModelNotes();
  $("hfSave").onclick = () => {
    const v = $("hfToken").value.trim();
    try { if (v) localStorage.setItem("keyfall:hftoken", v); else localStorage.removeItem("keyfall:hftoken"); } catch (e) {}
    $("hfToken").value = ""; showModelNotes();
  };
  try { if (localStorage.getItem("keyfall:pedal") === "off") ui.pedal.value = "off"; } catch (e) {}
  ui.pedal.onchange = () => { try { localStorage.setItem("keyfall:pedal", ui.pedal.value); } catch (e) {} reset(); };
  ui.level.onchange = () => { try { localStorage.setItem("keyfall:level", ui.level.value); } catch (e) {} reset(); };
  ui.view.onchange = () => { try { localStorage.setItem("keyfall:view", ui.view.value); } catch (e) {} sheet = null; layout(); };
  ui.ignoreTalk.onchange = () => { try { localStorage.setItem("keyfall:ignoreTalk", ui.ignoreTalk.checked ? "1" : "0"); } catch (e) {} };
  ui.mic.onclick = toggleMic;
  ui.restart.onclick = () => { reset(); start(); };
  $("again").onclick = () => { reset(); start(); };
  $("close").onclick = showHome;
  document.querySelectorAll("select, button, input[type=checkbox]").forEach(el => el.addEventListener("change", () => el.blur()));
  document.querySelectorAll("button").forEach(el => el.addEventListener("click", () => el.blur()));

  window.addEventListener("resize", () => { layout(); grad = null; });
  layout(); songChanged(); showHome();
  // Safari keeps the page for a while after an update: if the server has a newer version, offer it
  async function checkForUpdate() {
    try {
      const mine = ([...document.scripts].map(x => x.src).find(x => /app\.js\?v=/.test(x)) || "").match(/v=(\d+)/);
      if (!mine) return;
      const html = await (await fetch("index.html?check=" + Date.now(), { cache: "no-store" })).text();
      const live = (html.match(/app\.js\?v=(\d+)/) || [])[1];
      if (!live || live === mine[1] || document.getElementById("updateBar")) return;
      const bar = document.createElement("div"); bar.id = "updateBar";
      const b = document.createElement("button"); b.className = "primary"; b.textContent = "Update now";
      b.onclick = () => location.replace(location.pathname + "?v=" + live);
      bar.append("A new version of Keyfall is ready. ", b); document.body.append(bar);
    } catch (e) {}
  }
  checkForUpdate();
  {                                                         // which version this is, at the bottom of the song list
    const v = (([...document.scripts].map(x => x.src).find(x => /app\.js\?v=/.test(x)) || "").match(/v=(\d{8})(\d{4})/));
    const credit = document.querySelector(".credit");
    if (v && credit) { const e = document.createElement("span"); e.className = "version"; e.textContent = ` Version ${v[1].slice(4, 6)}/${v[1].slice(6)} ${v[2].slice(0, 2)}:${v[2].slice(2)} UTC.`; credit.append(e); }
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) checkForUpdate(); });
  requestAnimationFrame(frame);

  window.__keyfall = { held: () => [...autoDown.keys()].length, get sheet() { return sheet; }, mic, press: (m) => { press(m, 0.8); setTimeout(() => release && release(m), 150); }, get drill() { return drill; }, get train() { return train; }, get calib() { return calib; }, get tmpl() { return tmpl; }, get state() { return state; }, get time() { return time; }, get song() { return song; }, loadSong, playable, get ac() { return ac; }, get stats() { return { score, hits, misses, wrong }; } };
})();
