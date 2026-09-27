// WebGPU benchmark: 100 000 vehicles integrated entirely on the GPU with the
// IDM/MOBIL compute shaders (traffic.wgsl). Vehicle poses are written to a
// storage buffer that is bound directly as the vertex-instance source, so no
// data crosses back to the CPU each frame. Falls back with a clear message
// where WebGPU is unavailable.

import { TRAFFIC_WGSL } from './traffic.wgsl';
import { t } from '../i18n';

export class GpuTrafficBenchmark {
  canvas: HTMLCanvasElement;
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private format!: GPUTextureFormat;
  private computePipeline!: GPUComputePipeline;
  private mobilPipeline!: GPUComputePipeline;
  private renderPipeline!: GPURenderPipeline;
  private stateBuf!: GPUBuffer;
  private poseBuf!: GPUBuffer;
  private paramBuf!: GPUBuffer;
  private computeBind!: GPUBindGroup;
  private renderBind!: GPUBindGroup;
  private depth!: GPUTexture;
  private viewBuf!: GPUBuffer;
  count = 100000;
  private laneCount = 100;
  private perLane = 1000;
  private laneLen = 380;
  private running = false;
  private raf = 0;
  private frames = 0;
  private lastFpsT = 0;
  onStats: ((fps: number, count: number) => void) | null = null;
  private angle = 0;

  constructor(count = 100000) {
    this.count = count;
    this.perLane = Math.ceil(count / this.laneCount);
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'bench-canvas';
  }

  static supported(): boolean {
    return 'gpu' in navigator;
  }

