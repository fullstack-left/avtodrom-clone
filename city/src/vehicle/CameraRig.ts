// Camera rig with three modes matching the Avtodrom exam simulator: cockpit
// (driver eye), chase (close third person) and top-down. Free orbit with the
// mouse/right-stick and zoom; the chase camera trails the car with smoothing
// and looks a little into turns.

import * as THREE from 'three';
import { PlayerCar } from './PlayerCar';

export type CameraMode = 'cockpit' | 'chase' | 'top';

export class CameraRig {
  mode: CameraMode = 'chase';
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private yawOff = 0;
  private pitchOff = 0;
  private dist = 6.5;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private listeners: (() => void)[] = [];
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private initialised = false;

  constructor(public camera: THREE.PerspectiveCamera, dom: HTMLElement) {
    const down = (e: PointerEvent) => {
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    };
    const move = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.yawOff -= (e.clientX - this.lastX) * 0.005;
      this.pitchOff = THREE.MathUtils.clamp(this.pitchOff - (e.clientY - this.lastY) * 0.004, -0.5, 1.2);
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    };
    const up = () => (this.dragging = false);
    const wheel = (e: WheelEvent) => {
      this.dist = THREE.MathUtils.clamp(this.dist + e.deltaY * 0.01, 3.5, 20);
      e.preventDefault();
    };
    dom.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    dom.addEventListener('wheel', wheel, { passive: false });
    // pinch zoom
    let pinch = 0;
    const tm = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        if (pinch) this.dist = THREE.MathUtils.clamp(this.dist - (d - pinch) * 0.02, 3.5, 20);
        pinch = d;
      }
    };
    const te = () => (pinch = 0);
    dom.addEventListener('touchmove', tm, { passive: true });
    dom.addEventListener('touchend', te);
    this.listeners.push(
      () => dom.removeEventListener('pointerdown', down),
      () => window.removeEventListener('pointermove', move),
      () => window.removeEventListener('pointerup', up),
      () => dom.removeEventListener('wheel', wheel),
      () => dom.removeEventListener('touchmove', tm),
      () => dom.removeEventListener('touchend', te),
    );
  }

  cycle(): void {
    this.mode = this.mode === 'chase' ? 'cockpit' : this.mode === 'cockpit' ? 'top' : 'chase';
    this.yawOff = 0;
    this.pitchOff = 0;
    this.initialised = false;
  }

  update(dt: number, car: PlayerCar): void {
    const p = car.phys;
    // Right stick orbit.
    const pads = navigator.getGamepads?.() ?? [];
    for (const gp of pads) {
      if (!gp) continue;
      const rx = gp.axes[2] ?? 0, ry = gp.axes[3] ?? 0;
      if (Math.abs(rx) > 0.15) this.yawOff -= rx * dt * 2;
      if (Math.abs(ry) > 0.15) this.pitchOff = THREE.MathUtils.clamp(this.pitchOff + ry * dt * 1.5, -0.5, 1.2);
    }
    const carYaw = p.yaw;
    if (this.mode === 'cockpit') {
      car.eyeWorld(this.pos);
      const yaw = carYaw + this.yawOff;
      const pitch = this.pitchOff;
      this.tmp.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch) - 0.02, -Math.cos(yaw) * Math.cos(pitch));
      this.look.copy(this.pos).add(this.tmp);
      this.camera.position.copy(this.pos);
      this.camera.lookAt(this.look);
      if (car.model) car.model.visible = true;
      return;
    }
    if (this.mode === 'top') {
      const target = this.tmp.set(p.x, 0, p.z);
      this.pos.set(p.x, 42 + this.dist * 2, p.z + 0.01);
      this.camera.position.lerp(this.pos, 1 - Math.pow(0.001, dt));
      this.camera.up.set(0, 0, -1);
      this.camera.lookAt(target);
      this.camera.up.set(0, 1, 0);
      return;
    }
    // Chase.
    const turnLook = THREE.MathUtils.clamp(p.r * 0.3, -0.4, 0.4);
    const yaw = carYaw + this.yawOff + turnLook;
    const pitch = 0.28 + this.pitchOff;
    const back = this.tmp.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(this.dist);
    const focus = this.tmp2.set(p.x, 1.1, p.z);
    this.pos.copy(focus).add(back);
    if (this.pos.y < 0.6) this.pos.y = 0.6;
    if (!this.initialised) {
      this.camera.position.copy(this.pos);
      this.initialised = true;
    } else {
      const a = 1 - Math.pow(0.0009, dt);
      this.camera.position.lerp(this.pos, a);
    }
    this.look.set(p.x - Math.sin(yaw) * 4, 1.0, p.z - Math.cos(yaw) * 4);
    this.camera.lookAt(this.look);
    if (car.model) car.model.visible = true;
  }

  dispose(): void {
    for (const l of this.listeners) l();
  }
}
