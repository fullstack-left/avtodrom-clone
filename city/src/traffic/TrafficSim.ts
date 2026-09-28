// Microscopic traffic simulation on the TrafficRuleGraph.
//
//   Longitudinal: Intelligent Driver Model (Treiber, Hennecke, Helbing 2000)
//     v̇ = a [1 − (v/v0)^δ − (s*(v,Δv)/s)²],  s* = s0 + vT + vΔv / (2√(ab))
//   Lateral: MOBIL (Kesting, Treiber, Helbing 2007)
//     ã_c − a_c + p (ã_n − a_n + ã_o − a_o) > Δa_th,  ã_n ≥ −b_safe
//   Junctions: regulation hierarchy regulator → light → temporary sign →
//     permanent sign → markings → equal (right-hand rule), with conflict
//     points between turn paths, pedestrian yielding and gridlock prevention.
//
// Structure-of-arrays storage keeps thousands of agents cache friendly; the
// renderer reads x/z/yaw straight from the typed arrays (no per-car objects).

import { IDM_DEFAULTS, WEATHER_MODS } from '../rules/PddKnowledge';
import { Connector, Crosswalk, Dir, Lane, Node, Path, Signal, TrafficRuleGraph, pathHeading, pathPoint } from '../world/TrafficRuleGraph';

export interface ExternalObstacle {
  x: number;
  z: number;
  vx: number;
  vz: number;
  yaw: number;
  halfLen: number;
  halfWid: number;
  active: boolean;
  /** Junction the obstacle is inside or approaching (for yielding). */
  node: Node | null;
  dIn: Dir | -1;
  timeToNode: number;
}

export interface TrafficMetrics {
  targetVehicles: number;
  activeVehicles: number;
  laneKilometres: number;
  stoppedFraction: number;
  activeReservations: number;
  deniedSpawns: number;
  recoveries: number;
  failedRecoveries: number;
  longitudinalCorrections: number;
}

interface ExclusionZone {
  x: number;
  z: number;
  radius: number;
}

const GO_SIGNALS = new Set<Signal>(['green', 'green_flash']);
const HARD_GAP = 1.0;
const SPAWN_MIN_GAP = 16;
const SPAWN_START = 12;
const SPAWN_END = 8;
const RESERVATION_HORIZON = 60;
const LANE_CHANGE_RATE = 1.4;
const LANE_CHANGE_MIN_TIME = 2.7;

export class TrafficSim {
  cap: number;
  count = 0;
  // State
  path: Int32Array;
  prev: Int32Array;
  next: Int32Array; // planned connector pid while on a lane
  goal: Int32Array; // strategic goal connector pid for this edge
  s: Float32Array;
  v: Float32Array;
  acc: Float32Array;
  lat: Float32Array; // visual lateral offset (lane change animation)
  len: Float32Array;
  v0f: Float32Array;
  Tf: Float32Array;
  pol: Float32Array;
  wait: Float32Array;
  stuck: Float32Array;
  stopped: Uint8Array;
  lcTimer: Float32Array;
  lcPending: Int8Array; // −1 left, +1 right (indicator phase)
  lcPendingT: Float32Array;
  /** Source lane remains occupied until the lateral transition finishes. */
  private lcSource: Int32Array;
  /** Sticky connector grant, retained until the rear clears its exit lane. */
  private grant: Int32Array;
  private grantEntered: Uint8Array;
  private grantLastS: Float32Array;
  private grantExpires: Float32Array;
  private grantCooldown: Float32Array;
  indicator: Int8Array;
  brake: Uint8Array;
  model: Uint8Array;
  color: Uint32Array;
  // Pose for rendering
  x: Float32Array;
  z: Float32Array;
  yaw: Float32Array;
  // Buckets
  private pathStart: Int32Array;
  private pathCount: Int32Array;
  private pathFill: Int32Array;
  private sorted: Int32Array;
  private rank: Int32Array; // index of car within its primary path bucket
  private projectedS: Float32Array;
  private projectedV: Float32Array;
  /** Leader snapshot used by the cross-path hard safety projection. */
  private leaderGap: Float32Array;
  private leaderSpeed: Float32Array;
  private reservationDebt: Int16Array;
  private reservationCandidates: number[] = [];
  private nodeReservations: number[][];
  private downstreamReserved: Float32Array;
  // Environment
  weather: 'clear' | 'rain' | 'fog' = 'clear';
  player: ExternalObstacle = { x: 1e9, z: 1e9, vx: 0, vz: 0, yaw: 0, halfLen: 2.2, halfWid: 0.85, active: false, node: null, dIn: -1, timeToNode: 99 };
  pedestrianQuery: ((x: number, z: number, r: number) => boolean) | null = null;
  // Stats / demand
  laneChanges = 0;
  junctionPasses = 0;
  simTime = 0;
  deniedSpawns = 0;
  forcedRecoveries = 0;
  failedRecoveries = 0;
  longitudinalCorrections = 0;
  targetCount = 0;
  readonly laneKilometres: number;
  private demandClock = 0;
  private rng = mulberry32(12345);
  private mobilClock = 0;

  constructor(public g: TrafficRuleGraph, cap = 4096) {
    this.cap = cap;
    const F = () => new Float32Array(cap);
    const I = () => new Int32Array(cap);
    this.path = I(); this.prev = I(); this.next = I(); this.goal = I();
    this.s = F(); this.v = F(); this.acc = F(); this.lat = F(); this.len = F(); this.v0f = F(); this.Tf = F(); this.pol = F();
    this.wait = F(); this.stuck = F(); this.lcTimer = F(); this.lcPendingT = F();
    this.stopped = new Uint8Array(cap); this.lcPending = new Int8Array(cap); this.indicator = new Int8Array(cap);
    this.brake = new Uint8Array(cap); this.model = new Uint8Array(cap); this.color = new Uint32Array(cap);
    this.lcSource = I(); this.lcSource.fill(-1);
    this.grant = I(); this.grant.fill(-1);
    this.grantEntered = new Uint8Array(cap);
    this.grantLastS = F(); this.grantExpires = F(); this.grantCooldown = F();
    this.projectedS = F(); this.projectedV = F();
    this.leaderGap = F(); this.leaderGap.fill(1e9);
    this.leaderSpeed = F();
    this.reservationDebt = new Int16Array(cap);
    this.x = F(); this.z = F(); this.yaw = F();
    const np = g.paths.length;
    this.pathStart = new Int32Array(np + 1);
    this.pathCount = new Int32Array(np);
    this.pathFill = new Int32Array(np);
    this.sorted = new Int32Array(cap * 2);
    this.rank = I();
    this.nodeReservations = g.nodes.map(() => []);
    this.downstreamReserved = new Float32Array(np);
    this.laneKilometres = g.lanes.reduce((sum, lane) => sum + lane.length, 0) / 1000;
  }

  // ─── Population ──────────────────────────────────────────────────────────

  /**
   * Converts the density control to a road-network occupancy target. About
   * 30 m of lane per vehicle leaves room for IDM headways and junction queues.
   * Graphics quality deliberately does not participate in this calculation.
   */
  calibratedCount(density: number, spectator = false): number {
    const physical = Math.max(1, Math.min(this.cap, Math.floor((this.laneKilometres * 1000) / 30)));
    const playableMax = Math.min(650, physical);
    if (spectator) return Math.min(700, physical);
    const playableMin = Math.min(220, playableMax);
    const d = Math.max(0, Math.min(1, density));
    return Math.round(playableMin + d * (playableMax - playableMin));
  }

