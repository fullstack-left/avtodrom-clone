// Player vehicle dynamics — a TypeScript port of the Avtodrom C++ presets
// (native/src/sim/vehicle_params.cpp): same masses, torque curves, gear
// ratios, final drives, tyre radii, brake torques and steering locks.
//
// Model: planar two-track-equivalent "bicycle" with load transfer, Pacejka
// lateral tyre forces with friction-circle coupling, engine + clutch (manual,
// with stalling) or torque converter + shift schedule (automatic), ABS,
// hand brake, drag and rolling resistance. Integrated at 120 Hz sub-steps.

export type Transmission = 'manual' | 'automatic';

export interface VehicleSpec {
  id: 'nexia2' | 'cobalt_at';
  mass: number;
  yawInertia: number;
  wheelbase: number;
  track: number;
  cgFront: number; // distance CG → front axle
  cgHeight: number;
  dragArea: number;
  torque: [number, number][]; // rpm → Nm (full load)
  engineInertia: number;
  idleRpm: number;
  redlineRpm: number;
  limiterRpm: number;
  clutchMaxTorque: number;
  transmission: Transmission;
  gears: number[];
  reverse: number;
  finalDrive: number;
  efficiency: number;
  upshiftLight?: number[];
  upshiftFull?: number[];
  downshiftHyst?: number;
  tireRadius: number;
  maxSteerDeg: number;
  steeringWheelLockDeg: number;
  brakeFront: number; // per wheel, Nm
  brakeRear: number;
  handbrake: number; // per rear wheel
  frontHalfLen: number; // bumper distances (collision box)
  rearHalfLen: number;
  halfWidth: number;
}

export const NEXIA2: VehicleSpec = {
  id: 'nexia2',
  mass: 1025 + 75,
  yawInertia: 1780,
  wheelbase: 2.4802,
  track: 1.4212,
  cgFront: 2.4802 / 2 - 0.27,
  cgHeight: 0.5,
  dragArea: 0.34 * 1.92,
  torque: [[0, 62], [600, 86], [1000, 97], [1500, 106], [2000, 113], [2500, 119], [3200, 123], [3800, 121], [4400, 116], [5000, 109], [5600, 101], [6200, 88], [7000, 60]],
  engineInertia: 0.13,
  idleRpm: 850,
  redlineRpm: 6000,
  limiterRpm: 6200,
  clutchMaxTorque: 190,
  transmission: 'manual',
  gears: [3.545, 2.048, 1.346, 0.971, 0.763],
  reverse: 3.333,
  finalDrive: 3.722,
  efficiency: 0.93,
  tireRadius: 0.2888,
  maxSteerDeg: 39,
  steeringWheelLockDeg: 540,
  brakeFront: 1250,
  brakeRear: 520,
  handbrake: 900,
  frontHalfLen: 2.18,
  rearHalfLen: 2.31,
  halfWidth: 0.83,
};

export const COBALT_AT: VehicleSpec = {
  id: 'cobalt_at',
  mass: 1165 + 75,
  yawInertia: 2050,
  wheelbase: 2.62,
  track: 1.52,
  cgFront: 2.62 / 2 - 0.26,
  cgHeight: 0.54,
  dragArea: 0.33 * 2.05,
  torque: [[0, 66], [600, 92], [1000, 104], [1500, 112], [2000, 118], [2500, 123], [3000, 128], [4000, 134], [4800, 131], [5400, 127], [5800, 124], [6400, 110], [7000, 80]],
  engineInertia: 0.14,
  idleRpm: 750,
  redlineRpm: 6300,
  limiterRpm: 6500,
  clutchMaxTorque: 260,
  transmission: 'automatic',
  gears: [4.584, 2.964, 1.912, 1.446, 1.0, 0.746],
  reverse: 2.943,
  finalDrive: 3.53,
  efficiency: 0.9,
  upshiftLight: [17, 30, 44, 57, 70],
  upshiftFull: [42, 72, 105, 138, 168],
  downshiftHyst: 8,
  tireRadius: 0.3165,
  maxSteerDeg: 37,
  steeringWheelLockDeg: 510,
  brakeFront: 1450,
  brakeRear: 620,
  handbrake: 1000,
  frontHalfLen: 2.22,
  rearHalfLen: 2.26,
  halfWidth: 0.86,
};

