// Unified input: keyboard, gamepad and on-screen touch controls. Produces a
// normalised control state consumed by the game every frame.

export interface InputState {
  throttle: number;
  brake: number;
  steer: number; // −1 right … +1 left
  clutch: number;
  handbrake: boolean;
  // Edge-triggered actions (consumed via take()).
  toggleIndicatorLeft: boolean;
  toggleIndicatorRight: boolean;
  toggleHazard: boolean;
  toggleHeadlights: boolean;
  toggleSeatbelt: boolean;
  cycleCamera: boolean;
  gearUp: boolean;
  gearDown: boolean;
  selectDrive: boolean;
  selectReverse: boolean;
  selectPark: boolean;
  neutral: boolean;
  startEngine: boolean;
  horn: boolean;
  toggleMap: boolean;
  pause: boolean;
  respawn: boolean;
}

const ZERO = (): InputState => ({
  throttle: 0, brake: 0, steer: 0, clutch: 0, handbrake: false,
  toggleIndicatorLeft: false, toggleIndicatorRight: false, toggleHazard: false, toggleHeadlights: false,
  toggleSeatbelt: false, cycleCamera: false, gearUp: false, gearDown: false,
  selectDrive: false, selectReverse: false, selectPark: false, neutral: false,
  startEngine: false, horn: false, toggleMap: false, pause: false, respawn: false,
});

export class InputManager {
  state = ZERO();
  private keys = new Set<string>();
  private edges = ZERO();
  private prevGamepad: Record<number, boolean> = {};
  touch = { throttle: 0, brake: 0, steer: 0, clutch: 0, handbrake: false };
  hasTouch = false;
  private listeners: (() => void)[] = [];
  private lastUpdate = performance.now();
  private filteredThrottle = 0;
  private filteredBrake = 0;
  private filteredSteer = 0;

