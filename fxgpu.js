// Particle effects on WebGPU: every particle is moved and drawn by the graphics chip (a compute shader moves
// them, an instanced draw shows them), so the page's own processor does almost nothing per frame.
// Same look and the same calls as fx3d.js (the WebGL version, used where WebGPU isn't available).

const MAX = 150000;                                       // particles alive at once
const STRIDE = 16;                                        // floats per particle (see struct P)

const SHARED = /* wgsl */`
struct P { pos: vec3f, born: f32, vel: vec3f, life: f32, col: vec3f, base: f32, kind: f32, seed: f32, p0: f32, p1: f32 };
struct U { now: f32, dt: f32, w: f32, h: f32, ratio: f32, dist: f32, p0: f32, p1: f32 };
@group(0) @binding(0) var<uniform> u: U;
`;
// kinds: 2 trails/smoke (curling strands that rise, slow down and hang), 3 fountain, 4 embers, 5 shockwave ring
const SIM = SHARED + /* wgsl */`
@group(0) @binding(1) var<storage, read_write> ps: array<P>;
fn hash(n: f32) -> f32 { return fract(sin(n) * 43758.5453); }
@compute @workgroup_size(64) fn sim(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&ps)) { return; }
  var p = ps[i];
  if (p.life <= 0.0) { return; }
  if (u.now - p.born >= p.life) { ps[i].life = 0.0; return; }
  let dt = u.dt;
  if (p.kind == 3.0) { p.vel.x *= pow(0.6, dt); p.vel.y -= 520.0 * dt; }
  else if (p.kind == 4.0) {
    p.vel.x = (p.vel.x + (hash(f32(i) * 12.9898 + u.now * 78.233) - 0.5) * 420.0 * dt) * pow(0.3, dt); p.vel.y += 18.0 * dt;
  } else if (p.kind == 5.0) { p.vel *= pow(0.06, dt); }
  else {
    let y = p.pos.y; let sd = p.seed;
    let want = sin(y * 0.012 + sd * 3.1 + u.now * 0.45) * 62.0 + sin(y * 0.031 - u.now * 0.8 + sd * 5.3) * 30.0;
    p.vel.x += (want - p.vel.x) * min(1.0, dt * 3.0);
    p.vel.y = p.vel.y * pow(0.5, dt) + 16.0 * dt;
    p.vel.z *= pow(0.75, dt);
  }
  p.pos += p.vel * dt;
  ps[i].pos = p.pos; ps[i].vel = p.vel;
}`;
const DRAW = SHARED + /* wgsl */`
@group(0) @binding(1) var<storage, read> ps: array<P>;
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) col: vec3f, @location(2) a: f32 };
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  var o: VO;
  let p = ps[ii];
  let age = (u.now - p.born) / max(p.life, 0.0001);
  if (p.life <= 0.0 || age >= 1.0 || age < 0.0) { o.pos = vec4f(2.0, 2.0, 2.0, 1.0); return o; }   // not alive: off screen
  let k = f32(ii);
  var a: f32; var size: f32;
  if (p.kind >= 3.0) {
    if (p.kind == 4.0) { a = (1.0 - age) * (0.45 + 0.55 * abs(sin(u.now * 17.0 + k * 1.7))); }                  // embers flicker
    else if (p.kind == 5.0) { a = pow(1.0 - age, 1.6) * min(1.0, age * 14.0); }
    else { a = pow(1.0 - age, 1.2) * min(1.0, age * 14.0); }
    size = p.base * (1.0 - age * 0.3);
  } else {                                                  // crisp points that twinkle, each at its own pace
    let lo = min(0.7, 0.1 + 0.25 * u.p0);                    // (p0: how vivid; they twinkle without going dim)
    a = min(1.0, (1.0 - age) * 2.2) * min(1.0, age * 14.0) * (lo + (1.0 - lo) * (0.5 + 0.5 * sin(u.now * (5.0 + f32(ii % 7u)) + k * 2.3)));
    size = p.base * (1.0 - age * 0.25);
  }
  // the camera looks straight at the stage from "dist" away: what is nearer to you is bigger
  let persp = u.dist / max(1.0, u.dist - p.pos.z);
  let px = max(1.0, size * u.ratio * persp);                // its width in screen pixels
  let c = corners[vi];
  let centre = vec2f(p.pos.x * persp / (u.w * 0.5), p.pos.y * persp / (u.h * 0.5));
  o.pos = vec4f(centre + c * px / vec2f(u.w * u.ratio, u.h * u.ratio), 0.5, 1.0);
  o.uv = c; o.col = p.col; o.a = a;
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let d = length(i.uv);
  if (d > 1.0) { discard; }
  return vec4f(i.col, i.a * (1.0 - smoothstep(0.55, 1.0, d)));   // a crisp dot, exactly its colour
}`;