export interface Controls {
  throttle: number; // 0..1
  brake: number; // 0..1
  steer: number; // −1 (right) … +1 (left)
  clutch: number; // 0 released … 1 pressed
  handbrake: boolean;
}

const G = 9.81;
const RAD2RPM = 60 / (2 * Math.PI);

function curve(c: [number, number][], x: number): number {
  if (x <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) {
    if (x <= c[i][0]) {
      const t = (x - c[i - 1][0]) / (c[i][0] - c[i - 1][0]);
      return c[i - 1][1] + (c[i][1] - c[i - 1][1]) * t;
    }
  }
  return c[c.length - 1][1];
}

export class VehiclePhysics {
  // World pose
  x = 0;
  z = 0;
  yaw = 0;
  // Local velocities: vx forward, vy left; r yaw rate (CCW +)
  vx = 0;
  vy = 0;
  r = 0;
  ax = 0;
  ay = 0;
  steerAngle = 0; // road wheel angle (rad, + left)
  engineOmega = 0;
  running = true;
  stalled = false;
  /** Manual: −1 R, 0 N, 1..5. Automatic selector: 'P' | 'R' | 'N' | 'D'. */
  gear = 0;
  autoMode: 'P' | 'R' | 'N' | 'D' = 'P';
  autoGear = 1;
  wheelSpin = 0; // accumulated wheel rotation for rendering
  grip = 1;
  skid = 0; // 0..1 tyre scrub level (audio)
  limiter = false;
  /** Assisted clutch is the default: real gears/torque, playable keyboard launch. */
  manualAssist = true;
  /** 0 open … 1 fully engaged, exposed for HUD feedback. */
  clutchEngagement = 0;
  private shiftTimer = 0;
  private manualShiftCut = 0;

  constructor(public spec: VehicleSpec) {
    this.engineOmega = spec.idleRpm / RAD2RPM;
    if (spec.transmission === 'automatic') this.autoMode = 'P';
  }

  get speed(): number {
    return Math.hypot(this.vx, this.vy);
  }
  get kmh(): number {
    return this.speed * 3.6;
  }
  get rpm(): number {
    return this.engineOmega * RAD2RPM;
  }
  get vxWorld(): number {
    return -Math.sin(this.yaw) * this.vx - Math.cos(this.yaw) * this.vy;
  }
  get vzWorld(): number {
    return -Math.cos(this.yaw) * this.vx + Math.sin(this.yaw) * this.vy;
  }
  /** Gear label for the HUD. */
  gearLabel(): string {
    if (this.spec.transmission === 'automatic') return this.autoMode === 'D' ? `D${this.autoGear}` : this.autoMode;
    return this.gear < 0 ? 'R' : this.gear === 0 ? 'N' : String(this.gear);
  }
  isReverse(): boolean {
    return this.spec.transmission === 'automatic' ? this.autoMode === 'R' : this.gear < 0;
  }

  shiftUp(): void {
    const s = this.spec;
    if (s.transmission === 'automatic') {
      // One action means Drive; internal D1…D6 selection remains automatic.
      this.setAuto('D');
    } else if (this.gear < s.gears.length) {
      this.gear++;
      this.manualShiftCut = 0.28;
    }
  }
  shiftDown(): void {
    const s = this.spec;
    if (s.transmission === 'automatic') {
      // Down/reverse action is direct and interlocked at walking speed.
      this.setAuto('R');
    } else if (this.gear > -1) {
      this.gear--;
      this.manualShiftCut = 0.28;
    }
  }
  setAuto(m: 'P' | 'R' | 'N' | 'D'): void {
    // P/R direction changes are accepted only at walking speed.
    if ((m === 'P' || m === 'R') && Math.abs(this.vx) > 1.2) return;
    if (m === 'D' && this.vx < -1.2) return;
    this.autoMode = m;
    if (m === 'D') this.autoGear = 1;
  }
  selectDrive(): void {
    if (this.spec.transmission === 'automatic') this.setAuto('D');
    else if (this.gear <= 0) {
      this.gear = 1;
      this.manualShiftCut = 0.2;
    }
  }
  selectReverse(): void {
    if (this.spec.transmission === 'automatic') this.setAuto('R');
    else if (Math.abs(this.vx) < 1.2) {
      this.gear = -1;
      this.manualShiftCut = 0.25;
    }
  }
  selectPark(): void {
    if (this.spec.transmission === 'automatic') this.setAuto('P');
    else this.gear = 0;
  }
  neutral(): void {
    if (this.spec.transmission === 'automatic') this.setAuto('N');
    else {
      this.gear = 0;
      this.clutchEngagement = 0;
    }
  }
  start(): void {
    if (!this.running) {
      this.running = true;
      this.stalled = false;
      this.engineOmega = this.spec.idleRpm / RAD2RPM;
      if (this.manualAssist) this.clutchEngagement = 0;
    }
  }

