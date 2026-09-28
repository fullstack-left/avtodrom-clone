// Watches the player against the Uzbekistan traffic rules and emits violations
// with the official penalty points and an in-game fine. Used both for the free
// drive / taxi "fine counter" and for the city exam (fail at ≥ 20 points).

import {
  CITY_SPEED_LIMIT,
  EXAM_FAIL_POINTS,
  ViolationCode,
  VIOLATIONS,
  ViolationDef,
} from '../rules/PddKnowledge';
import { PlayerCar } from '../vehicle/PlayerCar';
import { Dir, DX, DZ, Node, Signal, TrafficRuleGraph, movementOf, opposite } from '../world/TrafficRuleGraph';
import { Navigator } from './Navigator';

export interface LoggedViolation {
  def: ViolationDef;
  t: number;
  count: number;
}

const GO = new Set<Signal>(['green', 'green_flash', 'off', 'flash']);

export class RuleMonitor {
  total = 0;
  fines = 0;
  log: LoggedViolation[] = [];
  onViolation: ((v: ViolationDef) => void) | null = null;
  active = true;
  examMode = false;
  // approach bookkeeping
  private lastNode: Node | null = null;
  private approachDir: Dir | -1 = -1;
  private enteredNode: Node | null = null;
  private enterDir: Dir | -1 = -1;
  private signalledBefore = false;
  private crossedStopLine = false;
  private stopWaited = 0;
  private lastLimit = CITY_SPEED_LIMIT;
  private speedTimer = 0;
  private cooldown = new Map<ViolationCode, number>();
  private t = 0;
  private prevOnZebraClear = true;
  currentLimit = CITY_SPEED_LIMIT;
  regime = 'equal';
  private wrongWayTimer = 0;
  private sidewalkTimer = 0;
  private oncomingTimer = 0;

  constructor(private g: TrafficRuleGraph, private car: PlayerCar, private nav: Navigator) {}

  reset(): void {
    this.total = 0;
    this.fines = 0;
    this.log = [];
    this.t = 0;
    this.lastLimit = CITY_SPEED_LIMIT;
    this.currentLimit = CITY_SPEED_LIMIT;
    this.speedTimer = this.wrongWayTimer = this.sidewalkTimer = this.oncomingTimer = 0;
    this.stopWaited = 0;
    this.lastNode = this.enteredNode = null;
    this.approachDir = this.enterDir = -1;
    this.cooldown.clear();
  }

  private emit(code: ViolationCode, mult = 1): void {
    // Three-second pre-drive grace lets the car/controls settle and prevents a
    // spawn contact or seatbelt warning from becoming an instant fine.
    if (this.t < 3) return;
    const cd = this.cooldown.get(code) ?? 0;
    if (this.t < cd) return;
    this.cooldown.set(code, this.t + (code === 'speeding' ? 4 : 2.5));
    const def = VIOLATIONS[code];
    this.total += def.points * mult;
    this.fines += def.fine * mult;
    const existing = this.log.find((l) => l.def.code === code);
    if (existing) existing.count += 1;
    else this.log.push({ def, t: this.t, count: 1 });
    this.onViolation?.(def);
  }

  get failed(): boolean {
    return this.examMode && this.total >= EXAM_FAIL_POINTS;
  }

