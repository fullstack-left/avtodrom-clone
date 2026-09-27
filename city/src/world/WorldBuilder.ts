// Builds the static city from the TrafficRuleGraph: asphalt, sidewalks,
// markings (1.1, 1.3, 1.5, stop lines 1.12, zebras 1.14.1, lane arrows 1.18,
// disabled parking 1.24), buildings, trees, street lights, signs, traffic
// lights and the traffic officer. Everything repeated is drawn with
// InstancedMesh or merged geometry, so the whole city costs < 60 draw calls.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { EngineContext, Quality } from '../core/EngineContext';
import { mulberry32 } from '../traffic/TrafficSim';
import { signSize, signTexture } from './SignTextures';
import { CW, DX, DZ, Dir, Movement, Node, SIDEWALK, Signal, TrafficRuleGraph, opposite } from './TrafficRuleGraph';

export interface AABB {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  h: number;
}
export interface Circle {
  x: number;
  z: number;
  r: number;
}

class GeoBuf {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  quad(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, dx: number, dy: number, dz: number, nx: number, ny: number, nz: number, uvs: number[] = [0, 0, 1, 0, 1, 1, 0, 1]): void {
    // Ensure winding matches the requested normal.
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const crx = uy * vz - uz * vy, cry = uz * vx - ux * vz, crz = ux * vy - uy * vx;
    const P = [ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz];
    let order = [0, 1, 2, 0, 2, 3];
    if (crx * nx + cry * ny + crz * nz < 0) order = [0, 2, 1, 0, 3, 2];
    for (const k of order) {
      this.pos.push(P[k * 3], P[k * 3 + 1], P[k * 3 + 2]);
      this.nor.push(nx, ny, nz);
      this.uv.push(uvs[k * 2], uvs[k * 2 + 1]);
    }
  }
  /** Flat strip on the ground from a to b (width w) at height y. */
  strip(ax: number, az: number, bx: number, bz: number, w: number, y: number, uv?: number[]): void {
    const len = Math.hypot(bx - ax, bz - az) || 1;
    const nx = (-(bz - az) / len) * (w / 2), nz = ((bx - ax) / len) * (w / 2);
    this.quad(ax - nx, y, az - nz, ax + nx, y, az + nz, bx + nx, y, bz + nz, bx - nx, y, bz - nz, 0, 1, 0, uv);
  }
  /** Axis-aligned box with world-space UVs (scale s metres per tile). */
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, s: number): void {
    const u = (a: number) => a / s;
    this.quad(x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1, 0, 1, 0, [u(x0), u(z0), u(x1), u(z0), u(x1), u(z1), u(x0), u(z1)]);
    const h = u(y1 - y0);
    this.quad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, 0, 0, 1, [u(x0), 0, u(x1), 0, u(x1), h, u(x0), h]);
    this.quad(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, 0, 0, -1, [u(x1), 0, u(x0), 0, u(x0), h, u(x1), h]);
    this.quad(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, 1, 0, 0, [u(z1), 0, u(z0), 0, u(z0), h, u(z1), h]);
    this.quad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, -1, 0, 0, [u(z0), 0, u(z1), 0, u(z1), h, u(z0), h]);
  }
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeBoundingSphere();
    return g;
  }
}

interface LampRef {
  node: Node;
  dIn: Dir;
  kind: 'r' | 'y' | 'g' | 'arrow' | 'pr' | 'pg';
  armDir: Dir;
}

const LAMP_ON: Record<LampRef['kind'], THREE.Color> = {
  r: new THREE.Color(4, 0.25, 0.2),
  y: new THREE.Color(4, 2.4, 0.2),
  g: new THREE.Color(0.2, 3.6, 1.2),
  arrow: new THREE.Color(0.2, 3.6, 1.2),
  pr: new THREE.Color(4, 0.25, 0.2),
  pg: new THREE.Color(0.2, 3.6, 1.2),
};
const LAMP_OFF: Record<LampRef['kind'], THREE.Color> = {
  r: new THREE.Color(0.12, 0.02, 0.02),
  y: new THREE.Color(0.12, 0.08, 0.01),
  g: new THREE.Color(0.02, 0.1, 0.05),
  arrow: new THREE.Color(0.02, 0.1, 0.05),
  pr: new THREE.Color(0.12, 0.02, 0.02),
  pg: new THREE.Color(0.02, 0.1, 0.05),
};

export class WorldBuilder {
  group = new THREE.Group();
  buildings: AABB[] = [];
  circles: Circle[] = [];
  parkingBays: { x: number; z: number; yaw: number; w: number; disabled: boolean }[] = [];
  private circleGrid = new Map<number, Circle[]>();
  private lamps: LampRef[] = [];
  private lampMesh: THREE.InstancedMesh | null = null;
  private windowMat: THREE.MeshStandardMaterial | null = null;
  private streetLampMat: THREE.MeshStandardMaterial | null = null;
  private officer: THREE.Group | null = null;
  private officerArms: THREE.Object3D | null = null;
  private blink = 0;
  private rng = mulberry32(2024);
  private texLoader = new THREE.TextureLoader();
  hwV: number[] = [];
  hwH: number[] = [];

  constructor(private g: TrafficRuleGraph, private engine: EngineContext, private quality: Quality) {}

  private tex(path: string, repeat: number, srgb: boolean): THREE.Texture {
    const t = this.texLoader.load(path);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.anisotropy = this.quality === 'high' ? 8 : 4;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    this.engine.track(t);
    return t;
  }

  build(): THREE.Group {
    const g = this.g;
    for (let i = 0; i < g.nx; i++) this.hwV[i] = g.node(i, 0)!.arms[1]!.halfWidth;
    for (let j = 0; j < g.ny; j++) this.hwH[j] = g.node(0, j)!.arms[0]!.halfWidth;
    this.buildGround();
    this.buildMarkings();
    this.buildBlocks();
    this.buildStreetFurniture();
    this.buildSigns();
    this.buildTrafficLights();
    this.buildOfficer();
    for (const c of this.circles) {
      const k = this.cellKey(c.x, c.z);
      let arr = this.circleGrid.get(k);
      if (!arr) this.circleGrid.set(k, (arr = []));
      arr.push(c);
    }
    return this.group;
  }

