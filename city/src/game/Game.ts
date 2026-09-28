// Central game loop: owns the engine, world, traffic, pedestrians, player car,
// camera, input, audio, rule monitor, navigator and HUD, and runs the selected
// mode (free / missions / exam / spectate). Fixed-step simulation (60 Hz) with
// frame interpolation; the render side is decoupled and culls per frame.

import * as THREE from 'three';
import { EngineContext } from '../core/EngineContext';
import { Pedestrians } from '../traffic/Pedestrians';
import { CAR_COLORS, TrafficSim } from '../traffic/TrafficSim';
import { TrafficRenderer } from '../traffic/TrafficRenderer';
import { WorldBuilder } from '../world/WorldBuilder';
import { TrafficRuleGraph } from '../world/TrafficRuleGraph';
import { COBALT_AT, NEXIA2, VehiclePhysics } from '../vehicle/VehiclePhysics';
import { PlayerCar } from '../vehicle/PlayerCar';
import { CameraRig } from '../vehicle/CameraRig';
import { EngineAudio } from '../vehicle/EngineAudio';
import { InputManager } from '../input/InputManager';
import { Navigator } from './Navigator';
import { RuleMonitor } from './RuleMonitor';
import { Collisions } from './Collisions';
import { CityExam, TaxiMissions } from './Missions';
import { HUD } from '../ui/HUD';
import { GameMode, Settings } from '../ui/Menu';
import { EXAM_FAIL_POINTS } from '../rules/PddKnowledge';
import { getLang, t, uzLatToCyr } from '../i18n';

const CAP = 4096;

export interface GameResult {
  title: string;
  pass: boolean | null;
  lines: string[];
}

export class Game {
  engine: EngineContext;
  graph: TrafficRuleGraph;
  world: WorldBuilder;
  sim: TrafficSim;
  peds: Pedestrians;
  trafficRenderer: TrafficRenderer;
  car!: PlayerCar;
  phys!: VehiclePhysics;
  cameraRig: CameraRig;
  audio: EngineAudio;
  nav: Navigator;
  monitor!: RuleMonitor;
  collisions!: Collisions;
  hud: HUD;
  mode: GameMode = 'free';
  taxi: TaxiMissions | null = null;
  exam: CityExam | null = null;
  paused = false;
  running = false;
  onResult: ((r: GameResult) => void) | null = null;
  onCrash: (() => void) | null = null;
  private acc = 0;
  private raf = 0;
  private last = 0;
  private focus = new THREE.Vector3();
  private aiBuf: number[] = [];
  private fps = 60;
  private frameCount = 0;
  private fpsT = 0;
  private startEdge = 0;
  private examResultShown = false;

  constructor(private canvas: HTMLCanvasElement, private input: InputManager, private settings: Settings) {
    this.engine = new EngineContext(canvas, settings.quality);
    this.graph = new TrafficRuleGraph({ nx: 7, ny: 7, block: 130 });
    this.world = new WorldBuilder(this.graph, this.engine, settings.quality);
    this.sim = new TrafficSim(this.graph, CAP);
    this.peds = new Pedestrians(this.graph, this.sim, settings.quality === 'low' ? 250 : 600);
    this.trafficRenderer = new TrafficRenderer(this.sim, CAP);
    this.cameraRig = new CameraRig(this.engine.camera, canvas);
    this.audio = new EngineAudio();
    this.audio.setEnabled(settings.sound);
    this.nav = new Navigator(this.graph);
    this.hud = new HUD(input);
  }

  async load(): Promise<void> {
    await this.engine.loadSky();
    this.engine.setTime(this.settings.time);
    this.engine.setWeather(this.settings.weather);
    this.engine.scene.add(this.world.build());
    await this.trafficRenderer.load();
    this.engine.scene.add(this.trafficRenderer.group);
    this.engine.scene.add(this.peds.mesh);
    this.engine.scene.add(this.nav.group);
    this.graph.setLightsMode(this.settings.lights);
    this.graph.setRegulator(this.settings.officer);
    this.sim.weather = this.settings.weather;
    this.hud.minimap.setGraph(this.graph);
  }

