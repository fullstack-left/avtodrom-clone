// TrafficRuleGraph — procedural city road network turned into a directed lane
// graph with Uzbek traffic rules attached to every element:
//   • Road (undirected) → Edge (directed carriageway half) → Lane
//   • Node (junction) → Connector (turn path through the junction box)
//   • signs, markings, traffic lights, regulator, crosswalks
// The graph is the single source of truth for the renderer, the AI traffic
// (IDM/MOBIL + priority resolver), pedestrians, the navigator (A*) and the
// player's rule monitor.

import { CITY_SPEED_LIMIT, ControlSource, SIGN_BY_CODE } from '../rules/PddKnowledge';

export type Dir = 0 | 1 | 2 | 3; // 0 = East (+x), 1 = South (+z), 2 = West (−x), 3 = North (−z)
export const DX = [1, 0, -1, 0];
export const DZ = [0, 1, 0, -1];
export type Movement = 'straight' | 'left' | 'right' | 'uturn';
export type RoadClassName = 'arterial' | 'street' | 'oneway';
export type Signal = 'green' | 'green_flash' | 'yellow' | 'red' | 'red_yellow' | 'flash' | 'off';
export type CenterMarking = 'double_solid' | 'solid' | 'dashed' | 'none';

export function movementOf(dIn: Dir, dOut: Dir): Movement {
  const k = (dOut - dIn + 4) % 4;
  return k === 0 ? 'straight' : k === 1 ? 'right' : k === 3 ? 'left' : 'uturn';
}
export const opposite = (d: Dir): Dir => ((d + 2) % 4) as Dir;

export const CW = 4.0; // crosswalk width, m
export const SIDEWALK = 4.5; // sidewalk width, m
export const STOP_GAP = 1.0; // stop line before crosswalk, m

interface RoadClass {
  name: RoadClassName;
  laneWidth: number;
  median: number;
  lanes: number; // per direction (one-way: total)
  speed: number;
  rank: number;
}

const CLASSES: Record<RoadClassName, RoadClass> = {
  arterial: { name: 'arterial', laneWidth: 3.5, median: 0.6, lanes: 2, speed: CITY_SPEED_LIMIT, rank: 3 },
  street: { name: 'street', laneWidth: 3.5, median: 0, lanes: 1, speed: CITY_SPEED_LIMIT, rank: 1 },
  oneway: { name: 'oneway', laneWidth: 3.5, median: 0, lanes: 2, speed: CITY_SPEED_LIMIT, rank: 2 },
};

export interface PlacedSign {
  code: string;
  x: number;
  z: number;
  /** Direction the sign face looks at (towards approaching drivers). */
  faceDir: Dir;
  /** Height offset for stacked plates. */
  stack: number;
  edge?: Edge;
}

export interface Crosswalk {
  id: number;
  /** Centre point and the axis pedestrians walk along. */
  cx: number;
  cz: number;
  axis: 'x' | 'z'; // walking axis
  halfLen: number; // half of carriageway width being crossed
  node: Node | null; // junction crosswalk or mid-block (null)
  armDir: Dir | -1; // arm of the node
  signalized: boolean;
  /** Pedestrians currently on the zebra (updated by Pedestrians). */
  occupants: { u: number; vu: number }[];
}

/** Common interface for things a car can drive along. */
export interface Path {
  pid: number;
  kind: 'lane' | 'conn';
  length: number;
  speedLimit: number; // km/h
  xs: Float32Array;
  zs: Float32Array;
  cum: Float32Array;
  /** Crosswalk crossings: s-interval on this path. */
  xings: { cw: Crosswalk; s0: number; s1: number; u: number }[];
}

export class Lane implements Path {
  pid = -1;
  kind = 'lane' as const;
  length = 0;
  speedLimit = 60;
  xs: Float32Array;
  zs: Float32Array;
  cum: Float32Array;
  xings: Path['xings'] = [];
  left: Lane | null = null;
  right: Lane | null = null;
  /** Lane change allowed to the left/right neighbour (dashed 1.5). */
  canLeft = false;
  canRight = false;
  /** Distance before the stop line where the divider becomes solid (1.1). */
  solidTail = 30;
  out: Connector[] = [];
  /** Temporary sign speed (road works) overrides permanent sign. */
  permanentLimit: number | null = null;
  temporaryLimit: number | null = null;
  warnFactor = 1;
  constructor(public edge: Edge, public index: number, public offset: number, sx: number, sz: number, ex: number, ez: number) {
    this.xs = new Float32Array([sx, ex]);
    this.zs = new Float32Array([sz, ez]);
    this.length = Math.hypot(ex - sx, ez - sz);
    this.cum = new Float32Array([0, this.length]);
  }
}

export class Connector implements Path {
  pid = -1;
  kind = 'conn' as const;
  length = 0;
  speedLimit = 40;
  xs!: Float32Array;
  zs!: Float32Array;
  cum!: Float32Array;
  xings: Path['xings'] = [];
  conflicts: { c: Connector; sSelf: number; sOther: number; merge: boolean }[] = [];
  siblings: Connector[] = []; // other connectors starting from the same lane
  constructor(public node: Node, public from: Lane, public to: Lane, public movement: Movement, public dIn: Dir, public dOut: Dir) {}
}