  async init(): Promise<boolean> {
    if (!GpuTrafficBenchmark.supported()) return false;
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return false;
    this.device = await adapter.requestDevice();
    this.context = this.canvas.getContext('webgpu') as unknown as GPUCanvasContext;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.resize();
    this.context.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });

    const module = this.device.createShaderModule({ code: TRAFFIC_WGSL });
    this.computePipeline = this.device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    this.mobilPipeline = this.device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'mobil' } });

    // Buffers.
    const state = new Float32Array(this.count * 4);
    for (let i = 0; i < this.count; i++) {
      const lane = Math.floor(i / this.perLane);
      const idx = i % this.perLane;
      state[i * 4] = (idx / this.perLane) * this.laneLen;
      state[i * 4 + 1] = 8 + Math.random() * 6;
      state[i * 4 + 2] = lane;
      state[i * 4 + 3] = 0.85 + Math.random() * 0.25;
    }
    this.stateBuf = this.device.createBuffer({ size: state.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.stateBuf, 0, state);
    this.poseBuf = this.device.createBuffer({ size: this.count * 16, usage: GPUBufferUsage.STORAGE });
    this.paramBuf = this.device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.writeParams(1 / 60);

    this.computeBind = this.device.createBindGroup({
      layout: this.computePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.stateBuf } },
        { binding: 1, resource: { buffer: this.poseBuf } },
        { binding: 2, resource: { buffer: this.paramBuf } },
      ],
    });

    // Render pipeline: instanced quads read pose from the same storage buffer.
    const renderModule = this.device.createShaderModule({ code: RENDER_WGSL });
    this.viewBuf = this.device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.renderPipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: renderModule, entryPoint: 'vs' },
      fragment: { module: renderModule, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });
    this.renderBind = this.device.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.poseBuf } },
        { binding: 1, resource: { buffer: this.viewBuf } },
      ],
    });
    this.makeDepth();
    return true;
  }

  private writeParams(dt: number): void {
    const p = new ArrayBuffer(64);
    const u = new Uint32Array(p);
    const f = new Float32Array(p);
    u[0] = this.count;
    u[1] = this.laneCount;
    u[2] = this.perLane;
    f[3] = dt;
    f[4] = 33; // v0 ≈ 120 km/h on the open ring
    f[5] = 1.4;
    f[6] = 2.0;
    f[7] = 2.5;
    f[8] = 1.2;
    f[9] = this.laneLen;
    f[10] = 4;
    f[11] = 0.3;
    this.device.queue.writeBuffer(this.paramBuf, 0, p);
  }

  private makeDepth(): void {
    this.depth?.destroy();
    this.depth = this.device.createTexture({
      size: [this.canvas.width, this.canvas.height],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  resize(): void {
    const dpr = Math.min(devicePixelRatio, 2);
    this.canvas.width = Math.floor((this.canvas.clientWidth || window.innerWidth) * dpr);
    this.canvas.height = Math.floor((this.canvas.clientHeight || window.innerHeight) * dpr);
    if (this.device) this.makeDepth();
  }

  private writeView(): void {
    // Orbit camera over the grid of ring roads.
    this.angle += 0.0015;
    const cxN = this.laneCount % 10 === 0 ? 10 : this.laneCount;
    const gx = 9 * 320 * 0.5;
    const gz = (Math.ceil(this.laneCount / 10) - 1) * 320 * 0.5;
    const R = 2600;
    const eye = [gx + Math.cos(this.angle) * R, 1500, gz + Math.sin(this.angle) * R];
    const center = [gx, 0, gz];
    const view = lookAt(eye, center, [0, 1, 0]);
    const aspect = this.canvas.width / this.canvas.height;
    const proj = perspective((55 * Math.PI) / 180, aspect, 1, 9000);
    const vp = multiply(proj, view);
    this.device.queue.writeBuffer(this.viewBuf, 0, new Float32Array(vp));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    let last = performance.now();
    this.lastFpsT = last;
    const loop = (now: number) => {
      if (!this.running) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      this.writeParams(dt);
      this.writeView();
      const enc = this.device.createCommandEncoder();
      const cp = enc.beginComputePass();
      cp.setPipeline(this.computePipeline);
      cp.setBindGroup(0, this.computeBind);
      cp.dispatchWorkgroups(Math.ceil(this.count / 64));
      if (this.frames % 8 === 0) {
        cp.setPipeline(this.mobilPipeline);
        cp.setBindGroup(0, this.computeBind);
        cp.dispatchWorkgroups(Math.ceil(this.count / 64));
      }
      cp.end();
      const rp = enc.beginRenderPass({
        colorAttachments: [{ view: this.context.getCurrentTexture().createView(), clearValue: { r: 0.04, g: 0.05, b: 0.08, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
        depthStencilAttachment: { view: this.depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      });
      rp.setPipeline(this.renderPipeline);
      rp.setBindGroup(0, this.renderBind);
      rp.draw(6, this.count);
      rp.end();
      this.device.queue.submit([enc.finish()]);
      this.frames++;
      if (now - this.lastFpsT > 500) {
        const fps = (this.frames * 1000) / (now - this.lastFpsT);
        this.onStats?.(fps, this.count);
        this.frames = 0;
        this.lastFpsT = now;
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  dispose(): void {
    this.stop();
    this.stateBuf?.destroy();
    this.poseBuf?.destroy();
    this.paramBuf?.destroy();
    this.viewBuf?.destroy();
    this.depth?.destroy();
    this.device?.destroy?.();
  }
}

const RENDER_WGSL = /* wgsl */ `
struct View { vp : mat4x4<f32> };
@group(0) @binding(0) var<storage, read> pose : array<vec4<f32>>;
@group(0) @binding(1) var<uniform> V : View;

struct VOut { @builtin(position) pos : vec4<f32>, @location(0) col : vec3<f32> };

@vertex
fn vs(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> VOut {
  // Two triangles forming a 2 × 4.4 m car footprint, extruded 1.4 m tall.
  var corners = array<vec2<f32>, 6>(
    vec2(-1.0, -2.2), vec2(1.0, -2.2), vec2(1.0, 2.2),
    vec2(-1.0, -2.2), vec2(1.0, 2.2), vec2(-1.0, 2.2));
  let c = corners[vi];
  let p = pose[ii];
  let yaw = p.z;
  let cs = cos(yaw); let sn = sin(yaw);
  let wx = p.x + c.x * cs - c.y * sn;
  let wz = p.y + c.x * sn + c.y * cs;
  var out : VOut;
  out.pos = V.vp * vec4<f32>(wx, 0.7, wz, 1.0);
  let lane = p.w;
  out.col = vec3<f32>(0.3 + fract(lane * 0.13) * 0.7, 0.4 + fract(lane * 0.37) * 0.6, 0.55 + fract(lane * 0.7) * 0.45);
  return out;
}

@fragment
fn fs(in : VOut) -> @location(0) vec4<f32> {
  return vec4<f32>(in.col, 1.0);
}
`;

// ── tiny mat4 helpers (column-major) ──────────────────────────────────────
function perspective(fovy: number, aspect: number, near: number, far: number): number[] {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}
function lookAt(eye: number[], center: number[], up: number[]): number[] {
  const z = norm(sub(eye, center));
  const x = norm(cross(up, z));
  const y = cross(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
}
function multiply(a: number[], b: number[]): number[] {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: number[]) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