  async startMode(mode: GameMode): Promise<void> {
    this.mode = mode;
    const spec = this.settings.car === 'cobalt_at' ? COBALT_AT : NEXIA2;
    this.phys = new VehiclePhysics(spec);
    this.phys.manualAssist = this.settings.manualAssist;
    this.car = new PlayerCar(this.phys, 0xdfe4ea);
    await this.car.load(this.settings.quality);
    this.car.onBlink = (on) => this.settings.sound && this.audio.tick(on ? 'on' : 'off');
    this.engine.scene.add(this.car.root);
    this.monitor = new RuleMonitor(this.graph, this.car, this.nav);
    this.monitor.examMode = mode === 'exam';
    this.collisions = new Collisions(this.phys, this.sim, this.peds, this.world);

    // Traffic demand is calibrated from lane-kilometres, independent of
    // renderer quality. Quality only controls representation/culling.
    const n = this.sim.calibratedCount(this.settings.density, mode === 'spectate');
    this.sim.setCount(n);
    this.peds.setCount(this.settings.pedestrians ? (this.settings.quality === 'low' ? 120 : 400) : 0);
    // Warm the same control/pedestrian/traffic ordering used by live ticks.
    // This avoids filling a city against frozen red lights and empty zebras.
    const warmStep = 1 / 30;
    for (let i = 0; i < 240; i++) {
      this.graph.update(warmStep);
      this.peds.update(warmStep);
      this.sim.step(warmStep);
    }

    this.trafficRenderer.setNight(this.engine.night);
    this.monitor.setDark(this.engine.night > 0.5 || this.settings.weather === 'fog');

    // Place the player on a lane.
    this.placePlayer();

    const dark = this.engine.night > 0.5 || this.settings.weather === 'fog';
    if (dark) this.car.headlights = true;

    if (mode === 'missions') {
      this.taxi = new TaxiMissions(this.graph, this.nav);
      this.engine.scene.add(this.taxi.ring);
      await this.waitNav();
      await this.taxi.begin(this.startEdge);
    } else if (mode === 'exam') {
      this.exam = new CityExam(this.graph, this.nav);
      this.engine.scene.add(this.exam.ring);
      await this.waitNav();
      await this.exam.begin(this.startEdge);
      this.examResultShown = false;
    }
    this.hud.showPenalty(mode !== 'spectate');
    this.monitor.onViolation = (v) => this.hud.flashViolation(v);
    this.running = true;
    this.paused = false;
    this.last = performance.now();
    this.loop(this.last);
  }

  private async waitNav(): Promise<void> {
    let tries = 0;
    while (!this.nav.ready && tries++ < 200) await new Promise((r) => setTimeout(r, 10));
  }

  private placePlayer(): void {
    // Choose a lane on a two-way street away from junctions, facing along it.
    const lanes = this.graph.lanes.filter((l) => !l.edge.road.oneWay && l.length > 60);
    const lane = lanes[Math.floor(Math.random() * lanes.length)] ?? this.graph.lanes[0];
    const s = lane.length * 0.4;
    const t2 = s / lane.length;
    const x = lane.xs[0] + (lane.xs[1] - lane.xs[0]) * t2;
    const z = lane.zs[0] + (lane.zs[1] - lane.zs[0]) * t2;
    const yaw = Math.atan2(-(lane.xs[1] - lane.xs[0]), -(lane.zs[1] - lane.zs[0]));
    this.phys.reset(x, z, yaw);
    this.phys.prepareForDriving();
    // Rehome AI state, including reservations and lane-change occupancy; merely
    // zeroing speed leaves canonical overlaps and an immediate collision.
    this.sim.clearPlayerArea(x, z, 20);
    this.startEdge = this.nav.currentEdge(x, z, yaw);
    if (this.startEdge < 0) this.startEdge = lane.edge.id;
  }

  resume(): void {
    if (!this.running) return;
    this.paused = false;
    this.last = performance.now();
    this.audio.resume();
    this.loop(this.last);
  }
  pause(): void {
    this.paused = true;
    cancelAnimationFrame(this.raf);
    this.audio.horn(false);
  }

