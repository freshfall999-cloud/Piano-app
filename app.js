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
    streak: $("streak"), mic: $("mic"), acc: $("acc"), midi: $("midi"), hint: $("hint"), results: $("results"),
  };

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
    if (down.has(midi)) return;
    down.add(midi); noteOn(midi, vel);
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
      } else if (mode() === "play" && n.state === "pending" && time > n.start + HIT_WINDOW) {
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

  // ---------- Microphone listening ----------
  // Hears an acoustic/digital piano through the mic. Single notes are found by pitch
  // detection (YIN); chords are confirmed by looking for each expected note in the spectrum.
  const mic = { on: false, analyser: null, stream: null, buf: null, spec: null, note: null, cand: null, count: 0, rms: [], lastTrig: 0 };
  const sameNote = (a, b) => a === b || Math.abs(a - b) === 12;   // forgive octave slips of the detector

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
    mic.buf = new Float32Array(mic.analyser.fftSize);
    mic.spec = new Float32Array(mic.analyser.frequencyBinCount);
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

  function heard(midi) {               // the mic picked up a freshly struck note
    mic.lastTrig = performance.now();
    if (state !== "running" || mode() === "listen") return;
    let n = null;
    if (mode() === "practice") {
      const g = nextGroup();
      if (g.length && g[0].start - time <= 0.35) n = g.find(n => sameNote(n.midi, midi));
    } else {
      for (const c of song.notes)
        if (c.state === "pending" && isUser(c) && sameNote(c.midi, midi) && Math.abs(c.start - time) <= HIT_WINDOW &&
            (!n || Math.abs(c.start - time) < Math.abs(n.start - time))) n = c;
    }
    if (n) registerHit(n, mode() === "practice" || Math.abs(n.start - time) <= PERFECT);
  }

  function micTick() {
    if (!mic.on) return;
    mic.analyser.getFloatTimeDomainData(mic.buf);
    const x = mic.buf.subarray(mic.buf.length - 4096);
    let e = 0;
    for (let i = 0; i < x.length; i++) e += x[i] * x[i];
    const rms = Math.sqrt(e / x.length);
    mic.rms.push(rms); if (mic.rms.length > 5) mic.rms.shift();
    if (rms < 0.008) { mic.note = mic.cand = null; mic.count = 0; return; }
    const f = detectPitch(x, ac.sampleRate);
    const midi = f ? Math.round(69 + 12 * Math.log2(f / 440)) : null;
    if (midi !== null && midi >= 33 && midi <= 105) {
      if (midi === mic.cand) mic.count++; else { mic.cand = midi; mic.count = 1; }
      if (mic.count >= 2) {
        const restruck = rms > mic.rms[0] * 1.5 && performance.now() - mic.lastTrig > 120;
        if (midi !== mic.note || restruck) { mic.note = midi; heard(midi); }
      }
    }
    // chords: check each expected note's fundamental in the spectrum
    if (state === "running" && mode() === "practice") {
      const g = nextGroup();
      if (!g.length || g[0].start - time > 0.05) return;
      if (song.notes.filter(n => isUser(n) && Math.abs(n.start - g[0].start) < 1e-6).length < 2) return;
      mic.analyser.getFloatFrequencyData(mic.spec);
      const hz = ac.sampleRate / mic.analyser.fftSize;
      let avg = 0, cnt = 0;
      for (let b = Math.round(100 / hz); b < 2000 / hz; b++) { avg += mic.spec[b]; cnt++; }
      avg /= cnt;
      for (const n of g) {
        const b = Math.round(440 * Math.pow(2, (n.midi - 69) / 12) / hz);
        const peak = Math.max(mic.spec[b - 1], mic.spec[b], mic.spec[b + 1]);
        if (peak > -60 && peak > avg + 20) registerHit(n, true);
      }
    }
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
    if (song) {
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
    const lab = ui.labels.value;
    ctx.textAlign = "center";
    for (const pass of [false, true]) for (const k of keys) {
      if (k.black !== pass) continue;
      const on = down.has(k.midi) || autoDown.has(k.midi) || mic.note === k.midi;
      ctx.fillStyle = on ? "#39b6ff" : target.has(k.midi) ? (pass ? "#2e7d4f" : "#a8f0c0") : pass ? "#181a22" : "#f4f5f9";
      rrect(k.x + (pass ? 0 : 1), kbTop, k.w - (pass ? 0 : 2), k.h - 2, 4); ctx.fill();
      if (lab === "off") continue;
      const text = lab === "keys" ? KEYLABEL[k.midi] : (pass ? "" : NAMES[k.midi % 12] + (k.midi % 12 === 0 ? Math.floor(k.midi / 12) - 1 : ""));
      if (!text || k.w < 11) continue;
      ctx.font = `${Math.max(9, Math.min(13, k.w * 0.55))}px system-ui, sans-serif`;
      ctx.fillStyle = pass ? "#9aa0b8" : "#5a6078";
      ctx.fillText(text, k.x + k.w / 2, kbTop + k.h - 10);
    }
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
    // countdown / progress
    if (song && state !== "idle") {
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
    if (e.key === " ") { e.preventDefault(); if (!e.repeat && $("home").hidden) toggle(); return; }
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
    if (!hasLeft) ui.hand.value = "right";
    $("title").textContent = SONGS[ui.song.value].title;
    reset();
  }
  ui.song.onchange = songChanged;

  // ---------- Song library screen ----------
  function showHome() {
    if (state === "running") pause();
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
  document.querySelectorAll("select, button").forEach(el => el.addEventListener("change", () => el.blur()));
  document.querySelectorAll("button").forEach(el => el.addEventListener("click", () => el.blur()));

  window.addEventListener("resize", layout);
  layout(); songChanged(); showHome();
  requestAnimationFrame(frame);

  window.__keyfall = { get state() { return state; }, get time() { return time; }, get song() { return song; }, get stats() { return { score, hits, misses, wrong }; } };
})();