  update(dt: number, aiCollision: boolean, pedCollision: boolean, objCollision: boolean): void {
    this.t += dt;
    if (!this.active) return;
    const p = this.car.phys;
    const x = p.x, z = p.z, yaw = p.yaw;
    const kmh = p.kmh;

    // Collisions (reported by the game loop).
    if (aiCollision) this.emit('collision_car');
    if (pedCollision) this.emit('collision_ped');
    if (objCollision) this.emit('collision_obj');

    // Seatbelt while moving.
    if (kmh > 5 && !this.car.seatbelt) this.emit('seatbelt');
    // Headlights at night / fog.
    // (night/fog flag comes from the game via setDark)
    if (this.dark && kmh > 5 && !this.car.headlights) this.emit('headlights');

    // Which road / lane are we on?
    const road = this.g.roadAt(x, z);
    // Keep the last matched segment's limit while traversing connector space.
    this.currentLimit = this.lastLimit;
    if (road) {
      // Determine travel direction vs road orientation.
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      const along = road.road.axis === 'h' ? Math.sign(fx) : Math.sign(fz);
      const dir: Dir = road.road.axis === 'h' ? (along >= 0 ? 0 : 2) : (along >= 0 ? 1 : 3);
      const edge = along >= 0 ? road.road.fwd : road.road.back;
      const oppEdge = along >= 0 ? road.road.back : road.road.fwd;
      if (edge) this.currentLimit = edge.lanes[0].speedLimit;
      else if (oppEdge) this.currentLimit = oppEdge.lanes[0].speedLimit;
      if (this.currentLimit !== this.lastLimit) {
        this.lastLimit = this.currentLimit;
        this.speedTimer = 0;
      }

      // One-way wrong direction.
      if (!edge && oppEdge && kmh > 3) {
        this.wrongWayTimer += dt;
        if (this.wrongWayTimer > 1.2) this.emit('wrong_way');
      } else this.wrongWayTimer = 0;

      // Oncoming lane on a two-way road (lat sign relative to travel dir).
      if (edge && !road.road.oneWay && kmh > 8) {
        // right side of travel is positive lat for fwd; the centre is lat 0.
        const rightSide = along >= 0 ? road.lat > 0 : road.lat < 0;
        const overCenter = Math.abs(road.lat) > 0.2 && !rightSide;
        const solid = road.road.center === 'double_solid' || road.road.center === 'solid';
        if (overCenter) {
          this.oncomingTimer += dt;
          if (solid && this.oncomingTimer > 0.55) this.emit('solid_line');
          // A brief line crossing and sustained travel in the opposing lane are
          // separate offences; do not stack both at the first sampled frame.
          if (this.oncomingTimer > 2.0) this.emit('oncoming_lane');
        } else this.oncomingTimer = 0;
      }
      // Driving on the sidewalk.
      if (Math.abs(road.lat) > road.road.halfWidth + 0.4 && Math.abs(road.lat) < road.road.halfWidth + 4 && kmh > 3) {
        this.sidewalkTimer += dt;
        if (this.sidewalkTimer > 1.0) this.emit('sidewalk');
      } else this.sidewalkTimer = 0;
    }

    // Speeding requires a sustained exceedance; segment changes and one-frame
    // integration spikes no longer create instant fines.
    const excess = kmh - this.currentLimit;
    if (excess > 5) {
      this.speedTimer += dt;
      if (excess > 20 && this.speedTimer > 0.55) this.emit('speeding_major');
      else if (this.speedTimer > 1.25) this.emit('speeding');
    } else if (excess < 3) this.speedTimer = 0;

    // Stalling (once per stall event).
    if (p.stalled) {
      this.emit('stall');
      p.stalled = false;
    }

    // Junction behaviour.
    this.updateJunction(dt, x, z, yaw, kmh);

    // Pedestrian priority at crosswalks (must not force a pedestrian to stop).
    for (const cw of this.g.crosswalks) {
      if (!cw.occupants.length) continue;
      const dcx = x - cw.cx, dcz = z - cw.cz;
      if (Math.abs(dcx) > cw.halfLen + 6 || Math.abs(dcz) > cw.halfLen + 6) continue;
      // Are we entering the zebra fast while a pedestrian is on our half?
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      const toCw = dcx * fx + dcz * fz; // >0 → zebra behind us
      const onZebra = Math.abs(cw.axis === 'x' ? dcz : dcx) < 3.5;
      const nearHalf = cw.occupants.some((o) => {
        const du = (cw.axis === 'x' ? x - cw.cx : z - cw.cz) - o.u;
        return Math.abs(du) < 4;
      });
      if (onZebra && nearHalf && kmh > 8 && toCw > -3) this.emit('pedestrian');
    }
  }

  dark = false;
  setDark(v: boolean): void {
    this.dark = v;
  }