  private loop = (now: number): void => {
    if (this.paused || !this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.frameCount++;
    this.fpsT += dt;
    if (this.fpsT >= 0.5) {
      this.fps = this.frameCount / this.fpsT;
      this.frameCount = 0;
      this.fpsT = 0;
    }
    this.handleInput();
    // Fixed-step simulation.
    this.acc += dt;
    const STEP = 1 / 60;
    let steps = 0;
    while (this.acc >= STEP && steps < 4) {
      this.simulate(STEP);
      this.acc -= STEP;
      steps++;
    }
    this.render(dt);
    this.input.clearEdges();
  };

  private handleInput(): void {
    const inp = this.input;
    inp.update();
    if (this.mode === 'spectate') {
      if (inp.take('cycleCamera')) this.cameraRig.cycle();
      if (inp.take('toggleMap')) this.hud.minimap.toggleFullscreen();
      return;
    }
    if (inp.take('toggleIndicatorLeft')) this.car.indicator = this.car.indicator === -1 ? 0 : -1;
    if (inp.take('toggleIndicatorRight')) this.car.indicator = this.car.indicator === 1 ? 0 : 1;
    if (inp.take('toggleHazard')) this.car.hazard = !this.car.hazard;
    if (inp.take('toggleHeadlights')) this.car.headlights = !this.car.headlights;
    if (inp.take('toggleSeatbelt')) this.car.seatbelt = !this.car.seatbelt;
    if (inp.take('cycleCamera')) this.cameraRig.cycle();
    if (inp.take('gearUp')) this.phys.shiftUp();
    if (inp.take('gearDown')) this.phys.shiftDown();
    if (inp.take('selectDrive')) this.phys.selectDrive();
    if (inp.take('selectReverse')) this.phys.selectReverse();
    if (inp.take('selectPark')) this.phys.selectPark();
    if (inp.take('neutral')) this.phys.neutral();
    if (inp.take('startEngine')) {
      this.phys.start();
      this.audio.resume();
    }
    if (inp.take('respawn') && this.mode !== 'exam') this.placePlayerKeepMode();
    if (inp.take('toggleMap')) this.hud.minimap.toggleFullscreen();
    this.audio.horn(inp.state.horn);
  }

  private placePlayerKeepMode(): void {
    this.placePlayer();
  }

  private simulate(dt: number): void {
    this.graph.update(dt);
    // Feed the player into the AI as an obstacle.
    if (this.mode !== 'spectate') {
      const P = this.sim.player;
      P.active = true;
      P.x = this.phys.x;
      P.z = this.phys.z;
      P.vx = this.phys.vxWorld;
      P.vz = this.phys.vzWorld;
      P.yaw = this.phys.yaw;
      P.halfLen = this.phys.spec.frontHalfLen;
      P.halfWid = this.phys.spec.halfWidth;
      const node = this.graph.nodeAt(this.phys.x, this.phys.z, 22);
      P.node = node;
      if (node) {
        const fx = -Math.sin(this.phys.yaw), fz = -Math.cos(this.phys.yaw);
        P.dIn = (Math.abs(fx) > Math.abs(fz) ? (fx >= 0 ? 0 : 2) : (fz >= 0 ? 1 : 3)) as any;
        const d = Math.hypot(node.x - this.phys.x, node.z - this.phys.z);
        P.timeToNode = d / Math.max(this.phys.speed, 2);
      } else P.dIn = -1;
    } else this.sim.player.active = false;

    // Publish pedestrian occupancy before atomic vehicle admission so neither
    // side enters a crossing from a stale empty snapshot.
    this.peds.update(dt);
    this.sim.step(dt);

    if (this.mode !== 'spectate') {
      this.phys.grip = this.settings.weather === 'rain' ? 0.75 : this.settings.weather === 'fog' ? 0.92 : 1;
      this.phys.step(dt, {
        throttle: this.input.state.throttle,
        brake: this.input.state.brake,
        steer: this.input.state.steer,
        clutch: this.input.state.clutch,
        handbrake: this.input.state.handbrake,
      });
      const col = this.collisions.update(dt);
      if (col.impact > 4 && (col.ai || col.ped)) {
        this.audio.crash();
        this.onCrash?.();
      }
      // Only a moving, transverse approach can constitute conflicting traffic;
      // same-lane followers and parked neighbours must not cause yield fines.
      const nearby = this.sim.near(this.phys.x, this.phys.z, 18, this.aiBuf);
      const pfx = -Math.sin(this.phys.yaw), pfz = -Math.cos(this.phys.yaw);
      const crossTraffic = nearby.some((i) => {
        if (this.sim.v[i] < 1.2) return false;
        const afx = -Math.sin(this.sim.yaw[i]), afz = -Math.cos(this.sim.yaw[i]);
        return Math.abs(pfx * afx + pfz * afz) < 0.62;
      });
      this.monitor.setCrossTraffic(crossTraffic);
      this.monitor.update(dt, col.ai, col.ped, col.obj);
      this.audio.update(this.phys);
    }
    this.focus.set(this.mode === 'spectate' ? this.engine.camera.position.x : this.phys.x, 0, this.mode === 'spectate' ? this.engine.camera.position.z : this.phys.z);
  }

  private async render(dt: number): Promise<void> {
    if (this.mode !== 'spectate') {
      this.cameraRig.update(dt, this.car);
      this.car.update(dt, this.input.state.brake > 0.05 || this.phys.kmh < 0.5);
    } else {
      this.spectateCamera(dt);
    }
    this.engine.update(dt, this.focus);
    this.world.update(dt);
    const wView = this.settings.weather === 'fog' ? 0.4 : this.settings.weather === 'rain' ? 0.8 : 1;
    this.trafficRenderer.update(dt, this.engine.camera, wView);
    this.peds.render(this.engine.camera.position.x, this.engine.camera.position.z, this.settings.weather === 'fog' ? 90 : 200);
    this.engine.render();

    // HUD.
    if (this.mode !== 'spectate') {
      const blink = this.car.blinkLit;
      this.hud.update(this.car, this.phys, this.monitor.total, this.monitor.fines, this.monitor.regime, this.monitor.currentLimit, blink);
      await this.updateMissions();
    }
    this.hud.minimap.route = this.nav.ribbon ? this.routePoly() : null;
    this.hud.minimap.markers = this.taxi?.markers() ?? this.exam?.markers() ?? [];
    this.hud.minimap.render(this.sim, this.mode === 'spectate' ? this.engine.camera.position.x : this.phys.x, this.mode === 'spectate' ? this.engine.camera.position.z : this.phys.z, this.mode === 'spectate' ? 0 : this.phys.yaw);
    this.updateStats();
  }

  private routeCache: Float32Array | null = null;
  private routeRef: number[] | null = null;
  private routePoly(): Float32Array | null {
    if (!this.nav.route) {
      this.routeRef = null;
      this.routeCache = null;
      return null;
    }
    if (this.routeRef === this.nav.route && this.routeCache) return this.routeCache;
    const pts: number[] = [];
    for (const e of this.nav.route) {
      const ed = this.graph.edges[e];
      pts.push(ed.from.x, ed.from.z, ed.to.x, ed.to.z);
    }
    this.routeRef = this.nav.route;
    this.routeCache = new Float32Array(pts);
    return this.routeCache;
  }

  private async updateMissions(): Promise<void> {
    const carEdge = this.nav.currentEdge(this.phys.x, this.phys.z, this.phys.yaw);
    const m = this.nav.nextManoeuvre(carEdge < 0 ? this.startEdge : carEdge, this.phys.x, this.phys.z);
    if (this.mode === 'missions' && this.taxi) {
      this.hud.setNav(m);
      const msg = await this.taxi.update(carEdge, this.phys.x, this.phys.z, this.phys.speed, this.monitor.fines);
      if (msg) this.hud.toast(msg);
      if (this.taxi.stage === 'done') {
        // Auto-start next fare.
        this.taxi.begin(carEdge < 0 ? this.startEdge : carEdge);
      }
      this.hud.setMission(`${t('fare')}: ${this.taxi.fare.toLocaleString()} · ${t('fine_total')}: ${this.monitor.fines.toLocaleString()} · ${t('money')}: ${this.taxi.totalEarned.toLocaleString()}`);
    } else if (this.mode === 'exam' && this.exam) {
      this.hud.setNav(m);
      await this.exam.update(carEdge, this.phys.x, this.phys.z, this.phys.speed);
      this.hud.setMission(`${t('play_exam')} · ${Math.round(this.exam.elapsed())}s · ${t('penalty')}: ${this.monitor.total}/${EXAM_FAIL_POINTS}`);
      if (!this.examResultShown && (this.exam.finished || this.monitor.failed)) {
        this.examResultShown = true;
        this.finishExam();
      }
    } else {
      this.hud.setNav(null);
      this.hud.setMission(null);
    }
  }

  private finishExam(): void {
    if (!this.exam) return;
    this.pause();
    const pass = !this.monitor.failed && this.exam.finished;
    const lines = [
      `${t('penalty')}: ${this.monitor.total} ${t('points')}`,
      `${t('time')}: ${Math.round(this.exam.elapsed())}s`,
      ...(this.monitor.log.length ? this.monitor.log.map((l) => `+${l.def.points * l.count} — ${(getLang() === 'ru' ? l.def.text.ru : l.def.text.uz)}${l.count > 1 ? ' ×' + l.count : ''}`) : [t('no_violations')]),
    ];
    this.onResult?.({ title: pass ? t('exam_passed') : t('exam_failed'), pass, lines });
  }

  private spectateCamera(dt: number): void {
    // Slow cinematic orbit above the city following busy junctions.
    const g = this.graph;
    const t2 = performance.now() / 1000;
    const cx = (g.minX + g.maxX) / 2, cz = (g.minZ + g.maxZ) / 2;
    const R = 260 + Math.sin(t2 * 0.05) * 120;
    const cam = this.engine.camera;
    cam.position.set(cx + Math.cos(t2 * 0.06) * R, 120 + Math.sin(t2 * 0.04) * 40, cz + Math.sin(t2 * 0.06) * R);
    cam.lookAt(cx, 0, cz);
    this.focus.set(cx, 0, cz);
  }

  private updateStats(): void {
    const metrics = this.sim.getMetrics();
    const rows = [
      `${t('fps')}: <b>${this.fps.toFixed(0)}</b>`,
      `${t('cars')}: <b>${metrics.activeVehicles}/${metrics.targetVehicles}</b> <small>(${this.trafficRenderer.visibleClose}+${this.trafficRenderer.visibleMid}+${this.trafficRenderer.visibleFar})</small>`,
      `${t('avg_speed')}: <b>${this.sim.avgSpeedKmh().toFixed(0)}</b> km/h`,
      `${t('stopped_fraction')}: <b>${Math.round(metrics.stoppedFraction * 100)}%</b>`,
      `${t('reservations')}: <b>${metrics.activeReservations}</b>`,
      `${t('throughput')}: <b>${this.sim.junctionPasses}</b>`,
    ];
    this.hud.setStats(rows.join(' · '));
    if (this.mode !== 'spectate' && this.phys) {
      // Machine-readable telemetry for wrapper diagnostics and release smoke
      // checks; no internal object graph is exposed globally.
      this.canvas.dataset.speed = this.phys.kmh.toFixed(2);
      this.canvas.dataset.forwardSpeed = this.phys.vx.toFixed(3);
      this.canvas.dataset.rpm = this.phys.rpm.toFixed(0);
      this.canvas.dataset.throttle = this.input.state.throttle.toFixed(2);
      this.canvas.dataset.clutch = this.phys.clutchEngagement.toFixed(2);
      this.canvas.dataset.acceleration = this.phys.ax.toFixed(3);
      this.canvas.dataset.brake = this.input.state.brake.toFixed(2);
      this.canvas.dataset.handbrake = String(this.input.state.handbrake);
      this.canvas.dataset.position = `${this.phys.x.toFixed(2)},${this.phys.z.toFixed(2)}`;
      this.canvas.dataset.gear = this.phys.gearLabel();
    }
  }

  restart(): void {
    this.dispose(false);
  }

  get hudRoot(): HTMLElement {
    return this.hud.root;
  }

  dispose(full = true): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.audio.horn(false);
    this.trafficRenderer.dispose();
    this.nav.dispose();
    this.car?.dispose();
    this.hud.dispose();
    this.cameraRig.dispose();
    if (full) {
      this.engine.dispose();
      this.audio.dispose();
    }
  }
}