  setCount(n: number): void {
    n = Math.max(0, Math.min(Math.round(n), this.cap));
    this.targetCount = n;
    while (this.count < n) if (!this.spawn()) break;
    if (this.count > n) this.count = n;
    this.bucket();
    this.updatePoses();
  }

  /** Retry saturated demand slowly instead of abandoning the configured load. */
  private serviceDemand(dt: number): void {
    if (this.count >= this.targetCount) {
      this.demandClock = 0;
      return;
    }
    this.demandClock += dt;
    if (this.demandClock < 0.5) return;
    this.demandClock = 0;
    let changed = false;
    for (let k = 0; k < 2 && this.count < this.targetCount; k++) {
      if (!this.spawn()) break;
      changed = true;
    }
    if (changed) this.updatePoses();
  }

  private spawn(): boolean {
    if (this.count >= this.cap) return false;
    const i = this.count;
    this.initIdentity(i);
    const place = this.findPlacement(i, null);
    if (!place) {
      this.deniedSpawns++;
      return false;
    }
    this.placeCar(i, place.lane, place.s, place.speed);
    this.count++;
    return true;
  }

  private initIdentity(i: number): void {
    const r = this.rng;
    this.model[i] = r() < 0.5 ? 0 : 1;
    this.len[i] = this.model[i] === 0 ? 4.49 : 4.48;
    this.v0f[i] = 0.86 + r() * 0.2; // 86 %…106 % of the limit
    this.Tf[i] = 0.8 + r() * 0.5;
    this.pol[i] = IDM_DEFAULTS.politeness * (0.5 + r());
    this.color[i] = CAR_COLORS[Math.floor(r() * CAR_COLORS.length)];
  }

  /** Front-bumper coordinate of car i in lane coordinates, including straddlers. */
  private frontOnLane(i: number, lane: Lane): number | null {
    if (this.path[i] === lane.pid || this.lcSource[i] === lane.pid) return this.s[i];
    const p = this.g.paths[this.path[i]];
    if (p.kind !== 'conn') return null;
    const c = p as Connector;
    if (c.from === lane && this.prev[i] === lane.pid && this.s[i] < this.len[i] + SPAWN_MIN_GAP) return lane.length + this.s[i];
    if (c.to === lane && this.s[i] > c.length - this.len[i] - SPAWN_MIN_GAP) return this.s[i] - c.length;
    return null;
  }

  private placementAt(i: number, lane: Lane, s: number, exclusion: ExclusionZone | null): number | null {
    const minS = Math.max(SPAWN_START, this.len[i] + 7);
    if (s < minS || s > lane.length - SPAWN_END) return null;
    pathPoint(lane, Math.max(0, s - this.len[i] * 0.5), tmpP);
    if (exclusion && Math.hypot(tmpP.x - exclusion.x, tmpP.z - exclusion.z) < exclusion.radius) return null;
    if (this.player.active && Math.hypot(tmpP.x - this.player.x, tmpP.z - this.player.z) < 70) return null;

    let lead = -1, follower = -1;
    let leadS = 1e9, followerS = -1e9;
    for (let j = 0; j < this.count; j++) {
      if (j === i) continue;
      const sj = this.frontOnLane(j, lane);
      if (sj === null) continue;
      if (sj > s && sj < leadS) (lead = j), (leadS = sj);
      else if (sj <= s && sj > followerS) (follower = j), (followerS = sj);
    }

    const desired = (lane.speedLimit / 3.6) * this.v0f[i] * 0.82;
    const weather = WEATHER_MODS[this.weather];
    const braking = IDM_DEFAULTS.b * weather.b;
    let speed = desired;
    if (lead >= 0) {
      const gap = leadS - this.len[lead] - s;
      speed = Math.min(speed, this.v[lead] + Math.max(0, (gap - SPAWN_MIN_GAP) / 1.5));
      const need = SPAWN_MIN_GAP + Math.min(8, speed * 0.45);
      const accel = this.idm(speed, (lane.speedLimit / 3.6) * this.v0f[i], gap, speed - this.v[lead], IDM_DEFAULTS.T * this.Tf[i] * weather.T, IDM_DEFAULTS.a, braking);
      if (gap < need || accel < -IDM_DEFAULTS.bSafe || (this.v[lead] < 0.5 && gap < SPAWN_MIN_GAP + 8)) return null;
    }
    if (follower >= 0) {
      const gap = s - this.len[i] - followerS;
      const followerSpeed = this.v[follower];
      const need = SPAWN_MIN_GAP + Math.min(8, followerSpeed * 0.45);
      const accel = this.idm(followerSpeed, (lane.speedLimit / 3.6) * this.v0f[follower], gap, followerSpeed - speed, IDM_DEFAULTS.T * this.Tf[follower] * weather.T, IDM_DEFAULTS.a, braking);
      if (gap < need || accel < -IDM_DEFAULTS.bSafe) return null;
    }

    // Do not inject a fast car into the stopping distance of a closed signal.
    const dist = lane.length - s;
    if (dist < (speed * speed) / 7 + 5 && lane.out.length && !lane.out.some((c) => GO_SIGNALS.has(c.node.signal(c.dIn, c.movement)))) return null;
    return Math.max(0, speed);
  }

  private findPlacement(i: number, exclusion: ExclusionZone | null): { lane: Lane; s: number; speed: number } | null {
    const lanes = this.g.lanes;
    if (!lanes.length) return null;
    // Random probes preserve variety; the deterministic scan guarantees that a
    // usable gap is found even when random parking has fragmented free space.
    for (let attempt = 0; attempt < 160; attempt++) {
      const lane = lanes[Math.floor(this.rng() * lanes.length)];
      const lo = Math.max(SPAWN_START, this.len[i] + 7), hi = lane.length - SPAWN_END;
      if (hi <= lo) continue;
      const s = lo + this.rng() * (hi - lo);
      const speed = this.placementAt(i, lane, s, exclusion);
      if (speed !== null) return { lane, s, speed };
    }
    const first = Math.floor(this.rng() * lanes.length);
    for (let q = 0; q < lanes.length; q++) {
      const lane = lanes[(first + q) % lanes.length];
      const lo = Math.max(SPAWN_START, this.len[i] + 7), hi = lane.length - SPAWN_END;
      for (let s = lo; s <= hi; s += 2.5) {
        const speed = this.placementAt(i, lane, s, exclusion);
        if (speed !== null) return { lane, s, speed };
      }
    }
    return null;
  }

  private placeCar(i: number, lane: Lane, s: number, speed: number): void {
    this.path[i] = lane.pid;
    this.prev[i] = -1;
    this.s[i] = s;
    this.v[i] = speed;
    this.acc[i] = 0;
    this.lat[i] = 0;
    this.wait[i] = 0;
    this.stuck[i] = 0;
    this.stopped[i] = 0;
    this.lcTimer[i] = this.rng() * 3;
    this.lcPending[i] = 0;
    this.lcPendingT[i] = 0;
    this.lcSource[i] = -1;
    this.grant[i] = -1;
    this.grantEntered[i] = 0;
    this.grantLastS[i] = 0;
    this.grantExpires[i] = 0;
    this.grantCooldown[i] = 0;
    this.indicator[i] = 0;
    this.brake[i] = 0;
    this.plan(i, lane);
  }