export class Edge {
  lanes: Lane[] = [];
  twin: Edge | null = null;
  noOvertake = false;
  /** Signs that apply along this edge (codes). */
  signs: string[] = [];
  midCrosswalk: Crosswalk | null = null;
  constructor(public id: number, public road: Road, public from: Node, public to: Node, public dir: Dir) {}
  get cls(): RoadClass {
    return this.road.cls;
  }
}

export class Road {
  fwd: Edge | null = null; // from a → b (dir 0 or 1)
  back: Edge | null = null;
  name: string;
  constructor(public id: number, public a: Node, public b: Node, public axis: 'h' | 'v', public cls: RoadClass, name: string) {
    this.name = name;
  }
  get halfWidth(): number {
    const nF = this.fwd ? this.fwd.lanes.length || this.cls.lanes : 0;
    const nB = this.back ? this.back.lanes.length || this.cls.lanes : 0;
    if (!this.fwd || !this.back) return (Math.max(nF, nB) * this.cls.laneWidth) / 2;
    return this.cls.median / 2 + Math.max(nF, nB) * this.cls.laneWidth;
  }
  get oneWay(): boolean {
    return !this.fwd || !this.back;
  }
  center: CenterMarking = 'dashed';
}

export class TrafficLight {
  t = 0;
  idx = 0;
  mode: 'normal' | 'flash' = 'normal';
  phases: { green: Set<string>; dur: number }[] = [];
  static YELLOW = 3;
  static ALL_RED = 2;
  static GREEN_FLASH = 3; // flashing green before yellow (standard in Uzbekistan)
  constructor(public node: Node) {}
  /** Current stage: 'g' green, 'y' yellow, 'r' all-red. */
  stage(): { phase: number; st: 'g' | 'y' | 'r'; remain: number } {
    const p = this.phases[this.idx];
    if (this.t < p.dur) return { phase: this.idx, st: 'g', remain: p.dur - this.t };
    if (this.t < p.dur + TrafficLight.YELLOW) return { phase: this.idx, st: 'y', remain: p.dur + TrafficLight.YELLOW - this.t };
    return { phase: this.idx, st: 'r', remain: p.dur + TrafficLight.YELLOW + TrafficLight.ALL_RED - this.t };
  }
  update(dt: number): void {
    this.t += dt;
    const p = this.phases[this.idx];
    if (this.t >= p.dur + TrafficLight.YELLOW + TrafficLight.ALL_RED) {
      this.t = 0;
      this.idx = (this.idx + 1) % this.phases.length;
    }
  }
  signal(dIn: Dir, mov: Movement): Signal {
    if (this.mode === 'flash') return 'flash';
    const { phase, st, remain } = this.stage();
    const key = `${dIn}:${mov === 'uturn' ? 'left' : mov}`;
    const g = this.phases[phase].green.has(key);
    if (g) {
      if (st === 'g') return remain < TrafficLight.GREEN_FLASH ? 'green_flash' : 'green';
      if (st === 'y') return 'yellow';
      return 'red';
    }
    // red + yellow shown just before this movement gets green
    const next = this.phases[(phase + 1) % this.phases.length];
    if (st === 'r' && next.green.has(key)) return 'red_yellow';
    return 'red';
  }
  /** Main (through) aspect for a given approach — drawn on the 3-lamp head. */
  headSignal(dIn: Dir): Signal {
    const s = this.signal(dIn, 'straight');
    if (s !== 'red') return s;
    const r = this.signal(dIn, 'right');
    return r;
  }
  /** Left-arrow section state (protected left phases only). */
  hasLeftArrow = false;
  pedestrianGreen(armDir: Dir): boolean {
    if (this.mode === 'flash') return false;
    // Crosswalk across the arm pointing in armDir is parallel to traffic
    // moving along the perpendicular axis.
    const perp1 = ((armDir + 1) % 4) as Dir;
    const perp2 = ((armDir + 3) % 4) as Dir;
    const { phase, st, remain } = this.stage();
    if (st !== 'g' || remain < 4) return false;
    const g = this.phases[phase].green;
    return g.has(`${perp1}:straight`) || g.has(`${perp2}:straight`);
  }
}

/** Traffic police officer at a junction. Overrides the lights. */
export class Regulator {
  t = 0;
  /** 0: E–W traffic may go (officer's side to them), 1: N–S, with 3 s "hand up" between. */
  axis = 0;
  handUp = false;
  enabled = false;
  static GO = 20;
  static HAND_UP = 4;
  constructor(public node: Node) {}
  update(dt: number): void {
    this.t += dt;
    if (!this.handUp && this.t > Regulator.GO) {
      this.handUp = true;
      this.t = 0;
    } else if (this.handUp && this.t > Regulator.HAND_UP) {
      this.handUp = false;
      this.axis = 1 - this.axis;
      this.t = 0;
    }
  }
  /**
   * YHQ: arms extended — traffic from the officer's left and right may go
   * straight and right (sides), chest/back — stop. Right arm forward — the
   * left turn is also permitted for traffic in front of the officer's left side.
   * Simplified: sides (axis traffic) may go straight/right/left; others stop.
   */
  signal(dIn: Dir, _mov: Movement): Signal {
    if (this.handUp) return 'yellow';
    const onAxis = this.axis === 0 ? dIn === 0 || dIn === 2 : dIn === 1 || dIn === 3;
    return onAxis ? 'green' : 'red';
  }
  /** Direction the officer's chest faces (for rendering). */
  facing(): Dir {
    return this.axis === 0 ? 3 : 0;
  }
}