  /** Ready-to-drive spawn used by free, mission and exam modes. */
  prepareForDriving(): void {
    this.running = true;
    this.stalled = false;
    this.engineOmega = this.spec.idleRpm / RAD2RPM;
    if (this.spec.transmission === 'automatic') {
      this.autoMode = 'D';
      this.autoGear = 1;
    } else {
      this.gear = this.manualAssist ? 1 : 0;
      this.clutchEngagement = 0;
      this.manualShiftCut = 0;
    }
  }

  private ratio(): number {
    const s = this.spec;
    if (s.transmission === 'automatic') {
      if (this.autoMode === 'D') return s.gears[this.autoGear - 1] * s.finalDrive;
      if (this.autoMode === 'R') return -s.reverse * s.finalDrive;
      return 0;
    }
    if (this.gear === 0) return 0;
    if (this.gear < 0) return -s.reverse * s.finalDrive;
    return s.gears[this.gear - 1] * s.finalDrive;
  }

  private autoShift(throttle: number, dt: number): void {
    const s = this.spec;
    if (this.autoMode !== 'D' || !s.upshiftLight || !s.upshiftFull) return;
    this.shiftTimer -= dt;
    if (this.shiftTimer > 0) return;
    const kmh = this.vx * 3.6;
    const g = this.autoGear;
    const t = Math.min(1, Math.max(0, (throttle - 0.2) / 0.7));
    if (g < s.gears.length) {
      const up = s.upshiftLight[g - 1] + (s.upshiftFull[g - 1] - s.upshiftLight[g - 1]) * t;
      if (kmh > up) {
        this.autoGear++;
        this.shiftTimer = 0.45;
        return;
      }
    }
    if (g > 1) {
      const upPrev = s.upshiftLight[g - 2] + (s.upshiftFull[g - 2] - s.upshiftLight[g - 2]) * t;
      if (kmh < upPrev - (s.downshiftHyst ?? 8)) {
        this.autoGear--;
        this.shiftTimer = 0.45;
      }
    }
  }

  step(dtFrame: number, c: Controls): void {
    const sub = Math.max(1, Math.ceil(dtFrame * 120));
    const dt = dtFrame / sub;
    for (let k = 0; k < sub; k++) this.substep(dt, c);
  }