  /** Choose one legal connector from the current lane, favouring through flow. */
  private plan(i: number, lane: Lane): void {
    if (!lane.out.length) {
      this.goal[i] = -1;
      this.next[i] = -1;
      return;
    }
    let total = 0;
    for (const c of lane.out) total += c.movement === 'straight' ? 2 : c.movement === 'right' ? 0.8 : c.movement === 'left' ? 0.7 : 0.2;
    let r = this.rng() * total;
    let pick = lane.out[0];
    for (const c of lane.out) {
      r -= c.movement === 'straight' ? 2 : c.movement === 'right' ? 0.8 : c.movement === 'left' ? 0.7 : 0.2;
      if (r <= 0) {
        pick = c;
        break;
      }
    }
    this.goal[i] = pick.pid;
    this.next[i] = pick.pid;
  }

  private refreshNext(i: number, lane: Lane): void {
    const goal = this.goal[i] >= 0 ? (this.g.paths[this.goal[i]] as Connector) : null;
    if (goal?.from === lane) this.next[i] = goal.pid;
    else this.plan(i, lane); // discretionary lane changes legally reroute here
  }

  // ─── Buckets ─────────────────────────────────────────────────────────────

  private bucket(): void {
    const np = this.g.paths.length;
    const cnt = this.pathCount;
    cnt.fill(0);
    for (let i = 0; i < this.count; i++) {
      cnt[this.path[i]]++;
      if (this.lcSource[i] >= 0 && this.lcSource[i] !== this.path[i]) cnt[this.lcSource[i]]++;
    }
    let acc = 0;
    for (let p = 0; p < np; p++) {
      this.pathStart[p] = acc;
      acc += cnt[p];
    }
    this.pathStart[np] = acc;
    const fill = this.pathFill;
    fill.fill(0);
    for (let i = 0; i < this.count; i++) {
      const p = this.path[i];
      this.sorted[this.pathStart[p] + fill[p]++] = i;
      const source = this.lcSource[i];
      if (source >= 0 && source !== p) this.sorted[this.pathStart[source] + fill[source]++] = i;
    }
    // insertion sort by s within each bucket (small buckets)
    const S = this.s;
    for (let p = 0; p < np; p++) {
      const a = this.pathStart[p], b = this.pathStart[p + 1];
      for (let k = a + 1; k < b; k++) {
        const id = this.sorted[k];
        const sv = S[id];
        let m = k - 1;
        while (m >= a && S[this.sorted[m]] > sv) {
          this.sorted[m + 1] = this.sorted[m];
          m--;
        }
        this.sorted[m + 1] = id;
      }
      for (let k = a; k < b; k++) {
        const id = this.sorted[k];
        if (this.path[id] === p) this.rank[id] = k;
      }
    }
  }

  /** Cars on a path sorted by s (ascending). */
  carsOn(pid: number): Int32Array {
    return this.sorted.subarray(this.pathStart[pid], this.pathStart[pid + 1]);
  }

  // ─── IDM ─────────────────────────────────────────────────────────────────

  private idm(v: number, v0: number, gap: number, dv: number, T: number, a: number, b: number): number {
    const free = 1 - Math.pow(v / Math.max(v0, 0.1), IDM_DEFAULTS.delta);
    if (gap > 1e5) return a * free;
    const sStar = IDM_DEFAULTS.s0 + Math.max(0, v * T + (v * dv) / (2 * Math.sqrt(a * b)));
    const g = Math.max(gap, 0.1);
    return a * (free - (sStar / g) * (sStar / g));
  }

  /** Nearest leader ahead along the planned chain: gap (m) and its speed. */
  private leader(i: number, pid: number, s: number, laneOverride = -1): { gap: number; v: number } {
    const P = this.g.paths;
    let path = P[pid];
    let off = -s; // distance from our front to start of 'path'
    let skipUntilS = s;
    let chainNext = laneOverride >= 0 ? -1 : this.next[i];
    for (let depth = 0; depth < 4; depth++) {
      const list = this.carsOn(path.pid);
      // first car with s > skipUntilS
      let best = -1;
      for (let k = 0; k < list.length; k++) {
        const j = list[k];
        if (j === i) continue;
        if (this.s[j] > skipUntilS + 1e-3) {
          best = j;
          break;
        }
      }
      let gapBest = 1e9, vBest = 0;
      if (best >= 0) {
        gapBest = off + this.s[best] - this.len[best];
        vBest = this.v[best];
      }
      // Cars that just entered sibling connectors overlap physically.
      if (path.kind === 'conn') {
        for (const sib of (path as Connector).siblings) {
          const l2 = this.carsOn(sib.pid);
          for (let k = 0; k < l2.length; k++) {
            const j = l2[k];
            const sj = this.s[j];
            if (sj > 9) break;
            const gp = off + sj - this.len[j];
            if (gp < gapBest && gp > -this.len[j]) (gapBest = gp), (vBest = this.v[j]);
          }
        }
      }
      if (gapBest < 1e8) return { gap: gapBest, v: vBest };
      off += path.length;
      if (off > 140) break;
      skipUntilS = -1e9;
      // Only follow the route we have actually planned: current lane →
      // connector → exit lane. Inventing a later lane.out[0] route causes
      // braking for traffic the vehicle will never meet.
      if (path.kind === 'lane') {
        if (depth !== 0 || laneOverride >= 0) break;
        const nx = chainNext;
        if (nx < 0) break;
        path = P[nx];
      } else {
        path = (path as Connector).to;
      }
    }
    return { gap: 1e9, v: 0 };
  }

  // ─── Junction logic ──────────────────────────────────────────────────────

  private rankOf(n: Node, d: Dir): number {
    const p = n.approachPriority[d];
    return p === 'main' ? 2 : p ? 1 : 1;
  }

  /** +1: a has priority over b, −1: b over a, 0: equal (tie-break). */
  private priority(a: Connector, aInside: boolean, b: Connector, bInside: boolean): number {
    const n = a.node;
    const reg = n.regime();
    if (reg === 'regulator' || reg === 'light') {
      const goA = aInside || GO_SIGNALS.has(n.signal(a.dIn, a.movement));
      const goB = bInside || GO_SIGNALS.has(n.signal(b.dIn, b.movement));
      if (goA && !goB) return 1;
      if (!goA && goB) return -1;
    } else {
      const ra = this.rankOf(n, a.dIn), rb = this.rankOf(n, b.dIn);
      if (ra !== rb) return ra > rb ? 1 : -1;
      if (reg === 'equal' || ra === rb) {
        // Right-hand rule ("o'ng tomondan kelayotganga yo'l bering").
        if (b.dIn === (a.dIn + 3) % 4) return -1;
        if (a.dIn === (b.dIn + 3) % 4) return 1;
      }
    }
    // Opposite approaches: left turner yields to straight / right.
    if ((a.dIn + 2) % 4 === b.dIn) {
      if (a.movement === 'left' && b.movement !== 'left') return -1;
      if (b.movement === 'left' && a.movement !== 'left') return 1;
    }
    return 0;
  }

  private clearGrant(i: number): void {
    this.grant[i] = -1;
    this.grantEntered[i] = 0;
    this.grantLastS[i] = 0;
    this.grantExpires[i] = 0;
  }

  private connectorsConflict(a: Connector, b: Connector): boolean {
    return a === b || a.conflicts.some((cf) => cf.c === b);
  }

  private signalOrder(c: Connector): number {
    const s = c.node.signal(c.dIn, c.movement);
    return s === 'green' ? 4 : s === 'green_flash' ? 3 : s === 'yellow' ? 2 : s === 'flash' || s === 'off' ? 1 : 0;
  }

