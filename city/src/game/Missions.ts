// Two structured game modes on top of free driving:
//   • Taxi missions: pick up a passenger, drive to a destination without
//     violations; earns a fare minus the accumulated fines.
//   • City exam: a fixed multi-leg route with voice-style prompts; must be
//     completed without reaching the 20-point fail threshold.

import * as THREE from 'three';
import { Navigator } from './Navigator';
import { TrafficRuleGraph } from '../world/TrafficRuleGraph';
import { RuleMonitor } from './RuleMonitor';
import { mulberry32 } from '../traffic/TrafficSim';
import { t } from '../i18n';

export interface MissionMarker {
  x: number;
  z: number;
  edge: number;
}

export class TaxiMissions {
  stage: 'to_pickup' | 'to_drop' | 'done' = 'to_pickup';
  pickup!: MissionMarker;
  drop!: MissionMarker;
  fare = 0;
  completed = 0;
  totalEarned = 0;
  private rng = mulberry32(4242);
  ring = new THREE.Group();
  private rings: THREE.Mesh[] = [];

  constructor(private g: TrafficRuleGraph, private nav: Navigator) {
    for (let i = 0; i < 1; i++) {
      const geo = new THREE.CylinderGeometry(3.2, 3.2, 8, 24, 1, true);
      const mat = new THREE.MeshBasicMaterial({ color: 0x2bb3ff, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false });
      const m = new THREE.Mesh(geo, mat);
      m.position.y = 4;
      this.rings.push(m);
      this.ring.add(m);
    }
  }

  private randomEdge(): number {
    return Math.floor(this.rng() * this.g.edges.length);
  }
  private edgeMid(id: number): MissionMarker {
    const e = this.g.edges[id];
    return { x: (e.from.x + e.to.x) / 2, z: (e.from.z + e.to.z) / 2, edge: id };
  }

  async begin(fromEdge: number): Promise<void> {
    this.pickup = this.edgeMid(this.randomEdge());
    this.stage = 'to_pickup';
    this.fare = 0;
    await this.nav.requestRoute(fromEdge, this.pickup.edge);
    this.updateRing();
  }

  private updateRing(): void {
    const m = this.stage === 'to_pickup' ? this.pickup : this.stage === 'to_drop' ? this.drop : null;
    if (m) {
      this.ring.visible = true;
      this.ring.position.set(m.x, 0, m.z);
      const col = this.stage === 'to_pickup' ? 0x39d353 : 0x2bb3ff;
      (this.rings[0].material as THREE.MeshBasicMaterial).color.setHex(col);
    } else this.ring.visible = false;
  }

  async update(carEdge: number, x: number, z: number, speed: number, fines: number): Promise<string | null> {
    this.ring.rotation.y += 0.02;
    const target = this.stage === 'to_pickup' ? this.pickup : this.drop;
    if (!target) return null;
    const d = Math.hypot(x - target.x, z - target.z);
    if (this.stage === 'to_pickup' && d < 6 && speed < 2) {
      this.drop = this.edgeMid(this.randomEdge());
      const dist = Math.hypot(this.drop.x - x, this.drop.z - z);
      this.fare = Math.round(3000 + dist * 25);
      this.stage = 'to_drop';
      await this.nav.requestRoute(carEdge, this.drop.edge);
      this.updateRing();
      return t('dropoff');
    }
    if (this.stage === 'to_drop' && d < 6 && speed < 2) {
      this.stage = 'done';
      this.completed++;
      const earned = Math.max(0, this.fare - fines);
      this.totalEarned += earned;
      this.updateRing();
      return `${t('mission_done')}: +${earned.toLocaleString()} ${t('money')}`;
    }
    return null;
  }

  markers(): { x: number; z: number; color: string }[] {
    const target = this.stage === 'to_pickup' ? this.pickup : this.stage === 'to_drop' ? this.drop : null;
    return target ? [{ x: target.x, z: target.z, color: this.stage === 'to_pickup' ? '#39d353' : '#2bb3ff' }] : [];
  }
}

export interface ExamLeg {
  edge: number;
  instruction: 'left' | 'right' | 'straight' | 'finish';
}

export class CityExam {
  legs: ExamLeg[] = [];
  index = 0;
  finished = false;
  passed = false;
  startTime = 0;
  ring = new THREE.Group();
  private rng = mulberry32(1001);

  constructor(private g: TrafficRuleGraph, private nav: Navigator) {
    const geo = new THREE.CylinderGeometry(3, 3, 7, 20, 1, true);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffcc00, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false });
    const m = new THREE.Mesh(geo, mat);
    m.position.y = 3.5;
    this.ring.add(m);
  }

  async begin(fromEdge: number): Promise<void> {
    // Chain 6 waypoints across the city via A*.
    this.legs = [];
    let cur = fromEdge;
    const wpEdges: number[] = [];
    for (let i = 0; i < 6; i++) {
      let g = Math.floor(this.rng() * this.g.edges.length);
      wpEdges.push(g);
    }
    this.goalEdge = wpEdges[wpEdges.length - 1];
    this.index = 0;
    this.finished = false;
    this.passed = false;
    this.startTime = performance.now();
    this.wpEdges = wpEdges;
    this.curFrom = fromEdge;
    await this.routeTo(fromEdge, wpEdges[0]);
  }

  private wpEdges: number[] = [];
  private wpIndex = 0;
  private curFrom = 0;
  goalEdge = -1;

  private async routeTo(from: number, to: number): Promise<void> {
    await this.nav.requestRoute(from, to);
    const target = this.g.edges[to];
    this.ring.position.set((target.from.x + target.to.x) / 2, 0, (target.from.z + target.to.z) / 2);
    this.ring.visible = true;
  }

  async update(carEdge: number, x: number, z: number, speed: number): Promise<string | null> {
    this.ring.rotation.y += 0.02;
    if (this.finished) return null;
    const to = this.wpEdges[this.wpIndex];
    const target = this.g.edges[to];
    const tx = (target.from.x + target.to.x) / 2, tz = (target.from.z + target.to.z) / 2;
    const d = Math.hypot(x - tx, z - tz);
    if (d < 8) {
      this.wpIndex++;
      if (this.wpIndex >= this.wpEdges.length) {
        this.finished = true;
        this.ring.visible = false;
        return null;
      }
      await this.routeTo(carEdge, this.wpEdges[this.wpIndex]);
      return null;
    }
    return null;
  }

  elapsed(): number {
    return (performance.now() - this.startTime) / 1000;
  }
  markers(): { x: number; z: number; color: string }[] {
    if (this.finished || this.wpIndex >= this.wpEdges.length) return [];
    const target = this.g.edges[this.wpEdges[this.wpIndex]];
    return [{ x: (target.from.x + target.to.x) / 2, z: (target.from.z + target.to.z) / 2, color: '#ffcc00' }];
  }
}
