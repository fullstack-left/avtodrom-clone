// Navigator: talks to the A* worker, tracks which edge the player is on, and
// turns the current route into (a) a GPS ribbon on the ground, (b) the next
// manoeuvre instruction ("turn left at the next junction"), and (c) the goal
// direction used by the exam voice prompts and the mission arrows.

import * as THREE from 'three';
import { Dir, DX, DZ, TrafficRuleGraph, movementOf } from '../world/TrafficRuleGraph';

export interface Manoeuvre {
  mov: 'straight' | 'left' | 'right' | 'uturn' | 'arrive';
  distance: number;
  nodeX: number;
  nodeZ: number;
}

export class Navigator {
  private worker: Worker;
  ready = false;
  route: number[] | null = null;
  ribbon: THREE.Mesh | null = null;
  group = new THREE.Group();
  goalEdge = -1;
  private reqId = 0;
  private pending = new Map<number, (edges: number[] | null, poly: Float32Array | null) => void>();

  constructor(private g: TrafficRuleGraph) {
    this.worker = new Worker(new URL('../workers/pathfinder.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'ready') this.ready = true;
      else if (m.type === 'route') {
        const cb = this.pending.get(m.id);
        this.pending.delete(m.id);
        cb?.(m.edges, m.poly);
      }
    };
    this.worker.postMessage({ type: 'init', graph: g.serializeForRouting() });
  }

  /** Edge the player is currently travelling on (closest, correct heading). */
  currentEdge(x: number, z: number, yaw: number): number {
    let best = -1;
    let bestScore = -Infinity;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    for (const e of this.g.edges) {
      const ax = e.from.x, az = e.from.z, bx = e.to.x, bz = e.to.z;
      const ex = bx - ax, ez = bz - az;
      const len2 = ex * ex + ez * ez;
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / len2));
      const px = ax + ex * t, pz = az + ez * t;
      const d = Math.hypot(x - px, z - pz);
      if (d > e.road.halfWidth + 2) continue;
      const inv = 1 / Math.sqrt(len2);
      const align = fx * ex * inv + fz * ez * inv; // +1 same heading
      const score = align * 2 - d * 0.2;
      if (score > bestScore) {
        bestScore = score;
        best = e.id;
      }
    }
    return best;
  }

  requestRoute(startEdge: number, goalEdge: number): Promise<number[] | null> {
    this.goalEdge = goalEdge;
    return new Promise((resolve) => {
      const id = ++this.reqId;
      this.pending.set(id, (edges, poly) => {
        this.route = edges;
        this.buildRibbon(poly);
        resolve(edges);
      });
      this.worker.postMessage({ type: 'route', id, start: startEdge, goal: goalEdge });
    });
  }

  private buildRibbon(poly: Float32Array | null): void {
    if (this.ribbon) {
      this.group.remove(this.ribbon);
      this.ribbon.geometry.dispose();
    }
    if (!poly || poly.length < 4) {
      this.ribbon = null;
      return;
    }
    // De-duplicate consecutive points into a centre-line, then extrude a strip.
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i < poly.length; i += 2) {
      const v = new THREE.Vector2(poly[i], poly[i + 1]);
      if (!pts.length || pts[pts.length - 1].distanceTo(v) > 0.5) pts.push(v);
    }
    const pos: number[] = [];
    const W = 1.4;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x, dz = b.y - a.y;
      const l = Math.hypot(dx, dz) || 1;
      const nx = (-dz / l) * W, nz = (dx / l) * W;
      const y = 0.06;
      pos.push(a.x - nx, y, a.y - nz, a.x + nx, y, a.y + nz, b.x + nx, y, b.y + nz);
      pos.push(a.x - nx, y, a.y - nz, b.x + nx, y, b.y + nz, b.x - nx, y, b.y - nz);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({ color: 0x2bb3ff, transparent: true, opacity: 0.55, depthWrite: false });
    this.ribbon = new THREE.Mesh(geo, mat);
    this.ribbon.renderOrder = 1;
    this.group.add(this.ribbon);
  }

  /** Next manoeuvre for the driver given their current edge. */
  nextManoeuvre(currentEdge: number, x: number, z: number): Manoeuvre | null {
    if (!this.route) return null;
    const idx = this.route.indexOf(currentEdge);
    if (idx < 0) return null;
    if (idx >= this.route.length - 1) {
      const e = this.g.edges[currentEdge];
      return { mov: 'arrive', distance: Math.hypot(e.to.x - x, e.to.z - z), nodeX: e.to.x, nodeZ: e.to.z };
    }
    const e = this.g.edges[currentEdge];
    const nx = this.g.edges[this.route[idx + 1]];
    const mov = movementOf(e.dir as Dir, nx.dir as Dir);
    return { mov, distance: Math.hypot(e.to.x - x, e.to.z - z), nodeX: e.to.x, nodeZ: e.to.z };
  }

  /** True when the player has reached the goal edge and (almost) stopped. */
  atGoal(currentEdge: number, speed: number): boolean {
    return currentEdge === this.goalEdge && speed < 1.2;
  }

  dispose(): void {
    this.worker.terminate();
    if (this.ribbon) this.ribbon.geometry.dispose();
  }
}
