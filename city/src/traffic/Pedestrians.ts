// Pedestrians walk on a sidewalk graph (corners, mid-block zebras) and cross
// the carriageway only on crosswalks: on signalised junctions they obey the
// pedestrian light; on unregulated zebras they have priority (YHQ) but still
// check that approaching vehicles can stop. While on a zebra they register as
// occupants so vehicles yield to them.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CW, Crosswalk, Node, SIDEWALK, TrafficRuleGraph } from '../world/TrafficRuleGraph';
import { TrafficSim, mulberry32 } from './TrafficSim';

interface PPoint {
  x: number;
  z: number;
  links: number[];
}
interface PLink {
  a: number;
  b: number;
  len: number;
  cw: Crosswalk | null;
}

export class Pedestrians {
  pts: PPoint[] = [];
  links: PLink[] = [];
  count = 0;
  cap: number;
  link: Int32Array;
  t: Float32Array; // metres along the link
  dir: Int8Array; // +1 a→b, −1 b→a
  speed: Float32Array;
  waiting: Uint8Array;
  side: Float32Array; // lateral offset on the sidewalk
  x: Float32Array;
  z: Float32Array;
  yaw: Float32Array;
  phase: Float32Array;
  mesh: THREE.InstancedMesh;
  private rng = mulberry32(777);
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private p = new THREE.Vector3();
  private sc = new THREE.Vector3(1, 1, 1);

  constructor(private g: TrafficRuleGraph, private sim: TrafficSim, cap = 600) {
    this.cap = cap;
    this.link = new Int32Array(cap);
    this.t = new Float32Array(cap);
    this.dir = new Int8Array(cap);
    this.speed = new Float32Array(cap);
    this.waiting = new Uint8Array(cap);
    this.side = new Float32Array(cap);
    this.x = new Float32Array(cap);
    this.z = new Float32Array(cap);
    this.yaw = new Float32Array(cap);
    this.phase = new Float32Array(cap);
    this.buildGraph();
    this.mesh = this.buildMesh();
  }

  private addPt(x: number, z: number): number {
    for (let k = 0; k < this.pts.length; k++) if (Math.abs(this.pts[k].x - x) < 0.5 && Math.abs(this.pts[k].z - z) < 0.5) return k;
    this.pts.push({ x, z, links: [] });
    return this.pts.length - 1;
  }
  private addLink(a: number, b: number, cw: Crosswalk | null): void {
    const len = Math.hypot(this.pts[a].x - this.pts[b].x, this.pts[a].z - this.pts[b].z);
    const id = this.links.length;
    this.links.push({ a, b, len, cw });
    this.pts[a].links.push(id);
    this.pts[b].links.push(id);
  }

  private corner(n: Node, sx: number, sz: number): number {
    return this.addPt(n.x + sx * (n.halfX + SIDEWALK / 2), n.z + sz * (n.halfZ + SIDEWALK / 2));
  }

  private buildGraph(): void {
    const g = this.g;
    for (const road of g.roads) {
      const a = road.a, b = road.b;
      const mid = road.fwd?.midCrosswalk ?? road.back?.midCrosswalk ?? null;
      for (const side of [-1, 1]) {
        let pa: number, pb: number;
        if (road.axis === 'h') {
          pa = this.corner(a, 1, side);
          pb = this.corner(b, -1, side);
        } else {
          pa = this.corner(a, side, 1);
          pb = this.corner(b, side, -1);
        }
        if (mid) {
          const off = road.halfWidth + SIDEWALK / 2;
          const pm = road.axis === 'h' ? this.addPt(mid.cx, mid.cz + side * off) : this.addPt(mid.cx + side * off, mid.cz);
          this.addLink(pa, pm, null);
          this.addLink(pm, pb, null);
        } else this.addLink(pa, pb, null);
      }
      if (mid) {
        const off = road.halfWidth + SIDEWALK / 2;
        const p1 = road.axis === 'h' ? this.addPt(mid.cx, mid.cz - off) : this.addPt(mid.cx - off, mid.cz);
        const p2 = road.axis === 'h' ? this.addPt(mid.cx, mid.cz + off) : this.addPt(mid.cx + off, mid.cz);
        this.addLink(p1, p2, mid);
      }
    }
    for (const n of g.nodes) {
      for (let d = 0; d < 4; d++) {
        const cw = n.crosswalks[d];
        if (!cw) continue;
        let p1: number, p2: number;
        if (d === 0) (p1 = this.corner(n, 1, -1)), (p2 = this.corner(n, 1, 1));
        else if (d === 2) (p1 = this.corner(n, -1, -1)), (p2 = this.corner(n, -1, 1));
        else if (d === 1) (p1 = this.corner(n, -1, 1)), (p2 = this.corner(n, 1, 1));
        else (p1 = this.corner(n, -1, -1)), (p2 = this.corner(n, 1, -1));
        this.addLink(p1, p2, cw);
      }
    }
  }