  constructor() {
    const kd = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      this.keys.add(k);
      this.onKey(k, e);
    };
    const ku = (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase());
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    const release = () => this.releaseControls();
    const visibility = () => {
      if (document.hidden) release();
    };
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', visibility);
    this.listeners.push(
      () => window.removeEventListener('keydown', kd),
      () => window.removeEventListener('keyup', ku),
      () => window.removeEventListener('blur', release),
      () => document.removeEventListener('visibilitychange', visibility),
    );
    this.hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  }

  private onKey(k: string, e: KeyboardEvent): void {
    const map: Record<string, keyof InputState> = {
      q: 'toggleIndicatorLeft', e: 'toggleIndicatorRight', h: 'toggleHazard', l: 'toggleHeadlights',
      b: 'toggleSeatbelt', c: 'cycleCamera', x: 'gearUp', z: 'gearDown', f: 'gearDown',
      v: 'selectDrive', r: 'selectReverse', p: 'selectPark', n: 'neutral', i: 'startEngine',
      g: 'horn', m: 'toggleMap', escape: 'pause', t: 'respawn',
    };
    if (map[k]) {
      (this.edges as any)[map[k]] = true;
      e.preventDefault();
    }
  }

  /** Consume and clear an edge-triggered action. */
  take(name: keyof InputState): boolean {
    const v = this.edges[name] as boolean;
    (this.edges as any)[name] = false;
    return v;
  }

  /** Programmatically queue an edge action (touch UI / accessibility). */
  trigger(name: keyof InputState): void {
    if (typeof this.edges[name] === 'boolean') (this.edges as any)[name] = true;
  }

  /** Release every continuous control after blur, cancel or app backgrounding. */
  releaseControls(): void {
    this.keys.clear();
    this.touch.throttle = this.touch.brake = this.touch.steer = this.touch.clutch = 0;
    this.touch.handbrake = false;
    this.filteredThrottle = this.filteredBrake = this.filteredSteer = 0;
    this.state.throttle = this.state.brake = this.state.steer = 0;
    this.state.handbrake = false;
  }

  update(): void {
    const now = performance.now();
    const dt = Math.max(1 / 240, Math.min(0.05, (now - this.lastUpdate) / 1000));
    this.lastUpdate = now;
    const s = this.state;
    const K = (c: string) => this.keys.has(c);
    // Analog from keyboard.
    let steer = 0;
    if (K('a') || K('arrowleft')) steer += 1;
    if (K('d') || K('arrowright')) steer -= 1;
    let throttle = K('w') || K('arrowup') ? 1 : 0;
    let brake = K('s') || K('arrowdown') ? 1 : 0;
    let clutch = K('shift') ? 1 : 0;
    let handbrake = K(' ');

    // Gamepad overrides when a stick/trigger is active.
    const pads = navigator.getGamepads?.() ?? [];
    for (const gp of pads) {
      if (!gp) continue;
      const lx = deadzone(gp.axes[0] ?? 0);
      const rt = gp.buttons[7]?.value ?? 0;
      const lt = gp.buttons[6]?.value ?? 0;
      if (Math.abs(lx) > 0) steer = -lx;
      if (rt > 0.02) throttle = rt;
      if (lt > 0.02) brake = lt;
      if (gp.buttons[0]?.pressed) handbrake = true;
      clutch = gp.buttons[4]?.pressed ? 1 : clutch;
      const btn = (i: number, name: keyof InputState) => {
        const p = gp.buttons[i]?.pressed ?? false;
        if (p && !this.prevGamepad[i]) (this.edges as any)[name] = true;
        this.prevGamepad[i] = p;
      };
      btn(2, 'toggleHazard');
      btn(3, 'toggleHeadlights');
      btn(5, 'gearUp');
      btn(1, 'gearDown');
      btn(9, 'pause');
      btn(8, 'cycleCamera');
      btn(12, 'toggleIndicatorLeft');
      btn(13, 'toggleIndicatorRight');
    }

    // Touch overrides.
    if (this.hasTouch && (this.touch.throttle || this.touch.brake || this.touch.steer || this.touch.clutch || this.touch.handbrake)) {
      throttle = Math.max(throttle, this.touch.throttle);
      brake = Math.max(brake, this.touch.brake);
      steer = this.touch.steer || steer;
      clutch = Math.max(clutch, this.touch.clutch);
      handbrake = handbrake || this.touch.handbrake;
    }

    const targetThrottle = clamp01(throttle);
    const targetBrake = clamp01(brake);
    const targetSteer = Math.max(-1, Math.min(1, steer));
    this.filteredThrottle = approach(this.filteredThrottle, targetThrottle, (targetThrottle > this.filteredThrottle ? 2.8 : 4.5) * dt);
    this.filteredBrake = approach(this.filteredBrake, targetBrake, (targetBrake > this.filteredBrake ? 5.5 : 7.0) * dt);
    this.filteredSteer = approach(this.filteredSteer, targetSteer, (Math.abs(targetSteer) > Math.abs(this.filteredSteer) ? 2.7 : 4.2) * dt);
    s.throttle = this.filteredThrottle;
    s.brake = this.filteredBrake;
    s.steer = this.filteredSteer;
    s.clutch = clamp01(clutch);
    s.handbrake = handbrake;
    // Copy edges into state (read by the game, then cleared with take()).
    for (const key of Object.keys(this.edges) as (keyof InputState)[]) {
      if (typeof this.edges[key] === 'boolean') (s as any)[key] = this.edges[key];
    }
  }

  clearEdges(): void {
    for (const key of Object.keys(this.edges) as (keyof InputState)[]) if (typeof this.edges[key] === 'boolean') (this.edges as any)[key] = false;
  }

  dispose(): void {
    for (const l of this.listeners) l();
  }
}

function deadzone(v: number, dz = 0.12): number {
  return Math.abs(v) < dz ? 0 : (v - Math.sign(v) * dz) / (1 - dz);
}
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const approach = (value: number, target: number, amount: number) => value < target ? Math.min(target, value + amount) : Math.max(target, value - amount);