export class Node {
  arms: (Road | null)[] = [null, null, null, null]; // road going out in direction d
  out: (Edge | null)[] = [null, null, null, null]; // outgoing edge in dir d
  inc: (Edge | null)[] = [null, null, null, null]; // incoming edge travelling in dir d
  halfX = 0; // box half extent across x (width of N–S roads)
  halfZ = 0;
  light: TrafficLight | null = null;
  regulator: Regulator | null = null;
  approachPriority: ('main' | 'yield' | 'stop' | null)[] = [null, null, null, null]; // by dIn
  temporaryPriority = false;
  allowed: (Set<Movement> | null)[] = [null, null, null, null]; // by dIn (from 4.1.x/3.18/3.19)
  connectors: Connector[] = [];
  crosswalks: (Crosswalk | null)[] = [null, null, null, null]; // by arm dir
  name = '';
  constructor(public id: number, public i: number, public j: number, public x: number, public z: number) {}
  get armCount(): number {
    return this.arms.filter(Boolean).length;
  }
  /** Which regulation source currently governs this junction (hierarchy). */
  regime(): ControlSource {
    if (this.regulator?.enabled) return 'regulator';
    if (this.light && this.light.mode === 'normal') return 'light';
    if (this.approachPriority.some(Boolean)) return this.temporaryPriority ? 'temporary_sign' : 'permanent_sign';
    return 'equal';
  }
  signal(dIn: Dir, mov: Movement): Signal {
    const r = this.regime();
    if (r === 'regulator') return this.regulator!.signal(dIn, mov);
    if (r === 'light') return this.light!.signal(dIn, mov);
    if (this.light) return 'flash';
    return 'off';
  }
}

export interface CityOptions {
  nx: number;
  ny: number;
  block: number;
}

const STREET_NAMES_H = ["Bog'ishamol", 'Olmazor', 'Istiqbol', 'Amir Temur shoh ko\'chasi', 'Mustaqillik', 'Navro\'z', 'Sharof Rashidov', 'Bunyodkor', 'Chilonzor'];
const STREET_NAMES_V = ['Beruniy', 'Farobiy', "Qo'yliq", 'Alisher Navoiy shoh ko\'chasi', 'Mirzo Ulug\'bek', 'Bobur', 'Shota Rustaveli', 'Furqat', 'Yunusobod'];

/**
 * Deterministic procedural city. Grid of junctions; two arterials (4 lanes,
 * double solid 1.3) cross in the centre, two one-way streets, the rest are
 * 2-lane streets with priority signs or equal (right-hand rule) junctions.
 */
export class TrafficRuleGraph {
  nodes: Node[] = [];
  roads: Road[] = [];
  edges: Edge[] = [];
  lanes: Lane[] = [];
  connectors: Connector[] = [];
  paths: Path[] = [];
  signs: PlacedSign[] = [];
  crosswalks: Crosswalk[] = [];
  nx: number;
  ny: number;
  block: number;
  minX = 0;
  maxX = 0;
  minZ = 0;
  maxZ = 0;
  private nodeGrid: Node[][] = [];

  constructor(opts: CityOptions = { nx: 7, ny: 7, block: 125 }) {
    this.nx = opts.nx;
    this.ny = opts.ny;
    this.block = opts.block;
    this.build();
  }

  node(i: number, j: number): Node | null {
    return this.nodeGrid[i]?.[j] ?? null;
  }

  private classForLine(axis: 'h' | 'v', k: number): RoadClassName {
    const mid = axis === 'h' ? Math.floor(this.ny / 2) : Math.floor(this.nx / 2);
    if (k === mid) return 'arterial';
    if (axis === 'v' && k === 1) return 'oneway';
    if (axis === 'h' && k === this.ny - 2) return 'oneway';
    return 'street';
  }

