(() => {
  "use strict";
  const LOW = 48, HIGH = 84;            // C3..C6
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
    streak: $("streak"), acc: $("acc"), midi: $("midi"), hint: $("hint"), results: $("results"),
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
    let t = 0;
    for (const tok of (str || "").split(/\s+/)) {
      if (!tok || tok === "|") continue;
      const [names, d] = tok.split(":");
      const dur = (d ? parseFloat(d) : 1) * beat;
      if (names !== "R") for (const n of names.split("+"))
        out.push({ midi: toMidi(n), start: t, dur, hand, state: "pending", played: false });
      t += dur;
    }
    return t;
  }
  function loadSong(def) {
    const notes = [], beat = 60 / def.bpm;
    const end = Math.max(parseTrack(def.right, "right", beat, notes), parseTrack(def.left, "left", beat, notes));
    notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
    return { def, notes, end };
  }

  // ---------- Game state ----------
  let song = null, state = "idle";      // idle | running | paused | done
  let time = 0, score = 0, streak = 0, bestStreak = 0, hits = 0, perfects = 0, misses = 0, wrong = 0;
  const down = new Set(), autoDown = new Map(), flashes = [];

  const mode = () => ui.mode.value;
  const isUser = n => mode() !== "listen" && (ui.hand.value === "both" || n.hand === ui.hand.value);

  function reset() {
    song = loadSong(SONGS[ui.song.value]);
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
    $("resTitle").textContent = song.def.title;
    $("stars").innerHTML = [0, 1, 2].map(i => `<span class="${i < stars ? "" : "off"}">★</span>`).join("");
    $("resBody").textContent = mode() === "play"
      ? `Score ${score} · Accuracy ${acc}% · ${perfects} perfect · ${misses} missed · ${wrong} wrong · best streak ${bestStreak}`
      : `Accuracy ${acc}% · ${wrong} wrong notes · best streak ${bestStreak}`;
    $("resBest").textContent = score > best ? "New best score!" : `Best: ${best}`;
    ui.results.hidden = false;
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
      const on = down.has(k.midi) || autoDown.has(k.midi);
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
    step(Math.min((now - last) / 1000, 0.1)); last = now;
    draw();
    requestAnimationFrame(frame);
  }

  // ---------- Input ----------
  window.addEventListener("keydown", e => {
    if (e.ctrlKey || e.metaKey || e.altKey || /^(SELECT|INPUT)$/.test(e.target.tagName) && e.key !== " ") return;
    if (e.key === " ") { e.preventDefault(); if (!e.repeat) toggle(); return; }
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
  SONGS.forEach((s, i) => ui.song.add(new Option(s.title, i)));
  function songChanged() {
    const hasLeft = !!SONGS[ui.song.value].left;
    for (const o of ui.hand.options) o.disabled = o.value !== "right" && !hasLeft;
    if (!hasLeft) ui.hand.value = "right";
    reset();
  }
  ui.song.onchange = songChanged;
  ui.mode.onchange = ui.hand.onchange = reset;
  ui.speed.oninput = () => ui.speedVal.textContent = ui.speed.value + "%";
  ui.start.onclick = toggle;
  ui.restart.onclick = () => { reset(); start(); };
  $("again").onclick = () => { reset(); start(); };
  $("close").onclick = reset;
  document.querySelectorAll("select, button").forEach(el => el.addEventListener("change", () => el.blur()));
  document.querySelectorAll("button").forEach(el => el.addEventListener("click", () => el.blur()));

  window.addEventListener("resize", layout);
  layout(); songChanged();
  requestAnimationFrame(frame);

  window.__keyfall = { get state() { return state; }, get time() { return time; }, get song() { return song; }, get stats() { return { score, hits, misses, wrong }; } };
})();