  private reservationEligible(i: number, c: Connector, dist: number): boolean {
    const n = c.node;
    const regime = n.regime();
    const sig = n.signal(c.dIn, c.movement);
    if (regime === 'light' || regime === 'regulator') {
      if (GO_SIGNALS.has(sig)) return true;
      // Preserve the signal dilemma zone: a vehicle too close to stop safely
      // may finish the movement, but yellow never grants a comfortably
      // stoppable approach.
      if (sig === 'yellow') return dist <= (this.v[i] * this.v[i]) / 9 + 0.5;
      return false;
    }
    if (n.approachPriority[c.dIn] === 'stop' && !this.stopped[i]) {
      if (this.v[i] < 0.3 && dist < 4) this.stopped[i] = 1;
      else return false;
    }
    return true;
  }

  private playerBlocksGrant(c: Connector): boolean {
    const P = this.player;
    if (!P.active || P.node !== c.node) return false;
    const n = c.node;
    const inside = Math.abs(P.x - n.x) <= n.halfX + 3 && Math.abs(P.z - n.z) <= n.halfZ + 3;
    if (inside || P.dIn < 0) return true;
    if (P.timeToNode > 4) return false;
    // Unknown player intent is handled conservatively only when collision is
    // imminent. Otherwise preserve the legal rank/right-hand ordering.
    if (P.timeToNode < 1.5) return true;
    const myRank = this.rankOf(n, c.dIn);
    const hisRank = this.rankOf(n, P.dIn as Dir);
    const fromRight = P.dIn === (c.dIn + 3) % 4;
    return hisRank > myRank || (hisRank === myRank && fromRight);
  }

  private downstreamRoom(lane: Lane): number {
    const cars = this.carsOn(lane.pid);
    if (!cars.length) return Math.max(0, lane.length - 8);
    const first = cars[0];
    return Math.max(0, this.s[first] - this.len[first]);
  }

  /**
   * Atomically retain old grants and admit a deterministic, non-conflicting
   * set of front-of-queue requests at every node. Grants are intentionally
   * exclusive rather than time-windowed: conservative, stable flow is safer
   * than independently revoking vehicles after they enter the junction.
   */
  private updateReservations(): void {
    const P = this.g.paths;
    for (const active of this.nodeReservations) active.length = 0;
    this.downstreamReserved.fill(0);

    // Sticky grants survive signal changes and remain active until the rear of
    // the vehicle has cleared into the exit lane.
    for (let i = 0; i < this.count; i++) {
      const gp = this.grant[i];
      if (gp < 0 || P[gp]?.kind !== 'conn') continue;
      const c = P[gp] as Connector;
      const path = P[this.path[i]];
      let keep = false;
      if (path === c.from && this.next[i] === c.pid) {
        if (this.s[i] > this.grantLastS[i] + 0.2) {
          this.grantLastS[i] = this.s[i];
          this.grantExpires[i] = this.simTime + 6;
        }
        if (this.grantExpires[i] > 0 && this.simTime > this.grantExpires[i]) {
          this.clearGrant(i);
          this.grantCooldown[i] = this.simTime + 1.5;
          continue;
        }
        keep = true;
      } else if (path === c) {
        keep = true;
        this.grantEntered[i] = 1;
      } else if (path === c.to && this.grantEntered[i] && this.s[i] < this.len[i] + HARD_GAP) keep = true;
      if (!keep) {
        this.clearGrant(i);
        continue;
      }
      this.nodeReservations[c.node.id].push(i);
      if (path !== c.to) this.downstreamReserved[c.to.pid] += this.len[i] + IDM_DEFAULTS.s0 + 1;
    }

    const candidates = this.reservationCandidates;
    candidates.length = 0;
    this.reservationDebt.fill(0, 0, this.count);
    for (const lane of this.g.lanes) {
      const cars = this.carsOn(lane.pid);
      if (!cars.length) continue;
      const i = cars[cars.length - 1];
      // A lane-change ghost in front still owns this queue position. Its
      // follower cannot claim the junction through it.
      if (this.path[i] !== lane.pid || this.grant[i] >= 0 || this.grantCooldown[i] > this.simTime || this.lcSource[i] >= 0 || this.lat[i] !== 0) continue;
      const np = this.next[i];
      if (np < 0 || P[np]?.kind !== 'conn') continue;
      const c = P[np] as Connector;
      if (c.from !== lane) continue;
      const dist = lane.length - this.s[i];
      const horizon = Math.min(RESERVATION_HORIZON, Math.max(24, (this.v[i] * this.v[i]) / 7 + 12));
      if (dist < -0.1 || dist > horizon) continue;
      candidates.push(i);
    }

    // Pairwise legal precedence is converted to a debt count. This preserves
    // right-hand and opposite-left yielding without using a non-transitive
    // comparator; cyclic equal-road cases fall through to wait/ETA/id.
    for (let a = 0; a < candidates.length; a++) {
      const ia = candidates[a], ca = P[this.next[ia]] as Connector;
      for (let b = a + 1; b < candidates.length; b++) {
        const ib = candidates[b], cb = P[this.next[ib]] as Connector;
        if (ca.node !== cb.node || !this.connectorsConflict(ca, cb)) continue;
        const pr = this.priority(ca, false, cb, false);
        if (pr < 0) this.reservationDebt[ia]++;
        else if (pr > 0) this.reservationDebt[ib]++;
      }
    }

    candidates.sort((ia, ib) => {
      const ca = P[this.next[ia]] as Connector, cb = P[this.next[ib]] as Connector;
      if (ca.node.id !== cb.node.id) return ca.node.id - cb.node.id;
      const signal = this.signalOrder(cb) - this.signalOrder(ca);
      if (signal) return signal;
      const debt = this.reservationDebt[ia] - this.reservationDebt[ib];
      if (debt) return debt;
      const rank = this.rankOf(cb.node, cb.dIn) - this.rankOf(ca.node, ca.dIn);
      if (rank) return rank;
      const moveA = ca.movement === 'straight' ? 2 : ca.movement === 'right' ? 1 : 0;
      const moveB = cb.movement === 'straight' ? 2 : cb.movement === 'right' ? 1 : 0;
      if (moveA !== moveB) return moveB - moveA;
      if (this.wait[ia] !== this.wait[ib]) return this.wait[ib] - this.wait[ia];
      const etaA = (ca.from.length - this.s[ia]) / Math.max(this.v[ia], 1.5);
      const etaB = (cb.from.length - this.s[ib]) / Math.max(this.v[ib], 1.5);
      return etaA !== etaB ? etaA - etaB : ia - ib;
    });

    for (const i of candidates) {
      if (this.grant[i] >= 0) continue;
      const c = P[this.next[i]] as Connector;
      const dist = c.from.length - this.s[i];
      if (!this.reservationEligible(i, c, dist)) continue;
      if (this.pedBlock(c, 0, c.length + 2) >= 0 || this.playerBlocksGrant(c)) continue;
      let conflict = false;
      for (const j of this.nodeReservations[c.node.id]) {
        const other = P[this.grant[j]] as Connector;
        if (this.connectorsConflict(c, other)) {
          conflict = true;
          break;
        }
      }
      if (conflict) continue;
      const need = this.len[i] + IDM_DEFAULTS.s0 + 1;
      if (this.downstreamRoom(c.to) - this.downstreamReserved[c.to.pid] < need) continue;
      this.grant[i] = c.pid;
      this.grantEntered[i] = 0;
      this.grantLastS[i] = this.s[i];
      this.grantExpires[i] = this.simTime + 6;
      this.nodeReservations[c.node.id].push(i);
      this.downstreamReserved[c.to.pid] += need;
    }
  }

