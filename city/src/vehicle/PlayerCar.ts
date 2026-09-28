// Player car: the full Avtodrom GLB model (Nexia 2 / Cobalt) driven by
// VehiclePhysics — steering wheels, rolling wheels, rotating steering wheel,
// lamps (dipped beams with real spot lights, tail, brake, reverse, blinking
// indicators and hazard lights), cockpit eye point.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VehiclePhysics } from './VehiclePhysics';

export type Indicator = -1 | 0 | 1;

export class PlayerCar {
  root = new THREE.Group();
  model: THREE.Object3D | null = null;
  wheelPivots: THREE.Object3D[] = [];
  wheelSpins: THREE.Object3D[] = [];
  steering: THREE.Object3D | null = null;
  cockpitEye = new THREE.Vector3(-0.35, 1.13, 0.2);
  indicator: Indicator = 0;
  hazard = false;
  headlights = false;
  seatbelt = false;
  blinkLit = false;
  private blinkT = 0;
  private lamps = new Map<string, THREE.Mesh>();
  private lampMats = new Map<string, THREE.MeshStandardMaterial>();
  private spots: THREE.SpotLight[] = [];
  private paint: THREE.Color;
  onBlink: ((on: boolean) => void) | null = null;

  constructor(public phys: VehiclePhysics, paint = 0xf5f5f5) {
    this.paint = new THREE.Color(paint);
  }

  async load(quality: 'low' | 'medium' | 'high'): Promise<void> {
    const file = this.phys.spec.id === 'nexia2' ? './assets/cars/nexia2.glb' : './assets/cars/cobalt.glb';
    const gltf = await new GLTFLoader().loadAsync(file);
    const model = gltf.scene;
    this.model = model;
    this.root.add(model);
    for (const c of ['FL', 'FR', 'RL', 'RR']) {
      const p = model.getObjectByName('Wheel_' + c);
      const s = model.getObjectByName('Spin_' + c);
      if (p) this.wheelPivots.push(p);
      if (s) this.wheelSpins.push(s);
    }
    this.steering = model.getObjectByName('SteeringWheel') ?? null;
    const pivot = model.getObjectByName('SteeringPivot');
    if (pivot) this.cockpitEye.copy(pivot.position).add(new THREE.Vector3(-0.01, 0.34, 0.52));
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.name === 'CollisionHull') {
        mesh.visible = false;
        return;
      }
      mesh.castShadow = quality !== 'low';
      mesh.receiveShadow = true;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mm of mats) {
        const m = mm as THREE.MeshStandardMaterial;
        if (m.name === 'paint') {
          m.color.copy(this.paint);
          m.metalness = 0.5;
          m.roughness = 0.28;
        } else if (m.name === 'window') {
          m.transparent = true;
          m.opacity = 0.35;
          m.color.set(0x1b2733);
          m.roughness = 0.05;
          m.metalness = 0.3;
          m.depthWrite = false;
        } else if (m.name === 'chrome') {
          m.metalness = 1;
          m.roughness = 0.15;
        } else if (m.name === 'gauge') {
          m.color.set(0x111111);
        }
      }
    });
    for (const n of ['Lamp_Head', 'Lamp_Fog', 'Lamp_Tail', 'Lamp_Brake', 'Lamp_Reverse', 'Lamp_TurnFL', 'Lamp_TurnFR', 'Lamp_TurnRL', 'Lamp_TurnRR', 'Lamp_TurnSL', 'Lamp_TurnSR']) {
      const m = model.getObjectByName(n) as THREE.Mesh | undefined;
      if (!m || !m.isMesh) continue;
      const base = (m.material as THREE.MeshStandardMaterial).clone();
      m.material = base;
      this.lamps.set(n, m);
      this.lampMats.set(n, base);
    }
    // Dipped-beam spot lights (real dynamic lights, player car only).
    for (const sx of [-0.62, 0.62]) {
      const sp = new THREE.SpotLight(0xfff1d6, 0, 70, 0.5, 0.55, 1.6);
      sp.position.set(sx, 0.7, -2.0);
      sp.target.position.set(sx * 1.4, 0, -22);
      sp.castShadow = false;
      this.root.add(sp, sp.target);
      this.spots.push(sp);
    }
  }

  private setLamp(name: string, on: boolean, color: number, intensity = 3): void {
    const m = this.lampMats.get(name);
    if (!m) return;
    m.emissive.set(on ? color : 0x000000);
    m.emissiveIntensity = on ? intensity : 0;
  }

  update(dt: number, braking: boolean): void {
    const p = this.phys;
    this.root.position.set(p.x, 0, p.z);
    this.root.rotation.set(0, p.yaw, 0);
    // Body pitch/roll from accelerations (suspension feel).
    if (this.model) {
      this.model.rotation.x = THREE.MathUtils.clamp(p.ax * 0.006, -0.03, 0.03);
      this.model.rotation.z = THREE.MathUtils.clamp(-p.ay * 0.008, -0.04, 0.04);
    }
    const steer = p.steerAngle;
    for (let i = 0; i < this.wheelPivots.length; i++) if (i < 2) this.wheelPivots[i].rotation.y = steer;
    for (const s of this.wheelSpins) s.rotation.x = -p.wheelSpin;
    if (this.steering) {
      const ratio = p.spec.steeringWheelLockDeg / p.spec.maxSteerDeg;
      this.steering.rotation.y = steer * ratio;
    }
    // Indicators 90 flashes/min.
    this.blinkT += dt;
    const lit = (this.indicator !== 0 || this.hazard) && this.blinkT % 0.667 < 0.36;
    if (lit !== this.blinkLit) {
      this.blinkLit = lit;
      this.onBlink?.(lit);
    }
    const left = lit && (this.hazard || this.indicator === -1);
    const right = lit && (this.hazard || this.indicator === 1);
    const AMBER = 0xff8a00;
    for (const n of ['Lamp_TurnFL', 'Lamp_TurnRL', 'Lamp_TurnSL']) this.setLamp(n, left, AMBER, 5);
    for (const n of ['Lamp_TurnFR', 'Lamp_TurnRR', 'Lamp_TurnSR']) this.setLamp(n, right, AMBER, 5);
    this.setLamp('Lamp_Head', this.headlights, 0xfff4dc, 4);
    this.setLamp('Lamp_Tail', this.headlights, 0xff1010, 1.5);
    this.setLamp('Lamp_Brake', braking, 0xff1010, 5);
    this.setLamp('Lamp_Reverse', p.isReverse(), 0xffffff, 3);
    for (const s of this.spots) s.intensity = this.headlights ? 60 : 0;
  }

  /** World-space eye point for the cockpit camera. */
  eyeWorld(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.cockpitEye).applyMatrix4(this.root.matrixWorld);
  }

  dispose(): void {
    this.root.parent?.remove(this.root);
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
      }
    });
  }
}