  private buildMesh(): THREE.InstancedMesh {
    // Low-poly person: legs, torso, head (≈ 90 triangles), 1.72 m.
    const legs = new THREE.CylinderGeometry(0.16, 0.13, 0.85, 6).translate(0, 0.43, 0);
    const torso = new THREE.CylinderGeometry(0.2, 0.17, 0.62, 7).translate(0, 1.16, 0);
    const head = new THREE.SphereGeometry(0.12, 7, 5).translate(0, 1.6, 0);
    const geo = mergeGeometries([legs.toNonIndexed(), torso.toNonIndexed(), head.toNonIndexed()])!;
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.85 });
    const mesh = new THREE.InstancedMesh(geo, mat, this.cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    const palette = [0x334155, 0x7c2d12, 0x1e40af, 0x166534, 0x6b21a8, 0x9f1239, 0x78350f, 0x0f172a, 0xa3a3a3, 0xd97706];
    const c = new THREE.Color();
    for (let i = 0; i < this.cap; i++) mesh.setColorAt(i, c.setHex(palette[i % palette.length]));
    mesh.count = 0;
    return mesh;
  }

  setCount(n: number): void {
    n = Math.min(n, this.cap);
    while (this.count < n) {
      const i = this.count++;
      this.link[i] = Math.floor(this.rng() * this.links.length);
      while (this.links[this.link[i]].cw) this.link[i] = Math.floor(this.rng() * this.links.length);
      this.t[i] = this.rng() * this.links[this.link[i]].len;
      this.dir[i] = this.rng() < 0.5 ? 1 : -1;
      this.speed[i] = 1.1 + this.rng() * 0.5;
      this.side[i] = (this.rng() - 0.5) * 2.2;
      this.phase[i] = this.rng() * 6;
      this.waiting[i] = 0;
    }
    this.count = n;
    this.mesh.count = n;
  }

  /** Is it safe for a pedestrian to step onto this crosswalk now? */
  private canCross(cw: Crosswalk): boolean {
    // Vehicle and pedestrian admission share one exclusion protocol: sticky
    // connector grants win until rear-clear, while a newly committed pedestrian
    // publishes intent before the next vehicle reservation pass.
    if (this.sim.crosswalkReserved(cw)) return false;
    if (cw.signalized && cw.node?.light && cw.node.regime() === 'light') return cw.node.light.pedestrianGreen(cw.armDir as 0 | 1 | 2 | 3);
    if (cw.node?.regime() === 'regulator') {
      const r = cw.node.regulator!;
      if (r.handUp) return false;
      // pedestrians may cross parallel to permitted vehicle flow
      const armAlongX = cw.armDir === 0 || cw.armDir === 2;
      return r.axis === 0 ? !armAlongX : armAlongX;
    }
    // Unregulated: gap acceptance against vehicles that could not stop.
    const sim = this.sim;
    const r = cw.halfLen + 35;
    for (let i = 0; i < sim.count; i++) {
      const dx = sim.x[i] - cw.cx, dz = sim.z[i] - cw.cz;
      if (Math.abs(dx) > r || Math.abs(dz) > r) continue;
      const v = sim.v[i];
      const d = Math.hypot(dx, dz);
      const stopDist = (v * v) / (2 * 3.5) + 4;
      if (d < stopDist + cw.halfLen && v > 1) return false;
    }
    const P = sim.player;
    if (P.active) {
      const d = Math.hypot(P.x - cw.cx, P.z - cw.cz);
      const v = Math.hypot(P.vx, P.vz);
      if (d < (v * v) / (2 * 3.5) + 6 + cw.halfLen && v > 1) return false;
    }
    return true;
  }

  update(dt: number): void {
    for (const cw of this.g.crosswalks) cw.occupants.length = 0;
    for (let i = 0; i < this.count; i++) {
      const L = this.links[this.link[i]];
      if (this.waiting[i]) {
        if (L.cw && this.canCross(L.cw)) this.waiting[i] = 0;
      } else {
        this.t[i] += this.speed[i] * dt;
        this.phase[i] += this.speed[i] * dt * 3.2;
      }
      if (this.t[i] >= L.len) {
        // Arrived at the end point → choose next link.
        const endPt = this.dir[i] > 0 ? L.b : L.a;
        const opts = this.pts[endPt].links.filter((k) => k !== this.link[i]);
        const pick = opts.length ? opts[Math.floor(this.rng() * opts.length)] : this.link[i];
        const nl = this.links[pick];
        this.link[i] = pick;
        this.dir[i] = nl.a === endPt ? 1 : -1;
        this.t[i] = 0;
        if (nl.cw) this.waiting[i] = this.canCross(nl.cw) ? 0 : 1;
      }
      const cur = this.links[this.link[i]];
      const A = this.pts[this.dir[i] > 0 ? cur.a : cur.b];
      const B = this.pts[this.dir[i] > 0 ? cur.b : cur.a];
      const f = Math.min(1, this.t[i] / cur.len);
      const dx = B.x - A.x, dz = B.z - A.z;
      const inv = 1 / (cur.len || 1);
      // lateral: spread on sidewalk; on zebra keep within the stripe width
      const side = cur.cw ? this.side[i] * (CW / 2.6 / 1.1) : this.side[i];
      this.x[i] = A.x + dx * f + (-dz * inv) * side;
      this.z[i] = A.z + dz * f + (dx * inv) * side;
      this.yaw[i] = Math.atan2(-dx, -dz);
      if (cur.cw && !this.waiting[i] && this.t[i] < cur.len - 0.3) {
        const cw = cur.cw;
        const u = cw.axis === 'x' ? this.x[i] - cw.cx : this.z[i] - cw.cz;
        const du = cw.axis === 'x' ? dx : dz;
        // t <= 0.3 is a committed crossing intent at the curb. Publishing it
        // in this same update closes the pedestrian/new-grant race.
        cw.occupants.push({ u, vu: Math.sign(du) * this.speed[i], intent: this.t[i] <= 0.3 });
      }
    }
  }

  /** Any pedestrian within r of (x,z)? Returns index or −1. */
  hit(x: number, z: number, r: number): number {
    const r2 = r * r;
    for (let i = 0; i < this.count; i++) {
      const dx = this.x[i] - x, dz = this.z[i] - z;
      if (dx * dx + dz * dz < r2) return i;
    }
    return -1;
  }

  /** Push a hit pedestrian away (fallen) — they respawn on a sidewalk. */
  knock(i: number): void {
    this.link[i] = Math.floor(this.rng() * this.links.length);
    while (this.links[this.link[i]].cw) this.link[i] = Math.floor(this.rng() * this.links.length);
    this.t[i] = 0;
    this.waiting[i] = 0;
  }

  render(camX: number, camZ: number, maxDist: number): void {
    const md2 = maxDist * maxDist;
    let k = 0;
    for (let i = 0; i < this.count; i++) {
      const dx = this.x[i] - camX, dz = this.z[i] - camZ;
      if (dx * dx + dz * dz > md2) continue;
      const bob = this.waiting[i] ? 0 : Math.abs(Math.sin(this.phase[i])) * 0.04;
      const onZebra = !!this.links[this.link[i]].cw && !this.waiting[i];
      this.p.set(this.x[i], (onZebra ? 0.02 : 0.15) + bob, this.z[i]);
      this.e.set(0, this.yaw[i], Math.sin(this.phase[i]) * (this.waiting[i] ? 0 : 0.03));
      this.q.setFromEuler(this.e);
      this.m.compose(this.p, this.q, this.sc);
      this.mesh.setMatrixAt(k, this.m);
      if (this.mesh.instanceColor) {
        // Always rewrite compacted colours. Culling patterns can map a source
        // back to the same slot that another source overwrote last frame.
        this.mesh.instanceColor.setXYZ(k, ...colorOf(i));
      }
      k++;
    }
    this.mesh.count = k;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

const PAL = [0x334155, 0x7c2d12, 0x1e40af, 0x166534, 0x6b21a8, 0x9f1239, 0x78350f, 0x0f172a, 0xa3a3a3, 0xd97706].map((h) => {
  const c = new THREE.Color(h);
  return [c.r, c.g, c.b] as [number, number, number];
});
function colorOf(i: number): [number, number, number] {
  return PAL[i % PAL.length];
}
