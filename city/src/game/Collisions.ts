// Collision handling for the player car against: AI vehicles (oriented boxes,
// SAT + impulse), pedestrians (knock down), and static circle obstacles
// (poles, trees, sign posts, traffic-light masts) plus building AABBs.
// Returns which collision categories fired this frame for the rule monitor.

import { Pedestrians } from '../traffic/Pedestrians';
import { TrafficSim } from '../traffic/TrafficSim';
import { VehiclePhysics } from '../vehicle/VehiclePhysics';
import { AABB, Circle, WorldBuilder } from '../world/WorldBuilder';

export interface CollisionResult {
  ai: boolean;
  ped: boolean;
  obj: boolean;
  impact: number;
}

export class Collisions {
  private circleBuf: Circle[] = [];
  private aiBuf: number[] = [];
  private aiCooldown = 0;

  constructor(private phys: VehiclePhysics, private sim: TrafficSim, private peds: Pedestrians, private world: WorldBuilder) {}

  private corners(x: number, z: number, yaw: number, front: number, rear: number, half: number, out: number[]): void {
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = -fz, rz = fx;
    const set = (i: number, f: number, l: number) => {
      out[i * 2] = x + fx * f + rx * l;
      out[i * 2 + 1] = z + fz * f + rz * l;
    };
    set(0, front, -half);
    set(1, front, half);
    set(2, -rear, half);
    set(3, -rear, -half);
  }

  update(dt: number): CollisionResult {
    const p = this.phys;
    const s = p.spec;
    const res: CollisionResult = { ai: false, ped: false, obj: false, impact: 0 };
    this.aiCooldown = Math.max(0, this.aiCooldown - dt);

    // ── Static circles (poles/trees/posts) ─────────────────────────────
    const cx = p.x - Math.sin(p.yaw) * (s.frontHalfLen - s.rearHalfLen) / 2;
    const cz = p.z - Math.cos(p.yaw) * (s.frontHalfLen - s.rearHalfLen) / 2;
    this.world.circlesNear(p.x, p.z, this.circleBuf);
    const carR = Math.max(s.frontHalfLen, s.halfWidth);
    for (const c of this.circleBuf) {
      const dx = p.x - c.x, dz = p.z - c.z;
      const d = Math.hypot(dx, dz);
      const minD = c.r + s.halfWidth;
      // cheap: project onto car frame for a tighter test
      const localF = -Math.sin(p.yaw) * -dx + -Math.cos(p.yaw) * -dz;
      const localR = (-Math.cos(p.yaw)) * -dx + Math.sin(p.yaw) * -dz;
      const overF = Math.max(0, Math.abs(localF) - (localF > 0 ? s.frontHalfLen : s.rearHalfLen) - c.r);
      const overR = Math.max(0, Math.abs(localR) - s.halfWidth - c.r);
      if (overF <= 0 && overR <= 0 && d > 0.01) {
        const nx = dx / d, nz = dz / d;
        const depth = minD - d + 0.02;
        const imp = p.collide(nx, nz, Math.max(0.02, depth), 0.15);
        if (imp > 2 && this.aiCooldown === 0) {
          res.obj = true;
          res.impact = Math.max(res.impact, imp);
        }
      }
    }

    // ── Building AABBs ──────────────────────────────────────────────────
    for (const b of nearBuildings(this.world.buildings, p.x, p.z, 8)) {
      const nx = Math.max(b.x0, Math.min(p.x, b.x1));
      const nz = Math.max(b.z0, Math.min(p.z, b.z1));
      const dx = p.x - nx, dz = p.z - nz;
      const d = Math.hypot(dx, dz);
      if (d < s.halfWidth + 0.1) {
        let nvx: number, nvz: number, depth: number;
        if (d > 0.001) {
          nvx = dx / d;
          nvz = dz / d;
          depth = s.halfWidth - d;
        } else {
          // centre inside: push out along the nearest face
          const toL = p.x - b.x0, toR = b.x1 - p.x, toB = p.z - b.z0, toT = b.z1 - p.z;
          const m = Math.min(toL, toR, toB, toT);
          if (m === toL) (nvx = -1), (nvz = 0);
          else if (m === toR) (nvx = 1), (nvz = 0);
          else if (m === toB) (nvx = 0), (nvz = -1);
          else (nvx = 0), (nvz = 1);
          depth = s.halfWidth + m;
        }
        const imp = p.collide(nvx, nvz, depth + 0.02, 0.1);
        if (imp > 2 && this.aiCooldown === 0) {
          res.obj = true;
          res.impact = Math.max(res.impact, imp);
        }
      }
    }

    // ── AI vehicles (SAT of two oriented boxes) ─────────────────────────
    this.sim.near(p.x, p.z, 8, this.aiBuf);
    const pc: number[] = [];
    this.corners(p.x, p.z, p.yaw, s.frontHalfLen, s.rearHalfLen, s.halfWidth, pc);
    for (const i of this.aiBuf) {
      const ac: number[] = [];
      const half = this.sim.len[i] / 2;
      this.corners(this.sim.x[i], this.sim.z[i], this.sim.yaw[i], half, half, 0.85, ac);
      const mtv = satBoxes(pc, ac);
      if (mtv) {
        let nx = mtv.nx, nz = mtv.nz;
        // point normal from AI car towards player
        if ((p.x - this.sim.x[i]) * nx + (p.z - this.sim.z[i]) * nz < 0) {
          nx = -nx;
          nz = -nz;
        }
        const imp = p.collide(nx, nz, mtv.depth + 0.02, 0.2);
        // Nudge the AI car away and slow it.
        this.sim.x[i] -= nx * (mtv.depth * 0.5);
        this.sim.z[i] -= nz * (mtv.depth * 0.5);
        this.sim.v[i] *= 0.6;
        this.sim.stuck[i] = Math.min(this.sim.stuck[i], 60);
        if (imp > 1.5 && this.aiCooldown === 0) {
          res.ai = true;
          res.impact = Math.max(res.impact, imp);
          this.aiCooldown = 1.0;
        }
      }
    }

    // ── Pedestrians ─────────────────────────────────────────────────────
    const ph = this.peds.hit(p.x, p.z, s.halfWidth + 0.5);
    if (ph >= 0 && p.kmh > 2) {
      this.peds.knock(ph);
      res.ped = true;
      res.impact = Math.max(res.impact, p.kmh / 3);
    }
    return res;
  }
}