  private cellKey(x: number, z: number): number {
    return (Math.floor(x / 20) + 1000) * 4096 + (Math.floor(z / 20) + 1000);
  }

  circlesNear(x: number, z: number, out: Circle[]): Circle[] {
    out.length = 0;
    const cx = Math.floor(x / 20), cz = Math.floor(z / 20);
    for (let a = -1; a <= 1; a++)
      for (let b = -1; b <= 1; b++) {
        const arr = this.circleGrid.get((cx + a + 1000) * 4096 + (cz + b + 1000));
        if (arr) for (const c of arr) out.push(c);
      }
    return out;
  }

  // ─── Ground: asphalt + sidewalks + grass ────────────────────────────────

  private buildGround(): void {
    const g = this.g;
    const x0 = g.minX - this.hwV[0], x1 = g.maxX + this.hwV[g.nx - 1];
    const z0 = g.minZ - this.hwH[0], z1 = g.maxZ + this.hwH[g.ny - 1];
    const W = x1 - x0, H = z1 - z0;
    const aAlb = this.tex('./assets/textures/asphalt/albedo.jpg', 1, true);
    const aNor = this.tex('./assets/textures/asphalt/normal.jpg', 1, false);
    const aArm = this.tex('./assets/textures/asphalt/arm.jpg', 1, false);
    for (const t of [aAlb, aNor, aArm]) t.repeat.set(W / 7, H / 7);
    const asphaltMat = new THREE.MeshStandardMaterial({ map: aAlb, normalMap: aNor, roughnessMap: aArm, roughness: 1, metalness: 0, color: 0x9a9a9a });
    asphaltMat.normalScale.set(0.6, 0.6);
    this.engine.onEnvChange.push(() => {
      const wet = this.engine.weather === 'rain';
      asphaltMat.roughness = wet ? 0.35 : 1;
      asphaltMat.color.set(wet ? 0x6f6f6f : 0x9a9a9a);
    });
    const road = new THREE.Mesh(new THREE.PlaneGeometry(W, H).rotateX(-Math.PI / 2), asphaltMat);
    road.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
    road.receiveShadow = true;
    this.group.add(road);

    // Grass outside the city.
    const gAlb = this.tex('./assets/textures/grass/albedo.jpg', 1, true);
    gAlb.repeat.set(400, 400);
    const grassMat = new THREE.MeshStandardMaterial({ map: gAlb, roughness: 1, color: 0xb8c4a0 });
    const grass = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000).rotateX(-Math.PI / 2), grassMat);
    grass.position.y = -0.03;
    grass.receiveShadow = true;
    this.group.add(grass);
  }

  // ─── Markings ────────────────────────────────────────────────────────────

  private buildMarkings(): void {
    const g = this.g;
    const white = new GeoBuf();
    const yellow = new GeoBuf();
    const Y = 0.012;
    const dashed = (ax: number, az: number, bx: number, bz: number, w: number, dash: number, gap: number, solidHead: number, solidTail: number, buf = white) => {
      const len = Math.hypot(bx - ax, bz - az);
      const ux = (bx - ax) / len, uz = (bz - az) / len;
      const P = (s: number) => [ax + ux * s, az + uz * s];
      if (solidHead > 0) {
        const [p, q] = P(0), [r, t] = P(Math.min(solidHead, len));
        buf.strip(p, q, r, t, w, Y);
      }
      const end = len - solidTail;
      for (let s = solidHead + gap * 0.5; s + dash <= end; s += dash + gap) {
        const [p, q] = P(s), [r, t] = P(s + dash);
        buf.strip(p, q, r, t, w, Y);
      }
      if (solidTail > 0) {
        const [p, q] = P(Math.max(0, end)), [r, t] = P(len);
        buf.strip(p, q, r, t, w, Y);
      }
    };
    for (const road of g.roads) {
      const a = road.a, b = road.b;
      const dF: Dir = road.axis === 'h' ? 0 : 1;
      const dx = DX[dF], dz = DZ[dF];
      const rx = -dz, rz = dx;
      const offA = g.armOffset(a, dF);
      const offB = g.armOffset(b, opposite(dF));
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const sA = offA - 0.5, sB = len - offB + 0.5;
      const L = (lat: number, s: number) => [a.x + dx * s + rx * lat, a.z + dz * s + rz * lat];
      // centre line
      if (!road.oneWay) {
        if (road.center === 'double_solid') {
          for (const o of [-0.18, 0.18]) {
            const [p, q] = L(o, sA), [r, t] = L(o, sB);
            white.strip(p, q, r, t, 0.12, Y);
          }
        } else if (road.center === 'solid') {
          const [p, q] = L(0, sA), [r, t] = L(0, sB);
          white.strip(p, q, r, t, 0.12, Y);
        } else {
          const [p, q] = L(0, sA), [r, t] = L(0, sB);
          dashed(p, q, r, t, 0.12, 3, 6, 20, 20);
        }
      }
      // lane dividers (same direction) — dashed 1.5, solid 1.1 near stop line
      for (const e of [road.fwd, road.back]) {
        if (!e) continue;
        for (let k = 0; k < e.lanes.length - 1; k++) {
          const l1 = e.lanes[k], l2 = e.lanes[k + 1];
          const lat = (l1.offset + l2.offset) / 2;
          const ex = -DZ[e.dir], ez = DX[e.dir];
          const sx = l1.xs[0] + ex * (lat - l1.offset), sz = l1.zs[0] + ez * (lat - l1.offset);
          const tx = l1.xs[1] + ex * (lat - l1.offset), tz = l1.zs[1] + ez * (lat - l1.offset);
          dashed(sx, sz, tx, tz, 0.12, 3, 6, 0, l1.solidTail);
        }
        // Stop line 1.12 at junctions with ≥ 3 arms.
        if (e.to.armCount >= 3) {
          const first = e.lanes[0], last = e.lanes[e.lanes.length - 1];
          const lw = e.cls.laneWidth;
          const ex = -DZ[e.dir], ez = DX[e.dir];
          const ax = first.xs[1] - ex * (lw / 2) + DX[e.dir] * 0.2, az = first.zs[1] - ez * (lw / 2) + DZ[e.dir] * 0.2;
          const bx = last.xs[1] + ex * (lw / 2) + DX[e.dir] * 0.2, bz = last.zs[1] + ez * (lw / 2) + DZ[e.dir] * 0.2;
          white.strip(ax, az, bx, bz, 0.4, Y);
        }
      }
      // Road works zone: yellow temporary edge line.
      for (const e of [road.fwd, road.back]) {
        if (!e || !e.signs.includes('3.24-30T')) continue;
        const l = e.lanes[e.lanes.length - 1];
        const ex = -DZ[e.dir], ez = DX[e.dir];
        const o = e.cls.laneWidth / 2 - 0.3;
        yellow.strip(l.xs[0] + ex * o, l.zs[0] + ez * o, l.xs[1] + ex * o, l.zs[1] + ez * o, 0.15, Y + 0.001);
      }
    }
    // Zebras 1.14.1
    for (const cw of g.crosswalks) {
      const n = Math.floor((cw.halfLen * 2) / 1.0);
      for (let k = 0; k < n; k++) {
        const u = -cw.halfLen + 0.25 + k * 1.0 + 0.25;
        if (cw.axis === 'z') white.strip(cw.cx - CW / 2, cw.cz + u, cw.cx + CW / 2, cw.cz + u, 0.5, Y);
        else white.strip(cw.cx + u, cw.cz - CW / 2, cw.cx + u, cw.cz + CW / 2, 0.5, Y);
      }
    }
    const markMat = new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.75, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const mw = new THREE.Mesh(white.geometry(), markMat);
    mw.receiveShadow = true;
    this.group.add(mw);
    if (yellow.pos.length) {
      const ym = new THREE.Mesh(yellow.geometry(), new THREE.MeshStandardMaterial({ color: 0xf5b700, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
      this.group.add(ym);
    }
    this.buildLaneArrows();
  }

  /** 1.18 lane-direction arrows from an atlas canvas. */
  private buildLaneArrows(): void {
    const kinds = ['S', 'L', 'R', 'SL', 'SR', 'LR', 'SLR'];
    const TW = 64, TH = 256;
    const cv = document.createElement('canvas');
    cv.width = TW * kinds.length;
    cv.height = TH;
    const x = cv.getContext('2d')!;
    x.fillStyle = '#fff';
    x.strokeStyle = '#fff';
    const drawArrow = (ox: number, k: string) => {
      const cx = ox + TW / 2;
      x.lineWidth = 12;
      x.lineCap = 'butt';
      // stem
      x.beginPath();
      x.moveTo(cx, TH - 4);
      x.lineTo(cx, k.includes('S') ? 70 : 130);
      x.stroke();
      if (k.includes('S')) {
        x.beginPath();
        x.moveTo(cx - 20, 72);
        x.lineTo(cx, 8);
        x.lineTo(cx + 20, 72);
        x.fill();
      }
      for (const side of ['L', 'R']) {
        if (!k.includes(side)) continue;
        const sg = side === 'L' ? -1 : 1;
        x.beginPath();
        x.moveTo(cx, 150);
        x.quadraticCurveTo(cx, 110, cx + sg * 14, 110);
        x.stroke();
        x.beginPath();
        x.moveTo(cx + sg * 10, 88);
        x.lineTo(cx + sg * 30, 110);
        x.lineTo(cx + sg * 10, 132);
        x.fill();
      }
    };
    kinds.forEach((k, i) => drawArrow(i * TW, k));
    const tex = new THREE.CanvasTexture(cv);
    tex.anisotropy = 4;
    const buf = new GeoBuf();
    for (const n of this.g.nodes) {
      if (n.armCount < 3) continue;
      for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) {
        const e = n.inc[d];
        if (!e) continue;
        for (const lane of e.lanes) {
          const mv = new Set<Movement>(lane.out.map((c) => c.movement));
          let key = '';
          if (mv.has('straight')) key += 'S';
          if (mv.has('left')) key += 'L';
          if (mv.has('right')) key += 'R';
          const idx = kinds.indexOf(key);
          if (idx < 0) continue;
          const fx = DX[d], fz = DZ[d];
          const rx = -fz, rz = fx;
          const cx = lane.xs[1] - fx * 9, cz = lane.zs[1] - fz * 9;
          const hw = 0.55, hl = 2.5;
          const u0 = idx / kinds.length, u1 = (idx + 1) / kinds.length;
          // corners: back-left, back-right, front-right, front-left
          buf.quad(
            cx - fx * hl - rx * hw, 0.013, cz - fz * hl - rz * hw,
            cx - fx * hl + rx * hw, 0.013, cz - fz * hl + rz * hw,
            cx + fx * hl + rx * hw, 0.013, cz + fz * hl + rz * hw,
            cx + fx * hl - rx * hw, 0.013, cz + fz * hl - rz * hw,
            0, 1, 0, [u0, 0, u1, 0, u1, 1, u0, 1],
          );
        }
      }
    }
    const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: false, alphaTest: 0.5, color: 0xeeeeee, roughness: 0.75, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    // White arrows: use map as alpha too.
    mat.alphaMap = tex;
    this.group.add(new THREE.Mesh(buf.geometry(), mat));
  }

  // ─── Blocks, buildings, parks, parking ──────────────────────────────────

  private facadeTextures(): [THREE.Texture, THREE.Texture] {
    const S = 256;
    const mk = () => {
      const c = document.createElement('canvas');
      c.width = c.height = S;
      return c;
    };
    const cA = mk(), cE = mk();
    const a = cA.getContext('2d')!, e = cE.getContext('2d')!;
    a.fillStyle = '#d8d2c8';
    a.fillRect(0, 0, S, S);
    e.fillStyle = '#000';
    e.fillRect(0, 0, S, S);
    // 4 × 4 windows per 12 m tile; texel (0.02, 0.02) (bottom-left) stays wall.
    const r = mulberry32(99);
    for (let fy = 0; fy < 4; fy++)
      for (let fx = 0; fx < 4; fx++) {
        const x = fx * 64 + 14, y = fy * 64 + 12, w = 36, h = 40;
        a.fillStyle = '#3d4b5c';
        a.fillRect(x, y, w, h);
        a.fillStyle = 'rgba(255,255,255,0.18)';
        a.fillRect(x, y, w, 6);
        a.fillStyle = '#9aa3ad';
        a.fillRect(x - 2, y + h, w + 4, 4);
        if (r() < 0.45) {
          e.fillStyle = r() < 0.7 ? '#ffcf8a' : '#cfe3ff';
          e.fillRect(x, y, w, h);
        }
      }
    a.fillStyle = '#d8d2c8';
    a.fillRect(0, S - 10, 10, 10);
    const tA = new THREE.CanvasTexture(cA);
    const tE = new THREE.CanvasTexture(cE);
    for (const t of [tA, tE]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 4;
    }
    tA.colorSpace = THREE.SRGBColorSpace;
    tE.colorSpace = THREE.SRGBColorSpace;
    return [tA, tE];
  }

  private buildBlocks(): void {
    const g = this.g;
    const side = new GeoBuf();
    const parkGrass = new GeoBuf();
    const lotLines = new GeoBuf();
    const bld: { x: number; z: number; w: number; d: number; h: number; c: number }[] = [];
    const trees: { x: number; z: number; s: number }[] = [];
    const cxC = (g.minX + g.maxX) / 2, czC = (g.minZ + g.maxZ) / 2;
    const maxD = Math.hypot(g.maxX - cxC, g.maxZ - czC);
    const H = 0.15;
    const X = (i: number) => g.node(i, 0)!.x;
    const Z = (j: number) => g.node(0, j)!.z;
    const parkBlock = (i: number, j: number) => (i * 3 + j * 5) % 7 === 0;
    const parkingBlock = (i: number, j: number) => i === Math.floor(g.nx / 2) - 1 && j === Math.floor(g.ny / 2);
    for (let i = 0; i < g.nx - 1; i++)
      for (let j = 0; j < g.ny - 1; j++) {
        const x0 = X(i) + this.hwV[i], x1 = X(i + 1) - this.hwV[i + 1];
        const z0 = Z(j) + this.hwH[j], z1 = Z(j + 1) - this.hwH[j + 1];
        side.box(x0, x1, 0, H, z0, z1, 3);
        const ix0 = x0 + SIDEWALK, ix1 = x1 - SIDEWALK, iz0 = z0 + SIDEWALK, iz1 = z1 - SIDEWALK;
        if (parkBlock(i, j)) {
          parkGrass.quad(ix0, H + 0.01, iz0, ix1, H + 0.01, iz0, ix1, H + 0.01, iz1, ix0, H + 0.01, iz1, 0, 1, 0, [ix0 / 4, iz0 / 4, ix1 / 4, iz0 / 4, ix1 / 4, iz1 / 4, ix0 / 4, iz1 / 4]);
          for (let k = 0; k < 40; k++) trees.push({ x: ix0 + 3 + this.rng() * (ix1 - ix0 - 6), z: iz0 + 3 + this.rng() * (iz1 - iz0 - 6), s: 0.8 + this.rng() * 0.6 });
          continue;
        }
        if (parkingBlock(i, j)) {
          this.buildParking(ix0, ix1, iz0, iz1, H, lotLines, bld);
          continue;
        }
        // 2 × 2 lots, taller towards the centre.
        const t = 1 - Math.hypot((x0 + x1) / 2 - cxC, (z0 + z1) / 2 - czC) / maxD;
        const nxL = 2, nzL = 2;
        const lw = (ix1 - ix0) / nxL, ld = (iz1 - iz0) / nzL;
        for (let a = 0; a < nxL; a++)
          for (let b = 0; b < nzL; b++) {
            const setback = 1.5 + this.rng() * 2;
            const w = lw - setback * 2, d = ld - setback * 2;
            if (this.rng() < 0.12) {
              for (let k = 0; k < 5; k++) trees.push({ x: ix0 + a * lw + 3 + this.rng() * (lw - 6), z: iz0 + b * ld + 3 + this.rng() * (ld - 6), s: 0.8 + this.rng() * 0.5 });
              continue;
            }
            const h = 9 + this.rng() * 18 + t * t * 70 * this.rng();
            const cols = [0xf1e7d8, 0xe2d6c3, 0xcfd6dc, 0xe9e3dc, 0xd7c2a8, 0xbfc8d2, 0xf3efe9, 0xc9b79c];
            bld.push({ x: ix0 + a * lw + lw / 2, z: iz0 + b * ld + ld / 2, w, d, h, c: cols[Math.floor(this.rng() * cols.length)] });
          }
      }
    // Outer sidewalk ring.
    const ox0 = g.minX - this.hwV[0], ox1 = g.maxX + this.hwV[g.nx - 1];
    const oz0 = g.minZ - this.hwH[0], oz1 = g.maxZ + this.hwH[g.ny - 1];
    side.box(ox0 - SIDEWALK, ox1 + SIDEWALK, 0, H, oz0 - SIDEWALK, oz0, 3);
    side.box(ox0 - SIDEWALK, ox1 + SIDEWALK, 0, H, oz1, oz1 + SIDEWALK, 3);
    side.box(ox0 - SIDEWALK, ox0, 0, H, oz0, oz1, 3);
    side.box(ox1, ox1 + SIDEWALK, 0, H, oz0, oz1, 3);
    // Suburb ring of low houses + trees outside the city.
    for (let k = 0; k < 90; k++) {
      const ang = this.rng() * Math.PI * 2;
      const rr = Math.max(ox1 - ox0, oz1 - oz0) * 0.5 + 40 + this.rng() * 260;
      const x = cxC + Math.cos(ang) * rr, z = czC + Math.sin(ang) * rr;
      if (this.rng() < 0.5) bld.push({ x, z, w: 10 + this.rng() * 14, d: 10 + this.rng() * 14, h: 6 + this.rng() * 10, c: 0xe7dccb });
      else for (let q = 0; q < 6; q++) trees.push({ x: x + (this.rng() - 0.5) * 30, z: z + (this.rng() - 0.5) * 30, s: 0.9 + this.rng() * 0.8 });
    }

    const cAlb = this.tex('./assets/textures/concrete/albedo.jpg', 1, true);
    const cNor = this.tex('./assets/textures/concrete/normal.jpg', 1, false);
    const sideMat = new THREE.MeshStandardMaterial({ map: cAlb, normalMap: cNor, roughness: 0.9, color: 0xc8c4bc });
    const sm = new THREE.Mesh(side.geometry(), sideMat);
    sm.receiveShadow = true;
    this.group.add(sm);
    const gAlb = this.tex('./assets/textures/grass/albedo.jpg', 1, true);
    const pg = new THREE.Mesh(parkGrass.geometry(), new THREE.MeshStandardMaterial({ map: gAlb, roughness: 1, color: 0xb9c79f }));
    pg.receiveShadow = true;
    this.group.add(pg);
    if (lotLines.pos.length) this.group.add(new THREE.Mesh(lotLines.geometry(), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2 })));

    // Buildings: one InstancedMesh, UVs scaled per instance in the shader.
    const [fa, fe] = this.facadeTextures();
    this.engine.track(fa);
    this.engine.track(fe);
    const bmat = new THREE.MeshStandardMaterial({ map: fa, emissiveMap: fe, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.85 });
    bmat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
        {
          vec3 isc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
          float fw = abs(normal.x) > 0.5 ? isc.z : isc.x;
          vec2 sUv = vec2(uv.x * fw / 12.0, uv.y * isc.y / 12.0);
          if (abs(normal.y) > 0.5) sUv = vec2(0.01, 0.01);
          vMapUv = sUv;
          vEmissiveMapUv = sUv;
        }`,
      );
    };
    this.windowMat = bmat;
    const bgeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const bmesh = new THREE.InstancedMesh(bgeo, bmat, bld.length);
    const m = new THREE.Matrix4();
    const col = new THREE.Color();
    bld.forEach((b, k) => {
      m.makeScale(b.w, b.h, b.d).setPosition(b.x, H, b.z);
      bmesh.setMatrixAt(k, m);
      bmesh.setColorAt(k, col.setHex(b.c));
      this.buildings.push({ x0: b.x - b.w / 2, x1: b.x + b.w / 2, z0: b.z - b.d / 2, z1: b.z + b.d / 2, h: b.h });
    });
    bmesh.castShadow = true;
    bmesh.receiveShadow = true;
    bmesh.computeBoundingSphere();
    this.group.add(bmesh);
    this.engine.onEnvChange.push(() => (bmat.emissiveIntensity = this.engine.night * 1.1));

    // Trees along sidewalks.
    for (const road of g.roads) {
      const len = Math.hypot(road.b.x - road.a.x, road.b.z - road.a.z);
      const dF: Dir = road.axis === 'h' ? 0 : 1;
      const dx = DX[dF], dz = DZ[dF];
      const rx = -dz, rz = dx;
      const off = road.halfWidth + SIDEWALK - 1.1;
      for (let s = 22; s < len - 22; s += 14) {
        if (Math.abs(s - len / 2) < 6 && (road.fwd?.midCrosswalk || road.back?.midCrosswalk)) continue;
        for (const sd of [-1, 1]) {
          if (this.rng() < 0.2) continue;
          trees.push({ x: road.a.x + dx * s + rx * off * sd, z: road.a.z + dz * s + rz * off * sd, s: 0.75 + this.rng() * 0.35 });
        }
      }
    }
    this.buildTrees(trees);
  }

  private buildParking(x0: number, x1: number, z0: number, z1: number, H: number, lines: GeoBuf, bld: { x: number; z: number; w: number; d: number; h: number; c: number }[]): void {
    // Asphalt lot with perpendicular bays; the two nearest the entrance are
    // 3.5 m wide disabled bays (marking 1.24 + sign 5.15 with plate 7.17).
    const asphalt = new GeoBuf();
    asphalt.quad(x0, H + 0.005, z0, x1, H + 0.005, z0, x1, H + 0.005, z1, x0, H + 0.005, z1, 0, 1, 0, [x0 / 7, z0 / 7, x1 / 7, z0 / 7, x1 / 7, z1 / 7, x0 / 7, z1 / 7]);
    const aAlb = this.tex('./assets/textures/asphalt/albedo.jpg', 1, true);
    const lot = new THREE.Mesh(asphalt.geometry(), new THREE.MeshStandardMaterial({ map: aAlb, roughness: 0.95, color: 0x8a8a8a }));
    lot.receiveShadow = true;
    this.group.add(lot);
    const y = H + 0.02;
    let x = x0 + 4;
    const zRow = z0 + 2;
    let k = 0;
    while (x < x1 - 4) {
      const disabled = k < 2;
      const w = disabled ? 3.5 : 2.5;
      lines.strip(x, zRow, x, zRow + 5.3, 0.12, y);
      if (disabled) {
        // wheelchair pictogram (simplified) — marking 1.24
        lines.strip(x + w / 2 - 0.5, zRow + 2.2, x + w / 2 + 0.5, zRow + 2.2, 0.12, y);
        lines.strip(x + w / 2, zRow + 1.5, x + w / 2, zRow + 3.0, 0.12, y);
        this.g.signs.push({ code: '5.15', x: x + w / 2, z: z0 - 0.3, faceDir: 3, stack: 0 });
        this.g.signs.push({ code: '7.17', x: x + w / 2, z: z0 - 0.3, faceDir: 3, stack: 1 });
      }
      this.parkingBays.push({ x: x + w / 2, z: zRow + 2.65, yaw: 0, w, disabled });
      x += w;
      k++;
    }
    lines.strip(x, zRow, x, zRow + 5.3, 0.12, y);
    bld.push({ x: (x0 + x1) / 2, z: z1 - 14, w: (x1 - x0) * 0.7, d: 20, h: 12, c: 0xcfd6dc }); // service centre (6.4)
    this.g.signs.push({ code: '6.4', x: x0 + 1, z: z0 - 0.3, faceDir: 3, stack: 0 });
  }

  private buildTrees(trees: { x: number; z: number; s: number }[]): void {
    const trunkG = new THREE.CylinderGeometry(0.16, 0.24, 3.2, 6).translate(0, 1.6, 0);
    const crownG = new THREE.IcosahedronGeometry(2.3, 1).translate(0, 4.6, 0);
    const trunk = new THREE.InstancedMesh(trunkG, new THREE.MeshStandardMaterial({ color: 0x5b4636, roughness: 1 }), trees.length);
    const crown = new THREE.InstancedMesh(crownG, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true }), trees.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const c = new THREE.Color();
    trees.forEach((t, k) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.rng() * 6.28);
      m.compose(new THREE.Vector3(t.x, 0.15, t.z), q, new THREE.Vector3(t.s, t.s * (0.9 + this.rng() * 0.3), t.s));
      trunk.setMatrixAt(k, m);
      crown.setMatrixAt(k, m);
      crown.setColorAt(k, c.setHSL(0.24 + this.rng() * 0.08, 0.45 + this.rng() * 0.2, 0.24 + this.rng() * 0.1));
      this.circles.push({ x: t.x, z: t.z, r: 0.35 * t.s });
    });
    for (const mm of [trunk, crown]) {
      mm.castShadow = this.quality !== 'low';
      mm.receiveShadow = true;
      mm.computeBoundingSphere();
      this.group.add(mm);
    }
  }

  // ─── Street lights, cones ────────────────────────────────────────────────

  private buildStreetFurniture(): void {
    const g = this.g;
    const poles: { x: number; z: number; yaw: number }[] = [];
    for (const road of g.roads) {
      const len = Math.hypot(road.b.x - road.a.x, road.b.z - road.a.z);
      const dF: Dir = road.axis === 'h' ? 0 : 1;
      const dx = DX[dF], dz = DZ[dF];
      const rx = -dz, rz = dx;
      const off = road.halfWidth + 0.7;
      let sd = 1;
      for (let s = 30; s < len - 25; s += 32) {
        sd = road.cls.name === 'arterial' ? sd : -sd;
        const sides = road.cls.name === 'arterial' ? [-1, 1] : [sd];
        for (const q of sides) {
          const x = road.a.x + dx * s + rx * off * q, z = road.a.z + dz * s + rz * off * q;
          // arm points over the road
          const yaw = Math.atan2(rx * q, rz * q);
          poles.push({ x, z, yaw });
          this.circles.push({ x, z, r: 0.18 });
        }
      }
    }
    const poleG = new THREE.CylinderGeometry(0.09, 0.13, 8, 6).translate(0, 4, 0);
    const armG = new THREE.BoxGeometry(0.08, 0.08, 1.8).translate(0, 7.9, -0.9);
    const headG = new THREE.BoxGeometry(0.35, 0.12, 0.7).translate(0, 7.84, -1.75);
    const metal = new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.5, metalness: 0.6 });
    const geo = mergeGeometries([poleG, armG]);
    const pm = new THREE.InstancedMesh(geo!, metal, poles.length);
    const lampMat = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xffe2b0, emissiveIntensity: 0 });
    this.streetLampMat = lampMat;
    const hm = new THREE.InstancedMesh(headG, lampMat, poles.length);
    const m = new THREE.Matrix4();
    poles.forEach((p, k) => {
      m.makeRotationY(p.yaw).setPosition(p.x, 0.15, p.z);
      pm.setMatrixAt(k, m);
      hm.setMatrixAt(k, m);
    });
    pm.castShadow = this.quality === 'high';
    for (const x of [pm, hm]) {
      x.computeBoundingSphere();
      this.group.add(x);
    }
    // Light pools under the lamps (additive decals — cheap "deferred" lights).
    const poolTex = radialTexture();
    this.engine.track(poolTex);
    const poolMat = new THREE.MeshBasicMaterial({ map: poolTex, color: 0xffd9a0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 });
    const pool = new THREE.InstancedMesh(new THREE.PlaneGeometry(14, 14).rotateX(-Math.PI / 2), poolMat, poles.length);
    poles.forEach((p, k) => {
      const fx = -Math.sin(p.yaw) * 1.75, fz = -Math.cos(p.yaw) * 1.75;
      m.makeTranslation(p.x + fx, 0.03, p.z + fz);
      pool.setMatrixAt(k, m);
    });
    pool.computeBoundingSphere();
    pool.renderOrder = 2;
    this.group.add(pool);
    this.engine.onEnvChange.push(() => {
      const n = this.engine.night;
      lampMat.emissiveIntensity = n > 0.3 ? 3 : 0;
      poolMat.opacity = n > 0.3 ? 0.55 * n : 0;
      pool.visible = n > 0.3;
    });
    // Road works cones.
    const cones: { x: number; z: number }[] = [];
    for (const e of g.edges) {
      if (!e.signs.includes('3.24-30T')) continue;
      const l = e.lanes[e.lanes.length - 1];
      const ex = -DZ[e.dir], ez = DX[e.dir];
      for (let s = 20; s < l.length - 20; s += 6) {
        const f = s / l.length;
        cones.push({ x: l.xs[0] + (l.xs[1] - l.xs[0]) * f + ex * (e.cls.laneWidth / 2 + 0.2), z: l.zs[0] + (l.zs[1] - l.zs[0]) * f + ez * (e.cls.laneWidth / 2 + 0.2) });
      }
    }
    if (cones.length) {
      const cg = new THREE.ConeGeometry(0.18, 0.7, 8).translate(0, 0.35, 0);
      const cm = new THREE.InstancedMesh(cg, new THREE.MeshStandardMaterial({ color: 0xff5a1f, roughness: 0.6 }), cones.length);
      cones.forEach((c, k) => cm.setMatrixAt(k, m.makeTranslation(c.x, 0, c.z)));
      cm.computeBoundingSphere();
      this.group.add(cm);
    }
  }

  // ─── Signs ───────────────────────────────────────────────────────────────

  private buildSigns(): void {
    const byCode = new Map<string, { x: number; y: number; z: number; yaw: number }[]>();
    const posts: { x: number; z: number; h: number }[] = [];
    const postKey = new Map<string, { x: number; z: number; h: number }>();
    for (const s of this.g.signs) {
      const [, h] = signSize(s.code);
      const top = 3.0 - s.stack * 0.85;
      const y = top - h / 2 + 0.15;
      const yaw = Math.atan2(DX[s.faceDir], DZ[s.faceDir]);
      // face slightly in front of the post
      const fx = DX[s.faceDir] * 0.06, fz = DZ[s.faceDir] * 0.06;
      if (!byCode.has(s.code)) byCode.set(s.code, []);
      byCode.get(s.code)!.push({ x: s.x + fx, y, z: s.z + fz, yaw });
      const key = `${s.x.toFixed(1)},${s.z.toFixed(1)}`;
      if (!postKey.has(key)) {
        const p = { x: s.x, z: s.z, h: 3.2 };
        postKey.set(key, p);
        posts.push(p);
        this.circles.push({ x: s.x, z: s.z, r: 0.1 });
      }
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    const backMat = new THREE.MeshStandardMaterial({ color: 0x8b9199, roughness: 0.6, metalness: 0.4 });
    for (const [code, list] of byCode) {
      const [w, h] = signSize(code);
      const tex = signTexture(code, this.quality === 'high' ? 8 : 4);
      const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: false, alphaTest: 0.4, roughness: 0.45, metalness: 0.0, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.12 });
      this.engine.onEnvChange.push(() => (mat.emissiveIntensity = this.engine.night > 0.3 ? 0.35 : 0.1));
      const face = new THREE.InstancedMesh(new THREE.PlaneGeometry(w, h), mat, list.length);
      const back = new THREE.InstancedMesh(new THREE.PlaneGeometry(w * 0.92, h * 0.92).rotateY(Math.PI).translate(0, 0, -0.01), backMat, list.length);
      list.forEach((p, k) => {
        q.setFromAxisAngle(up, p.yaw);
        m.compose(new THREE.Vector3(p.x, p.y, p.z), q, one);
        face.setMatrixAt(k, m);
        back.setMatrixAt(k, m);
      });
      face.computeBoundingSphere();
      back.computeBoundingSphere();
      face.name = 'sign:' + code;
      this.group.add(face, back);
    }
    const postG = new THREE.CylinderGeometry(0.045, 0.045, 3.2, 6).translate(0, 1.6 + 0.15, 0);
    const pm = new THREE.InstancedMesh(postG, new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.6, roughness: 0.4 }), posts.length);
    posts.forEach((p, k) => pm.setMatrixAt(k, m.makeTranslation(p.x, 0, p.z)));
    pm.computeBoundingSphere();
    this.group.add(pm);
  }

  // ─── Traffic lights ──────────────────────────────────────────────────────

  private buildTrafficLights(): void {
    const heads: THREE.Matrix4[] = [];
    const poles: THREE.Matrix4[] = [];
    const lampM: THREE.Matrix4[] = [];
    const pedHeads: THREE.Matrix4[] = [];
    const up = new THREE.Vector3(0, 1, 0);
    for (const n of this.g.nodes) {
      if (!n.light) continue;
      for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) {
        const e = n.inc[d];
        if (!e) continue;
        const fx = DX[d], fz = DZ[d];
        const rx = -fz, rz = fx;
        const hw = e.road.halfWidth;
        const off = this.g.armOffset(n, opposite(d)) - 0.3;
        const px = n.x - fx * off + rx * (hw + 0.9), pz = n.z - fz * off + rz * (hw + 0.9);
        const yaw = Math.atan2(-fx, -fz); // face towards approaching traffic
        const q = new THREE.Quaternion().setFromAxisAngle(up, yaw);
        poles.push(new THREE.Matrix4().makeTranslation(px, 0.15, pz));
        this.circles.push({ x: px, z: pz, r: 0.14 });
        // Near-side head at 3.0 m and an overhead copy on a mast for wide roads.
        const addHead = (hx: number, hy: number, hz: number) => {
          heads.push(new THREE.Matrix4().compose(new THREE.Vector3(hx, hy, hz), q, new THREE.Vector3(1, 1, 1)));
          const kinds: LampRef['kind'][] = ['r', 'y', 'g'];
          kinds.forEach((k, idx) => {
            const ly = hy + 0.32 - idx * 0.32;
            const lx = hx - fx * 0.14, lz = hz - fz * 0.14;
            lampM.push(new THREE.Matrix4().compose(new THREE.Vector3(lx, ly, lz), q, new THREE.Vector3(1, 1, 1)));
            this.lamps.push({ node: n, dIn: d, kind: k, armDir: d });
          });
          if (n.light!.hasLeftArrow) {
            // additional section (green arrow) on the left of the head
            const lx = hx - fx * 0.14 - rx * 0.36, lz = hz - fz * 0.14 - rz * 0.36;
            heads.push(new THREE.Matrix4().compose(new THREE.Vector3(hx - rx * 0.36, hy - 0.32, hz - rz * 0.36), q, new THREE.Vector3(1, 0.34, 1)));
            lampM.push(new THREE.Matrix4().compose(new THREE.Vector3(lx, hy - 0.32, lz), q, new THREE.Vector3(1, 1, 1)));
            this.lamps.push({ node: n, dIn: d, kind: 'arrow', armDir: d });
          }
        };
        addHead(px, 3.1, pz);
        // far-side overhead head on the mast arm
        const armLen = hw * 0.9;
        poles.push(new THREE.Matrix4().compose(new THREE.Vector3(px, 5.6, pz), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(fx, 0, fz), -Math.PI / 2), new THREE.Vector3(0.6, armLen / 5.5, 0.6)));
        addHead(px - rx * armLen, 5.0, pz - rz * armLen);
      }
      // Pedestrian signals at both ends of every crosswalk.
      for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) {
        const cw = n.crosswalks[d];
        if (!cw) continue;
        for (const sg of [-1, 1]) {
          const ex = cw.axis === 'x' ? cw.cx + sg * (cw.halfLen + 1.2) : cw.cx;
          const ez = cw.axis === 'z' ? cw.cz + sg * (cw.halfLen + 1.2) : cw.cz;
          // faces the opposite end of the crosswalk
          const fdx = cw.axis === 'x' ? -sg : 0, fdz = cw.axis === 'z' ? -sg : 0;
          const yaw = Math.atan2(fdx, fdz);
          const q = new THREE.Quaternion().setFromAxisAngle(up, yaw);
          pedHeads.push(new THREE.Matrix4().compose(new THREE.Vector3(ex, 2.4, ez), q, new THREE.Vector3(1, 1, 1)));
          (['pr', 'pg'] as const).forEach((k, idx) => {
            lampM.push(new THREE.Matrix4().compose(new THREE.Vector3(ex + fdx * 0.13, 2.55 - idx * 0.3, ez + fdz * 0.13), q, new THREE.Vector3(0.8, 0.8, 0.8)));
            this.lamps.push({ node: n, dIn: 0, kind: k, armDir: d });
          });
          this.circles.push({ x: ex, z: ez, r: 0.1 });
        }
      }
    }
    const dark = new THREE.MeshStandardMaterial({ color: 0x1f2328, roughness: 0.6, metalness: 0.3 });
    const headG = new THREE.BoxGeometry(0.36, 1.02, 0.24);
    const hm = new THREE.InstancedMesh(headG, dark, heads.length);
    heads.forEach((m, k) => hm.setMatrixAt(k, m));
    const poleG = new THREE.CylinderGeometry(0.07, 0.09, 5.5, 8).translate(0, 2.75, 0);
    const pm = new THREE.InstancedMesh(poleG, new THREE.MeshStandardMaterial({ color: 0x4b5563, roughness: 0.5, metalness: 0.5 }), poles.length);
    poles.forEach((m, k) => pm.setMatrixAt(k, m));
    const phG = new THREE.BoxGeometry(0.3, 0.66, 0.2);
    const phm = new THREE.InstancedMesh(phG, dark, Math.max(1, pedHeads.length));
    pedHeads.forEach((m, k) => phm.setMatrixAt(k, m));
    phm.count = pedHeads.length;
    const lampG = new THREE.CircleGeometry(0.11, 14); // faces +z locally → rotated with q
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const lm = new THREE.InstancedMesh(lampG, lampMat, lampM.length);
    lampM.forEach((m, k) => {
      lm.setMatrixAt(k, m);
      lm.setColorAt(k, LAMP_OFF.r);
    });
    lm.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.lampMesh = lm;
    for (const x of [hm, pm, phm, lm]) {
      x.computeBoundingSphere();
      this.group.add(x);
    }
    hm.castShadow = pm.castShadow = this.quality === 'high';
  }

  // ─── Traffic officer ────────────────────────────────────────────────────

  private buildOfficer(): void {
    const n = this.g.nodes.find((x) => x.regulator);
    if (!n) return;
    const grp = new THREE.Group();
    const uniform = new THREE.MeshStandardMaterial({ color: 0x3a4a3a, roughness: 0.8 });
    const vest = new THREE.MeshStandardMaterial({ color: 0xd4ff3a, roughness: 0.6, emissive: 0x334400 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xc58c6a, roughness: 0.8 });
    const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 });
    const legs = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.15, 0.9, 8).translate(0, 0.45, 0), uniform);
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.2, 0.66, 8).translate(0, 1.23, 0), vest);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8).translate(0, 1.7, 0), skin);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.15, 0.1, 10).translate(0, 1.83, 0), white);
    const podium = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.8, 0.25, 16).translate(0, 0.125, 0), new THREE.MeshStandardMaterial({ color: 0xffffff }));
    const arms = new THREE.Group();
    const armG = new THREE.BoxGeometry(1.5, 0.1, 0.1);
    arms.add(new THREE.Mesh(armG, uniform));
    const baton = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 6).rotateZ(Math.PI / 2).translate(1.0, 0, 0), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x888888 }));
    arms.add(baton);
    arms.position.y = 1.45;
    grp.add(podium, legs, torso, head, cap, arms);
    for (const c of grp.children) (c as THREE.Mesh).castShadow = true;
    for (const c of [legs, torso, head, cap, arms]) c.position.y += 0.25;
    grp.position.set(n.x, 0, n.z);
    grp.visible = false;
    this.officer = grp;
    this.officerArms = arms;
    this.group.add(grp);
    this.circles.push({ x: n.x, z: n.z, r: 0.8 });
  }

  // ─── Per-frame ───────────────────────────────────────────────────────────

  update(dt: number): void {
    this.blink += dt;
    const flashOn = this.blink % 1.0 < 0.5; // 60 flashes/min
    const lm = this.lampMesh;
    if (lm) {
      for (let k = 0; k < this.lamps.length; k++) {
        const L = this.lamps[k];
        const n = L.node;
        let on = false;
        if (L.kind === 'pr' || L.kind === 'pg') {
          const lightMode = n.regime() === 'light';
          const g = lightMode && n.light!.pedestrianGreen(L.armDir);
          on = !lightMode ? false : L.kind === 'pg' ? g : !g;
        } else {
          const light = n.light!;
          if (light.mode === 'flash') on = L.kind === 'y' && flashOn;
          else {
            let s: Signal;
            if (L.kind === 'arrow') s = light.signal(L.dIn, 'left');
            else s = light.signal(L.dIn, 'straight');
            if (L.kind === 'r') on = s === 'red' || s === 'red_yellow';
            else if (L.kind === 'y') on = s === 'yellow' || s === 'red_yellow';
            else if (L.kind === 'g') on = s === 'green' || (s === 'green_flash' && flashOn);
            else on = s === 'green' || (s === 'green_flash' && flashOn);
          }
        }
        lm.setColorAt(k, on ? LAMP_ON[L.kind] : LAMP_OFF[L.kind]);
      }
      lm.instanceColor!.needsUpdate = true;
    }
    const reg = this.g.nodes.find((x) => x.regulator)?.regulator;
    if (reg && this.officer && this.officerArms) {
      this.officer.visible = reg.enabled;
      if (reg.enabled) {
        const f = reg.facing();
        // Facing N/S (chest to N–S traffic = stop for them); arms along E–W.
        this.officer.rotation.y = f === 3 ? 0 : Math.PI / 2;
        this.officerArms.rotation.z = reg.handUp ? Math.PI / 2 : 0;
        this.officerArms.position.y = reg.handUp ? 1.95 : 1.7;
      }
    }
  }
}

function radialTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d')!;
  const gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.5, 'rgba(255,255,255,0.35)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = gr;
  x.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