  /**
   * Returns the s (on connector c) where car i must stop because of a
   * conflicting vehicle, or −1 when the way is clear.
   */
  private conflictStop(i: number, c: Connector, sOnC: number, inside: boolean, myDist: number): number {
    const myV = this.v[i];
    const myT = myDist / Math.max(myV, 2);
    let stopAt = -1;
    for (const cf of c.conflicts) {
      if (cf.sSelf < sOnC - 1) continue; // already passed this point
      const o = cf.c;
      // Vehicles on the other connector that have not cleared the conflict.
      const lst = this.carsOn(o.pid);
      let block = false;
      for (let k = 0; k < lst.length && !block; k++) {
        const j = lst[k];
        const sj = this.s[j];
        if (sj - this.len[j] > cf.sOther + 1.2) continue; // cleared
        const pr = this.priority(c, inside, o, true);
        const dj = Math.max(0, cf.sOther - sj);
        if (pr < 0) block = true;
        else if (pr === 0) block = !inside || dj < Math.max(0, cf.sSelf - sOnC) || (dj === 0 && j < i);
        else block = dj < 4 && this.v[j] > 0.5; // he is committed, let him clear
        if (block && pr > 0 && this.v[j] < 0.3 && dj > 3) block = false; // he is waiting for us
      }
      // Vehicles approaching the other connector on its entry lane.
      if (!block) {
        const lane = o.from;
        const ll = this.carsOn(lane.pid);
        for (let k = ll.length - 1; k >= 0 && !block; k--) {
          const j = ll[k];
          if (this.next[j] !== o.pid) continue;
          const dStop = lane.length - this.s[j];
          const dj = dStop + cf.sOther;
          if (dStop > 45) break;
          const pr = this.priority(c, inside, o, false);
          if (pr >= 0 && !(pr === 0 && !inside)) continue;
          const vj = this.v[j];
          const tj = dj / Math.max(vj, 1.5);
          // Is that car itself held (red, stop sign)? Then no need to yield.
          const sig = o.node.signal(o.dIn, o.movement);
          if (sig === 'red' || sig === 'red_yellow' || sig === 'yellow') continue;
          if (o.node.approachPriority[o.dIn] === 'stop' && !this.stopped[j] && o.node.regime() !== 'light' && o.node.regime() !== 'regulator') {
            if (vj < 0.5 && dStop < 5) {
              // stopped at STOP line — treat as waiting
            } else continue;
          }
          if (pr === 0) {
            // tie: the one arriving first goes; long waits win
            if (this.wait[i] > this.wait[j] + 1 || (this.wait[i] > 6 && vj < 0.3)) continue;
            if (myT + 0.3 < tj) continue;
          }
          // Deadlock breaker (e.g. four cars at an equal junction all
          // yielding to the right): after a long wait the lower id proceeds.
          if (pr < 0 && this.wait[i] > 7 && vj < 0.3 && this.wait[j] > 2 && i < j) continue;
          if (tj < myT + 4.5 || (vj < 0.5 && dStop < 6)) block = true;
        }
      }
      if (block) {
        const at = Math.max(0, cf.sSelf - this.len[i] * 0.5 - 2.2);
        if (stopAt < 0 || at < stopAt) stopAt = at;
      }
    }
    return stopAt;
  }

  /**
   * Used by the pedestrian controller to establish mutual exclusion. A person
   * may not commit to a zebra while a sticky vehicle grant still crosses it;
   * conversely, pedestrian intent is published before new grants are issued.
   */
  crosswalkReserved(cw: Crosswalk): boolean {
    const paths = this.g.paths;
    for (let i = 0; i < this.count; i++) {
      const gp = this.grant[i];
      if (gp < 0 || paths[gp]?.kind !== 'conn') continue;
      const c = paths[gp] as Connector;
      if (c.xings.some((x) => x.cw === cw)) return true;
    }
    return false;
  }

  /** Pedestrians on/entering a crosswalk that the path crosses near s-range. */
  private pedBlock(p: Path, sFront: number, look: number): number {
    for (const x of p.xings) {
      if (x.s1 < sFront - 0.5) continue;
      if (x.s0 > sFront + look) break;
      const cw = x.cw;
      for (const o of cw.occupants) {
        if (o.intent) return Math.max(0, x.s0 - 1.2);
        const du = o.u - x.u;
        // on our part of the zebra or walking towards it
        if (Math.abs(du) < 5 || Math.abs(du + o.vu * 3) < 4 || du * o.vu < 0 && Math.abs(du) < 9) return Math.max(0, x.s0 - 1.2);
      }
    }
    return -1;
  }

  private playerAhead(i: number, look: number): { gap: number; v: number } | null {
    const P = this.player;
    if (!P.active) return null;
    const path = this.g.paths[this.path[i]];
    const yaw = pathHeading(path, Math.max(0, Math.min(path.length, this.s[i] - this.len[i] * 0.5)));
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const pfx = -Math.sin(P.yaw), pfz = -Math.cos(P.yaw);
    const prx = Math.cos(P.yaw), prz = -Math.sin(P.yaw);
    const playerLong = Math.abs(pfx * fx + pfz * fz) * P.halfLen + Math.abs(prx * fx + prz * fz) * P.halfWid;
    const playerLat = Math.abs(pfx * rx + pfz * rz) * P.halfLen + Math.abs(prx * rx + prz * rz) * P.halfWid;
    const cx = this.x[i], cz = this.z[i];
    const playerV = P.vx * fx + P.vz * fz;
    let best: { gap: number; v: number } | null = null;
    for (const t of [0, 0.7]) {
      // Predict relative motion of both vehicles, not just the player. The old
      // future sample also clipped a moving player's speed to zero.
      const px = P.x + P.vx * t - (cx + fx * this.v[i] * t);
      const pz = P.z + P.vz * t - (cz + fz * this.v[i] * t);
      const f = px * fx + pz * fz;
      if (f < -playerLong || f > look) continue;
      const l = Math.abs(px * rx + pz * rz);
      if (l > 1.05 + playerLat + (t > 0 ? 0.3 : 0)) continue;
      const gap = f - this.len[i] * 0.5 - playerLong;
      if (!best || gap < best.gap) best = { gap, v: playerV };
    }
    return best;
  }