  private updateJunction(dt: number, x: number, z: number, yaw: number, kmh: number): void {
    const inside = this.g.nodeAt(x, z, 1.5);
    const approach = this.g.nodeAt(x, z, 16);
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const dir: Dir = Math.abs(fx) > Math.abs(fz) ? (fx >= 0 ? 0 : 2) : (fz >= 0 ? 1 : 3);
    this.regime = (inside ?? approach)?.regime() ?? 'equal';

    // Track approach to record turn signal usage before the junction.
    if (approach && !inside && approach !== this.enteredNode) {
      if (approach !== this.lastNode) {
        this.lastNode = approach;
        this.approachDir = dir;
        this.signalledBefore = false;
        this.crossedStopLine = false;
      }
      // Was the correct indicator on before we entered? (needs planned turn)
      const plannedMov = this.plannedMovement(approach, dir);
      if (plannedMov === 'left' && this.car.indicator === -1) this.signalledBefore = true;
      if (plannedMov === 'right' && this.car.indicator === 1) this.signalledBefore = true;
    }

    if (inside && this.enteredNode !== inside) {
      // Preserve the map-matched approach direction while the vehicle yaws
      // into a turn; instantaneous yaw inside the box is not the entry arm.
      const enteredDir = this.lastNode === inside && this.approachDir >= 0 ? this.approachDir as Dir : dir;
      this.enteredNode = inside;
      this.enterDir = enteredDir;
      const reg = inside.regime();
      if (reg === 'light') {
        const signal = inside.light!.headSignal(enteredDir);
        if (signal === 'red' || signal === 'red_yellow') this.emit('red_light');
      } else if (reg === 'regulator') {
        const signal = inside.regulator!.signal(enteredDir, 'straight');
        if (signal === 'red') this.emit('regulator');
      }
      if ((reg === 'permanent_sign' || reg === 'temporary_sign' || reg === 'equal') && this.violatedPriority(inside, enteredDir)) {
        this.emit('yield');
      }
      if (inside.approachPriority[enteredDir] === 'stop' && reg !== 'light' && reg !== 'regulator') {
        if (this.stopWaited < 1.0) this.emit('no_stop_sign');
      }
      if (!inside.inc[enteredDir]) this.emit('no_entry');
    }

    // While at rest just before a STOP sign, count the wait.
    if (approach && !inside && approach.approachPriority[dir] === 'stop') {
      if (kmh < 1) this.stopWaited += dt;
    } else if (!inside) this.stopWaited = 0;

    // Leaving a junction: check the executed movement was legal + signalled.
    if (!inside && this.enteredNode) {
      const n = this.enteredNode;
      const outDir = dir;
      const mov = movementOf(this.enterDir as Dir, outDir);
      if (mov !== 'straight') {
        if (!this.signalledBefore) this.emit('no_signal_turn');
      }
      const allowed = n.allowed[this.enterDir as Dir];
      if (allowed && !allowed.has(mov)) this.emit('forbidden_turn');
      if (mov === 'uturn' && n.allowed[this.enterDir as Dir]?.has('uturn') === false) this.emit('forbidden_turn');
      this.enteredNode = null;
      this.enterDir = -1;
    }
  }

  private plannedMovement(n: Node, dir: Dir): 'straight' | 'left' | 'right' | 'uturn' | null {
    const cur = this.nav.currentEdge(this.car.phys.x, this.car.phys.z, this.car.phys.yaw);
    const m = this.nav.nextManoeuvre(cur, this.car.phys.x, this.car.phys.z);
    if (m && m.mov !== 'arrive') return m.mov;
    // Fall back to the indicator (free-drive intent).
    return this.car.indicator === -1 ? 'left' : this.car.indicator === 1 ? 'right' : null;
  }

  /** Did the player enter against a higher-priority approach that had a car close? */
  private violatedPriority(n: Node, dir: Dir): boolean {
    const myRank = n.approachPriority[dir];
    if (myRank === 'main') return false;
    // If we must yield / stop and cross traffic is present within the box.
    // The game feeds AI proximity via setCrossTraffic each frame.
    return this.crossTrafficClose && myRank !== null;
  }

  crossTrafficClose = false;
  setCrossTraffic(v: boolean): void {
    this.crossTrafficClose = v;
  }

  /** Toggle indicator off after finishing a turn (10 m rule, no.3). */
  passed10mSignalStillOn(distanceSinceStart: number): void {
    // handled in game loop for the exam start line
  }
}