  private substep(dt: number, c: Controls): void {
    const s = this.spec;
    const m = s.mass;
    const L = s.wheelbase;
    const a = s.cgFront;
    const b = L - a;
    const R = s.tireRadius;
    const mu = 1.0 * this.grip;

    // Speed-sensitive steering. Full parking lock remains available below
    // walking speed, while a digital key cannot request 28–35° at urban speed.
    const vAbs = Math.abs(this.vx);
    const steeringScale = 0.14 + 0.86 / (1 + Math.pow(vAbs / 7.0, 1.75));
    const target = c.steer * (s.maxSteerDeg * Math.PI / 180) * steeringScale;
    const speedBlend = smoothstep(2, 20, vAbs);
    const rate = 2.0 + (0.62 - 2.0) * speedBlend;
    const returnBoost = Math.abs(c.steer) < 0.05 ? 1.45 : 1;
    const maxRate = rate * returnBoost * dt;
    this.steerAngle += Math.max(-maxRate, Math.min(maxRate, target - this.steerAngle));
    const delta = this.steerAngle;

    // Normal loads with longitudinal transfer.
    const Fz = m * G;
    let Fzf = (Fz * b) / L - (m * this.ax * s.cgHeight) / L;
    let Fzr = (Fz * a) / L + (m * this.ax * s.cgHeight) / L;
    Fzf = Math.max(Fzf, 0.15 * Fz);
    Fzr = Math.max(Fzr, 0.15 * Fz);

    // ── Powertrain ─────────────────────────────────────────────────────
    if (s.transmission === 'automatic') this.autoShift(c.throttle, dt);
    const ratio = this.ratio();
    const wheelOmega = this.vx / R;
    const inOmega = wheelOmega * ratio; // engine-side speed of the gearbox input
    let driveTorqueWheel = 0;
    const throttle = this.running ? c.throttle : 0;
    const rpm = this.rpm;
    this.limiter = rpm > s.limiterRpm;
    const effThrottle = this.limiter ? 0 : throttle;
    const full = curve(s.torque, rpm);
    const drag = 12 + rpm * 0.004; // pumping/friction (engine braking)
    let Te = this.running ? effThrottle * full - (1 - effThrottle) * drag * 0.6 : 0;
    // idle governor
    if (this.running && rpm < s.idleRpm + 50) Te += Math.min(45, (s.idleRpm + 50 - rpm) * 0.2);
    if (!this.running) Te = -drag * 2;

    if (s.transmission === 'manual') {
      this.manualShiftCut = Math.max(0, this.manualShiftCut - dt);
      let engage: number;
      if (this.manualAssist) {
        // Automatic clutch assistance retains the real clutch torque limit and
        // gear ratios, but ramps through the bite point for binary keyboards.
        const speedPart = smoothstep(0.25, 4.8, vAbs);
        const rpmProtection = Math.max(0.12, Math.min(1, (rpm - 430) / Math.max(450, s.idleRpm + 350 - 430)));
        let targetEngagement = (0.25 + throttle * 0.5 + speedPart * 0.65) * rpmProtection;
        if (c.brake > 0.2 && vAbs < 0.8) targetEngagement = 0;
        if (this.manualShiftCut > 0 || ratio === 0) targetEngagement = 0;
        if (ratio * this.vx < -0.35) targetEngagement = 0;
        targetEngagement = Math.max(0, Math.min(1, targetEngagement));
        const clutchRate = targetEngagement > this.clutchEngagement ? 1.4 : 3.4;
        this.clutchEngagement += Math.max(-clutchRate * dt, Math.min(clutchRate * dt, targetEngagement - this.clutchEngagement));
        engage = Math.min(this.clutchEngagement, 1 - Math.min(1, Math.max(0, c.clutch)));
      } else {
        engage = ratio === 0 ? 0 : 1 - Math.min(1, Math.max(0, c.clutch));
        this.clutchEngagement = engage;
      }
      if (ratio === 0) engage = 0;
      const Tmax = s.clutchMaxTorque * engage * engage;
      const slip = this.engineOmega - inOmega;
      // To drive slip to zero: Tc = Te + I*slip/dt (the previous minus sign
      // snapped RPM in the wrong direction and caused false stalls).
      const lockTorque = Te + (s.engineInertia * slip) / dt;
      let Tc: number;
      const lockThreshold = this.manualAssist ? 0.82 : 0.985;
      if (engage > lockThreshold && Math.abs(lockTorque) <= Tmax) {
        Tc = lockTorque;
        this.engineOmega = inOmega;
      } else {
        Tc = Math.sign(slip) * Math.min(Tmax, Math.abs(slip) * 60 * engage);
        this.engineOmega += ((Te - Tc) / s.engineInertia) * dt;
      }
      driveTorqueWheel = Tc * ratio * s.efficiency;
      if (this.manualAssist && this.rpm < s.idleRpm * 0.62) {
        // Stall protection opens the clutch and lets the idle governor recover.
        this.clutchEngagement = Math.min(this.clutchEngagement, 0.08);
        this.engineOmega += ((s.idleRpm / RAD2RPM) - this.engineOmega) * Math.min(1, dt * 7);
      } else if (!this.manualAssist && this.running && this.rpm < 300 && engage > 0.5) {
        this.running = false;
        this.stalled = true;
      }
    } else {
      // Torque converter: engine speed rises to the stall speed, torque
      // multiplication fades out towards the coupling point.
      if (ratio === 0) {
        this.engineOmega += ((Te - 0.02 * this.engineOmega) / s.engineInertia) * dt;
        driveTorqueWheel = 0;
      } else {
        const stallOmega = (2300 * Math.min(1, 0.25 + effThrottle)) / RAD2RPM;
        const inAbs = Math.abs(inOmega);
        const eng = Math.max(inAbs, Math.min(stallOmega, this.engineOmega));
        const sr = Math.min(1, inAbs / Math.max(eng, 1));
        const tr = sr < 0.86 ? 2.0 - (1.0 * sr) / 0.86 : 1.0;
        // Converter absorbs torque ∝ ω² (K-factor); simplified pull toward target.
        const targetOmega = Math.max(inAbs, (s.idleRpm / RAD2RPM) * (1 + effThrottle * 2.2 * (1 - sr)));
        this.engineOmega += (targetOmega - this.engineOmega) * Math.min(1, dt * 8);
        const Tt = Math.max(0, Te) * tr + (effThrottle < 0.05 ? (sr < 0.95 ? 18 * (1 - sr) : -8) : 0); // creep / engine brake
        driveTorqueWheel = Tt * Math.sign(ratio) * Math.abs(ratio) * s.efficiency;
        if (this.autoMode === 'D' && this.vx < -0.5) driveTorqueWheel = Math.abs(driveTorqueWheel);
      }
      if (this.autoMode === 'P' && Math.abs(this.vx) < 2) {
        // Parking pawl
        this.vx *= 0.8;
      }
    }
    if (this.engineOmega < 0) this.engineOmega = 0;
    if (this.running && this.engineOmega * RAD2RPM > s.limiterRpm + 200) this.engineOmega = (s.limiterRpm + 200) / RAD2RPM;

    // ── Longitudinal tyre forces (front-wheel drive) ─────────────────────
    let FxF = driveTorqueWheel / R;
    const brakeT = c.brake * 2 * (s.brakeFront + s.brakeRear);
    const hbT = c.handbrake ? 2 * s.handbrake : 0;
    const dir = Math.sign(this.vx);
    let brakeF = (c.brake * 2 * s.brakeFront) / R;
    let brakeR = (c.brake * 2 * s.brakeRear + hbT) / R;
    // ABS: limit to the available grip on each axle.
    brakeF = Math.min(brakeF, mu * Fzf * 0.95);
    const rearLocked = c.handbrake && brakeR > mu * Fzr;
    brakeR = Math.min(brakeR, mu * Fzr * (c.handbrake ? 1 : 0.95));
    const tractiveLimit = Math.min(mu * Fzf, m * (s.transmission === 'automatic' ? 3.05 : 3.2));
    FxF = Math.max(-tractiveLimit, Math.min(tractiveLimit, FxF));
    const stopHold = Math.abs(this.vx) < 0.25 && (brakeT + hbT > 50);
    let FxBrakeF = 0, FxBrakeR = 0;
    if (!stopHold) {
      FxBrakeF = -dir * brakeF;
      FxBrakeR = -dir * brakeR;
    }

    // ── Lateral tyre forces ─────────────────────────────────────────────
    const vyF = this.vy + a * this.r;
    const vyR = this.vy - b * this.r;
    const cd = Math.cos(delta), sd = Math.sin(delta);
    const vLongF = cd * this.vx + sd * vyF;
    const vLatF = -sd * this.vx + cd * vyF;
    const alphaF = Math.atan2(vLatF, Math.max(Math.abs(vLongF), 1.2));
    const alphaR = Math.atan2(vyR, Math.max(Math.abs(this.vx), 1.2));
    const pac = (al: number) => Math.sin(1.35 * Math.atan(10 * al));
    const fxFTotal = FxF + FxBrakeF;
    const circF = Math.sqrt(Math.max(0.05, 1 - (fxFTotal / (mu * Fzf)) ** 2));
    const circR = rearLocked ? 0.25 : Math.sqrt(Math.max(0.05, 1 - (FxBrakeR / (mu * Fzr)) ** 2));
    const FyF = -mu * Fzf * pac(alphaF) * circF;
    const FyR = -mu * Fzr * pac(alphaR) * circR;
    this.skid = Math.min(1, Math.max(Math.abs(alphaF), Math.abs(alphaR)) * 5 * Math.min(1, vAbs / 5) + (rearLocked && vAbs > 2 ? 0.8 : 0));

    // ── Resistances ────────────────────────────────────────────────────
    const aero = 0.5 * 1.2 * s.dragArea * this.vx * Math.abs(this.vx);
    const roll = 0.013 * m * G * Math.tanh(this.vx * 2);

    // ── Equations of motion (body frame) ───────────────────────────────
    const Fx = fxFTotal * cd - FyF * sd + FxBrakeR - aero - roll;
    const Fy = fxFTotal * sd + FyF * cd + FyR;
    const Mz = a * (fxFTotal * sd + FyF * cd) - b * FyR;
    this.ax = Fx / m;
    this.ay = Fy / m;
    this.vx += (this.ax + this.vy * this.r) * dt;
    this.vy += (this.ay - this.vx * this.r) * dt;
    this.r += (Mz / s.yawInertia) * dt;

    if (stopHold) {
      this.vx *= 0.5;
      if (Math.abs(this.vx) < 0.02) this.vx = 0;
    }
    // Smooth low-speed kinematic/dynamic blend; no sharp character change at
    // 2.5 m/s. Mild stability control damps excessive yaw when not commanded.
    const blend = 1 - smoothstep(0.7, 4.2, Math.abs(this.vx));
    if (blend > 0) {
      const rKin = (this.vx * Math.tan(delta)) / L;
      this.r += (rKin - this.r) * blend * Math.min(1, dt * 13);
      this.vy *= 1 - blend * Math.min(1, dt * 12);
    }
    if (vAbs > 7 && Math.abs(c.steer) < 0.18 && this.skid > 0.2) {
      this.r *= Math.max(0, 1 - dt * (0.7 + this.skid * 1.4));
      this.vy *= Math.max(0, 1 - dt * this.skid * 0.8);
    }

    // Integrate pose.
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const lx = -Math.cos(this.yaw), lz = Math.sin(this.yaw);
    this.x += (fx * this.vx + lx * this.vy) * dt;
    this.z += (fz * this.vx + lz * this.vy) * dt;
    this.yaw += this.r * dt;
    this.wheelSpin += (this.vx / R) * dt;
  }