  private build(): void {
    const { nx, ny, block } = this;
    const ox = -((nx - 1) * block) / 2;
    const oz = -((ny - 1) * block) / 2;
    for (let i = 0; i < nx; i++) {
      this.nodeGrid[i] = [];
      for (let j = 0; j < ny; j++) {
        const n = new Node(this.nodes.length, i, j, ox + i * block, oz + j * block);
        this.nodes.push(n);
        this.nodeGrid[i][j] = n;
      }
    }
    this.minX = ox;
    this.maxX = ox + (nx - 1) * block;
    this.minZ = oz;
    this.maxZ = oz + (ny - 1) * block;

    // Roads + directed edges.
    const addRoad = (a: Node, b: Node, axis: 'h' | 'v', line: number) => {
      const clsName = this.classForLine(axis, line);
      const cls = CLASSES[clsName];
      const name = axis === 'h' ? STREET_NAMES_H[line % STREET_NAMES_H.length] : STREET_NAMES_V[line % STREET_NAMES_V.length];
      const road = new Road(this.roads.length, a, b, axis, cls, name);
      this.roads.push(road);
      const dF: Dir = axis === 'h' ? 0 : 1;
      const dB = opposite(dF);
      // One-way directions: vertical one-way runs south (dir 1), horizontal runs west (dir 2).
      const makeF = clsName !== 'oneway' || axis === 'v';
      const makeB = clsName !== 'oneway' || axis === 'h';
      if (makeF) {
        const e = new Edge(this.edges.length, road, a, b, dF);
        this.edges.push(e);
        road.fwd = e;
        a.out[dF] = e;
        b.inc[dF] = e;
      }
      if (makeB) {
        const e = new Edge(this.edges.length, road, b, a, dB);
        this.edges.push(e);
        road.back = e;
        b.out[dB] = e;
        a.inc[dB] = e;
      }
      if (road.fwd && road.back) {
        road.fwd.twin = road.back;
        road.back.twin = road.fwd;
      }
      a.arms[dF] = road;
      b.arms[dB] = road;
      road.center = clsName === 'arterial' ? 'double_solid' : clsName === 'oneway' ? 'none' : 'dashed';
    };
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx - 1; i++) addRoad(this.nodeGrid[i][j], this.nodeGrid[i + 1][j], 'h', j);
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny - 1; j++) addRoad(this.nodeGrid[i][j], this.nodeGrid[i][j + 1], 'v', i);

    // Junction box sizes.
    for (const n of this.nodes) {
      const hwV = Math.max(n.arms[1]?.halfWidth ?? 0, n.arms[3]?.halfWidth ?? 0);
      const hwH = Math.max(n.arms[0]?.halfWidth ?? 0, n.arms[2]?.halfWidth ?? 0);
      n.halfX = hwV || hwH;
      n.halfZ = hwH || hwV;
      const hn = STREET_NAMES_H[n.j % STREET_NAMES_H.length];
      const vn = STREET_NAMES_V[n.i % STREET_NAMES_V.length];
      n.name = `${vn} / ${hn}`;
    }

    this.buildLanes();
    this.assignControl();
    this.buildCrosswalks();
    this.buildConnectors();
    this.placeSigns();
    this.computeConflicts();
    this.computeCrossings();
    this.paths = [...this.lanes, ...this.connectors];
    this.paths.forEach((p, k) => (p.pid = k));
  }

  /** Distance from node centre to the stop line along an arm. */
  armOffset(n: Node, d: Dir): number {
    const half = d === 0 || d === 2 ? n.halfX : n.halfZ;
    return half + CW + STOP_GAP;
  }

  private buildLanes(): void {
    for (const e of this.edges) {
      const road = e.road;
      const cls = road.cls;
      const n = cls.lanes;
      const dx = DX[e.dir];
      const dz = DZ[e.dir];
      const rx = -dz; // right normal
      const rz = dx;
      const cx0 = e.from.x;
      const cz0 = e.from.z;
      const offStart = this.armOffset(e.from, e.dir) - 0.5;
      const offEnd = this.armOffset(e.to, opposite(e.dir));
      const len = Math.hypot(e.to.x - e.from.x, e.to.z - e.from.z);
      for (let k = 0; k < n; k++) {
        const lat = road.oneWay ? -(n * cls.laneWidth) / 2 + (k + 0.5) * cls.laneWidth : cls.median / 2 + (k + 0.5) * cls.laneWidth;
        const sx = cx0 + dx * offStart + rx * lat;
        const sz = cz0 + dz * offStart + rz * lat;
        const ex = cx0 + dx * (len - offEnd) + rx * lat;
        const ez = cz0 + dz * (len - offEnd) + rz * lat;
        const lane = new Lane(e, k, lat, sx, sz, ex, ez);
        lane.speedLimit = cls.speed;
        e.lanes.push(lane);
        this.lanes.push(lane);
      }
      for (let k = 0; k < n; k++) {
        const l = e.lanes[k];
        l.left = e.lanes[k - 1] ?? null;
        l.right = e.lanes[k + 1] ?? null;
        l.canLeft = !!l.left;
        l.canRight = !!l.right;
      }
    }
    // Special zones (signs attach to edges; lanes read the limits).
    const zone = (i: number, j: number, di: number, dj: number, fn: (e: Edge) => void) => {
      const a = this.node(i, j);
      const b = this.node(i + di, j + dj);
      if (!a || !b) return;
      for (const e of this.edges) if ((e.from === a && e.to === b) || (e.from === b && e.to === a)) fn(e);
    };
    // School zone: 1.21 "Bolalar" + 3.24-40.
    zone(2, 1, 1, 0, (e) => {
      e.signs.push('1.21', '3.24-40');
      e.lanes.forEach((l) => ((l.permanentLimit = 40), (l.warnFactor = 0.85)));
    });
    // Street with no overtaking and 50 km/h.
    for (let j = 0; j < this.ny - 1; j++)
      zone(this.nx - 2, j, 0, 1, (e) => {
        e.noOvertake = true;
        e.signs.push('3.20', '3.24-50');
        e.lanes.forEach((l) => (l.permanentLimit = 50));
        e.road.center = 'solid';
      });
    // Arterials: 60 km/h permanent in the centre blocks.
    const mj = Math.floor(this.ny / 2);
    zone(1, mj, 1, 0, (e) => {
      e.signs.push('3.24-60');
      e.lanes.forEach((l) => (l.permanentLimit = 60));
    });
    // Road works: temporary 1.23 + 3.24-30T override the permanent 60.
    zone(4, mj, 1, 0, (e) => {
      e.signs.push('1.23', '3.24-30T');
      e.lanes.forEach((l) => ((l.temporaryLimit = 30), (l.warnFactor = 0.9)));
    });
    for (const l of this.lanes) {
      // Temporary sign > permanent sign > class default (hierarchy).
      l.speedLimit = l.temporaryLimit ?? l.permanentLimit ?? l.edge.cls.speed;
      if (l.edge.noOvertake && l.edge.road.oneWay === false) l.canLeft = false;
    }
  }

  private assignControl(): void {
    const mi = Math.floor(this.nx / 2);
    const mj = Math.floor(this.ny / 2);
    for (const n of this.nodes) {
      if (n.armCount < 3) continue; // corners: nothing to regulate
      const onArterial = n.i === mi || n.j === mj;
      const rankH = Math.max(n.arms[0]?.cls.rank ?? 0, n.arms[2]?.cls.rank ?? 0);
      const rankV = Math.max(n.arms[1]?.cls.rank ?? 0, n.arms[3]?.cls.rank ?? 0);
      if (onArterial) {
        const L = new TrafficLight(n);
        n.light = L;
        const isCentre = n.i === mi && n.j === mj;
        if (isCentre) {
          L.hasLeftArrow = true;
          L.phases = [
            { green: new Set(['0:straight', '0:right', '2:straight', '2:right']), dur: 22 },
            { green: new Set(['0:left', '2:left']), dur: 8 },
            { green: new Set(['1:straight', '1:right', '3:straight', '3:right']), dur: 22 },
            { green: new Set(['1:left', '3:left']), dur: 8 },
          ];
          n.regulator = new Regulator(n);
        } else {
          const mainH = rankH >= rankV;
          L.phases = [
            { green: new Set(['0:straight', '0:right', '0:left', '2:straight', '2:right', '2:left']), dur: mainH ? 24 : 14 },
            { green: new Set(['1:straight', '1:right', '1:left', '3:straight', '3:right', '3:left']), dur: mainH ? 14 : 24 },
          ];
        }
        L.t = ((n.i * 7 + n.j * 13) % 10) * 1.3; // offset (green wave-ish)
        // Priority signs under the lights: effective when lights flash.
        const mainAxisH = rankH >= rankV;
        for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) {
          if (!n.inc[d]) continue;
          const alongH = d === 0 || d === 2;
          n.approachPriority[d] = alongH === mainAxisH ? 'main' : 'yield';
        }
        continue;
      }
      // Unsignalised.
      const perimeterT = n.armCount === 3;
      let mainH: boolean | null;
      if (rankH !== rankV) mainH = rankH > rankV;
      else if (perimeterT) mainH = n.j === 0 || n.j === this.ny - 1; // through road of the T is main
      else if ((n.i + n.j) % 3 === 0) mainH = null; // equal junction (right-hand rule)
      else mainH = true;
      if (mainH === null) continue;
      for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) {
        if (!n.inc[d]) continue;
        const alongH = d === 0 || d === 2;
        if (alongH === mainH) n.approachPriority[d] = 'main';
        else n.approachPriority[d] = (n.i * 3 + n.j) % 4 === 1 ? 'stop' : 'yield';
      }
    }
    // Mandatory directions (4.1.x) and turn bans (3.18.x).
    const setAllowed = (i: number, j: number, dIn: Dir, code: string) => {
      const n = this.node(i, j);
      if (!n || !n.inc[dIn]) return;
      const def = SIGN_BY_CODE[code];
      let set: Set<Movement>;
      if (def.effect.allowed) set = new Set(def.effect.allowed);
      else {
        set = new Set<Movement>(['straight', 'left', 'right', 'uturn']);
        def.effect.forbidden?.forEach((m) => set.delete(m));
      }
      n.allowed[dIn] = set;
      n.inc[dIn]!.signs.push('@' + code); // '@' → placed at the stop line
    };
    // Streets crossing the arterial one block east of the centre: no left turn.
    setAllowed(mi + 2, mj, 1, '4.1.4');
    setAllowed(mi + 2, mj, 3, '4.1.4');
    setAllowed(mi, mj - 2, 1, '3.18.2');
    setAllowed(mi, mj, 0, '3.19');
    setAllowed(mi, mj, 2, '3.19');
    setAllowed(mi - 2, mj - 2, 2, '4.1.1');
  }

  private buildCrosswalks(): void {
    for (const n of this.nodes) {
      for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) {
        const road = n.arms[d];
        if (!road) continue;
        if (n.armCount < 3) continue; // corners have no crosswalks
        const alongX = d === 0 || d === 2; // arm along x → pedestrians walk along z
        const half = alongX ? n.halfX : n.halfZ;
        const c = half + CW / 2;
        const cw: Crosswalk = {
          id: this.crosswalks.length,
          cx: n.x + DX[d] * c,
          cz: n.z + DZ[d] * c,
          axis: alongX ? 'z' : 'x',
          halfLen: road.halfWidth,
          node: n,
          armDir: d,
          signalized: !!n.light,
          occupants: [],
        };
        n.crosswalks[d] = cw;
        this.crosswalks.push(cw);
      }
    }
    // Mid-block zebra (unsignalised) on arterials and some streets.
    for (const road of this.roads) {
      const mid = road.cls.name === 'arterial' || (road.id % 5 === 2 && road.cls.name === 'street');
      if (!mid) continue;
      const cx = (road.a.x + road.b.x) / 2;
      const cz = (road.a.z + road.b.z) / 2;
      const cw: Crosswalk = {
        id: this.crosswalks.length,
        cx,
        cz,
        axis: road.axis === 'h' ? 'z' : 'x',
        halfLen: road.halfWidth,
        node: null,
        armDir: -1,
        signalized: false,
        occupants: [],
      };
      this.crosswalks.push(cw);
      if (road.fwd) (road.fwd.midCrosswalk = cw), road.fwd.signs.push('1.20');
      if (road.back) (road.back.midCrosswalk = cw), road.back.signs.push('1.20');
    }
  }

  private buildConnectors(): void {
    for (const n of this.nodes) {
      for (let dIn = 0 as Dir; dIn < 4; dIn = (dIn + 1) as Dir) {
        const ein = n.inc[dIn];
        if (!ein) continue;
        for (let dOut = 0 as Dir; dOut < 4; dOut = (dOut + 1) as Dir) {
          const eout = n.out[dOut];
          if (!eout) continue;
          const mov = movementOf(dIn, dOut);
          if (mov === 'uturn') continue; // AI never U-turns at junctions
          const allowed = n.allowed[dIn];
          if (allowed && !allowed.has(mov)) continue;
          const nIn = ein.lanes.length;
          const nOut = eout.lanes.length;
          const pairs: [number, number][] = [];
          if (mov === 'right') pairs.push([nIn - 1, nOut - 1]);
          else if (mov === 'left') pairs.push([0, 0]);
          else {
            for (let k = 0; k < nIn; k++) {
              const t = nIn === 1 ? nOut - 1 : Math.round((k * (nOut - 1)) / (nIn - 1));
              pairs.push([k, t]);
            }
          }
          // With only 2 arms the "turn" is a bend in the road.
          for (const [a, b] of pairs) {
            const c = new Connector(n, ein.lanes[a], eout.lanes[b], mov, dIn, dOut);
            this.shapeConnector(c);
            c.from.out.push(c);
            n.connectors.push(c);
            this.connectors.push(c);
          }
        }
      }
    }
    for (const l of this.lanes) for (const c of l.out) c.siblings = l.out.filter((o) => o !== c);
  }

  private shapeConnector(c: Connector): void {
    const a = c.from;
    const b = c.to;
    const p0x = a.xs[1];
    const p0z = a.zs[1];
    const p3x = b.xs[0];
    const p3z = b.zs[0];
    const N = c.movement === 'straight' ? 2 : 14;
    const xs = new Float32Array(N);
    const zs = new Float32Array(N);
    if (c.movement === 'straight') {
      xs[0] = p0x; zs[0] = p0z; xs[1] = p3x; zs[1] = p3z;
    } else {
      // Control point: intersection of the two lane lines.
      const d0x = DX[c.dIn], d0z = DZ[c.dIn];
      const cx = d0x !== 0 ? p3x : p0x;
      const cz = d0z !== 0 ? p3z : p0z;
      for (let k = 0; k < N; k++) {
        const t = k / (N - 1);
        const u = 1 - t;
        xs[k] = u * u * p0x + 2 * u * t * cx + t * t * p3x;
        zs[k] = u * u * p0z + 2 * u * t * cz + t * t * p3z;
      }
    }
    const cum = new Float32Array(N);
    for (let k = 1; k < N; k++) cum[k] = cum[k - 1] + Math.hypot(xs[k] - xs[k - 1], zs[k] - zs[k - 1]);
    c.xs = xs;
    c.zs = zs;
    c.cum = cum;
    c.length = cum[N - 1];
    c.speedLimit = c.movement === 'straight' ? c.from.speedLimit : c.movement === 'right' ? 18 : 25;
  }

  private placeSigns(): void {
    const put = (code: string, x: number, z: number, faceDir: Dir, stack = 0, edge?: Edge) => this.signs.push({ code, x, z, faceDir, stack, edge });
    for (const n of this.nodes) {
      for (let dIn = 0 as Dir; dIn < 4; dIn = (dIn + 1) as Dir) {
        const e = n.inc[dIn];
        if (!e) continue;
        const road = e.road;
        const dx = DX[dIn], dz = DZ[dIn];
        const rx = -dz, rz = dx;
        const edgeLat = road.oneWay ? road.halfWidth : road.halfWidth;
        const off = this.armOffset(n, opposite(dIn)) + 1.5;
        const sx = n.x - dx * off + rx * (edgeLat + 1.2);
        const sz = n.z - dz * off + rz * (edgeLat + 1.2);
        const face = opposite(dIn);
        let stack = 0;
        const pr = n.approachPriority[dIn];
        if (pr) put(pr === 'main' ? '2.1' : pr === 'yield' ? '2.4' : '2.5', sx, sz, face, stack++, e);
        for (const s of e.signs) if (s.startsWith('@')) put(s.slice(1), sx, sz, face, stack++, e);
        if (n.light) {
          // 1.8 warning ahead of signalised junctions on streets.
          const w = Math.min(60, (this.block - 2 * off) * 0.5);
          put('1.8', n.x - dx * (off + w) + rx * (edgeLat + 1.2), n.z - dz * (off + w) + rz * (edgeLat + 1.2), face, 0, e);
        }
        // 5.16 pedestrian crossing at the zebra (right side).
        const cwk = n.crosswalks[opposite(dIn)];
        if (cwk && !cwk.signalized) put('5.16.1', sx + dx * 2.2, sz + dz * 2.2, face, 0, e);
      }
      // 3.1 at the mouth of one-way streets (entering against the flow).
      for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) {
        const road = n.arms[d];
        if (!road || !road.oneWay) continue;
        if (n.out[d]) {
          // One-way leaves this node in d: 5.5 at its start.
          const dx = DX[d], dz = DZ[d];
          const rx = -dz, rz = dx;
          const off = this.armOffset(n, d) + 3;
          put('5.5', n.x + dx * off + rx * (road.halfWidth + 1.2), n.z + dz * off + rz * (road.halfWidth + 1.2), opposite(d), 0);
        } else {
          // Traffic arrives here: entering in d is forbidden → 3.1 facing us.
          const dx = DX[d], dz = DZ[d];
          const rx = -dz, rz = dx;
          const off = this.armOffset(n, d) + 1;
          put('3.1', n.x + dx * off + rx * (road.halfWidth + 1.2), n.z + dz * off + rz * (road.halfWidth + 1.2), opposite(d), 0);
          put('3.1', n.x + dx * off - rx * (road.halfWidth + 1.2), n.z + dz * off - rz * (road.halfWidth + 1.2), opposite(d), 0);
        }
      }
    }
    // Edge signs at the start of the edge (after the junction).
    for (const e of this.edges) {
      const dx = DX[e.dir], dz = DZ[e.dir];
      const rx = -dz, rz = dx;
      const hw = e.road.halfWidth + 1.2;
      const base = this.armOffset(e.from, e.dir) + 12;
      let stack = 0;
      for (const s of e.signs) {
        if (s.startsWith('@')) continue;
        if (s === '1.20') {
          // warning 50 m before the mid-block zebra + 5.16 at it
          const len = Math.hypot(e.to.x - e.from.x, e.to.z - e.from.z);
          const at = len / 2 - 45;
          put('1.20', e.from.x + dx * at + rx * hw, e.from.z + dz * at + rz * hw, opposite(e.dir), 0, e);
          const z0 = len / 2 - CW / 2 - 1.5;
          put('5.16.1', e.from.x + dx * z0 + rx * hw, e.from.z + dz * z0 + rz * hw, opposite(e.dir), 0, e);
          continue;
        }
        put(s, e.from.x + dx * base + rx * hw, e.from.z + dz * base + rz * hw, opposite(e.dir), stack++, e);
      }
      if (e.signs.includes('3.24-40') || e.signs.includes('3.24-30T')) {
        const len = Math.hypot(e.to.x - e.from.x, e.to.z - e.from.z);
        const end = len - this.armOffset(e.to, opposite(e.dir)) - 8;
        put('3.25', e.from.x + dx * end + rx * hw, e.from.z + dz * end + rz * hw, opposite(e.dir), 0, e);
      }
    }
  }

  private computeConflicts(): void {
    const segInt = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): [number, number] | null => {
      const rX = bx - ax, rZ = bz - az, sX = dx - cx, sZ = dz - cz;
      const den = rX * sZ - rZ * sX;
      if (Math.abs(den) < 1e-9) return null;
      const t = ((cx - ax) * sZ - (cz - az) * sX) / den;
      const u = ((cx - ax) * rZ - (cz - az) * rX) / den;
      if (t < 0 || t > 1 || u < 0 || u > 1) return null;
      return [t, u];
    };
    for (const n of this.nodes) {
      const cs = n.connectors;
      for (let i = 0; i < cs.length; i++) {
        for (let j = i + 1; j < cs.length; j++) {
          const a = cs[i], b = cs[j];
          if (a.from === b.from) continue; // diverging — handled as siblings
          if (a.to === b.to) {
            a.conflicts.push({ c: b, sSelf: a.length - 1, sOther: b.length - 1, merge: true });
            b.conflicts.push({ c: a, sSelf: b.length - 1, sOther: a.length - 1, merge: true });
            continue;
          }
          let found = false;
          for (let p = 0; p < a.xs.length - 1 && !found; p++) {
            for (let q = 0; q < b.xs.length - 1 && !found; q++) {
              const r = segInt(a.xs[p], a.zs[p], a.xs[p + 1], a.zs[p + 1], b.xs[q], b.zs[q], b.xs[q + 1], b.zs[q + 1]);
              if (r) {
                const sa = a.cum[p] + r[0] * (a.cum[p + 1] - a.cum[p]);
                const sb = b.cum[q] + r[1] * (b.cum[q + 1] - b.cum[q]);
                a.conflicts.push({ c: b, sSelf: sa, sOther: sb, merge: false });
                b.conflicts.push({ c: a, sSelf: sb, sOther: sa, merge: false });
                found = true;
              }
            }
          }
          // Near-misses: paths that pass within 2.2 m (car widths) also conflict.
          if (!found) {
            let best = 1e9, sa = 0, sb = 0;
            for (let p = 0; p < a.xs.length; p++)
              for (let q = 0; q < b.xs.length; q++) {
                const d = Math.hypot(a.xs[p] - b.xs[q], a.zs[p] - b.zs[q]);
                if (d < best) (best = d), (sa = a.cum[p]), (sb = b.cum[q]);
              }
            if (best < 2.2) {
              a.conflicts.push({ c: b, sSelf: sa, sOther: sb, merge: false });
              b.conflicts.push({ c: a, sSelf: sb, sOther: sa, merge: false });
            }
          }
        }
      }
    }
  }

  /** s-intervals where each path runs over a crosswalk. */
  private computeCrossings(): void {
    const all: Path[] = [...this.lanes, ...this.connectors];
    for (const p of all) {
      for (const cw of this.crosswalks) {
        // Quick reject.
        const r = cw.halfLen + CW;
        let near = false;
        for (let k = 0; k < p.xs.length; k++) if (Math.abs(p.xs[k] - cw.cx) < r + 60 && Math.abs(p.zs[k] - cw.cz) < r + 60) near = true;
        if (!near) continue;
        let s0 = -1, s1 = -1, uSum = 0, cnt = 0;
        const step = 0.5;
        const pt = { x: 0, z: 0 };
        for (let s = 0; s <= p.length; s += step) {
          pathPoint(p, s, pt);
          const du = cw.axis === 'x' ? pt.x - cw.cx : pt.z - cw.cz; // along walking axis
          const dn = cw.axis === 'x' ? pt.z - cw.cz : pt.x - cw.cx; // across zebra
          if (Math.abs(dn) <= CW / 2 + 0.3 && Math.abs(du) <= cw.halfLen + 0.5) {
            if (s0 < 0) s0 = s;
            s1 = s;
            uSum += du;
            cnt++;
          }
        }
        if (s0 >= 0) p.xings.push({ cw, s0, s1, u: uSum / cnt });
      }
      p.xings.sort((a, b) => a.s0 - b.s0);
    }
  }

  // ─── Queries used by the player rule monitor / navigator ────────────────

  /** Node whose junction box contains (x,z). */
  nodeAt(x: number, z: number, margin = 0): Node | null {
    const i = Math.round((x - this.minX) / this.block);
    const j = Math.round((z - this.minZ) / this.block);
    const n = this.node(i, j);
    if (!n) return null;
    if (Math.abs(x - n.x) <= n.halfX + margin && Math.abs(z - n.z) <= n.halfZ + margin) return n;
    return null;
  }

  /** Road segment (outside junction boxes) under (x,z) and the lateral offset. */
  roadAt(x: number, z: number): { road: Road; lat: number; along: number } | null {
    const fi = (x - this.minX) / this.block;
    const fj = (z - this.minZ) / this.block;
    const i = Math.round(fi), j = Math.round(fj);
    // Horizontal road at row j?
    const nH = this.node(Math.floor(fi), j);
    if (nH && nH.arms[0] && fi >= 0 && fi <= this.nx - 1) {
      const road = nH.arms[0]!;
      const lat = z - nH.z;
      if (Math.abs(lat) <= road.halfWidth + SIDEWALK) return { road, lat, along: x - nH.x };
    }
    const nV = this.node(i, Math.floor(fj));
    if (nV && nV.arms[1] && fj >= 0 && fj <= this.ny - 1) {
      const road = nV.arms[1]!;
      const lat = -(x - nV.x); // right normal of dir 1 (south) is −x
      if (Math.abs(lat) <= road.halfWidth + SIDEWALK) return { road, lat, along: z - nV.z };
    }
    return null;
  }

  /** Movement permission at a junction for the player (signs + lanes). */
  isMovementAllowed(n: Node, dIn: Dir, mov: Movement): boolean {
    const a = n.allowed[dIn];
    if (a && !a.has(mov)) return false;
    if (mov === 'uturn') return true;
    const dOut = ((dIn + (mov === 'straight' ? 0 : mov === 'right' ? 1 : 3)) % 4) as Dir;
    return !!n.out[dOut];
  }

  update(dt: number): void {
    for (const n of this.nodes) {
      n.light?.update(dt);
      n.regulator?.update(dt);
    }
  }

  setLightsMode(mode: 'normal' | 'flash'): void {
    for (const n of this.nodes) if (n.light) n.light.mode = mode;
  }
  setRegulator(on: boolean): void {
    for (const n of this.nodes) if (n.regulator) n.regulator.enabled = on;
  }

  /** Graph data for the path-finding worker (structured-clone friendly). */
  serializeForRouting(): RoutingGraph {
    return {
      nodes: this.nodes.map((n) => ({ x: n.x, z: n.z })),
      edges: this.edges.map((e) => ({ from: e.from.id, to: e.to.id, dir: e.dir, len: Math.hypot(e.to.x - e.from.x, e.to.z - e.from.z), speed: e.lanes[0].speedLimit })),
      // Allowed transitions edge → edge through nodes (from connectors).
      turns: this.edges.map((e) => {
        const outs = new Set<number>();
        for (const l of e.lanes) for (const c of l.out) outs.add(c.to.edge.id);
        return [...outs];
      }),
    };
  }
}

