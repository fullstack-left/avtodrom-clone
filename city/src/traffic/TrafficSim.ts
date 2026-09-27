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
import { Connector, Dir, Lane, Node, Path, Signal, TrafficRuleGraph, pathHeading, pathPoint } from '../world/TrafficRuleGraph';

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

const GO_SIGNALS = new Set<Signal>(['green', 'green_flash']);

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
  private sorted: Int32Array;
  private rank: Int32Array; // index of car within its path bucket
  // Environment
  weather: 'clear' | 'rain' | 'fog' = 'clear';
  player: ExternalObstacle = { x: 1e9, z: 1e9, vx: 0, vz: 0, yaw: 0, halfLen: 2.2, halfWid: 0.85, active: false, node: null, dIn: -1, timeToNode: 99 };
  pedestrianQuery: ((x: number, z: number, r: number) => boolean) | null = null;
  // Stats
  laneChanges = 0;
  junctionPasses = 0;
  simTime = 0;
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
    this.x = F(); this.z = F(); this.yaw = F();
    const np = g.paths.length;
    this.pathStart = new Int32Array(np + 1);
    this.pathCount = new Int32Array(np);
    this.sorted = I();
    this.rank = I();
  }

  // ─── Population ──────────────────────────────────────────────────────────

  setCount(n: number): void {
    n = Math.min(n, this.cap);
    while (this.count < n) if (!this.spawn()) break;
    if (this.count > n) this.count = n;
    this.bucket();
  }

  private spawn(): boolean {
    const lanes = this.g.lanes;
    for (let attempt = 0; attempt < 40; attempt++) {
      const lane = lanes[Math.floor(this.rng() * lanes.length)];
      const s = 8 + this.rng() * Math.max(1, lane.length - 40);
      if (!this.isFree(lane.pid, s, 9)) continue;
      this.initCar(this.count, lane, s);
      this.count++;
      return true;
    }
    return false;
  }

  private isFree(pid: number, s: number, gap: number): boolean {
    for (let i = 0; i < this.count; i++) if (this.path[i] === pid && Math.abs(this.s[i] - s) < gap) return false;
    return true;
  }

  private initCar(i: number, lane: Lane, s: number): void {
    const r = this.rng;
    this.path[i] = lane.pid;
    this.prev[i] = -1;
    this.s[i] = s;
    this.v[i] = 5 + r() * 6;
    this.acc[i] = 0;
    this.lat[i] = 0;
    this.model[i] = r() < 0.5 ? 0 : 1;
    this.len[i] = this.model[i] === 0 ? 4.49 : 4.48;
    this.v0f[i] = 0.86 + r() * 0.2; // 86 %…106 % of the limit
    this.Tf[i] = 0.8 + r() * 0.5;
    this.pol[i] = IDM_DEFAULTS.politeness * (0.5 + r());
    this.wait[i] = 0;
    this.stuck[i] = 0;
    this.stopped[i] = 0;
    this.lcTimer[i] = r() * 3;
    this.lcPending[i] = 0;
    this.indicator[i] = 0;
    this.color[i] = CAR_COLORS[Math.floor(r() * CAR_COLORS.length)];
    this.plan(i, lane);
  }

  /** Choose the movement at the end of this edge (strategic lane goal). */
  private plan(i: number, lane: Lane): void {
    const cands: Connector[] = [];
    const w: number[] = [];
    for (const l of lane.edge.lanes)
      for (const c of l.out) {
        cands.push(c);
        w.push(c.movement === 'straight' ? 1.0 : 0.55);
      }
    if (!cands.length) {
      this.goal[i] = -1;
      this.next[i] = -1;
      return;
    }
    let tot = 0;
    for (const x of w) tot += x;
    let r = this.rng() * tot;
    let pick = cands[0];
    for (let k = 0; k < cands.length; k++) {
      r -= w[k];
      if (r <= 0) {
        pick = cands[k];
        break;
      }
    }
    this.goal[i] = pick.pid;
    this.refreshNext(i, lane);
  }

  private refreshNext(i: number, lane: Lane): void {
    const goal = this.goal[i] >= 0 ? (this.g.paths[this.goal[i]] as Connector) : null;
    if (goal && goal.from === lane) this.next[i] = goal.pid;
    else if (goal) {
      // Same movement from the current lane, if available.
      const same = lane.out.find((c) => c.movement === goal.movement);
      this.next[i] = same ? same.pid : lane.out.length ? lane.out[0].pid : -1;
    } else this.next[i] = lane.out.length ? lane.out[0].pid : -1;
  }

  // ─── Buckets ─────────────────────────────────────────────────────────────

  private bucket(): void {
    const np = this.g.paths.length;
    const cnt = this.pathCount;
    cnt.fill(0);
    for (let i = 0; i < this.count; i++) cnt[this.path[i]]++;
    let acc = 0;
    for (let p = 0; p < np; p++) {
      this.pathStart[p] = acc;
      acc += cnt[p];
    }
    this.pathStart[np] = acc;
    const fill = new Int32Array(np);
    for (let i = 0; i < this.count; i++) {
      const p = this.path[i];
      this.sorted[this.pathStart[p] + fill[p]++] = i;
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
      for (let k = a; k < b; k++) this.rank[this.sorted[k]] = k;
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
      // advance along chain
      if (path.kind === 'lane') {
        const nx = depth === 0 && laneOverride < 0 ? chainNext : (path as Lane).out[0]?.pid ?? -1;
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

  /** Pedestrians on/entering a crosswalk that the path crosses near s-range. */
  private pedBlock(p: Path, sFront: number, look: number): number {
    for (const x of p.xings) {
      if (x.s1 < sFront - 0.5) continue;
      if (x.s0 > sFront + look) break;
      const cw = x.cw;
      for (const o of cw.occupants) {
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
    const yaw = this.yaw[i];
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const cx = this.x[i], cz = this.z[i];
    let best: { gap: number; v: number } | null = null;
    for (const t of [0, 0.7]) {
      const px = P.x + P.vx * t - cx;
      const pz = P.z + P.vz * t - cz;
      const f = px * fx + pz * fz;
      if (f < 0 || f > look) continue;
      const l = Math.abs(-px * fz + pz * fx);
      if (l > 1.1 + P.halfWid + (t > 0 ? 0.3 : 0)) continue;
      const gap = f - this.len[i] / 2 - P.halfLen;
      const v = P.vx * fx + P.vz * fz;
      if (!best || gap < best.gap) best = { gap, v: t > 0 ? Math.min(v, 0) : v };
    }
    return best;
  }

  // ─── Step ────────────────────────────────────────────────────────────────

  step(dt: number): void {
    if (dt <= 0) return;
    this.simTime += dt;
    this.bucket();
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
      // leader
      const L = this.leader(i, path.pid, s);
      if (L.gap < 1e8) accMin = this.idm(v, v0, L.gap, v - L.v, T, a, b);
      else accMin = this.idm(v, v0, 1e9, 0, T, a, b);
      // player car
      const pa = this.playerAhead(i, 45 + v * 2);
      if (pa) accMin = Math.min(accMin, this.idm(v, v0, pa.gap, v - pa.v, T, a, b));
      // virtual stop points
      let stopS = -1; // s on current path
      let brakeHard = false;
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
        if (nextC && dist < 70) {
          const node = nextC.node;
          const sig = node.signal(nextC.dIn, nextC.movement);
          let hold = false;
          const canStop = dist > (v * v) / (2 * 4.5) + 0.5;
          if (sig === 'red' || sig === 'red_yellow') hold = canStop || dist > 2;
          else if (sig === 'yellow') hold = canStop;
          else if (sig === 'flash' || sig === 'off') {
            if (node.approachPriority[nextC.dIn] === 'stop' && !this.stopped[i]) {
              hold = true;
              if (v < 0.3 && dist < 4) this.stopped[i] = 1;
            }
          }
          if (hold) stopS = lane.length;
          else if (dist < 38) {
            // Right of way inside the junction.
            const cs = this.conflictStop(i, nextC, 0, false, dist);
            if (cs >= 0) stopS = lane.length;
            // Player in/approaching the junction with priority.
            if (stopS < 0 && this.player.active && this.player.node === node && (sig === 'flash' || sig === 'off')) {
              const pd = this.player.dIn;
              if (pd >= 0) {
                const myRank = this.rankOf(node, nextC.dIn);
                const hisRank = this.rankOf(node, pd as Dir);
                const fromRight = pd === (nextC.dIn + 3) % 4;
                if ((hisRank > myRank || (hisRank === myRank && fromRight)) && this.player.timeToNode < 4) stopS = lane.length;
              }
            }
            // Gridlock prevention: exit lane must have room.
            if (stopS < 0) {
              const exit = this.carsOn(nextC.to.pid);
              if (exit.length) {
                const last = exit[0];
                const room = this.s[last] - this.len[last];
                if (room < this.len[i] + 2.5 && this.v[last] < 3) stopS = lane.length;
              }
            }
          }
          // Pedestrians on the junction crosswalks this path crosses.
          if (stopS < 0) {
            const pb = this.pedBlock(nextC, 0, 12);
            if (pb >= 0 && dist < 25) stopS = lane.length + Math.min(pb, 0);
          }
        }
        // Mid-block zebra on the lane itself.
        const pz = this.pedBlock(lane, s, 30);
        if (pz >= 0 && (stopS < 0 || pz < stopS)) stopS = pz;
        if (stopS < 0 && this.stopped[i] === 0 && dist > 6) this.wait[i] = 0;
      } else {
        const c = path as Connector;
        const cs = this.conflictStop(i, c, s, true, 0);
        if (cs >= 0 && cs > s - 0.5) stopS = Math.max(cs, s);
        const pb = this.pedBlock(c, s, 14);
        if (pb >= 0 && pb > s - 0.3 && (stopS < 0 || pb < stopS)) stopS = pb;
      }
      if (stopS >= 0) {
        const gap = stopS - s;
        if (gap > -0.5) accMin = Math.min(accMin, this.idm(v, v0, Math.max(gap, 0.05), v, T, a, b));
        if (v < 0.3) this.wait[i] += dt;
      }
      if (brakeHard) accMin = Math.min(accMin, -8);
      accOut[i] = Math.max(-9, Math.min(a, accMin));
    }

    // MOBIL lane changes (staggered).
    if (doMobil) for (let i = 0; i < n; i++) this.mobil(i, a, b, 0.25);

    // Integrate & advance.
    for (let i = 0; i < n; i++) {
      let v = this.v[i] + accOut[i] * dt;
      if (v < 0) v = 0;
      let s = this.s[i] + Math.max(0, this.v[i] * dt + 0.5 * accOut[i] * dt * dt);
      this.v[i] = v;
      this.brake[i] = accOut[i] < -0.6 || v < 0.2 ? 1 : 0;
      // lateral animation
      const la = this.lat[i];
      if (la !== 0) {
        const nl = la - Math.sign(la) * Math.min(Math.abs(la), dt * 1.4);
        this.lat[i] = Math.abs(nl) < 0.01 ? 0 : nl;
        if (this.lat[i] === 0 && this.lcPending[i] === 0) this.indicator[i] = this.turnIndicator(i);
      }
      if (this.lcPending[i] !== 0) {
        this.lcPendingT[i] -= dt;
        if (this.lcPendingT[i] <= 0) this.executeLaneChange(i);
      }
      let path = P[this.path[i]];
      let guard = 0;
      while (s >= path.length && guard++ < 4) {
        s -= path.length;
        if (path.kind === 'lane') {
          const nx = this.next[i];
          if (nx < 0) {
            this.respawn(i);
            s = this.s[i];
            break;
          }
          this.prev[i] = path.pid;
          this.path[i] = nx;
          this.stopped[i] = 0;
          this.wait[i] = 0;
          this.lcPending[i] = 0;
          this.lat[i] = 0;
          path = P[nx];
          this.indicator[i] = this.turnIndicator(i);
        } else {
          const to = (path as Connector).to;
          this.prev[i] = path.pid;
          this.path[i] = to.pid;
          path = to;
          this.junctionPasses++;
          this.plan(i, to);
          this.indicator[i] = 0;
        }
      }
      this.s[i] = s;
      // Stuck watchdog (e.g. boxed in by the player) — respawn after 90 s.
      if (v < 0.1) this.stuck[i] += dt;
      else this.stuck[i] = 0;
      if (this.stuck[i] > 90) this.respawn(i);
      // indicator ahead of junction turns
      if (path.kind === 'lane' && this.lcPending[i] === 0 && this.lat[i] === 0) {
        const dist = path.length - s;
        const nx = this.next[i] >= 0 ? (P[this.next[i]] as Connector) : null;
        this.indicator[i] = nx && dist < 45 ? (nx.movement === 'left' ? -1 : nx.movement === 'right' ? 1 : 0) : 0;
      }
    }
    this.updatePoses();
  }

  private turnIndicator(i: number): number {
    const p = this.g.paths[this.path[i]];
    if (p.kind !== 'conn') return 0;
    const m = (p as Connector).movement;
    return m === 'left' ? -1 : m === 'right' ? 1 : 0;
  }

  private respawn(i: number): void {
    const lanes = this.g.lanes;
    for (let attempt = 0; attempt < 60; attempt++) {
      const lane = lanes[Math.floor(this.rng() * lanes.length)];
      const s = 5 + this.rng() * Math.max(1, lane.length * 0.4);
      // keep away from the player's view
      pathPoint(lane, s, tmpP);
      if (this.player.active && Math.hypot(tmpP.x - this.player.x, tmpP.z - this.player.z) < 120) continue;
      if (!this.isFree(lane.pid, s, 12)) continue;
      const c = this.color[i], m = this.model[i];
      this.initCar(i, lane, s);
      this.color[i] = c;
      this.model[i] = m;
      this.v[i] = 0;
      return;
    }
  }

  // ─── MOBIL ───────────────────────────────────────────────────────────────

  private mobil(i: number, a: number, b: number, dtCheck: number): void {
    this.lcTimer[i] -= dtCheck;
    if (this.lcTimer[i] > 0 || this.lcPending[i] !== 0 || this.lat[i] !== 0) return;
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
    const goal = this.goal[i] >= 0 ? (P[this.goal[i]] as Connector) : null;
    const needDir = goal && goal.from !== lane ? Math.sign(goal.from.index - lane.index) : 0;
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
      // Strategic: need to be in the goal lane before the junction.
      if (needDir === dir) gain += 1.0 + 3 * Math.max(0, 1 - (dist - lane.solidTail) / 120);
      else if (needDir === -dir) gain -= 2.0;
      else if (goal && goal.from === lane) gain -= 0.6;
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
    } else if (needDir !== 0 && dist < lane.solidTail + 12) {
      // Could not reach the goal lane — re-plan from the current lane.
      const alt = lane.out[Math.floor(this.rng() * lane.out.length)];
      if (alt) {
        this.goal[i] = alt.pid;
        this.next[i] = alt.pid;
      }
    }
    this.lcTimer[i] = 0.5 + this.rng() * 0.8;
  }

  private executeLaneChange(i: number): void {
    const dir = this.lcPending[i];
    this.lcPending[i] = 0;
    const P = this.g.paths;
    const lane = P[this.path[i]] as Lane;
    if (lane.kind !== 'lane') return;
    const tgt = dir < 0 ? lane.left : lane.right;
    if (!tgt || lane.length - this.s[i] < lane.solidTail) {
      this.indicator[i] = 0;
      return;
    }
    // Re-check gaps (cars moved during the indicator phase).
    const s = this.s[i];
    const list = this.carsOn(tgt.pid);
    for (let k = 0; k < list.length; k++) {
      const j = list[k];
      const d = this.s[j] - s;
      if (d > -this.len[i] - 2 - this.v[j] * 0.6 && d < this.len[j] + 1.5) {
        this.indicator[i] = 0;
        return;
      }
    }
    this.path[i] = tgt.pid;
    this.lat[i] = -dir * tgt.edge.cls.laneWidth; // visually starts from the old lane
    this.refreshNext(i, tgt);
    this.laneChanges++;
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