  /** Apply an impulse response using relative obstacle velocity and mass. */
  collide(nx: number, nz: number, depth: number, restitution = 0.25, otherVx = 0, otherVz = 0, otherMass = Infinity): number {
    this.x += nx * depth;
    this.z += nz * depth;
    const vxw = this.vxWorld, vzw = this.vzWorld;
    const relativeN = (vxw - otherVx) * nx + (vzw - otherVz) * nz;
    if (relativeN >= 0) return 0;
    const share = Number.isFinite(otherMass) ? otherMass / (this.spec.mass + otherMass) : 1;
    const impulse = (1 + restitution) * relativeN * share;
    const nvx = vxw - impulse * nx;
    const nvz = vzw - impulse * nz;
    // back to body frame
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const lx = -Math.cos(this.yaw), lz = Math.sin(this.yaw);
    this.vx = nvx * fx + nvz * fz;
    this.vy = nvx * lx + nvz * lz;
    this.r *= 0.62;
    return -relativeN;
  }

  reset(x: number, z: number, yaw: number): void {
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.vx = this.vy = this.r = this.ax = this.ay = 0;
    this.steerAngle = 0;
    this.running = true;
    this.stalled = false;
    this.engineOmega = this.spec.idleRpm / RAD2RPM;
    this.gear = this.spec.transmission === 'manual' && this.manualAssist ? 1 : 0;
    this.autoMode = this.spec.transmission === 'automatic' ? 'D' : 'N';
    this.autoGear = 1;
    this.clutchEngagement = 0;
    this.manualShiftCut = 0;
    this.shiftTimer = 0;
  }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a || 1)));
  return t * t * (3 - 2 * t);
}