export interface RoutingGraph {
  nodes: { x: number; z: number }[];
  edges: { from: number; to: number; dir: number; len: number; speed: number }[];
  turns: number[][];
}

const tmp = { x: 0, z: 0 };
/** Position at arc length s along a path (clamped). */
export function pathPoint(p: Path, s: number, out: { x: number; z: number } = tmp): { x: number; z: number } {
  const cum = p.cum;
  const n = cum.length;
  if (s <= 0) {
    out.x = p.xs[0];
    out.z = p.zs[0];
    return out;
  }
  if (s >= p.length) {
    out.x = p.xs[n - 1];
    out.z = p.zs[n - 1];
    return out;
  }
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (cum[m] <= s) lo = m;
    else hi = m;
  }
  const t = (s - cum[lo]) / (cum[hi] - cum[lo] || 1);
  out.x = p.xs[lo] + (p.xs[hi] - p.xs[lo]) * t;
  out.z = p.zs[lo] + (p.zs[hi] - p.zs[lo]) * t;
  return out;
}

/** Heading (yaw, radians, three.js convention: 0 = −z forward) at s. */
export function pathHeading(p: Path, s: number): number {
  const cum = p.cum;
  const n = cum.length;
  let k = 0;
  if (s >= p.length) k = n - 2;
  else {
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (cum[m] <= s) lo = m;
      else hi = m;
    }
    k = lo;
  }
  const dx = p.xs[k + 1] - p.xs[k];
  const dz = p.zs[k + 1] - p.zs[k];
  return Math.atan2(-dx, -dz);
}
