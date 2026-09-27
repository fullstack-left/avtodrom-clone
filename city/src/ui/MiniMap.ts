// 2D mini-map drawn once (static roads) into an offscreen canvas, then
// composited each frame with the moving car, AI traffic dots, the GPS route
// and mission markers. North-up.

import { TrafficRuleGraph } from '../world/TrafficRuleGraph';
import { TrafficSim } from '../traffic/TrafficSim';

export class MiniMap {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private base: HTMLCanvasElement;
  private scale = 1;
  private ox = 0;
  private oz = 0;
  private size = 190;
  private g: TrafficRuleGraph | null = null;
  route: Float32Array | null = null;
  markers: { x: number; z: number; color: string }[] = [];
  fullscreen = false;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'minimap';
    this.canvas.width = this.canvas.height = this.size;
    this.ctx = this.canvas.getContext('2d')!;
    this.base = document.createElement('canvas');
  }

  setGraph(g: TrafficRuleGraph): void {
    this.g = g;
    const pad = 40;
    const w = g.maxX - g.minX + pad * 2;
    const h = g.maxZ - g.minZ + pad * 2;
    this.scale = (this.size - 12) / Math.max(w, h);
    this.ox = g.minX - pad;
    this.oz = g.minZ - pad;
    this.base.width = this.base.height = this.size;
    const c = this.base.getContext('2d')!;
    c.fillStyle = 'rgba(20,26,38,0.9)';
    c.fillRect(0, 0, this.size, this.size);
    c.strokeStyle = '#5b6472';
    c.lineCap = 'round';
    for (const road of g.roads) {
      c.lineWidth = Math.max(1.5, road.halfWidth * this.scale);
      c.strokeStyle = road.cls.name === 'arterial' ? '#8b95a6' : '#5b6472';
      c.beginPath();
      c.moveTo(this.px(road.a.x), this.pz(road.a.z));
      c.lineTo(this.px(road.b.x), this.pz(road.b.z));
      c.stroke();
    }
    // signalised junctions
    c.fillStyle = '#c9a227';
    for (const n of g.nodes)
      if (n.light) {
        c.beginPath();
        c.arc(this.px(n.x), this.pz(n.z), 2, 0, 7);
        c.fill();
      }
  }

  private px(x: number): number {
    return (x - this.ox) * this.scale + 6;
  }
  private pz(z: number): number {
    return (z - this.oz) * this.scale + 6;
  }

  toggleFullscreen(): void {
    this.fullscreen = !this.fullscreen;
    this.canvas.classList.toggle('full', this.fullscreen);
    const s = this.fullscreen ? Math.min(window.innerWidth, window.innerHeight) - 40 : this.size;
    // Re-render base at higher resolution when enlarged is skipped for simplicity;
    // CSS scales the 190px canvas smoothly.
    this.canvas.style.width = this.canvas.style.height = s + 'px';
  }

  render(sim: TrafficSim | null, carX: number, carZ: number, carYaw: number): void {
    const c = this.ctx;
    c.clearRect(0, 0, this.size, this.size);
    c.drawImage(this.base, 0, 0);
    // route
    if (this.route && this.route.length >= 4) {
      c.strokeStyle = '#2bb3ff';
      c.lineWidth = 2.5;
      c.beginPath();
      c.moveTo(this.px(this.route[0]), this.pz(this.route[1]));
      for (let i = 2; i < this.route.length; i += 2) c.lineTo(this.px(this.route[i]), this.pz(this.route[i + 1]));
      c.stroke();
    }
    // AI traffic
    if (sim) {
      c.fillStyle = 'rgba(255,255,255,0.5)';
      const step = sim.count > 600 ? 3 : 1;
      for (let i = 0; i < sim.count; i += step) {
        c.fillRect(this.px(sim.x[i]) - 0.6, this.pz(sim.z[i]) - 0.6, 1.4, 1.4);
      }
    }
    // markers
    for (const m of this.markers) {
      c.fillStyle = m.color;
      c.beginPath();
      c.arc(this.px(m.x), this.pz(m.z), 4, 0, 7);
      c.fill();
      c.strokeStyle = '#fff';
      c.lineWidth = 1.5;
      c.stroke();
    }
    // player arrow
    const x = this.px(carX), z = this.pz(carZ);
    c.save();
    c.translate(x, z);
    c.rotate(carYaw);
    c.fillStyle = '#39d353';
    c.beginPath();
    c.moveTo(0, -6);
    c.lineTo(4, 5);
    c.lineTo(0, 2);
    c.lineTo(-4, 5);
    c.closePath();
    c.fill();
    c.restore();
  }
}