  private laneChangeSafe(i: number, source: Lane, target: Lane): boolean {
    const remaining = source.length - this.s[i];
    const lateralDistance = Math.abs(target.offset - source.offset);
    const duration = Math.max(LANE_CHANGE_MIN_TIME, lateralDistance / LANE_CHANGE_RATE);
    // The body must be centred in the target lane before the solid approach
    // marking and connector throat begin. This avoids truncating dual-lane
    // occupancy (and visually snapping) at a lane→connector transition.
    if (this.grant[i] >= 0 || remaining < source.solidTail + this.v[i] * duration + 3 || this.s[i] < 8) return false;
    const samples = [0, duration * 0.25, duration * 0.5, duration * 0.75, duration];
    for (let j = 0; j < this.count; j++) {
      if (j === i) continue;
      const sj0 = this.frontOnLane(j, target);
      if (sj0 === null) continue;
      for (const t of samples) {
        const si = this.s[i] + this.v[i] * t;
        const sj = sj0 + this.v[j] * t;
        if (sj >= si) {
          const gap = sj - this.len[j] - si;
          const need = IDM_DEFAULTS.s0 + Math.min(11, this.v[i] * 0.7) + Math.max(0, (this.v[i] - this.v[j]) * 1.3);
          if (gap < need) return false;
        } else {
          const gap = si - this.len[i] - sj;
          const need = IDM_DEFAULTS.s0 + Math.min(11, this.v[j] * 0.7) + Math.max(0, (this.v[j] - this.v[i]) * 1.3);
          if (gap < need) return false;
        }
      }
    }

    // Include the player in the complete swept-lane interval. A lane change
    // may never be committed into a gap occupied by the player even though the
    // player is not part of the AI path buckets.
    const P = this.player;
    if (P.active) {
      const heading = pathHeading(target, this.s[i]);
      const fx = -Math.sin(heading), fz = -Math.cos(heading);
      const rx = Math.cos(heading), rz = -Math.sin(heading);
      const pfx = -Math.sin(P.yaw), pfz = -Math.cos(P.yaw);
      const prx = Math.cos(P.yaw), prz = -Math.sin(P.yaw);
      const playerLong = Math.abs(pfx * fx + pfz * fz) * P.halfLen + Math.abs(prx * fx + prz * fz) * P.halfWid;
      const playerLat = Math.abs(pfx * rx + pfz * rz) * P.halfLen + Math.abs(prx * rx + prz * rz) * P.halfWid;
      for (const t of samples) {
        const si = this.s[i] + this.v[i] * t;
        pathPoint(target, Math.max(0, Math.min(target.length, si - this.len[i] * 0.5)), tmpP);
        const px = P.x + P.vx * t - tmpP.x;
        const pz = P.z + P.vz * t - tmpP.z;
        const longitudinal = px * fx + pz * fz;
        const lateral = Math.abs(px * rx + pz * rz);
        if (lateral < playerLat + 1.15 && Math.abs(longitudinal) < playerLong + this.len[i] * 0.5 + 5) return false;
      }
    }
    return true;
  }

  /** Due lane changes commit in stable id order against immediately updated occupancy. */
  private advancePendingLaneChanges(dt: number): void {
    let changed = false;
    for (let i = 0; i < this.count; i++) {
      if (this.lcPending[i] === 0) continue;
      this.lcPendingT[i] -= dt;
      if (this.lcPendingT[i] <= 0 && this.executeLaneChange(i)) changed = true;
    }
    if (changed) this.bucket();
  }

  /** Clamp next positions in each occupied lane before any path transition. */
  private projectLongitudinal(dt: number): void {
    for (let p = 0; p < this.g.paths.length; p++) {
      const cars = this.carsOn(p);
      for (let k = cars.length - 2; k >= 0; k--) {
        const follower = cars[k], leader = cars[k + 1];
        if (follower === leader) continue;
        const maxS = this.projectedS[leader] - this.len[leader] - HARD_GAP;
        if (this.projectedS[follower] <= maxS) continue;
        this.projectedS[follower] = maxS;
        this.projectedV[follower] = Math.min(this.projectedV[follower], this.projectedV[leader], Math.max(0, (maxS - this.s[follower]) / dt));
        this.longitudinalCorrections++;
      }
    }
  }

  /** Repair any overlap created when several vehicles change paths together. */
  private correctPathOverlaps(): void {
    // Two passes propagate a correction through cars that occupy both lanes.
    for (let pass = 0; pass < 2; pass++) {
      for (let p = 0; p < this.g.paths.length; p++) {
        const cars = this.carsOn(p);
        for (let k = cars.length - 2; k >= 0; k--) {
          const follower = cars[k], leader = cars[k + 1];
          if (follower === leader) continue;
          const maxS = this.s[leader] - this.len[leader] - HARD_GAP;
          if (this.s[follower] <= maxS) continue;
          this.s[follower] = Math.max(0, maxS);
          this.v[follower] = Math.min(this.v[follower], this.v[leader]);
          this.brake[follower] = 1;
          this.longitudinalCorrections++;
        }
      }
    }
  }

  // ─── Step ────────────────────────────────────────────────────────────────

