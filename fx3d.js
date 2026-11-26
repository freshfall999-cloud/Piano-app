// 3D hit effects, drawn with three.js (MIT) on a see-through layer over the keyboard:
// sparks that burst out of the key toward you, a ring of light rippling across the keys and a quick glow.
// It only draws while something is moving, so it costs nothing when you aren't playing.
import * as THREE from "./vendor/three/three.module.min.js";

const MAX = 1600;                                         // sparks alive at once

export function createFx(host) {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: "low-power", premultipliedAlpha: false });
  const canvas = renderer.domElement;
  canvas.className = "fx3d";
  canvas.setAttribute("aria-hidden", "true");
  host.after(canvas);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 1, 10000);
  let W = 1, H = 1, dist = 1;

  // ---- sparks: one point cloud, soft round dots that grow as they fly toward you ----
  const pos = new Float32Array(MAX * 3), col = new Float32Array(MAX * 3), alpha = new Float32Array(MAX), size = new Float32Array(MAX);
  const vel = new Float32Array(MAX * 3), born = new Float32Array(MAX), life = new Float32Array(MAX).fill(0), base = new Float32Array(MAX);
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
        gl_PointSize = size * scale / -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying float vA; varying vec3 vC;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        if (d > 1.0) discard;
        float core = pow(1.0 - d, 1.6);
        gl_FragColor = vec4(mix(vC, vec3(1.0), core * 0.7), vA * min(1.0, core * 1.6));
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
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
  const ringGeo = new THREE.RingGeometry(0.93, 1, 72);
  const flashGeo = new THREE.PlaneGeometry(1, 1);
  const pool = [];                                         // rings and flashes, reused
  function piece(kind) {
    let p = pool.find(q => !q.mesh.visible && q.kind === kind);
    if (!p) {
      const mat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        map: kind === "flash" ? glowTex : null });
      p = { kind, mesh: new THREE.Mesh(kind === "ring" ? ringGeo : flashGeo, mat) };
      scene.add(p.mesh); pool.push(p);
    }
    p.mesh.visible = true;
    return p;
  }

  // screen pixels (from the top left of the stage) → the 3D plane the camera sees at 1:1
  const toWorld = (x, y) => [x - W / 2, H / 2 - y];

  function resize(w, h) {
    W = Math.max(1, w); H = Math.max(1, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
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
    const [wx, wy] = toWorld(x, y), c = new THREE.Color(color), now = performance.now() / 1000;
    const n = big ? 80 : 44;
    for (let i = 0; i < n; i++) {
      const k = next; next = (next + 1) % MAX;
      const a = (Math.random() - 0.5) * 2.2, up = 220 + Math.random() * (big ? 520 : 360);
      pos[k * 3] = wx + (Math.random() - 0.5) * keyW * 0.6; pos[k * 3 + 1] = wy; pos[k * 3 + 2] = 0;
      vel[k * 3] = Math.sin(a) * up * 0.55;
      vel[k * 3 + 1] = Math.cos(a) * up;
      vel[k * 3 + 2] = (0.2 + Math.random()) * (big ? 520 : 380);   // out of the screen, toward you
      const white = Math.random() < 0.3;
      col[k * 3] = white ? 1 : c.r; col[k * 3 + 1] = white ? 1 : c.g; col[k * 3 + 2] = white ? 1 : c.b;
      born[k] = now; life[k] = 0.55 + Math.random() * (big ? 0.75 : 0.5);
      base[k] = 9 + Math.random() * (big ? 14 : 9);
    }
    // a ring of light spreading over the keys (lying flat, seen at an angle)
    const ring = piece("ring");
    ring.mesh.material.color.copy(c);
    ring.mesh.position.set(wx, wy - 4, 0);
    ring.mesh.rotation.set(-1.15, 0, 0);
    ring.t0 = now; ring.dur = big ? 0.75 : 0.55; ring.r = keyW * (big ? 4.2 : 3);
    // and a quick glow where the key was struck
    const fl = piece("flash");
    fl.mesh.material.color.copy(c);
    fl.mesh.position.set(wx, wy, 1);
    fl.mesh.rotation.set(0, 0, 0);
    fl.t0 = now; fl.dur = big ? 0.45 : 0.32; fl.r = keyW * (big ? 5 : 3.4);
    kick();
  }

  let raf = 0, last = 0;
  function kick() { if (!raf) { last = performance.now() / 1000; raf = requestAnimationFrame(frame); } }
  function frame() {
    raf = 0;
    const now = performance.now() / 1000, dt = Math.min(0.05, now - last); last = now;
    let alive = 0;
    const drag = Math.pow(0.35, dt);
    for (let k = 0; k < MAX; k++) {
      if (!life[k]) { alpha[k] = 0; size[k] = 0; continue; }
      const age = (now - born[k]) / life[k];
      if (age >= 1) { life[k] = 0; alpha[k] = 0; size[k] = 0; continue; }
      alive++;
      vel[k * 3] *= drag; vel[k * 3 + 2] *= drag; vel[k * 3 + 1] = vel[k * 3 + 1] * drag - 900 * dt;   // air and gravity
      pos[k * 3] += vel[k * 3] * dt; pos[k * 3 + 1] += vel[k * 3 + 1] * dt; pos[k * 3 + 2] += vel[k * 3 + 2] * dt;
      alpha[k] = (1 - age) * (1 - age) * Math.min(1, age * 12);
      size[k] = base[k] * (1 - age * 0.5);
    }
    for (const p of pool) {
      if (!p.mesh.visible) continue;
      const a = (now - p.t0) / p.dur;
      if (a >= 1) { p.mesh.visible = false; continue; }
      alive++;
      const e = 1 - Math.pow(1 - a, 3);
      if (p.kind === "ring") { const r = p.r * (0.25 + e); p.mesh.scale.set(r, r, r); p.mesh.material.opacity = (1 - a) * (1 - a) * 0.75; }
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
    renderer.dispose(); canvas.remove();
  }

  return { burst, resize, dispose };
}
