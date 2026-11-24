(() => {
  "use strict";
  let LOW = 48, HIGH = 84;            // C3..C6
  const LOOKAHEAD = 2.6;                // seconds of music visible above the hit line
  const HIT_WINDOW = 0.22, PERFECT = 0.08;
  const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const isBlack = m => [1, 3, 6, 8, 10].includes(m % 12);

  // Computer keyboard: bottom row = C3 octave, top rows = C4 upward.
  const KEYMAP = {};
  [..."zsxdcvgbhnjm"].forEach((k, i) => KEYMAP[k] = 48 + i);
  [..."q2w3er5t6y7ui9o0p[=]"].forEach((k, i) => KEYMAP[k] = 60 + i);
  const KEYLABEL = {};
  for (const k in KEYMAP) KEYLABEL[KEYMAP[k]] = k.toUpperCase();

  const $ = id => document.getElementById(id);
  const canvas = $("stage"), ctx = canvas.getContext("2d");
  const ui = {
    song: $("song"), mode: $("mode"), hand: $("hand"), speed: $("speed"), speedVal: $("speedVal"),
    labels: $("labels"), start: $("start"), restart: $("restart"), score: $("score"),
    streak: $("streak"), mic: $("mic"), sens: $("sens"), dClef: $("dClef"), dLedger: $("dLedger"), dAcc: $("dAcc"), dNames: $("dNames"), acc: $("acc"), midi: $("midi"), hint: $("hint"), results: $("results"),
  };

  const HINT = ui.hint.textContent;

  // ---------- Audio ----------
  let ac = null, master = null;
  const voices = new Map();
  function audio() {
    if (!ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ac = new AC();
      master = ac.createDynamicsCompressor();
      master.connect(ac.destination);
    }
    if (ac.state === "suspended") ac.resume();
    return ac;
  }
  function noteOn(midi, vel = 0.8) {
    if (!audio()) return;
    noteOff(midi);
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
    const v = voices.get(midi);
    if (!v) return;
    voices.delete(midi);
    const t = ac.currentTime;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setTargetAtTime(0, t, 0.06);
    v.oscs.forEach(o => { try { o.stop(t + 0.4); } catch (e) {} });
  }

  // ---------- Songs ----------
  function toMidi(name) {
    const m = /^([A-G])([#b]?)(\d)$/.exec(name);
    if (!m) throw new Error("Bad note " + name);
    let n = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]];
    if (m[2] === "#") n++; else if (m[2] === "b") n--;
    return n + 12 * (+m[3] + 1);
  }
  function parseTrack(str, hand, beat, out) {
    let t = 0, lastTok = [];
    for (const tok of (str || "").split(/\s+/)) {
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
  function loadSong(def) {
    const notes = [], beat = 60 / def.bpm;
    let end;
    if (def.notes) {                     // imported song: [midi, start, duration, isLeft]
      for (const [midi, start, dur, left] of def.notes)
        notes.push({ midi, start, dur, hand: left ? "left" : "right", state: "pending", played: false });
      end = Math.max(...notes.map(n => n.start + n.dur));
    } else end = Math.max(parseTrack(def.right, "right", beat, notes), parseTrack(def.left, "left", beat, notes));
    notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
    // if both hands strike the same key at the same moment, keep one note
    const uniq = notes.filter((n, i) => !(i && notes[i - 1].midi === n.midi && Math.abs(notes[i - 1].start - n.start) < 1e-6));
    return { def, notes: uniq, end };
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
    const tempos = [], tracks = [];
    for (let t = 0; t < ntr && p < d.byteLength; t++) {
      const id = str(4), len = d.getUint32(p); p += 4;
      const end = p + len;
      if (id !== "MTrk") { p = end; continue; }
      let tick = 0, status = 0;
      const open = {}, notes = [];
      while (p < end) {
        tick += vlq();
        if (d.getUint8(p) & 0x80) status = d.getUint8(p++);
        if (status === 0xff) {
          const type = d.getUint8(p++), l = vlq();
          if (type === 0x51) tempos.push([tick, (d.getUint8(p) << 16) | (d.getUint8(p + 1) << 8) | d.getUint8(p + 2)]);
          p += l;
        } else if (status === 0xf0 || status === 0xf7) { const l = vlq(); p += l; }
        else {
          const cmd = status & 0xf0, ch = status & 15, a = d.getUint8(p++);
          const b = cmd === 0xc0 || cmd === 0xd0 ? 0 : d.getUint8(p++);
          if (ch === 9) continue;                                   // drums
          if (cmd === 0x90 && b > 0) (open[a] = open[a] || []).push(tick);
          else if (cmd === 0x80 || cmd === 0x90) {
            const s = open[a] && open[a].shift();
            if (s !== undefined && a >= 21 && a <= 108) notes.push({ midi: a, t0: s, t1: tick });
          }
        }
      }
      p = end;
      if (notes.length) tracks.push(notes);
    }
    if (!tracks.length) throw new Error("No notes found in that file.");
    tempos.sort((a, b) => a[0] - b[0]);
    const segs = [{ tick: 0, sec: 0, us: 500000 }];
    for (const [tick, us] of tempos) {
      const l = segs[segs.length - 1];
      segs.push({ tick, sec: l.sec + (tick - l.tick) * l.us / div / 1e6, us });
    }
    const sec = tick => { let g = segs[0]; for (const x of segs) { if (x.tick > tick) break; g = x; } return g.sec + (tick - g.tick) * g.us / div / 1e6; };
    // hands: the track with the highest average pitch is the right hand; one track is split at middle C
    const avg = tr => tr.reduce((a, n) => a + n.midi, 0) / tr.length;
    const top = tracks.reduce((a, b) => avg(b) > avg(a) ? b : a);
    const out = [];
    for (const tr of tracks) for (const n of tr)
      out.push([n.midi, sec(n.t0), Math.max(sec(n.t1) - sec(n.t0), 0.05), tracks.length > 1 ? +(tr !== top) : +(n.midi < 60)]);
    const t0 = Math.min(...out.map(n => n[1]));
    out.forEach(n => { n[1] = Math.round((n[1] - t0) * 1000) / 1000; n[2] = Math.round(n[2] * 1000) / 1000; });
    return out;
  }
  const saveImported = () => { try { localStorage.setItem("keyfall:imported", JSON.stringify(SONGS.filter(s => s.notes))); } catch (e) {} };
  try { SONGS.push(...(JSON.parse(localStorage.getItem("keyfall:imported")) || [])); } catch (e) {}

  // ---------- Game state ----------
  let song = null, state = "idle";      // idle | running | paused | done
  let time = 0, score = 0, streak = 0, bestStreak = 0, hits = 0, perfects = 0, misses = 0, wrong = 0;
  const down = new Set(), autoDown = new Map(), flashes = [];

  const mode = () => ui.mode.value;
  const isUser = n => mode() !== "listen" && (ui.hand.value === "both" || n.hand === ui.hand.value);

  function reset() {
    song = loadSong(SONGS[ui.song.value]);
    // fit the on-screen keyboard to the song (never smaller than C3..C6)
    const lo = Math.min(...song.notes.map(n => n.midi)), hi = Math.max(...song.notes.map(n => n.midi));
    LOW = Math.min(48, Math.floor(lo / 12) * 12); HIGH = Math.max(84, Math.ceil(hi / 12) * 12);
    layout();
    time = -2; score = streak = bestStreak = hits = perfects = misses = wrong = 0;
    autoDown.forEach((_, m) => noteOff(m)); autoDown.clear();
    state = "idle"; ui.start.textContent = "Start"; ui.results.hidden = true;
    updateHud();
  }
  function start() {
    audio();
    if (state === "done" || !song) reset();
    state = "running"; ui.start.textContent = "Pause"; ui.hint.hidden = true;
  }
  function pause() {
    state = "paused"; ui.start.textContent = "Resume";
    autoDown.forEach((_, m) => noteOff(m)); autoDown.clear();
  }
  function toggle() { state === "running" ? pause() : start(); }

  function updateHud() {
    ui.score.textContent = score;
    ui.streak.textContent = streak;
    const total = hits + misses + wrong;
    ui.acc.textContent = total ? Math.round(100 * hits / total) + "%" : "–";
  }
  function registerHit(n, perfect) {
    n.state = "hit"; hits++; streak++; bestStreak = Math.max(bestStreak, streak);
    if (perfect) perfects++;
    score += (perfect ? 100 : 50) + Math.min(streak, 50);
    flashes.push({ midi: n.midi, t: performance.now(), text: perfect ? "Perfect" : "Good" });
    updateHud();
  }
  function registerWrong() { wrong++; streak = 0; updateHud(); }

  function nextGroup() {                 // earliest pending user notes (a chord shares a start)
    const first = song.notes.find(n => n.state === "pending" && isUser(n));
    return first ? song.notes.filter(n => n.state === "pending" && isUser(n) && n.start - first.start < 1e-6) : [];
  }

  function press(midi, vel) {
    if (down.has(midi) || train) return;
    down.add(midi); noteOn(midi, vel);
    if (drill) { drillAnswer(midi); return; }
    if (state !== "running" || mode() === "listen") return;
    if (mode() === "practice") {
      const g = nextGroup();
      if (!g.length || g[0].start - time > 0.35) return;
      const n = g.find(n => n.midi === midi);
      n ? registerHit(n, true) : registerWrong();
    } else {
      let best = null;
      for (const n of song.notes)
        if (n.state === "pending" && n.midi === midi && isUser(n) && Math.abs(n.start - time) <= HIT_WINDOW &&
            (!best || Math.abs(n.start - time) < Math.abs(best.start - time))) best = n;
      best ? registerHit(best, Math.abs(best.start - time) <= PERFECT) : registerWrong();
    }
  }
  function release(midi) {
    if (!down.delete(midi)) return;
    if (!autoDown.has(midi)) noteOff(midi);
  }

  function step(dt) {
    if (state !== "running") return;
    time += dt * ui.speed.value / 100;
    if (mode() === "practice") {
      const g = nextGroup();
      if (g.length && time > g[0].start) time = g[0].start;   // wait for the player
    }
    for (const n of song.notes) {
      if (n.start > time) break;
      if (!isUser(n)) {
        if (!n.played) { n.played = true; n.state = "hit"; noteOn(n.midi, 0.6); autoDown.set(n.midi, n.start + n.dur * 0.92); }
      } else if (mode() === "play" && n.state === "pending" && time > n.start + (mic.on ? LATE : HIT_WINDOW)) {
        n.state = "miss"; misses++; streak = 0; updateHud();
      }
    }
    autoDown.forEach((end, m) => { if (time >= end) { autoDown.delete(m); if (!down.has(m)) noteOff(m); } });
    if (time > song.end + 0.8) finish();
  }

  function finish() {
    state = "done"; ui.start.textContent = "Start";
    if (mode() === "listen") { reset(); return; }
    const total = hits + misses + wrong, acc = total ? Math.round(100 * hits / total) : 0;
    const stars = acc >= 95 ? 3 : acc >= 80 ? 2 : acc >= 50 ? 1 : 0;
    const key = `keyfall:${song.def.title}:${mode()}:${ui.hand.value}`;
    let best = 0;
    try { best = +localStorage.getItem(key) || 0; if (score > best) localStorage.setItem(key, score); } catch (e) {}
    try { const k = "keyfall:stars:" + song.def.title; if (stars > (+localStorage.getItem(k) || 0)) localStorage.setItem(k, stars); } catch (e) {}
    $("resTitle").textContent = song.def.title;
    $("stars").innerHTML = [0, 1, 2].map(i => `<span class="${i < stars ? "" : "off"}">★</span>`).join("");
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
    $("home").hidden = true; $("bar").classList.add("drill"); $("title").textContent = "Note practice";
    ui.hint.textContent = "Find the note shown on the staff and play it."; ui.hint.hidden = false;
  }
  function drillAnswer(midi) {
    const d = drill;
    if (d.done) return;
    ui.hint.hidden = true;
    if (midi === d.target.midi) {
      hits++; streak++; bestStreak = Math.max(bestStreak, streak); score += 10;
      d.done = true; d.doneAt = performance.now();
      setTimeout(() => { if (drill === d) nextDrill(); }, 550);
    } else { wrong++; streak = 0; d.tries++; d.wrongKey = midi; d.wrongAt = performance.now(); }
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
    sal: new Float32Array(130).fill(-200), hist: [],
    armed: new Uint8Array(128).fill(1), peak: new Float32Array(128), hitAt: new Float64Array(128),
    onsetAt: new Float64Array(128), softAt: new Float64Array(128), usedAt: new Float64Array(128),
    lowEv: new Uint8Array(128), upTone: new Uint8Array(128), own: new Uint8Array(128), seen: new Uint8Array(128), groupHitAt: 0, groupStart: null,
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
      mic.on = false; mic.note = null; ui.mic.textContent = "🎤 Listen: off"; ui.mic.classList.remove("primary");
      return;
    }
    if (!audio() || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { ui.mic.textContent = "🎤 Mic unsupported"; return; }
    try {
      mic.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch (e) { ui.mic.textContent = "🎤 Mic blocked"; return; }
    mic.analyser = ac.createAnalyser();
    mic.analyser.fftSize = 8192; mic.analyser.smoothingTimeConstant = 0;
    ac.createMediaStreamSource(mic.stream).connect(mic.analyser);
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
    mic.hist = []; mic.live.fill(-200); mic.spread.fill(9);
    mic.on = true; ui.mic.textContent = "🎤 Listen: on"; ui.mic.classList.add("primary");
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
    if (drill) drillAnswer(n.midi); else registerHit(n, perfect);
  }
  function micTargets() {              // notes the song is currently waiting to hear
    if (train) return [];
    if (drill) return drill.done ? [] : [drill.target];
    if (state !== "running" || mode() === "listen") return [];
    if (mode() === "practice") { const g = nextGroup(); return g.length && g[0].start - time <= 0.35 ? g : []; }
    return song.notes.filter(n => n.state === "pending" && isUser(n) && n.start - time <= HIT_WINDOW && time - n.start <= LATE);
  }
  const micPerfect = (n, ago = 0) => mode() === "practice" || Math.abs(n.start - (time - ago / 1000 * ui.speed.value / 100)) <= PERFECT + 0.12;

  function micTick() {
    if (!mic.on) return;
    const now = performance.now(), sr = ac.sampleRate, S = sens();
    mic.analyser.getFloatTimeDomainData(mic.buf);
    const x = mic.buf.subarray(mic.buf.length - 4096);
    let e = 0;
    for (let i = 0; i < x.length; i++) e += x[i] * x[i];
    const rms = mic.level = Math.sqrt(e / x.length);

    // --- band levels (dB) for every key, and a slow estimate of each band's background level
    const spec = mic.spec, L = mic.L, F = mic.F, live = mic.live, hz = sr / mic.analyser.fftSize, nb = spec.length;
    mic.analyser.getFloatFrequencyData(spec);
    for (let k = BLO; k <= BHI; k++) {
      const [i0, i1] = mic.bands[k];
      let pk = -200;
      for (let i = i0; i <= i1; i++) if (spec[i] > pk) pk = spec[i];
      L[k] = pk;
      // background level per band: a running mean and spread that ignore anything far above it (the notes)
      const d = pk - live[k], sp = mic.spread;
      if (live[k] <= -199) { live[k] = pk; sp[k] = 9; }
      else if (d < 3 * Math.sqrt(sp[k]) + 3) { live[k] += 0.01 * d; sp[k] += 0.01 * (d * d - sp[k]); }
      else live[k] += 0.0005 * d;
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

    if (train) trainTick(now);
    else {
      // --- untrained floor: a low percentile of the spectrum between 200 Hz and 4 kHz
      const sample = [];
      for (let b = Math.round(200 / hz); b < 4000 / hz && b < nb; b += 4) sample.push(spec[b]);
      sample.sort((a, b) => a - b);
      const floor = Math.max(sample[Math.floor(sample.length * 0.3)], -110);
      // --- decide, for every key, whether it was just struck
      for (let m = 21; m <= 108; m++) {
        // untrained check: three overtones from 250 Hz up stand out and just jumped
        const s = mic.sal[m], level = s;
        let lo = s;
        for (const h of hist) if (h.s[m] < lo) lo = h.s[m];
        let strict = s >= mic.sal[m - 1] + 4 && s >= mic.sal[m + 1] + 4 && s >= floor + S.gFloor && s >= -95 && s - lo >= S.gRise;
        let soft = s >= mic.sal[m - 1] + 2 && s >= mic.sal[m + 1] + 2 && s >= floor + S.gFloor - 6 && s - lo >= S.gRise * 0.5;
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
          if (tot) { strict = got >= 0.6 * tot; soft = soft || gotSoft >= 0.5 * tot; }
        }
        if (!mic.armed[m]) {                             // a struck key listens again once it fades a little
          if (level > mic.peak[m]) mic.peak[m] = level;
          if ((now - mic.hitAt[m] > 100 && level < mic.peak[m] - 6) || now - mic.hitAt[m] > 400) mic.armed[m] = 1;
        }
        if (mic.armed[m]) {
          if (strict) {
            mic.onsetAt[m] = now; mic.armed[m] = 0; mic.peak[m] = level; mic.hitAt[m] = now;
            mic.lowEv[m] = mic.upTone[m] = mic.own[m] = mic.seen[m] = 0;
          } else if (soft) mic.softAt[m] = now;
        }
        // wrong octave? A key an octave away shares many of this key's overtones, so watch the ones it doesn't
        // share during the first 0.2 s after a strike (the attack's splash hides them at first).
        if (now - mic.onsetAt[m] <= 200) {
          if (mic.seen[m] < 255) mic.seen[m]++;
          const lo = m - 12, ref = Math.max(lvl(m), lvl(m + 12), lvl(m + 19), lvl(m + 24));
          const tone = b => b >= BLO && b <= BHI && F[b] >= 6 && L[b] >= noiseAt(b) + S.tMargin && peaky(b, 4);
          const there = b => b > BHI || (L[b] >= noiseAt(b) + S.tMargin * 0.6 && peaky(b, 2));
          const visible = b => b > BHI || noiseAt(b) + 15 < L[m + 12];
          // octave below: its fundamental and 3rd overtone (which this key lacks) sounded as well
          const clear = b => b >= BLO && b <= BHI && noiseAt(b) + 15 < ref;
          if (clear(lo) && clear(m + 7) && tone(lo) && tone(m + 7) && L[lo] >= ref - 15 && L[m + 7] >= ref - 25 && mic.lowEv[m] < 9) mic.lowEv[m]++;
          // octave above: the key above sounded, but this key's own fundamental and 3rd overtone never did
          if (m >= 36 && tone(m + 12) && visible(m) && visible(m + 19)) mic.upTone[m] = 1;
          if ((there(m) || there(m + 19)) && mic.own[m] < 255) mic.own[m]++;   // counted per frame, so a flicker doesn't count
        }
      }
      // --- match what was heard to the notes the song is waiting for
      const targets = micTargets();
      if (targets.length) {
        const keep = drill || mode() === "practice" ? 700 : 250;
        // every note of the chord being played, including ones already heard, so C3 + C4 isn't mistaken for a lone C3
        const t0 = Math.min(...targets.map(n => n.start)), t1 = Math.max(...targets.map(n => n.start));
        const want = new Set(drill ? [drill.target.midi] : song.notes.filter(n => isUser(n) && n.start >= t0 - 1e-6 && n.start <= t1 + 1e-6).map(n => n.midi));
        const take = (n, from) => {
          const m = n.midi;
          mic.usedAt[m] = from;
          if ((mic.lowEv[m] >= 2 && !want.has(m - 12)) || (mic.upTone[m] && mic.own[m] * 3 < mic.seen[m] && !want.has(m + 12))) return;   // wrong octave
          micHit(n, micPerfect(n, now - from)); mic.groupHitAt = now; mic.groupStart = n.start;
        };
        for (const n of targets) {
          const m = n.midi;
          const age = now - mic.onsetAt[m];
          if (mic.onsetAt[m] > mic.usedAt[m] && age >= 120 && age <= keep + 120) take(n, mic.onsetAt[m]);
        }
        // the rest of a chord that was just heard: weaker evidence is enough for its other notes
        if (!drill && now - mic.groupHitAt <= keep) for (const n of micTargets()) {
          const m = n.midi;
          if (n.state !== "hit" && n.start === mic.groupStart && mic.softAt[m] > mic.usedAt[m] && now - mic.softAt[m] <= keep) {
            mic.lowEv[m] = mic.upTone[m] = 0;
            take(n, mic.softAt[m]);
          }
        }
      }
    }
    hist.push({ t: now, L: L.slice(), s: mic.sal.slice() });

    // --- pitch readout
    if (rms < 0.003) { mic.note = mic.cand = null; mic.count = 0; return; }
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
    T.okAt = now; T.rejects = 0;
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
  function layout() {
    const dpr = window.devicePixelRatio || 1, r = canvas.getBoundingClientRect();
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const kbH = Math.max(90, Math.min(H * 0.26, 200));
    kbTop = H - kbH;
    let whites = 0;
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

  function rrect(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function draw() {
    ctx.fillStyle = "#12141c"; ctx.fillRect(0, 0, W, H);
    // lane guides at each C
    ctx.strokeStyle = "#1f2331"; ctx.lineWidth = 1;
    for (const k of keys) if (!k.black && k.midi % 12 === 0) {
      ctx.beginPath(); ctx.moveTo(k.x + 0.5, 0); ctx.lineTo(k.x + 0.5, kbTop); ctx.stroke();
    }
    // falling notes
    if (song && !drill && !train) {
      const pps = kbTop / LOOKAHEAD;
      for (const n of song.notes) {
        if (n.start - time > LOOKAHEAD) break;
        if (n.start + n.dur < time || n.midi < LOW || n.midi > HIGH) continue;
        const k = keyOf(n.midi), inset = k.black ? 0 : k.w * 0.14;
        const yb = kbTop - (n.start - time) * pps, h = Math.max(n.dur * pps - 3, 8);
        const user = isUser(n);
        ctx.globalAlpha = n.state === "hit" ? 0.45 : user ? 1 : 0.5;
        ctx.fillStyle = n.state === "miss" ? "#e2495b" : COLORS[n.hand];
        rrect(k.x + inset, yb - h, k.w - inset * 2, h, 5); ctx.fill();
        if (k.black) { ctx.fillStyle = "rgba(0,0,0,.3)"; ctx.fill(); }
      }
      ctx.globalAlpha = 1;
    }
    // keyboard
    ctx.fillStyle = "#0b0c11"; ctx.fillRect(0, kbTop - 3, W, H - kbTop + 3);
    ctx.fillStyle = "#7fd4ff"; ctx.fillRect(0, kbTop - 3, W, 2);
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
      ctx.fillStyle = k.midi === badKey ? "#ff6b7d" : target.has(k.midi) ? (pass ? "#2e7d4f" : "#a8f0c0") : on ? "#39b6ff"
        : learned ? (pass ? "#34507a" : "#cfe2fb") : pass ? "#181a22" : "#f4f5f9";
      rrect(k.x + (pass ? 0 : 1), kbTop, k.w - (pass ? 0 : 2), k.h - 2, 4); ctx.fill();
      if (lab === "off") continue;
      const text = lab === "keys" ? KEYLABEL[k.midi] : (pass ? "" : NAMES[k.midi % 12] + (k.midi % 12 === 0 ? Math.floor(k.midi / 12) - 1 : ""));
      if (!text || k.w < 11) continue;
      ctx.font = `${Math.max(9, Math.min(13, k.w * 0.55))}px system-ui, sans-serif`;
      ctx.fillStyle = pass ? "#9aa0b8" : "#5a6078";
      ctx.fillText(text, k.x + k.w / 2, kbTop + k.h - 10);
    }
    if (drill) drawStaff();
    if (train) drawTraining();
    // hit feedback
    const now = performance.now();
    ctx.font = "bold 13px system-ui, sans-serif";
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i], a = (now - f.t) / 600;
      if (a >= 1 || f.midi < LOW || f.midi > HIGH) { flashes.splice(i, 1); continue; }
      const k = keyOf(f.midi);
      ctx.globalAlpha = 1 - a;
      ctx.fillStyle = f.text === "Perfect" ? "#8dffb0" : "#ffe08a";
      ctx.fillText(f.text, k.x + k.w / 2, kbTop - 14 - a * 30);
    }
    ctx.globalAlpha = 1;
    // microphone meter: shows that the app is hearing something, and which note
    if (mic.on) {
      const lv = Math.min(1, Math.sqrt((mic.level || 0) * 12)), x = W - 176, y = 12;
      ctx.fillStyle = "rgba(27,30,42,.9)"; rrect(x, y, 164, 34, 8); ctx.fill();
      ctx.fillStyle = "#2c3042"; ctx.fillRect(x + 10, y + 22, 144, 5);
      ctx.fillStyle = lv > 0.12 ? "#5fd38a" : "#56607f"; ctx.fillRect(x + 10, y + 22, 144 * lv, 5);
      ctx.font = "12px system-ui, sans-serif"; ctx.textAlign = "left"; ctx.fillStyle = "#e8eaf2";
      ctx.fillText(mic.note != null ? "Hearing: " + NAMES[mic.note % 12] + (Math.floor(mic.note / 12) - 1) : "Listening…", x + 10, y + 15);
      ctx.textAlign = "center";
    }
    // countdown / progress
    if (song && state !== "idle" && !train) {
      if (time < 0 && state === "running") {
        ctx.font = "bold 64px system-ui, sans-serif"; ctx.fillStyle = "rgba(255,255,255,.25)";
        ctx.fillText(Math.ceil(-time), W / 2, kbTop / 2);
      }
      ctx.fillStyle = "#2f8fd8";
      ctx.fillRect(0, 0, W * Math.max(0, Math.min(1, time / song.end)), 3);
    }
  }

  let last = performance.now();
  function frame(now) {
    micTick();
    step(Math.min((now - last) / 1000, 0.1)); last = now;
    draw();
    requestAnimationFrame(frame);
  }

  // ---------- Input ----------
  window.addEventListener("keydown", e => {
    if (e.ctrlKey || e.metaKey || e.altKey || /^(SELECT|INPUT)$/.test(e.target.tagName) && e.key !== " ") return;
    if (e.key === " ") { e.preventDefault(); if (!e.repeat && $("home").hidden && !drill && !train) toggle(); return; }
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

  if (navigator.requestMIDIAccess) {
    navigator.requestMIDIAccess().then(access => {
      const hook = () => {
        let n = 0;
        access.inputs.forEach(inp => {
          n++;
          inp.onmidimessage = ({ data }) => {
            const cmd = data[0] & 0xf0;
            if (cmd === 0x90 && data[2] > 0) press(data[1], 0.3 + 0.7 * data[2] / 127);
            else if (cmd === 0x80 || cmd === 0x90) release(data[1]);
          };
        });
        ui.midi.textContent = n ? `MIDI: ${n} connected` : "MIDI: none";
      };
      hook(); access.onstatechange = hook;
    }, () => { ui.midi.textContent = "MIDI: blocked"; });
  } else ui.midi.textContent = "MIDI: unsupported";

  // ---------- UI wiring ----------
  function refreshOptions() { ui.song.length = 0; SONGS.forEach((s, i) => ui.song.add(new Option(s.title, i))); }
  refreshOptions();
  function songChanged() {
    const def = SONGS[ui.song.value], hasLeft = def.notes ? def.notes.some(n => n[3]) && def.notes.some(n => !n[3]) : !!def.left;
    for (const o of ui.hand.options) o.disabled = o.value !== "right" && !hasLeft;
    ui.hand.value = hasLeft ? "both" : "right";      // you play everything unless you choose one hand
    $("title").textContent = SONGS[ui.song.value].title;
    reset();
  }
  ui.song.onchange = songChanged;

  // ---------- Song library screen ----------
  function showHome() {
    if (train) { finishTraining(); return; }
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
          b.append(x);
        }
        const st = document.createElement("span"); st.className = "st";
        for (let k = 0; k < 3; k++) { const x = document.createElement("i"); x.textContent = "★"; if (k < stars) x.className = "on"; st.append(x); }
        b.append(t, by, st);
        b.onclick = () => { ui.song.value = i; songChanged(); $("home").hidden = true; ui.hint.hidden = false; };
        grid.append(b);
      });
    }
    $("home").hidden = false;
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
  $("file").onchange = async ev => {
    const f = ev.target.files[0], msg = $("importMsg");
    ev.target.value = "";
    if (!f) return;
    try {
      const notes = parseMidi(await f.arrayBuffer());
      SONGS.push({ title: f.name.replace(/\.[^.]+$/, "").slice(0, 60), by: "Imported", level: "My songs", notes });
      saveImported(); refreshOptions();
      msg.textContent = `Added “${SONGS[SONGS.length - 1].title}” (${notes.length} notes).`;
      showHome();
    } catch (e) { msg.textContent = e.message && /MIDI|notes/.test(e.message) ? e.message : "Couldn't read that file. It needs to be a .mid file."; }
  };
  ui.mode.onchange = ui.hand.onchange = reset;
  ui.speed.oninput = () => ui.speedVal.textContent = ui.speed.value + "%";
  ui.start.onclick = toggle;
  ui.mic.onclick = toggleMic;
  ui.restart.onclick = () => { reset(); start(); };
  $("again").onclick = () => { reset(); start(); };
  $("close").onclick = showHome;
  document.querySelectorAll("select, button, input[type=checkbox]").forEach(el => el.addEventListener("change", () => el.blur()));
  document.querySelectorAll("button").forEach(el => el.addEventListener("click", () => el.blur()));

  window.addEventListener("resize", layout);
  layout(); songChanged(); showHome();
  requestAnimationFrame(frame);

  window.__keyfall = { mic, get drill() { return drill; }, get train() { return train; }, get calib() { return calib; }, get tmpl() { return tmpl; }, get state() { return state; }, get time() { return time; }, get song() { return song; }, get stats() { return { score, hits, misses, wrong }; } };
})();