  step(dt: number): void {
    if (dt <= 0) return;
    this.simTime += dt;
    this.serviceDemand(dt);
    this.bucket();
    this.advancePendingLaneChanges(dt);
    this.updateReservations();
    const P = this.g.paths;
    const wm = WEATHER_MODS[this.weather];
    const a = IDM_DEFAULTS.a;
    const b = IDM_DEFAULTS.b * wm.b;
    this.mobilClock += dt;
    const doMobil = this.mobilClock > 0.25;
    if (doMobil) this.mobilClock = 0;
    const n = this.count;
    const accOut = this.acc;
    for (let i = 0; i < n; i++) {
      const path = P[this.path[i]];
      const s = this.s[i];
      const v = this.v[i];
      const T = IDM_DEFAULTS.T * this.Tf[i] * wm.T;
      let v0 = (path.speedLimit / 3.6) * this.v0f[i] * (wm.grip < 1 ? 0.9 : 1);
      if (path.kind === 'lane') v0 *= (path as Lane).warnFactor;
      let accMin = 1e9;
      // leader (also retained for the cross-path hard safety projection)
      const L = this.leader(i, path.pid, s);
      this.leaderGap[i] = L.gap;
      this.leaderSpeed[i] = L.v;
      if (L.gap < 1e8) accMin = this.idm(v, v0, L.gap, v - L.v, T, a, b);
      else accMin = this.idm(v, v0, 1e9, 0, T, a, b);
      // player car
      const pa = this.playerAhead(i, 45 + v * 2);
      if (pa) accMin = Math.min(accMin, this.idm(v, v0, pa.gap, v - pa.v, T, a, b));
      // virtual stop points
      let stopS = -1; // s on current path
      if (path.kind === 'lane') {
        const lane = path as Lane;
        const dist = lane.length - s;
        const nextC = this.next[i] >= 0 ? (P[this.next[i]] as Connector) : null;
        // Slow down for the turn ahead.
        if (nextC) {
          const vc = (nextC.speedLimit / 3.6) * this.v0f[i];
          const vAllowed = Math.sqrt(vc * vc + 2 * b * 0.8 * Math.max(0, dist - 2));
          if (vAllowed < v0) accMin = Math.min(accMin, this.idm(v, vAllowed, 1e9, 0, T, a, b));
        }
        if (nextC && dist < 70 && this.grant[i] !== nextC.pid) {
          // Signals, signs, conflicting movements, pedestrians, the player and
          // downstream storage are all admitted atomically. No grant means a
          // hard stop-line obligation regardless of what a pairwise scan sees.
          stopS = lane.length;
          if (nextC.node.regime() !== 'light' && nextC.node.regime() !== 'regulator' && nextC.node.approachPriority[nextC.dIn] === 'stop' && v < 0.3 && dist < 4) {
            this.stopped[i] = 1;
          }
        }
        // Mid-block zebra on the lane itself is outside junction admission.
        const pz = this.pedBlock(lane, s, 30);
        if (pz >= 0 && (stopS < 0 || pz < stopS)) stopS = pz;
        if (stopS < 0 && this.stopped[i] === 0 && dist > 6) this.wait[i] = 0;
      }
      if (stopS >= 0) {
        const gap = stopS - s;
        if (gap > -0.5) accMin = Math.min(accMin, this.idm(v, v0, Math.max(gap, 0.05), v, T, a, b));
        if (v < 0.3) this.wait[i] += dt;
      }
      accOut[i] = Math.max(-9, Math.min(a, accMin));
    }

    // MOBIL lane changes (staggered).
    if (doMobil) for (let i = 0; i < n; i++) this.mobil(i, a, b, 0.25);

    // Project all longitudinal motion from the same snapshot, then enforce a
    // hard no-passing bound before any path transition is applied.
    for (let i = 0; i < n; i++) {
      this.projectedV[i] = Math.max(0, this.v[i] + accOut[i] * dt);
      this.projectedS[i] = this.s[i] + Math.max(0, this.v[i] * dt + 0.5 * accOut[i] * dt * dt);
      // leader() follows the actual lane→connector→exit chain, therefore this
      // bound closes the hard-safety hole at path boundaries as well as within
      // one pid bucket. IDM controls comfort; this projection is the invariant.
      const gap = this.leaderGap[i];
      if (gap < 1e8) {
        const maxAdvance = Math.max(0, gap - HARD_GAP + Math.max(0, this.leaderSpeed[i]) * dt);
        const maxS = this.s[i] + maxAdvance;
        if (this.projectedS[i] > maxS) {
          this.projectedS[i] = maxS;
          this.projectedV[i] = Math.min(this.projectedV[i], this.leaderSpeed[i], Math.max(0, maxAdvance / dt));
          this.longitudinalCorrections++;
        }
      }
    }
    this.projectLongitudinal(dt);

    // Integrate & advance.
    for (let i = 0; i < n; i++) {
      let v = this.projectedV[i];
      let s = Math.max(0, this.projectedS[i]);
      this.brake[i] = accOut[i] < -0.6 || v < 0.2 ? 1 : 0;
      // lateral animation; logical occupancy remains in both lanes
      const la = this.lat[i];
      if (la !== 0) {
        const nl = la - Math.sign(la) * Math.min(Math.abs(la), dt * LANE_CHANGE_RATE);
        this.lat[i] = Math.abs(nl) < 0.01 ? 0 : nl;
        if (this.lat[i] === 0) {
          this.lcSource[i] = -1;
          if (this.lcPending[i] === 0) this.indicator[i] = this.turnIndicator(i);
        }
      }
      let path = P[this.path[i]];
      let guard = 0;
      let recovered = false;
      while (s >= path.length && guard++ < 4) {
        if (path.kind === 'lane') {
          const nx = this.next[i];
          if (nx < 0) {
            recovered = this.respawn(i);
            if (!recovered) {
              s = Math.max(0, path.length - HARD_GAP);
              v = 0;
            }
            break;
          }
          // Atomic admission has a hard transition gate. Numerical overshoot
          // can never carry an ungranted vehicle through the stop line.
          if (this.grant[i] !== nx) {
            s = Math.max(0, path.length - HARD_GAP);
            v = 0;
            this.brake[i] = 1;
            break;
          }
          s -= path.length;
          this.prev[i] = path.pid;
          this.path[i] = nx;
          this.grantEntered[i] = 1;
          this.stopped[i] = 0;
          this.wait[i] = 0;
          this.lcPending[i] = 0;
          this.lcSource[i] = -1;
          this.lat[i] = 0;
          path = P[nx];
          this.indicator[i] = this.turnIndicator(i);
        } else {
          s -= path.length;
          const to = (path as Connector).to;
          this.prev[i] = path.pid;
          this.path[i] = to.pid;
          path = to;
          this.junctionPasses++;
          this.plan(i, to);
          this.indicator[i] = 0;
        }
      }
      if (recovered) continue;
      this.s[i] = s;
      this.v[i] = v;

      // Release only when the rear, not merely the front, has cleared the box.
      const gp = this.grant[i];
      if (gp >= 0) {
        const c = P[gp] as Connector;
        if (path === c.to && this.grantEntered[i] && s >= this.len[i] + HARD_GAP) this.clearGrant(i);
      }

      // Stuck watchdog (e.g. boxed in by the player) — recover after 90 s.
      if (v < 0.1) this.stuck[i] += dt;
      else this.stuck[i] = 0;
      if (this.stuck[i] > 90) {
        if (this.respawn(i)) continue;
        this.stuck[i] = 80; // avoid retrying an exhaustive search every tick
      }
      // indicator ahead of junction turns
      if (path.kind === 'lane' && this.lcPending[i] === 0 && this.lat[i] === 0) {
        const dist = path.length - s;
        const nx = this.next[i] >= 0 ? (P[this.next[i]] as Connector) : null;
        this.indicator[i] = nx && dist < 45 ? (nx.movement === 'left' ? -1 : nx.movement === 'right' ? 1 : 0) : 0;
      }
    }
    this.bucket();
    this.correctPathOverlaps();
    this.bucket();
    this.updatePoses();
  }

  private turnIndicator(i: number): number {
    const p = this.g.paths[this.path[i]];
    if (p.kind !== 'conn') return 0;
    const m = (p as Connector).movement;
    return m === 'left' ? -1 : m === 'right' ? 1 : 0;
  }

  private respawn(i: number, exclusion: ExclusionZone | null = null): boolean {
    const place = this.findPlacement(i, exclusion);
    if (!place) {
      this.failedRecoveries++;
      return false;
    }
    this.placeCar(i, place.lane, place.s, place.speed);
    this.forcedRecoveries++;
    return true;
  }

  private removeCar(i: number): void {
    const last = this.count - 1;
    if (i < 0 || i > last) return;
    if (i !== last) {
      const arrays: Array<Int32Array | Float32Array | Int8Array | Uint8Array | Uint32Array> = [
        this.path, this.prev, this.next, this.goal, this.s, this.v, this.acc, this.lat, this.len, this.v0f, this.Tf, this.pol,
        this.wait, this.stuck, this.stopped, this.lcTimer, this.lcPending, this.lcPendingT, this.lcSource, this.grant,
        this.grantEntered, this.grantLastS, this.grantExpires, this.grantCooldown, this.indicator, this.brake, this.model,
        this.color, this.x, this.z, this.yaw, this.projectedS, this.projectedV,
      ];
      for (const a of arrays) a[i] = a[last];
    }
    this.count--;
    this.grant[this.count] = -1;
    this.lcSource[this.count] = -1;
  }

  /**
   * Rehome every AI vehicle in the player's spawn zone. Exhaustive placement
   * normally succeeds; dense removal is the safe fallback and retained demand
   * will replace the vehicle away from the active player on a later tick.
   */
  clearPlayerArea(x: number, z: number, radius = 20): number {
    this.updatePoses();
    const r2 = radius * radius;
    const exclusion = { x, z, radius: Math.max(70, radius + 24) };
    let cleared = 0;
    for (let i = this.count - 1; i >= 0; i--) {
      const dx = this.x[i] - x, dz = this.z[i] - z;
      if (dx * dx + dz * dz >= r2) continue;
      cleared++;
      if (!this.respawn(i, exclusion)) this.removeCar(i);
    }
    this.bucket();
    this.updatePoses();
    return cleared;
  }

  // ─── MOBIL ───────────────────────────────────────────────────────────────