function nearBuildings(list: AABB[], x: number, z: number, m: number): AABB[] {
  const out: AABB[] = [];
  for (const b of list) if (x > b.x0 - m && x < b.x1 + m && z > b.z0 - m && z < b.z1 + m) out.push(b);
  return out;
}

interface MTV {
  nx: number;
  nz: number;
  depth: number;
}

/** Separating-axis test of two convex quads (8 numbers each). */
function satBoxes(a: number[], b: number[]): MTV | null {
  let minDepth = Infinity;
  let mnx = 0, mnz = 0;
  for (const poly of [a, b]) {
    for (let i = 0; i < 4; i++) {
      const x1 = poly[i * 2], z1 = poly[i * 2 + 1];
      const x2 = poly[((i + 1) % 4) * 2], z2 = poly[((i + 1) % 4) * 2 + 1];
      let axx = -(z2 - z1), axz = x2 - x1;
      const l = Math.hypot(axx, axz) || 1;
      axx /= l;
      axz /= l;
      let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
      for (let k = 0; k < 4; k++) {
        const pa = a[k * 2] * axx + a[k * 2 + 1] * axz;
        const pb = b[k * 2] * axx + b[k * 2 + 1] * axz;
        aMin = Math.min(aMin, pa);
        aMax = Math.max(aMax, pa);
        bMin = Math.min(bMin, pb);
        bMax = Math.max(bMax, pb);
      }
      if (aMax < bMin || bMax < aMin) return null; // separating axis found
      const overlap = Math.min(aMax, bMax) - Math.max(aMin, bMin);
      if (overlap < minDepth) {
        minDepth = overlap;
        mnx = axx;
        mnz = axz;
      }
    }
  }
  return { nx: mnx, nz: mnz, depth: minDepth };
}
