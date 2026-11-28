// 3D hit effects, drawn with three.js (MIT) on a see-through layer over the keyboard:
// sparks that burst out of the key toward you, a stream of tiny lights that rises from every sounding key and
// curls like smoke (the particle look of piano videos), twinkling glitter and a quick glow.
// It only draws while something is moving, so it costs nothing when you aren't playing.
import * as THREE from "./vendor/three/three.module.min.js";

const MAX = 48000;                                        // sparks, smoke and glitter alive at once

export function createFx(host) {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: "high-performance" });
  const canvas = renderer.domElement;
  canvas.className = "fx3d";
  canvas.setAttribute("aria-hidden", "true");
  host.after(canvas);
  renderer.setClearColor(0x000000, 0);
  // iPads drop a page's 3D drawing when memory is short or the app was in the background: then say so
  // (the next burst throws, and the app goes back to its flat sparks)
  let lost = false;
  canvas.addEventListener("webglcontextlost", e => { e.preventDefault(); lost = true; });
  // Light that adds up where sparks overlap, and also covers what's under it (so it shows on the white keys too):
  // the colour is added (premultiplied, as the page composites it); the see-through-ness blends normally.
  const glow = { transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor };

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 1, 10000);
  let W = 1, H = 1, dist = 1;

  // ---- sparks: one point cloud, soft round dots that grow as they fly toward you ----
  const pos = new Float32Array(MAX * 3), col = new Float32Array(MAX * 3), alpha = new Float32Array(MAX), size = new Float32Array(MAX);
  const vel = new Float32Array(MAX * 3), born = new Float32Array(MAX), life = new Float32Array(MAX).fill(0), base = new Float32Array(MAX);
  const glitter = new Uint8Array(MAX);                     // 0: a spark (flies out and falls); 1: glitter (floats, twinkles); 2: smoke
  const seed = new Float32Array(MAX);                      // smoke from one key shares a seed, so it curls together in wisps
  let ratio = Math.min(window.devicePixelRatio || 1, 2);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("alpha", new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("size", new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
  const sparkMat = new THREE.ShaderMaterial({
    uniforms: { scale: { value: 1 } },
    vertexShader: `
      attribute float alpha; attribute float size; attribute vec3 color;
      varying float vA; varying vec3 vC; uniform float scale;
      void main() {
        vA = alpha; vC = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = max(1.2, size * scale / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying float vA; varying vec3 vC;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        if (d > 1.0) discard;
        float core = 1.0 - smoothstep(0.55, 1.0, d);            // a crisp, tiny dot (no soft halo)
        gl_FragColor = vec4(vC, vA * core);                     // the colour as chosen
      }`,
    ...glow, blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const sparks = new THREE.Points(geo, sparkMat);
  sparks.frustumCulled = false;
  scene.add(sparks);
  let next = 0, madeAt = 0, sentAt = 0;

  // ---- a soft glow texture (for the flash and the ripple rings) ----
  const glowTex = (() => {
    const c = document.createElement("canvas"); c.width = c.height = 128;
    const g = c.getContext("2d"), r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(0.25, "rgba(255,255,255,.55)"); r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r; g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const ringGeo = new THREE.RingGeometry(0.97, 1, 96);
  const flashGeo = new THREE.PlaneGeometry(1, 1);
  const pool = [];                                         // rings and flashes, reused
  function piece(kind) {
    let p = pool.find(q => !q.mesh.visible && q.kind === kind);
    if (!p) {
      const mat = new THREE.MeshBasicMaterial({ ...glow, side: THREE.DoubleSide,
        map: kind === "flash" ? glowTex : null });
      p = { kind, mesh: new THREE.Mesh(kind === "ring" ? ringGeo : flashGeo, mat) };
      scene.add(p.mesh); pool.push(p);
    }
    p.mesh.visible = true;
    return p;
  }

  // screen pixels (from the top left of the stage) → the 3D plane the camera sees at 1:1
  const toWorld = (x, y) => [x - W / 2, H / 2 - y];

  function resize(w, h, pr) {
    W = Math.max(1, w); H = Math.max(1, h);
    if (pr) ratio = Math.min(pr, 2);                       // (tiny dots gain nothing from more, and it costs speed)
    renderer.setPixelRatio(ratio);
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    dist = H / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    camera.position.set(0, 0, dist); camera.lookAt(0, 0, 0);
    camera.near = 1; camera.far = dist * 4; camera.updateProjectionMatrix();
    sparkMat.uniforms.scale.value = dist * renderer.getPixelRatio();
    kick();
  }

  // a hit on the key whose top centre is at (x, y) on the stage
  function burst(x, y, color, big, keyW = 20) {
    if (lost || renderer.getContext().isContextLost()) throw new Error("3D drawing was lost");
    const [wx, wy] = toWorld(x, y), c = new THREE.Color(color), now = performance.now() / 1000;
    // only tiny lights (no big sparks, no glowing blobs): a burst shaped by the chosen motion
    const a = style.amount, m = style.motion;
    if (m === "shock") spawn(5, wx, wy, keyW, Math.round((big ? 420 : 200) * a));
    else if (m === "fountain") spawn(3, wx, wy, keyW, Math.round((big ? 260 : 120) * a));
    else if (m === "embers") spawn(4, wx, wy, keyW, Math.round((big ? 200 : 90) * a));
    else smoke(wx, wy, c, keyW * 1.3, Math.round((big ? 500 : 220) * a), Math.random() * 10, 1.4);
    kick();
  }

  // glitter: tiny lights that float up from the key and drift and twinkle as they fade
  function sprinkle(wx, wy, c, keyW, n, speed = 1) {
    const now = performance.now() / 1000;
    for (let i = 0; i < n; i++) {
      const k = next; next = (next + 1) % MAX; madeAt++;
      pos[k * 3] = wx + (Math.random() - 0.5) * keyW * 0.9; pos[k * 3 + 1] = wy + Math.random() * 6; pos[k * 3 + 2] = Math.random() * 40;
      vel[k * 3] = (Math.random() - 0.5) * 60 * speed;
      vel[k * 3 + 1] = (50 + Math.random() * 190) * speed;
      vel[k * 3 + 2] = Math.random() * 90 * speed;
      const white = Math.random() < 0.45, f = 0.75 + Math.random() * 0.25;
      col[k * 3] = white ? 1 : c.r * f; col[k * 3 + 1] = white ? 0.92 : c.g * f; col[k * 3 + 2] = white ? 0.94 : c.b * f;
      born[k] = now; life[k] = 0.9 + Math.random() * 1.3;
      base[k] = 2.4 + Math.random() * 2.4; glitter[k] = 1;
    }
  }
  // How the particles look and move (set from the app's Effects settings)
  //   motion: trails (thin curling sparkle trails), smoke (wide, slow, soft), fountain (shoot up and fall back),
  //   embers (flickering, wandering sparks of fire), shock (a ring bursting outward on every hit, light trails)
  const style = { motion: "trails", color: new THREE.Color("#ffd6de"), amount: 1, size: 1, vivid: 0 };
  function setStyle(o) { if (o.motion) style.motion = o.motion; if (o.color) style.color = new THREE.Color(o.color); if (o.amount != null) style.amount = o.amount; if (o.size != null) style.size = o.size; if (o.vivid != null) style.vivid = o.vivid; }
  function paint(k) {                                      // exactly the chosen colour (no white mixed in); when vivid, all at full strength
    const c = style.color, bright = Math.min(1, 0.8 + 0.1 * style.vivid), b = bright + Math.random() * (1 - bright);
    col[k * 3] = c.r * b; col[k * 3 + 1] = c.g * b; col[k * 3 + 2] = c.b * b;
  }
  function spawn(kind, wx, wy, keyW, n) {
    const now = performance.now() / 1000;
    for (let i = 0; i < n; i++) {
      const k = next; next = (next + 1) % MAX; madeAt++;
      pos[k * 3 + 2] = Math.random() * 8; vel[k * 3 + 2] = Math.random() * 6; paint(k); born[k] = now; glitter[k] = kind;
      if (kind === 3) {                                    // fountain
        pos[k * 3] = wx + (Math.random() - 0.5) * keyW * 0.5; pos[k * 3 + 1] = wy;
        vel[k * 3] = (Math.random() - 0.5) * 180; vel[k * 3 + 1] = 260 + Math.random() * 260;
        life[k] = 1.1 + Math.random() * 0.8; base[k] = (0.9 + Math.random() * 1.1) * style.size;
      } else if (kind === 4) {                             // embers
        pos[k * 3] = wx + (Math.random() - 0.5) * keyW * 0.7; pos[k * 3 + 1] = wy + Math.random() * 4;
        vel[k * 3] = (Math.random() - 0.5) * 30; vel[k * 3 + 1] = 70 + Math.random() * 110;
        life[k] = 1.4 + Math.random() * 1.6; base[k] = (1.2 + Math.random() * 1.6) * style.size;
      } else if (kind === 5) {                             // shockwave ring
        const a = Math.random() * Math.PI * 2, v = 220 + Math.random() * 200;
        pos[k * 3] = wx; pos[k * 3 + 1] = wy;
        vel[k * 3] = Math.cos(a) * v * 1.4; vel[k * 3 + 1] = Math.abs(Math.sin(a)) * v * 0.8 + 20; vel[k * 3 + 2] = Math.sin(a) * v;
        life[k] = 0.6 + Math.random() * 0.5; base[k] = (0.9 + Math.random() * 0.9) * style.size;
      } else {                                             // smoke: wide, slow, every particle its own swirl
        pos[k * 3] = wx + (Math.random() - 0.5) * keyW * 1.3; pos[k * 3 + 1] = wy + Math.random() * 6;
        vel[k * 3] = (Math.random() - 0.5) * 20; vel[k * 3 + 1] = 25 + Math.random() * 60;
        life[k] = 2.5 + Math.random() * 2.5; base[k] = (0.7 + Math.random() * 0.8) * style.size; seed[k] = Math.random() * 20; glitter[k] = 2;
      }
    }
  }
  // smoke: a fine stream of tiny lights that rises slowly and curls (all the smoke of one key follows one swirl)
  function smoke(wx, wy, c, keyW, n, sd, speed = 1) {
    const now = performance.now() / 1000;
    for (let i = 0; i < n; i++) {
      const k = next; next = (next + 1) % MAX; madeAt++;
      // from a narrow spot on the key they shoot up, slow down and hang in the air, drifting together in curling
      // strands (as in piano videos); a few stray from the strand
      const stray = Math.random() < 0.12;
      pos[k * 3] = wx + (Math.random() - 0.5) * keyW * 0.3; pos[k * 3 + 1] = wy + Math.random() * 4; pos[k * 3 + 2] = Math.random() * 8;
      vel[k * 3] = (Math.random() - 0.5) * (stray ? 60 : 10) * speed;
      vel[k * 3 + 1] = (110 + Math.random() * 230) * speed;
      vel[k * 3 + 2] = Math.random() * 6;
      paint(k);
      born[k] = now; life[k] = 2.2 + Math.random() * 2.6;
      // most are tiny pinpoints; some are brighter sparkles of different sizes
      const r = Math.random();
      base[k] = (r < 0.05 ? 2.4 + Math.random() * 1.4 : r < 0.25 ? 1.3 + Math.random() * 0.9 : 0.7 + Math.random() * 0.5) * style.size;
      glitter[k] = 2; seed[k] = sd + (stray ? Math.random() * 3 : Math.random() * 0.12);
    }
  }
  // a key that is sounding (held, or played by the app): a steady stream of smoke and a little glitter (per second)
  const tally = new Map();
  const RATE = { trails: 650, smoke: 900, fountain: 220, embers: 170, shock: 260 };
  function emit(x, y, color, keyW, dt, key = 0) {
    if (lost) return;
    const want = (RATE[style.motion] || 650) * style.amount * dt + (tally.get(key) || 0), n = Math.floor(want);
    tally.set(key, want - n);
    if (!n) return;
    const [wx, wy] = toWorld(x, y), m = style.motion;
    if (m === "fountain") spawn(3, wx, wy, keyW, n);
    else if (m === "embers") spawn(4, wx, wy, keyW, n);
    else if (m === "smoke") spawn(2, wx, wy, keyW, n);
    else smoke(wx, wy, null, keyW, n, key * 1.37);        // trails (and the light trails of "shock")
    kick();
  }

  let raf = 0, last = 0;
  function kick() { if (!raf) { last = performance.now() / 1000; raf = requestAnimationFrame(frame); } }
  function frame() {
    raf = 0;
    const now = performance.now() / 1000, dt = Math.min(0.05, now - last); last = now;
    let alive = 0;
    const drag = Math.pow(0.35, dt), float = Math.pow(0.75, dt), lo = Math.min(0.7, 0.1 + 0.25 * style.vivid);   // (vivid: they twinkle without going dim)
    for (let k = 0; k < MAX; k++) {
      if (!life[k]) continue;
      const age = (now - born[k]) / life[k];
      if (age >= 1) { life[k] = 0; alpha[k] = 0; size[k] = 0; continue; }
      alive++;
      const kind = glitter[k];
      if (kind === 3) { vel[k * 3] *= Math.pow(0.6, dt); vel[k * 3 + 1] -= 520 * dt; }                   // fountain: falls back
      else if (kind === 4) {                               // embers: wander and drift up
        vel[k * 3] = (vel[k * 3] + (Math.random() - 0.5) * 420 * dt) * Math.pow(0.3, dt); vel[k * 3 + 1] += 18 * dt;
      } else if (kind === 5) { const d = Math.pow(0.06, dt); vel[k * 3] *= d; vel[k * 3 + 1] *= d; vel[k * 3 + 2] *= d; }   // ring: slows quickly
      else if (kind === 2) {                               // smoke: follows a slowly turning swirl as it rises
        const y = pos[k * 3 + 1], sd = seed[k];
        const want = Math.sin(y * 0.012 + sd * 3.1 + now * 0.45) * 62 + Math.sin(y * 0.031 - now * 0.8 + sd * 5.3) * 30;
        vel[k * 3] += (want - vel[k * 3]) * Math.min(1, dt * 3);
        vel[k * 3 + 1] = vel[k * 3 + 1] * Math.pow(0.5, dt) + 16 * dt; vel[k * 3 + 2] *= float;   // slows down, then hangs and drifts
      } else if (glitter[k]) {                             // glitter: rises gently and swirls
        vel[k * 3] = vel[k * 3] * float + Math.sin(now * 2.1 + k * 1.7 + pos[k * 3 + 1] * 0.015) * 160 * dt;
        vel[k * 3 + 1] = vel[k * 3 + 1] * float + 40 * dt; vel[k * 3 + 2] *= float;
      } else {
        vel[k * 3] *= drag; vel[k * 3 + 2] *= drag; vel[k * 3 + 1] = vel[k * 3 + 1] * drag - 900 * dt;   // air and gravity
      }
      pos[k * 3] += vel[k * 3] * dt; pos[k * 3 + 1] += vel[k * 3 + 1] * dt; pos[k * 3 + 2] += vel[k * 3 + 2] * dt;
      if (kind >= 3) {
        alpha[k] = kind === 4 ? (1 - age) * (0.45 + 0.55 * Math.abs(Math.sin(now * 17 + k * 1.7)))      // flicker
          : Math.pow(1 - age, kind === 5 ? 1.6 : 1.2) * Math.min(1, age * 14);
        size[k] = base[k] * (1 - age * 0.3);
        continue;
      }
      if (kind === 2) {
        // bright, crisp points that sparkle (each twinkles at its own pace) and fade near the end
        alpha[k] = Math.min(1, (1 - age) * 2.2) * Math.min(1, age * 14) * (lo + (1 - lo) * (0.5 + 0.5 * Math.sin(now * (5 + (k % 7)) + k * 2.3)));
        size[k] = base[k] * (1 - age * 0.25);
        continue;
      }
      alpha[k] = Math.pow(1 - age, 1.3) * Math.min(1, age * 12);
      if (glitter[k]) alpha[k] *= 0.5 + 0.5 * Math.sin(now * (9 + (k % 7) * 2) + k);          // twinkle
      size[k] = base[k] * (1 - age * 0.5);
    }
    for (const p of pool) {
      if (!p.mesh.visible) continue;
      const a = (now - p.t0) / p.dur;
      if (a >= 1) { p.mesh.visible = false; continue; }
      alive++;
      const e = 1 - Math.pow(1 - a, 3);
      if (p.kind === "ring") { const r = p.r * (0.25 + e); p.mesh.scale.set(r, r, r); p.mesh.material.opacity = (1 - a) * (1 - a) * 0.5; }
      else { const r = p.r * (0.6 + 0.6 * e); p.mesh.scale.set(r, r, r); p.mesh.material.opacity = (1 - a) * (1 - a); }
    }
    // only what changed goes to the graphics chip: colours only when new particles were made
    for (const n of ["position", "alpha", "size"]) geo.attributes[n].needsUpdate = true;
    if (madeAt !== sentAt) { geo.attributes.color.needsUpdate = true; sentAt = madeAt; }
    renderer.render(scene, camera);
    if (api.onRender) api.onRender(canvas);                // (the app copies the picture for its glow, right after it is drawn)
    if (alive) raf = requestAnimationFrame(frame);
  }

  function dispose() {
    cancelAnimationFrame(raf); raf = 0;
    geo.dispose(); sparkMat.dispose(); ringGeo.dispose(); flashGeo.dispose(); glowTex.dispose();
    pool.forEach(p => p.mesh.material.dispose());
    renderer.dispose(); renderer.forceContextLoss(); canvas.remove();   // (hand the graphics memory back right away)
  }

  const api = { burst, emit, resize, dispose, setStyle, canvas, onRender: null };
  return api;
}