  private mobil(i: number, a: number, b: number, dtCheck: number): void {
    this.lcTimer[i] -= dtCheck;
    if (this.lcTimer[i] > 0 || this.lcPending[i] !== 0 || this.lat[i] !== 0 || this.grant[i] >= 0) return;
    const P = this.g.paths;
    const path = P[this.path[i]];
    if (path.kind !== 'lane') return;
    const lane = path as Lane;
    const s = this.s[i];
    const dist = lane.length - s;
    if (dist < lane.solidTail || s < 6) return; // solid 1.1 near junctions
    const v = this.v[i];
    const T = IDM_DEFAULTS.T * this.Tf[i] * WEATHER_MODS[this.weather].T;
    const v0 = (lane.speedLimit / 3.6) * this.v0f[i];
    const cur = this.leader(i, lane.pid, s);
    const aC = cur.gap < 1e8 ? this.idm(v, v0, cur.gap, v - cur.v, T, a, b) : this.idm(v, v0, 1e9, 0, T, a, b);
    const bSafe = IDM_DEFAULTS.bSafe;
    let bestDir = 0;
    let bestGain = IDM_DEFAULTS.athreshold;
    for (const dir of [-1, 1]) {
      const tgt = dir < 0 ? lane.left : lane.right;
      if (!tgt) continue;
      if (dir < 0 && !lane.canLeft) continue;
      if (dir > 0 && !lane.canRight) continue;
      // Neighbours in target lane.
      const list = this.carsOn(tgt.pid);
      let lead = -1, fol = -1;
      for (let k = 0; k < list.length; k++) {
        const j = list[k];
        if (this.s[j] >= s) {
          lead = j;
          fol = k > 0 ? list[k - 1] : -1;
          break;
        }
        fol = j;
      }
      // Physical overlap check.
      if (lead >= 0 && this.s[lead] - this.len[lead] - s < 1.5) continue;
      if (fol >= 0 && s - this.len[i] - this.s[fol] < 1.5) continue;
      const gapL = lead >= 0 ? this.s[lead] - this.len[lead] - s : 1e9;
      const aCt = this.idm(v, v0, gapL, lead >= 0 ? v - this.v[lead] : 0, T, a, b);
      // New follower after change
      let aN = 0, aNt = 0;
      if (fol >= 0) {
        const vf = this.v[fol];
        const Tf = IDM_DEFAULTS.T * this.Tf[fol];
        const v0f = (tgt.speedLimit / 3.6) * this.v0f[fol];
        const gOld = lead >= 0 ? this.s[lead] - this.len[lead] - this.s[fol] : 1e9;
        aN = this.idm(vf, v0f, gOld, lead >= 0 ? vf - this.v[lead] : 0, Tf, a, b);
        aNt = this.idm(vf, v0f, s - this.len[i] - this.s[fol], vf - v, Tf, a, b);
        if (aNt < -bSafe) continue; // safety criterion
      }
      // Old follower (behind us in current lane) gains
      let aO = 0, aOt = 0;
      const myList = this.carsOn(lane.pid);
      const rk = this.rank[i] - this.pathStart[lane.pid];
      const oldF = rk > 0 ? myList[rk - 1] : -1;
      if (oldF >= 0) {
        const vo = this.v[oldF];
        const v0o = (lane.speedLimit / 3.6) * this.v0f[oldF];
        aO = this.idm(vo, v0o, s - this.len[i] - this.s[oldF], vo - v, IDM_DEFAULTS.T, a, b);
        const nl = cur.gap < 1e8 ? cur : { gap: 1e9, v: 0 };
        aOt = this.idm(vo, v0o, nl.gap < 1e8 ? nl.gap + (s - this.s[oldF]) : 1e9, nl.gap < 1e8 ? vo - nl.v : 0, IDM_DEFAULTS.T, a, b);
      }
      let gain = aCt - aC + this.pol[i] * (aNt - aN + aOt - aO);
      // Keep-right rule (YHQ: occupy the rightmost lane when it is free).
      gain += dir > 0 ? IDM_DEFAULTS.bias : -IDM_DEFAULTS.bias;
      // Planning is always legal from the current lane. Lane changes here are
      // discretionary flow/keep-right moves and reroute after commit.
      if (gain > bestGain) {
        bestGain = gain;
        bestDir = dir;
      }
    }
    if (bestDir !== 0) {
      // Indicator first (YHQ: signal before manoeuvre), then move.
      this.lcPending[i] = bestDir;
      this.lcPendingT[i] = 1.0;
      this.indicator[i] = bestDir;
    }
    this.lcTimer[i] = 0.5 + this.rng() * 0.8;
  }

  private executeLaneChange(i: number): boolean {
    const dir = this.lcPending[i];
    this.lcPending[i] = 0;
    const P = this.g.paths;
    const lane = P[this.path[i]] as Lane;
    if (!dir || lane.kind !== 'lane') return false;
    const tgt = dir < 0 ? lane.left : lane.right;
    if (!tgt || (dir < 0 && !lane.canLeft) || (dir > 0 && !lane.canRight) || !this.laneChangeSafe(i, lane, tgt)) {
      this.indicator[i] = 0;
      this.lcTimer[i] = 0.5 + this.rng() * 0.8;
      return false;
    }
    this.lcSource[i] = lane.pid;
    this.path[i] = tgt.pid;
    this.lat[i] = -dir * tgt.edge.cls.laneWidth; // visually starts from the old lane
    this.refreshNext(i, tgt);
    this.laneChanges++;
    return true;
  }

  // ─── Poses ───────────────────────────────────────────────────────────────

  updatePoses(): void {
    const P = this.g.paths;
    for (let i = 0; i < this.count; i++) {
      const p = P[this.path[i]];
      // reference = car centre = front − len/2
      let sc = this.s[i] - this.len[i] * 0.5;
      let pp = p;
      if (sc < 0 && this.prev[i] >= 0) {
        pp = P[this.prev[i]];
        sc += pp.length;
        if (sc < 0) sc = 0;
      } else if (sc < 0) sc = 0;
      pathPoint(pp, sc, tmpP);
      let yaw = pathHeading(pp, sc);
      // rotate slightly when changing lanes
      const la = this.lat[i];
      if (la !== 0) yaw += Math.sign(la) * Math.min(0.12, Math.abs(la) * 0.05);
      const rx = Math.cos(yaw), rz = -Math.sin(yaw); // right vector of yaw
      this.x[i] = tmpP.x + rx * la;
      this.z[i] = tmpP.z + rz * la;
      this.yaw[i] = yaw;
    }
  }

  // ─── Stats / queries ─────────────────────────────────────────────────────

  getMetrics(): TrafficMetrics {
    let stopped = 0, reservations = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.v[i] < 0.3) stopped++;
      if (this.grant[i] >= 0) reservations++;
    }
    return {
      targetVehicles: this.targetCount,
      activeVehicles: this.count,
      laneKilometres: this.laneKilometres,
      stoppedFraction: this.count ? stopped / this.count : 0,
      activeReservations: reservations,
      deniedSpawns: this.deniedSpawns,
      recoveries: this.forcedRecoveries,
      failedRecoveries: this.failedRecoveries,
      longitudinalCorrections: this.longitudinalCorrections,
    };
  }

  avgSpeedKmh(): number {
    let s = 0;
    for (let i = 0; i < this.count; i++) s += this.v[i];
    return this.count ? (s / this.count) * 3.6 : 0;
  }

  /** Nearest AI cars around a point (for collisions with the player). */
  near(x: number, z: number, r: number, out: number[]): number[] {
    out.length = 0;
    const r2 = r * r;
    for (let i = 0; i < this.count; i++) {
      const dx = this.x[i] - x, dz = this.z[i] - z;
      if (dx * dx + dz * dz < r2) out.push(i);
    }
    return out;
  }
}

const tmpP = { x: 0, z: 0 };

export const CAR_COLORS = [0xf2f2f2, 0xe8e8e8, 0xd9dde2, 0x1b1d22, 0x2b2f36, 0x9aa3ad, 0x6d747c, 0x7f1d1d, 0xb91c1c, 0x1e3a8a, 0x2563eb, 0x0f766e, 0x14532d, 0xa16207, 0xeab308, 0xc2410c, 0x4b5563];

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
