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
    ready: $("ready"), pause: $("pause"), micText: $("micText"), micLvl: $("micLvl"), prog: $("progFill"), streakBox: $("streakBox"),
    ignoreTalk: $("ignoreTalk"), importAs: $("importAs"), ai: $("ai"), sfx: $("sfx"), scoreBox: $("score").parentNode,
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
      if (window.KeyfallSound) KeyfallSound.init(ac, master);
    }
    if (ac.state === "suspended") ac.resume();
    return ac;
  }
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
  try { SONGS.push(...(JSON.parse(localStorage.getItem("keyfall:imported")) || []).map(s => ({ ...s, title: s.title.replace(/_+/g, " ").replace(/\s+/g, " ").trim() }))); } catch (e) {}

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
    ui.restart.hidden = true; ui.pause.hidden = true;
    const def = SONGS[ui.song.value];
    $("readyTitle").textContent = def.title;
    $("readySub").textContent = [def.by, def.level, def.left || (def.notes && def.notes.some(n => n[3])) ? "two hands" : "one hand"].filter(Boolean).join(" · ");
    ui.ready.hidden = !$("home").hidden || !!drill || !!train;
    updateHud();
  }
  function start() {
    audio();
    if (state === "done" || !song) reset();
    state = "running"; ui.hint.hidden = true; ui.ready.hidden = true; ui.pause.hidden = false;
  }
  function pause() {
    state = "paused"; ui.start.textContent = "Resume"; ui.restart.hidden = false; ui.pause.hidden = true;
    ui.ready.hidden = !!drill || !!train || !$("home").hidden;
    autoDown.forEach((_, m) => noteOff(m)); autoDown.clear();
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
  function burst(midi, color, big) {
    if (midi < LOW || midi > HIGH || !keys.length) return;
    const k = keyOf(midi), x = k.x + k.w / 2, now = performance.now();
    beams.push({ x, w: k.w, color, t: now });
    if (reduceMotion) return;
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
    burst(n.midi, perfect ? "#8dffb0" : COLORS[n.hand] || "#39b6ff", streak >= 5 && streak % 5 === 0);
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

  function press(midi, vel) {
    if (down.has(midi) || train) return;
    down.add(midi); noteOn(midi, vel);
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
    if (!down.delete(midi)) return;
    if (!autoDown.has(midi)) noteOff(midi);
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
          if (!mic.on) noteOn(n.midi, 0.6);                // silent while listening: the microphone would hear it
          autoDown.set(n.midi, n.start + n.dur * 0.92);
        }
      } else if (mode() === "play" && n.state === "pending" && time > n.start + lateBy()) {
        n.state = "miss"; misses++; streak = 0; updateHud();
      }
    }
    autoDown.forEach((end, m) => { if (time >= end) { autoDown.delete(m); if (!down.has(m)) noteOff(m); } });
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
      mic.on = false; mic.note = null; ui.micText.textContent = "🎤 Listen: off"; ui.mic.classList.remove("primary");
      return;
    }
    if (!audio() || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { ui.micText.textContent = "🎤 Mic unsupported"; return; }
    // ask for the raw microphone: voice processing (echo cancellation, noise suppression, auto gain) treats
    // a held piano note as noise and turns soft playing down
    const raw = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    try {
      try { mic.stream = await navigator.mediaDevices.getUserMedia({ audio: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, { exact: v }])) }); }
      catch (e) { if (e && e.name === "NotAllowedError") throw e; mic.stream = await navigator.mediaDevices.getUserMedia({ audio: raw }); }
    } catch (e) { ui.micText.textContent = "🎤 Mic blocked"; return; }
    const track = mic.stream.getAudioTracks()[0], st = track && track.getSettings ? track.getSettings() : {};
    mic.filtered = st.echoCancellation === true || st.noiseSuppression === true || st.autoGainControl === true;
    mic.analyser = ac.createAnalyser();
    mic.analyser.fftSize = 8192; mic.analyser.smoothingTimeConstant = 0;
    const micSource = ac.createMediaStreamSource(mic.stream);
    micSource.connect(mic.analyser);
    if (window.KeyfallML && ui.ai.checked) KeyfallML.start(ac, micSource);
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
          const talkFilter = ui.ignoreTalk.checked && from === mic.onsetAt[m];
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
          const wait = ui.ignoreTalk.checked ? 170 : 120;
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
  function layout() {
    const dpr = window.devicePixelRatio || 1, r = canvas.getBoundingClientRect();
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const kbH = Math.max(90, Math.min(H * 0.26, 200));
    kbTop = H - kbH;
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
    g.shade = ctx.createLinearGradient(0, kbTop, 0, kbTop + 14);
    g.shade.addColorStop(0, "rgba(0,0,0,.45)"); g.shade.addColorStop(1, "rgba(0,0,0,0)");
    return g;
  }
  function keyFill(color, k) {                        // a lit key: the colour, brighter at the top, with a soft sheen
    const gr = ctx.createLinearGradient(0, kbTop, 0, kbTop + k.h);
    gr.addColorStop(0, color); gr.addColorStop(0.75, color); gr.addColorStop(1, k.black ? "#0d2a3f" : "#ffffff");
    return gr;
  }

  function draw() {
    if (!grad) grad = gradients();
    const now = performance.now();
    ctx.fillStyle = grad.bg; ctx.fillRect(0, 0, W, kbTop);
    // lane guides at each C
    ctx.strokeStyle = "rgba(127,212,255,.06)"; ctx.lineWidth = 1;
    for (const k of keys) if (!k.black && k.midi % 12 === 0) {
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
    // falling notes
    if (song && !drill && !train) {
      const pps = kbTop / LOOKAHEAD;
      for (const n of song.notes) {
        if (n.start - time > LOOKAHEAD) break;
        if (n.start + n.dur < time || n.midi < LOW || n.midi > HIGH) continue;
        const k = keyOf(n.midi), inset = k.black ? 0 : k.w * 0.14;
        const yb = kbTop - (n.start - time) * pps, h = Math.max(n.dur * pps - 3, 8);
        const user = isUser(n);
        ctx.globalAlpha = n.state === "hit" ? 0.35 : user ? 1 : 0.5;
        const base = n.state === "miss" ? "#e2495b" : COLORS[n.hand], x0 = k.x + inset, w0 = k.w - inset * 2;
        const near = user && n.state === "pending" && n.start - time < 0.35 && n.start + n.dur > time;
        if (near) { ctx.shadowColor = base; ctx.shadowBlur = 16; }
        const gr = ctx.createLinearGradient(x0, 0, x0 + w0, 0);
        gr.addColorStop(0, LIGHT[base] || base); gr.addColorStop(0.55, base); gr.addColorStop(1, DARK[base] || base);
        ctx.fillStyle = gr; rrect(x0, yb - h, w0, h, 6); ctx.fill();
        ctx.shadowBlur = 0;
        if (k.black) { ctx.fillStyle = "rgba(0,0,0,.25)"; ctx.fill(); }
        ctx.fillStyle = "rgba(255,255,255,.28)";           // glossy highlight down the left edge
        rrect(x0 + 2, yb - h + 2, Math.max(2, w0 * 0.22), h - 4, 3); ctx.fill();
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
          ctx.fillStyle = "rgba(27,30,42,.92)"; rrect(cx - tw / 2, cy - 22, tw, 40, 20); ctx.fill();
          ctx.strokeStyle = "#5fd38a"; ctx.lineWidth = 2; ctx.stroke();
          ctx.fillStyle = "#a8f0c0"; ctx.textAlign = "center"; ctx.fillText(txt, cx, cy + 5);
        }
      }
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
      const lit = k.midi === badKey || flash ? "#ff6b7d" : target.has(k.midi) ? (pass ? "#2e9d5f" : "#8fe9b0") : on ? (pass ? "#1f86c9" : "#7ccdff")
        : learned ? (pass ? "#34507a" : "#cfe2fb") : null;
      const kx = k.x + (pass ? 0 : 1), kw = k.w - (pass ? 0 : 2), kh = k.h - (on && !pass ? 0 : 3);
      if (lit && (on || target.has(k.midi))) { ctx.shadowColor = lit; ctx.shadowBlur = 14; }
      ctx.fillStyle = lit ? keyFill(lit, k) : pass ? grad.black : grad.white;
      rrect(kx, kbTop - 2, kw, kh + 2, pass ? 3 : 5); ctx.fill();
      ctx.shadowBlur = 0;
      if (pass) {                                        // black keys: a polished bevel catching the light
        ctx.fillStyle = "rgba(255,255,255,.13)";
        rrect(kx + kw * 0.14, kbTop + 4, kw * 0.72, kh * 0.78, 2); ctx.fill();
      } else if (!lit) {
        ctx.fillStyle = "rgba(0,0,0,.05)"; ctx.fillRect(kx + kw - 1, kbTop, 1, kh);
      }
      if (lab === "off") continue;
      const text = lab === "keys" ? KEYLABEL[k.midi] : (pass ? "" : NAMES[k.midi % 12] + (k.midi % 12 === 0 ? Math.floor(k.midi / 12) - 1 : ""));
      if (!text || k.w < 11) continue;
      ctx.font = `${Math.max(9, Math.min(13, k.w * 0.55))}px system-ui, sans-serif`;
      ctx.fillStyle = pass ? "#9aa0b8" : "#5a6078";
      ctx.fillText(text, k.x + k.w / 2, kbTop + k.h - 10);
    }
    ctx.fillStyle = grad.shade; ctx.fillRect(0, kbTop, W, 14);     // shadow under the rail
    // the hit line: a glowing rail the notes land on
    ctx.shadowColor = "#7fd4ff"; ctx.shadowBlur = 12;
    ctx.fillStyle = "#7fd4ff"; ctx.fillRect(0, kbTop - 3, W, 2);
    ctx.shadowBlur = 0;
    // sparks from hits
    for (let i = particles.length - 1; i >= 0; i--) {
      const pt = particles[i], a = (now - pt.t) / pt.life;
      if (a >= 1) { particles.splice(i, 1); continue; }
      const t = (now - pt.t) / 1000;
      const px = pt.x + pt.vx * t, py = pt.y + pt.vy * t + 260 * t * t, r = pt.r * (1 - a * 0.4);
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
    // hit feedback

    ctx.textAlign = "center";
    ctx.shadowColor = "rgba(0,0,0,.6)"; ctx.shadowBlur = 6;
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i], a = (now - f.t) / 700;
      if (a >= 1 || f.midi < LOW || f.midi > HIGH) { flashes.splice(i, 1); continue; }
      const k = keyOf(f.midi), pop = 1 + 0.25 * Math.max(0, 1 - a * 5);
      ctx.globalAlpha = 1 - a * a * a;
      ctx.font = `800 ${Math.round(20 * pop)}px system-ui, sans-serif`;
      ctx.fillStyle = f.text === "Perfect" ? "#8dffb0" : "#ffe08a";
      ctx.fillText(f.text, k.x + k.w / 2, kbTop - 18 - a * 40);
    }
    if (streak >= 5 && streakAt && now - streakAt < 900) {
      const a = (now - streakAt) / 900;
      ctx.globalAlpha = 1 - a;
      ctx.font = `800 ${Math.round(34 + 10 * (1 - a))}px system-ui, sans-serif`;
      ctx.fillStyle = "#ffcc4d";
      ctx.fillText(`🔥 ${streak} in a row`, W / 2, kbTop * 0.42);
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
    ui.prog.style.width = song && !drill && !train ? Math.max(0, Math.min(100, time / song.end * 100)).toFixed(1) + "%" : "0%";
    // countdown / progress
    if (song && state !== "idle" && !train) {
      if (time < 0 && state === "running") {
        ctx.font = "bold 64px system-ui, sans-serif"; ctx.fillStyle = "rgba(255,255,255,.25)";
        ctx.fillText(Math.ceil(-time), W / 2, kbTop / 2);
      }

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
        ui.midi.textContent = n ? "🎹 MIDI" : ""; ui.midi.hidden = !n; ui.midi.className = "stat midi";
      };
      hook(); access.onstatechange = hook;
    }, () => {});
  }

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
  // ---------- Recording → notes (Spotify's Basic Pitch, run on this device) ----------
  const loadScript = src => new Promise((ok, fail) => {
    const el = document.createElement("script");
    el.src = src; el.onload = ok; el.onerror = () => fail(new Error("Couldn't load " + src));
    document.head.append(el);
  });
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
  // easier versions: at most a melody note and a bass note at a time, without quiet inner notes or ornaments
  function simplify(notes) {
    const res = [];
    for (const c of clusters(notes)) {
      const loud = Math.max(...c.map(n => n.amp));
      const keep = c.filter(n => n.amp >= loud * 0.35 && n.end - n.start >= 0.08);
      if (!keep.length) continue;
      const top = keep.reduce((a, b) => b.midi > a.midi ? b : a), low = keep.reduce((a, b) => b.midi < a.midi ? b : a);
      res.push(top); if (low !== top && low.left) res.push(low);
    }
    return res;
  }
  function melodyOnly(notes) {
    const res = [];
    for (const c of clusters(notes)) {
      const right = c.filter(n => !n.left);
      if (!right.length) continue;
      const top = right.reduce((a, b) => b.midi > a.midi ? b : a);
      res.push({ ...top, left: 0 });
    }
    return res;
  }

  async function transcribe(file, progress) {
    progress("Getting the note finder ready…");
    if (window.KeyfallML) await KeyfallML.prepare();       // loads the model and picks the fastest back-end
    else if (!window.tf) await loadScript("vendor/tf.min.js");
    if (!window.BasicPitchLib) await loadScript("vendor/basic-pitch/basic-pitch.js");
    progress("Reading the recording…");
    const data = await file.arrayBuffer(), ctx = audio();
    const decoded = await new Promise((ok, fail) => {
      const pr = ctx.decodeAudioData(data, ok, () => fail(new Error("decode")));
      if (pr && pr.then) pr.then(ok, () => fail(new Error("decode")));
    });
    if (decoded.duration > 12 * 60) throw new Error("That recording is longer than 12 minutes. Try a shorter one.");
    // the model listens at 22,050 samples a second, in mono
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const off = new OAC(1, Math.ceil(decoded.duration * 22050), 22050), src = off.createBufferSource();
    src.buffer = decoded; src.connect(off.destination); src.start();
    const mono = await off.startRendering();
    const { BasicPitch, outputToNotesPoly, addPitchBendsToNoteEvents, noteFramesToTime } = BasicPitchLib;
    const bp = new BasicPitch("vendor/basic-pitch/model.json");
    const frames = [], onsets = [], contours = [];
    await bp.evaluateModel(mono.getChannelData(0), (f, o, c) => { frames.push(...f); onsets.push(...o); contours.push(...c); },
      pct => progress(`Finding the notes… ${Math.round(pct * 100)}%`));
    window.__bpRaw = { frames, onsets };                 // kept for automated accuracy tests
    // thresholds tuned on piano recordings with known notes (10 pieces): 97% of notes found, almost no extra ones
    const found = noteFramesToTime(outputToNotesPoly(frames, onsets, 0.7, 0.45, 7, true, null, null, false, 11));
    // keep real piano notes: very short blips and very quiet echoes go, and a key "struck" twice within 80 ms is one strike.
    // (The thresholds above already split notes only at real strikes, so repeated notes stay separate.)
    const loud = Math.max(...found.map(n => n.amplitude), 0);
    const kept = [], lastOf = {};
    for (const n of found.filter(n => n.pitchMidi >= 21 && n.pitchMidi <= 108 && n.durationSeconds >= 0.06 && n.amplitude >= loud * 0.12)
      .sort((x, y) => x.startTimeSeconds - y.startTimeSeconds)) {
      const prev = lastOf[n.pitchMidi], s0 = n.startTimeSeconds, s1 = s0 + n.durationSeconds;
      if (prev && s0 - prev.start < 0.08) { prev.end = Math.max(prev.end, s1); continue; }
      const k = { midi: n.pitchMidi, start: s0, end: s1, amp: n.amplitude };
      kept.push(k); lastOf[n.pitchMidi] = k;
    }
    if (!kept.length) throw new Error("No piano notes were found in that recording.");
    assignHands(kept);
    const t0 = kept[0].start;
    const out = list => list.map(n => [n.midi, Math.round((n.start - t0) * 1000) / 1000, Math.round((n.end - n.start) * 1000) / 1000, n.left]);
    return { full: out(kept), simple: out(simplify(kept)), melody: out(melodyOnly(kept)) };
  }

  $("file").onchange = async ev => {
    const f = ev.target.files[0], msg = $("importMsg");
    ev.target.value = "";
    if (!f) return;
    const head = new Uint8Array(await f.slice(0, 4).arrayBuffer());
    const isMidi = String.fromCharCode(...head) === "MThd";          // what's in the file, not what it's called
    const title = f.name.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "My song";
    try {
      let notes;
      if (isMidi) notes = parseMidi(await f.arrayBuffer());
      else {
        $("importBtn").classList.add("busy");
        const versions = await transcribe(f, t => { msg.textContent = t; });
        notes = versions[ui.importAs.value] || versions.full;
      }
      SONGS.push({ title, by: isMidi ? "Imported" : "From a recording", level: "My songs", notes });
      saveImported(); refreshOptions();
      msg.textContent = `Added “${title}” (${notes.length} notes).`;
      sfx("trained");
      showHome();
    } catch (e) {
      msg.textContent = e && /MIDI|notes|minutes|load/.test(e.message || "") ? e.message
        : isMidi ? "Couldn't read that file. It needs to be a .mid file." : "Couldn't read that recording. Try an MP3, M4A or WAV file.";
    } finally { $("importBtn").classList.remove("busy"); }
  };
  ui.mode.onchange = ui.hand.onchange = reset;
  ui.speed.oninput = () => ui.speedVal.textContent = ui.speed.value + "%";
  ui.start.onclick = () => { sfx("click"); toggle(); };
  try { if (localStorage.getItem("keyfall:sfx") === "0") ui.sfx.checked = false; } catch (e) {}
  ui.sfx.onchange = () => { try { localStorage.setItem("keyfall:sfx", ui.sfx.checked ? "1" : "0"); } catch (e) {} };
  ui.pause.onclick = toggle;
  try { if (localStorage.getItem("keyfall:ignoreTalk") === "0") ui.ignoreTalk.checked = false; } catch (e) {}
  try { const v = localStorage.getItem("keyfall:importAs"); if (v) ui.importAs.value = v; } catch (e) {}
  try { if (localStorage.getItem("keyfall:ai") === "0") ui.ai.checked = false; } catch (e) {}
  ui.ai.onchange = () => { try { localStorage.setItem("keyfall:ai", ui.ai.checked ? "1" : "0"); } catch (e) {} };
  ui.importAs.onchange = () => { try { localStorage.setItem("keyfall:importAs", ui.importAs.value); } catch (e) {} };
  ui.ignoreTalk.onchange = () => { try { localStorage.setItem("keyfall:ignoreTalk", ui.ignoreTalk.checked ? "1" : "0"); } catch (e) {} };
  ui.mic.onclick = toggleMic;
  ui.restart.onclick = () => { reset(); start(); };
  $("again").onclick = () => { reset(); start(); };
  $("close").onclick = showHome;
  document.querySelectorAll("select, button, input[type=checkbox]").forEach(el => el.addEventListener("change", () => el.blur()));
  document.querySelectorAll("button").forEach(el => el.addEventListener("click", () => el.blur()));

  window.addEventListener("resize", () => { layout(); grad = null; });
  layout(); songChanged(); showHome();
  requestAnimationFrame(frame);

  window.__keyfall = { mic, get drill() { return drill; }, get train() { return train; }, get calib() { return calib; }, get tmpl() { return tmpl; }, get state() { return state; }, get time() { return time; }, get song() { return song; }, get stats() { return { score, hits, misses, wrong }; } };
})();
