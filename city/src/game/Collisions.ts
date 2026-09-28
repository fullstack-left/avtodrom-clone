// Player collision system. Narrow phases match the actual vehicle footprint:
// circle-vs-OBB for trees/poles, OBB-vs-AABB SAT for buildings, OBB-vs-OBB
// for traffic and point-vs-OBB for pedestrians. Events are emitted on contact
// start (not every frame of one overlap), and vehicle impulses use relative
// velocity instead of treating a moving AI car as a concrete wall.

import { Pedestrians } from '../traffic/Pedestrians';
import { TrafficSim } from '../traffic/TrafficSim';
import { VehiclePhysics, VehicleSpec } from '../vehicle/VehiclePhysics';
import { AABB, Circle, WorldBuilder } from '../world/WorldBuilder';

export interface CollisionResult {
  ai: boolean;
  ped: boolean;
  obj: boolean;
  impact: number;
}

interface MTV {
  nx: number;
  nz: number;
  depth: number;
}

export class Collisions {
  private circleBuf: Circle[] = [];
  private aiBuf: number[] = [];
  private playerCorners: number[] = new Array(8).fill(0);
  private otherCorners: number[] = new Array(8).fill(0);
  private wasAiContact = false;
  private wasObjectContact = false;
  private wasPedContact = false;

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

  update(_dt: number): CollisionResult {
    const p = this.phys;
    const spec = p.spec;
    let aiContact = false, objectContact = false, pedContact = false;
    let aiImpact = 0, objectImpact = 0, pedImpact = 0;

    // ── Static circles: exact closest point on the oriented car rectangle.
    this.world.circlesNear(p.x, p.z, this.circleBuf);
    for (const circle of this.circleBuf) {
      const mtv = circleVsVehicle(circle, p.x, p.z, p.yaw, spec);
      if (!mtv) continue;
      objectContact = true;
      const impact = p.collide(mtv.nx, mtv.nz, mtv.depth + 0.006, 0.08);
      objectImpact = Math.max(objectImpact, impact);
    }

    // ── Buildings: complete player OBB against the axis-aligned footprint.
    for (const building of nearBuildings(this.world.buildings, p.x, p.z, 9)) {
      this.corners(p.x, p.z, p.yaw, spec.frontHalfLen, spec.rearHalfLen, spec.halfWidth, this.playerCorners);
      aabbCorners(building, this.otherCorners);
      const mtv = satBoxes(this.playerCorners, this.otherCorners);
      if (!mtv) continue;
      orientTowards(mtv, p.x - (building.x0 + building.x1) * 0.5, p.z - (building.z0 + building.z1) * 0.5);
      objectContact = true;
      const impact = p.collide(mtv.nx, mtv.nz, mtv.depth + 0.008, 0.06);
      objectImpact = Math.max(objectImpact, impact);
    }

    // ── AI vehicles: relative-velocity two-body share, no derived-pose nudge.
    this.sim.near(p.x, p.z, 9, this.aiBuf);
    for (const i of this.aiBuf) {
      this.corners(p.x, p.z, p.yaw, spec.frontHalfLen, spec.rearHalfLen, spec.halfWidth, this.playerCorners);
      const half = this.sim.len[i] * 0.5;
      this.corners(this.sim.x[i], this.sim.z[i], this.sim.yaw[i], half, half, 0.86, this.otherCorners);
      const mtv = satBoxes(this.playerCorners, this.otherCorners);
      if (!mtv) continue;
      orientTowards(mtv, p.x - this.sim.x[i], p.z - this.sim.z[i]);
      const ofx = -Math.sin(this.sim.yaw[i]);
      const ofz = -Math.cos(this.sim.yaw[i]);
      const otherVx = ofx * this.sim.v[i];
      const otherVz = ofz * this.sim.v[i];
      const impact = p.collide(mtv.nx, mtv.nz, mtv.depth + 0.01, 0.16, otherVx, otherVz, 1200);
      // Canonical AI state is path/s; only adjust its speed. Modifying rendered
      // x/z would snap back on the next TrafficSim.updatePoses().
      if (impact > 0) this.sim.v[i] = Math.max(0, this.sim.v[i] - impact * 0.16);
      aiContact = true;
      aiImpact = Math.max(aiImpact, impact);
    }

    // ── Pedestrians: point/capsule centre against the whole oriented body.
    const pedestrian = pedestrianInVehicle(this.peds, p.x, p.z, p.yaw, spec, 0.28);
    if (pedestrian >= 0) {
      pedContact = true;
      pedImpact = p.speed;
      if (!this.wasPedContact && p.kmh > 2) this.peds.knock(pedestrian);
    }

    const result: CollisionResult = {
      ai: aiContact && !this.wasAiContact && aiImpact > 1.2,
      obj: objectContact && !this.wasObjectContact && objectImpact > 1.5,
      ped: pedContact && !this.wasPedContact && p.kmh > 2,
      impact: Math.max(aiImpact, objectImpact, pedImpact),
    };
    this.wasAiContact = aiContact;
    this.wasObjectContact = objectContact;
    this.wasPedContact = pedContact;
    return result;
  }
}

