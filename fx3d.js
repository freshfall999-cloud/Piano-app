// 3D hit effects, drawn with three.js (MIT) on a see-through layer over the keyboard:
// sparks that burst out of the key toward you, a stream of tiny lights that rises from every sounding key and
// curls like smoke (the particle look of piano videos), twinkling glitter and a quick glow.
// It only draws while something is moving, so it costs nothing when you aren't playing.
import * as THREE from "./vendor/three/three.module.min.js";

const MAX = 12000;                                        // sparks, smoke and glitter alive at once

export function createFx(host) {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: "low-power" });
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
        gl_PointSize = max(1.4, size * scale / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying float vA; varying vec3 vC;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        if (d > 1.0) discard;
        float core = pow(1.0 - d, 1.6);
        gl_FragColor = vec4(mix(vC, vec3(1.0), core * 0.7) * 1.5, vA * min(1.0, core * 1.8));   // (brighter than the colour: it glows)
      }`,
    ...glow,
  });
  const sparks = new THREE.Points(geo, sparkMat);
  sparks.frustumCulled = false;
  scene.add(sparks);
  let next = 0;

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
    if (pr) ratio = pr;
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
    const n = big ? 70 : 40;
    for (let i = 0; i < n; i++) {                            // sparks
      const k = next; next = (next + 1) % MAX;
      const a = (Math.random() - 0.5) * 2.2, up = 220 + Math.random() * (big ? 520 : 360);
      pos[k * 3] = wx + (Math.random() - 0.5) * keyW * 0.6; pos[k * 3 + 1] = wy; pos[k * 3 + 2] = 0;
      vel[k * 3] = Math.sin(a) * up * 0.55;
      vel[k * 3 + 1] = Math.cos(a) * up;
      vel[k * 3 + 2] = (0.2 + Math.random()) * (big ? 520 : 380);   // out of the screen, toward you
      const white = Math.random() < 0.22;
      col[k * 3] = white ? 1 : c.r; col[k * 3 + 1] = white ? 1 : c.g; col[k * 3 + 2] = white ? 1 : c.b;
      born[k] = now; life[k] = 0.45 + Math.random() * (big ? 0.65 : 0.4);
      base[k] = 5 + Math.random() * (big ? 11 : 7); glitter[k] = 0;
    }
    sprinkle(wx, wy, c, keyW, big ? 50 : 26, 1.3);
    smoke(wx, wy, c, keyW * 1.4, big ? 160 : 90, Math.random() * 10, 1.6);
    if (big) sprinkle(wx, wy, new THREE.Color(1, 1, 1), keyW * 3, 60, 1.8);   // a streak: an extra fountain of white glitter
    // and a quick glow where the key was struck
    const fl = piece("flash");
    fl.mesh.material.color.copy(c);
    fl.mesh.position.set(wx, wy, 1);
    fl.mesh.rotation.set(0, 0, 0);
    fl.t0 = now; fl.dur = big ? 0.4 : 0.28; fl.r = keyW * (big ? 3.6 : 2.4);
    kick();
  }

  // glitter: tiny lights that float up from the key and drift and twinkle as they fade
  function sprinkle(wx, wy, c, keyW, n, speed = 1) {
    const now = performance.now() / 1000;
    for (let i = 0; i < n; i++) {
      const k = next; next = (next + 1) % MAX;
      pos[k * 3] = wx + (Math.random() - 0.5) * keyW * 0.9; pos[k * 3 + 1] = wy + Math.random() * 6; pos[k * 3 + 2] = Math.random() * 40;
      vel[k * 3] = (Math.random() - 0.5) * 60 * speed;
      vel[k * 3 + 1] = (50 + Math.random() * 190) * speed;
      vel[k * 3 + 2] = Math.random() * 90 * speed;
      const white = Math.random() < 0.45, f = 0.75 + Math.random() * 0.25;
      col[k * 3] = white ? 1 : c.r * f; col[k * 3 + 1] = white ? 0.92 : c.g * f; col[k * 3 + 2] = white ? 0.94 : c.b * f;
      born[k] = now; life[k] = 0.9 + Math.random() * 1.3;
      base[k] = 5 + Math.random() * 8; glitter[k] = 1;
    }
  }
  // smoke: a fine stream of tiny lights that rises slowly and curls (all the smoke of one key follows one swirl)
  function smoke(wx, wy, c, keyW, n, sd, speed = 1) {
    const now = performance.now() / 1000;
    for (let i = 0; i < n; i++) {
      const k = next; next = (next + 1) % MAX;
      pos[k * 3] = wx + (Math.random() - 0.5) * keyW * 0.75; pos[k * 3 + 1] = wy + Math.random() * 5; pos[k * 3 + 2] = Math.random() * 14;
      vel[k * 3] = (Math.random() - 0.5) * 14 * speed;
      vel[k * 3 + 1] = (22 + Math.random() * 55) * speed;
      vel[k * 3 + 2] = Math.random() * 10;
      const pale = Math.random() < 0.62, b = 0.8 + Math.random() * 0.2;
      if (pale) { col[k * 3] = b; col[k * 3 + 1] = 0.84 * b; col[k * 3 + 2] = 0.88 * b; }
      else { col[k * 3] = c.r * b; col[k * 3 + 1] = c.g * b; col[k * 3 + 2] = c.b * b; }
      born[k] = now; life[k] = 2.2 + Math.random() * 2.2;
      base[k] = 2 + Math.random() * 2.8; glitter[k] = 2; seed[k] = sd + Math.random() * 0.5;
    }
  }
  // a key that is sounding (held, or played by the app): a steady stream of smoke and a little glitter (per second)
  const tally = new Map();
  function emit(x, y, color, keyW, dt, rate = 220, key = 0) {
    if (lost) return;
    const want = rate * dt + (tally.get(key) || 0), n = Math.floor(want);
    tally.set(key, want - n);
    const [wx, wy] = toWorld(x, y), c = new THREE.Color(color);
    if (n) smoke(wx, wy, c, keyW, n, key * 1.37);
    if (Math.random() < 14 * dt) sprinkle(wx, wy, c, keyW, 1);
    kick();
  }

  let raf = 0, last = 0;
  function kick() { if (!raf) { last = performance.now() / 1000; raf = requestAnimationFrame(frame); } }
  function frame() {
    raf = 0;
    const now = performance.now() / 1000, dt = Math.min(0.05, now - last); last = now;
    let alive = 0;
    const drag = Math.pow(0.35, dt), float = Math.pow(0.75, dt);
    for (let k = 0; k < MAX; k++) {
      if (!life[k]) { alpha[k] = 0; size[k] = 0; continue; }
      const age = (now - born[k]) / life[k];
      if (age >= 1) { life[k] = 0; alpha[k] = 0; size[k] = 0; continue; }
      alive++;
      if (glitter[k] === 2) {                              // smoke: follows a slowly turning swirl as it rises
        const y = pos[k * 3 + 1], sd = seed[k];
        const want = Math.sin(y * 0.011 + sd * 3.1 + now * 0.6) * 38 + Math.sin(y * 0.027 - now * 1.1 + sd * 5.3) * 16;
        vel[k * 3] += (want - vel[k * 3]) * Math.min(1, dt * 2.2);
        vel[k * 3 + 1] = Math.min(150, vel[k * 3 + 1] + 24 * dt); vel[k * 3 + 2] *= float;
      } else if (glitter[k]) {                             // glitter: rises gently and swirls
        vel[k * 3] = vel[k * 3] * float + Math.sin(now * 2.1 + k * 1.7 + pos[k * 3 + 1] * 0.015) * 160 * dt;
        vel[k * 3 + 1] = vel[k * 3 + 1] * float + 40 * dt; vel[k * 3 + 2] *= float;
      } else {
        vel[k * 3] *= drag; vel[k * 3 + 2] *= drag; vel[k * 3 + 1] = vel[k * 3 + 1] * drag - 900 * dt;   // air and gravity
      }
      pos[k * 3] += vel[k * 3] * dt; pos[k * 3 + 1] += vel[k * 3 + 1] * dt; pos[k * 3 + 2] += vel[k * 3 + 2] * dt;
      if (glitter[k] === 2) {
        alpha[k] = Math.pow(1 - age, 1.6) * Math.min(1, age * 14) * (0.75 + 0.25 * Math.sin(now * (6 + (k % 5)) + k));
        size[k] = base[k] * (1 - age * 0.3);
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
    for (const n of ["position", "color", "alpha", "size"]) geo.attributes[n].needsUpdate = true;
    renderer.render(scene, camera);
    if (alive) raf = requestAnimationFrame(frame);
  }

  function dispose() {
    cancelAnimationFrame(raf); raf = 0;
    geo.dispose(); sparkMat.dispose(); ringGeo.dispose(); flashGeo.dispose(); glowTex.dispose();
    pool.forEach(p => p.mesh.material.dispose());
    renderer.dispose(); renderer.forceContextLoss(); canvas.remove();   // (hand the graphics memory back right away)
  }

  return { burst, emit, resize, dispose };
}
