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
  private instancePhase!: THREE.InstancedBufferAttribute;
  private instanceTop!: THREE.InstancedBufferAttribute;
  private instanceBottom!: THREE.InstancedBufferAttribute;
  private instanceSkin!: THREE.InstancedBufferAttribute;
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
    // One 260-ish triangle articulated person with explicit body-part ids.
    // Limbs animate in the vertex shader, preserving one draw call for the
    // entire pedestrian population while avoiding the former rigid pawn/bob.
    const tagged = (source: THREE.BufferGeometry, part: number): THREE.BufferGeometry => {
      let geo = source;
      if (geo.index) {
        const flat = geo.toNonIndexed();
        geo.dispose();
        geo = flat;
      }
      for (const name of Object.keys(geo.attributes)) if (name !== 'position' && name !== 'normal') geo.deleteAttribute(name);
      if (!geo.getAttribute('normal')) geo.computeVertexNormals();
      const count = geo.getAttribute('position').count;
      geo.setAttribute('partId', new THREE.Float32BufferAttribute(new Float32Array(count).fill(part), 1));
      return geo;
    };
    const parts: THREE.BufferGeometry[] = [
      tagged(new THREE.CylinderGeometry(0.19, 0.23, 0.56, 9).translate(0, 1.16, 0), 0), // top
      tagged(new THREE.SphereGeometry(0.21, 9, 6).scale(1, 0.55, 0.72).translate(0, 0.86, 0), 7), // hips
      tagged(new THREE.CylinderGeometry(0.085, 0.1, 0.76, 8).translate(-0.115, 0.5, 0), 1), // left leg
      tagged(new THREE.CylinderGeometry(0.085, 0.1, 0.76, 8).translate(0.115, 0.5, 0), 2), // right leg
      tagged(new THREE.CylinderGeometry(0.065, 0.075, 0.62, 7).translate(-0.275, 1.17, 0), 3), // left arm
      tagged(new THREE.CylinderGeometry(0.065, 0.075, 0.62, 7).translate(0.275, 1.17, 0), 4), // right arm
      tagged(new THREE.SphereGeometry(0.115, 10, 7).scale(0.94, 1.08, 0.96).translate(0, 1.67, 0), 5), // head
      tagged(new THREE.SphereGeometry(0.07, 7, 5).translate(-0.275, 0.84, 0), 5),
      tagged(new THREE.SphereGeometry(0.07, 7, 5).translate(0.275, 0.84, 0), 5),
      tagged(new THREE.BoxGeometry(0.18, 0.1, 0.29).translate(-0.115, 0.09, -0.055), 6),
      tagged(new THREE.BoxGeometry(0.18, 0.1, 0.29).translate(0.115, 0.09, -0.055), 6),
      tagged(new THREE.SphereGeometry(0.118, 9, 5, 0, Math.PI * 2, 0, Math.PI * 0.48).translate(0, 1.7, 0), 6), // hair
    ];
    const geo = mergeGeometries(parts, false)!;
    for (const part of parts) part.dispose();
    this.instancePhase = new THREE.InstancedBufferAttribute(new Float32Array(this.cap), 1).setUsage(THREE.DynamicDrawUsage);
    this.instanceTop = new THREE.InstancedBufferAttribute(new Float32Array(this.cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.instanceBottom = new THREE.InstancedBufferAttribute(new Float32Array(this.cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.instanceSkin = new THREE.InstancedBufferAttribute(new Float32Array(this.cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('instancePhase', this.instancePhase);
    geo.setAttribute('instanceTop', this.instanceTop);
    geo.setAttribute('instanceBottom', this.instanceBottom);
    geo.setAttribute('instanceSkin', this.instanceSkin);

    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.78, metalness: 0.02 });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = `
        attribute float partId;
        attribute float instancePhase;
        attribute vec3 instanceTop;
        attribute vec3 instanceBottom;
        attribute vec3 instanceSkin;
        varying vec3 vPedColor;
        vec3 pedRotateX(vec3 p, vec3 pivot, float a) {
          p -= pivot;
          float c = cos(a), s = sin(a);
          p.yz = mat2(c, -s, s, c) * p.yz;
          return p + pivot;
        }
      ` + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `vec3 transformed = vec3(position);
         float walk = sin(instancePhase) * 0.62;
         if (partId > 0.5 && partId < 1.5) transformed = pedRotateX(transformed, vec3(-0.115, 0.86, 0.0), walk);
         else if (partId > 1.5 && partId < 2.5) transformed = pedRotateX(transformed, vec3(0.115, 0.86, 0.0), -walk);
         else if (partId > 2.5 && partId < 3.5) transformed = pedRotateX(transformed, vec3(-0.275, 1.43, 0.0), -walk * 0.72);
         else if (partId > 3.5 && partId < 4.5) transformed = pedRotateX(transformed, vec3(0.275, 1.43, 0.0), walk * 0.72);
         if (partId < 0.5 || (partId > 2.5 && partId < 4.5)) vPedColor = instanceTop;
         else if (partId < 2.5 || partId > 6.5) vPedColor = instanceBottom;
         else if (partId < 5.5) vPedColor = instanceSkin;
         else vPedColor = vec3(0.035, 0.045, 0.055);`,
      );
      shader.fragmentShader = 'varying vec3 vPedColor;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vPedColor;');
    };
    mat.customProgramCacheKey = () => 'avtoshahar-articulated-pedestrian-v2';
    const mesh = new THREE.InstancedMesh(geo, mat, this.cap);
    mesh.name = 'Articulated pedestrians';
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
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
      const bob = this.waiting[i] ? 0 : Math.abs(Math.sin(this.phase[i] * 2)) * 0.014;
      const onZebra = !!this.links[this.link[i]].cw && !this.waiting[i];
      this.p.set(this.x[i], (onZebra ? 0.02 : 0.15) + bob, this.z[i]);
      this.e.set(0, this.yaw[i], 0);
      this.q.setFromEuler(this.e);
      const body = 0.94 + (i % 7) * 0.015;
      this.sc.set(body, 0.94 + (i % 5) * 0.025, body);
      this.m.compose(this.p, this.q, this.sc);
      this.mesh.setMatrixAt(k, this.m);
      this.instancePhase.setX(k, this.waiting[i] ? 0 : this.phase[i]);
      const top = PED_TOP[i % PED_TOP.length];
      const bottom = PED_BOTTOM[(i * 3 + 1) % PED_BOTTOM.length];
      const skin = PED_SKIN[(i * 5 + 2) % PED_SKIN.length];
      this.instanceTop.setXYZ(k, top.r, top.g, top.b);
      this.instanceBottom.setXYZ(k, bottom.r, bottom.g, bottom.b);
      this.instanceSkin.setXYZ(k, skin.r, skin.g, skin.b);
      k++;
    }
    this.mesh.count = k;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.instancePhase.needsUpdate = true;
    this.instanceTop.needsUpdate = true;
    this.instanceBottom.needsUpdate = true;
    this.instanceSkin.needsUpdate = true;
  }
}

const palette = (values: number[]) => values.map((hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace));
const PED_TOP = palette([0x264653, 0x8b2f2f, 0x2855a6, 0x2f6d45, 0x6d3f8f, 0xb23a5a, 0x9a5b24, 0x3d4654, 0xd0a52f, 0x5c6675]);
const PED_BOTTOM = palette([0x172033, 0x293241, 0x31343b, 0x4a4038, 0x22314f, 0x5b5d63]);
const PED_SKIN = palette([0xf0c4a4, 0xd9a17e, 0xbd805f, 0x8c5b43, 0x6f4433]);