function circleVsVehicle(circle: Circle, x: number, z: number, yaw: number, s: VehicleSpec): MTV | null {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const rx = -fz, rz = fx;
  const wx = circle.x - x, wz = circle.z - z;
  const lf = wx * fx + wz * fz;
  const lr = wx * rx + wz * rz;
  const cf = Math.max(-s.rearHalfLen, Math.min(s.frontHalfLen, lf));
  const cr = Math.max(-s.halfWidth, Math.min(s.halfWidth, lr));
  const df = lf - cf, dr = lr - cr;
  const d = Math.hypot(df, dr);
  if (d >= circle.r) return null;
  if (d > 1e-5) {
    // (df,dr) points from car to circle; push the car the other way.
    const nf = -df / d, nr = -dr / d;
    return { nx: fx * nf + rx * nr, nz: fz * nf + rz * nr, depth: circle.r - d };
  }
  // Circle centre lies inside the OBB. Choose the nearest separating face.
  const distances = [s.frontHalfLen - lf, lf + s.rearHalfLen, s.halfWidth - lr, lr + s.halfWidth];
  let side = 0;
  for (let i = 1; i < 4; i++) if (distances[i] < distances[side]) side = i;
  if (side === 0) return { nx: -fx, nz: -fz, depth: circle.r + distances[side] };
  if (side === 1) return { nx: fx, nz: fz, depth: circle.r + distances[side] };
  if (side === 2) return { nx: -rx, nz: -rz, depth: circle.r + distances[side] };
  return { nx: rx, nz: rz, depth: circle.r + distances[side] };
}

function pedestrianInVehicle(peds: Pedestrians, x: number, z: number, yaw: number, s: VehicleSpec, radius: number): number {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const rx = -fz, rz = fx;
  for (let i = 0; i < peds.count; i++) {
    const dx = peds.x[i] - x, dz = peds.z[i] - z;
    const f = dx * fx + dz * fz;
    const r = dx * rx + dz * rz;
    if (f >= -s.rearHalfLen - radius && f <= s.frontHalfLen + radius && Math.abs(r) <= s.halfWidth + radius) return i;
  }
  return -1;
}

function nearBuildings(list: AABB[], x: number, z: number, margin: number): AABB[] {
  const out: AABB[] = [];
  for (const b of list) if (x > b.x0 - margin && x < b.x1 + margin && z > b.z0 - margin && z < b.z1 + margin) out.push(b);
  return out;
}

function aabbCorners(b: AABB, out: number[]): void {
  out[0] = b.x0; out[1] = b.z0;
  out[2] = b.x1; out[3] = b.z0;
  out[4] = b.x1; out[5] = b.z1;
  out[6] = b.x0; out[7] = b.z1;
}

function orientTowards(mtv: MTV, dx: number, dz: number): void {
  if (dx * mtv.nx + dz * mtv.nz < 0) {
    mtv.nx = -mtv.nx;
    mtv.nz = -mtv.nz;
  }
}

/** Separating-axis test of two convex quads (8 numbers each). */
function satBoxes(a: number[], b: number[]): MTV | null {
  let minDepth = Infinity;
  let mnx = 0, mnz = 0;
  for (const poly of [a, b]) {
    for (let i = 0; i < 4; i++) {
      const x1 = poly[i * 2], z1 = poly[i * 2 + 1];
      const x2 = poly[((i + 1) % 4) * 2], z2 = poly[((i + 1) % 4) * 2 + 1];
      let ax = -(z2 - z1), az = x2 - x1;
      const length = Math.hypot(ax, az) || 1;
      ax /= length;
      az /= length;
      let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
      for (let k = 0; k < 4; k++) {
        const pa = a[k * 2] * ax + a[k * 2 + 1] * az;
        const pb = b[k * 2] * ax + b[k * 2 + 1] * az;
        aMin = Math.min(aMin, pa);
        aMax = Math.max(aMax, pa);
        bMin = Math.min(bMin, pb);
        bMax = Math.max(bMax, pb);
      }
      if (aMax < bMin || bMax < aMin) return null;
      const overlap = Math.min(aMax, bMax) - Math.max(aMin, bMin);
      if (overlap < minDepth) {
        minDepth = overlap;
        mnx = ax;
        mnz = az;
      }
    }
  }
  return { nx: mnx, nz: mnz, depth: minDepth };
}