export async function createFxGPU(host) {
  if (!navigator.gpu) throw new Error("no WebGPU");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("no WebGPU adapter");
  const device = await adapter.requestDevice();
  const canvas = document.createElement("canvas");
  canvas.className = "fx3d";
  canvas.setAttribute("aria-hidden", "true");
  const ctx = canvas.getContext("webgpu");
  if (!ctx) throw new Error("no WebGPU canvas");
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: "premultiplied" });
  host.after(canvas);
  let lost = false;
  device.lost.then(() => { lost = true; });

  const pbuf = device.createBuffer({ size: MAX * STRIDE * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const ubuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const simPipe = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: SIM }), entryPoint: "sim" } });
  const drawMod = device.createShaderModule({ code: DRAW });
  const drawPipe = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: drawMod, entryPoint: "vs" },
    // plain see-through dots (many on top of each other keep their colour), written as the page composites them
    fragment: { module: drawMod, entryPoint: "fs", targets: [{ format, blend: {
      color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } } }] },
    primitive: { topology: "triangle-list" },
  });
  const entries = [{ binding: 0, resource: { buffer: ubuf } }, { binding: 1, resource: { buffer: pbuf } }];
  const simBind = device.createBindGroup({ layout: simPipe.getBindGroupLayout(0), entries });
  const drawBind = device.createBindGroup({ layout: drawPipe.getBindGroupLayout(0), entries });

  let W = 1, H = 1, dist = 1, ratio = Math.min(window.devicePixelRatio || 1, 2);
  const t0 = performance.now();
  const clock = () => (performance.now() - t0) / 1000;
  const toWorld = (x, y) => [x - W / 2, H / 2 - y];
  function resize(w, h, pr) {
    W = Math.max(1, w); H = Math.max(1, h);
    if (pr) ratio = Math.min(pr, 2);
    canvas.width = Math.max(1, Math.round(W * ratio)); canvas.height = Math.max(1, Math.round(H * ratio));
    dist = H / 2 / Math.tan(20 * Math.PI / 180);            // (a 40° view, as in the WebGL version)
    kick();
  }

  // How the particles look and move (set from the app's Effects settings)
  const style = { motion: "trails", color: [1, 0.29, 0.4], amount: 1, size: 1, vivid: 0 };
  function setStyle(o) {
    if (o.motion) style.motion = o.motion;
    if (o.color) style.color = [1, 3, 5].map(i => parseInt(o.color.slice(i, i + 2), 16) / 255);
    if (o.amount != null) style.amount = o.amount;
    if (o.size != null) style.size = o.size;
    if (o.vivid != null) style.vivid = o.vivid;
  }

  // ---- new particles are written straight into the graphics chip's memory ----
  let next = 0, used = 0, lastDeath = 0;
  function make(n, fill) {
    if (n <= 0 || lost) return;
    n = Math.min(n, MAX);
    const now = clock(), a = new Float32Array(n * STRIDE);
    for (let i = 0; i < n; i++) {
      const j = i * STRIDE, bright = Math.min(1, 0.8 + 0.1 * style.vivid), b = bright + Math.random() * (1 - bright);
      a[j + 3] = now;
      a[j + 8] = style.color[0] * b; a[j + 9] = style.color[1] * b; a[j + 10] = style.color[2] * b;
      fill(a, j);
      if (now + a[j + 7] > lastDeath) lastDeath = now + a[j + 7];
    }
    const first = Math.min(n, MAX - next);                   // (the list is a ring: the oldest are written over)
    device.queue.writeBuffer(pbuf, next * STRIDE * 4, a, 0, first * STRIDE);
    if (first < n) device.queue.writeBuffer(pbuf, 0, a, first * STRIDE, (n - first) * STRIDE);
    used = Math.min(MAX, Math.max(used, next + n));
    next = (next + n) % MAX;
    kick();
  }
  // a: pos xyz 0-2, born 3, vel xyz 4-6, life 7, colour 8-10, size 11, kind 12, seed 13
  const set = (a, j, x, y, z, vx, vy, vz, life, size, kind, seed = 0) => {
    a[j] = x; a[j + 1] = y; a[j + 2] = z; a[j + 4] = vx; a[j + 5] = vy; a[j + 6] = vz; a[j + 7] = life; a[j + 11] = size * style.size; a[j + 12] = kind; a[j + 13] = seed;
  };
  const R = Math.random;
  // thin sparkle trails: shoot up, slow down and hang, drifting together in curling strands; a few stray
  const trail = (wx, wy, keyW, sd, speed) => (a, j) => {
    const stray = R() < 0.12, r = R();
    set(a, j, wx + (R() - 0.5) * keyW * 0.3, wy + R() * 4, R() * 8, (R() - 0.5) * (stray ? 60 : 10) * speed, (110 + R() * 230) * speed, R() * 6,
      2.2 + R() * 2.6, r < 0.05 ? 2.4 + R() * 1.4 : r < 0.25 ? 1.3 + R() * 0.9 : 0.7 + R() * 0.5, 2, sd + (stray ? R() * 3 : R() * 0.12));
  };
  const KIND = {
    smoke: (wx, wy, keyW) => (a, j) => set(a, j, wx + (R() - 0.5) * keyW * 1.3, wy + R() * 6, R() * 8, (R() - 0.5) * 20, 25 + R() * 60, R() * 6, 2.5 + R() * 2.5, 0.7 + R() * 0.8, 2, R() * 20),
    fountain: (wx, wy, keyW) => (a, j) => set(a, j, wx + (R() - 0.5) * keyW * 0.5, wy, R() * 8, (R() - 0.5) * 180, 260 + R() * 260, R() * 6, 1.1 + R() * 0.8, 0.9 + R() * 1.1, 3),
    embers: (wx, wy, keyW) => (a, j) => set(a, j, wx + (R() - 0.5) * keyW * 0.7, wy + R() * 4, R() * 8, (R() - 0.5) * 30, 70 + R() * 110, R() * 6, 1.4 + R() * 1.6, 1.2 + R() * 1.6, 4),
    shock: (wx, wy) => (a, j) => { const g = R() * Math.PI * 2, v = 220 + R() * 200;
      set(a, j, wx, wy, R() * 8, Math.cos(g) * v * 1.4, Math.abs(Math.sin(g)) * v * 0.8 + 20, Math.sin(g) * v, 0.6 + R() * 0.5, 0.9 + R() * 0.9, 5); },
  };

  // a hit on the key whose top centre is at (x, y) on the stage
  function burst(x, y, color, big, keyW = 20) {
    if (lost) throw new Error("WebGPU drawing was lost");
    const [wx, wy] = toWorld(x, y), a = style.amount, m = style.motion;
    if (m === "shock") make(Math.round((big ? 420 : 200) * a), KIND.shock(wx, wy));
    else if (m === "fountain") make(Math.round((big ? 260 : 120) * a), KIND.fountain(wx, wy, keyW));
    else if (m === "embers") make(Math.round((big ? 200 : 90) * a), KIND.embers(wx, wy, keyW));
    else make(Math.round((big ? 500 : 220) * a), trail(wx, wy, keyW * 1.3, R() * 10, 1.4));
  }
  // a key that is sounding (held, or played by the app): a steady stream (per second)
  const RATE = { trails: 650, smoke: 900, fountain: 220, embers: 170, shock: 260 }, tally = new Map();
  function emit(x, y, color, keyW, dt, key = 0) {
    if (lost) return;
    const want = (RATE[style.motion] || 650) * style.amount * dt + (tally.get(key) || 0), n = Math.floor(want);
    tally.set(key, want - n);
    if (!n) return;
    const [wx, wy] = toWorld(x, y), m = style.motion;
    make(n, m === "fountain" || m === "embers" || m === "smoke" ? KIND[m](wx, wy, keyW) : trail(wx, wy, keyW, key * 1.37, 1));
  }

  let raf = 0, last = 0;
  const uni = new Float32Array(8);
  function kick() { if (!raf && !lost) { last = clock(); raf = requestAnimationFrame(frame); } }
  function frame() {
    raf = 0;
    if (lost) return;
    const now = clock(), dt = Math.min(0.05, now - last); last = now;
    uni[0] = now; uni[1] = dt; uni[2] = W; uni[3] = H; uni[4] = ratio; uni[5] = dist; uni[6] = style.vivid;
    device.queue.writeBuffer(ubuf, 0, uni);
    const enc = device.createCommandEncoder();
    if (used) {
      const sim = enc.beginComputePass();
      sim.setPipeline(simPipe); sim.setBindGroup(0, simBind); sim.dispatchWorkgroups(Math.ceil(used / 64)); sim.end();
    }
    let view;
    try { view = ctx.getCurrentTexture().createView(); } catch (e) { lost = true; return; }
    const pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
    if (used) { pass.setPipeline(drawPipe); pass.setBindGroup(0, drawBind); pass.draw(6, used); }
    pass.end();
    device.queue.submit([enc.finish()]);
    if (api.onRender) api.onRender(canvas);                // (the app copies the picture for its glow)
    if (now < lastDeath + 0.25) raf = requestAnimationFrame(frame);   // it only draws while something is alive
  }

  function dispose() {
    cancelAnimationFrame(raf); raf = 0; lost = true;
    try { pbuf.destroy(); ubuf.destroy(); device.destroy(); } catch (e) {}
    canvas.remove();
  }

  // (the adapter is kept too: some browsers drop the device when nothing refers to its adapter any more)
  const api = { burst, emit, resize, dispose, setStyle, canvas, onRender: null, gpu: true, adapter, device, isLost: () => lost };
  return api;
}
