// EngineContext — renderer, scene, lighting, sky, day/night cycle, weather,
// resource disposal. WebGL2 is used because it is the only API available on
// every target (Android WebView, Electron, all browsers); the massive-traffic
// WebGPU compute benchmark lives in gpu/GpuTrafficBenchmark.ts.

import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

export type Quality = 'low' | 'medium' | 'high';
export type TimeOfDay = 'day' | 'evening' | 'night';
export type Weather = 'clear' | 'rain' | 'fog';

export class EngineContext {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  quality: Quality;
  time: TimeOfDay = 'day';
  weather: Weather = 'clear';
  /** 0 day … 1 night — drives emissive windows, street lights, headlights. */
  night = 0;
  private skyTex: THREE.Texture | null = null;
  private envTex: THREE.Texture | null = null;
  private rain: THREE.LineSegments | null = null;
  private rainPos: Float32Array | null = null;
  private listeners: (() => void)[] = [];
  private disposables = new Set<{ dispose(): void }>();
  onEnvChange: (() => void)[] = [];

  constructor(public canvas: HTMLCanvasElement, quality: Quality) {
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: quality !== 'low',
      powerPreference: 'high-performance',
      stencil: false,
    });
    const pr = quality === 'high' ? Math.min(devicePixelRatio, 2) : quality === 'medium' ? Math.min(devicePixelRatio, 1.5) : 1;
    this.renderer.setPixelRatio(pr);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = quality !== 'low';
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.PerspectiveCamera(62, 1, 0.1, 1600);
    this.hemi = new THREE.HemisphereLight(0xdbeafe, 0x5b5140, 0.9);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff4e0, 2.6);
    this.sun.position.set(-120, 200, 80);
    this.sun.castShadow = quality !== 'low';
    const sm = quality === 'high' ? 2048 : 1024;
    this.sun.shadow.mapSize.set(sm, sm);
    const sc = this.sun.shadow.camera;
    sc.left = -90;
    sc.right = 90;
    sc.top = 90;
    sc.bottom = -90;
    sc.near = 10;
    sc.far = 600;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.scene.fog = new THREE.Fog(0xcfd8e3, 250, 1100);

    const onResize = () => this.resize();
    window.addEventListener('resize', onResize);
    this.listeners.push(() => window.removeEventListener('resize', onResize));
    this.resize();
  }

  async loadSky(): Promise<void> {
    try {
      const hdr = await new HDRLoader().loadAsync('./assets/sky/sky_1k.hdr');
      hdr.mapping = THREE.EquirectangularReflectionMapping;
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.envTex = pmrem.fromEquirectangular(hdr).texture;
      pmrem.dispose();
      this.skyTex = hdr;
      this.track(hdr);
      this.track(this.envTex);
    } catch (e) {
      console.warn('sky load failed', e);
    }
    this.applyEnvironment();
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setTime(t: TimeOfDay): void {
    this.time = t;
    this.applyEnvironment();
  }
  setWeather(w: Weather): void {
    this.weather = w;
    this.applyEnvironment();
  }

  private applyEnvironment(): void {
    const s = this.scene;
    const t = this.time;
    this.night = t === 'night' ? 1 : t === 'evening' ? 0.55 : 0;
    const fog = s.fog as THREE.Fog;
    if (t === 'day') {
      s.background = this.skyTex ?? new THREE.Color(0x9cc3e8);
      s.environment = this.envTex;
      s.environmentIntensity = 0.9;
      s.backgroundIntensity = 1;
      this.sun.color.set(0xfff4e0);
      this.sun.intensity = 2.6;
      this.sun.position.set(-120, 200, 80);
      this.hemi.intensity = 0.8;
      this.hemi.color.set(0xdbeafe);
      fog.color.set(0xcfd8e3);
      this.renderer.toneMappingExposure = 1.0;
    } else if (t === 'evening') {
      s.background = this.skyTex ?? new THREE.Color(0xe9a36b);
      s.environment = this.envTex;
      s.environmentIntensity = 0.45;
      s.backgroundIntensity = 0.45;
      this.sun.color.set(0xffa860);
      this.sun.intensity = 1.5;
      this.sun.position.set(-220, 60, 40);
      this.hemi.intensity = 0.45;
      this.hemi.color.set(0xffc9a0);
      fog.color.set(0x9e8778);
      this.renderer.toneMappingExposure = 0.95;
    } else {
      s.background = new THREE.Color(0x070b16);
      s.environment = this.envTex;
      s.environmentIntensity = 0.06;
      this.sun.color.set(0x9fb4ff);
      this.sun.intensity = 0.18;
      this.sun.position.set(80, 200, -60);
      this.hemi.intensity = 0.16;
      this.hemi.color.set(0x5d6b9c);
      fog.color.set(0x0b1020);
      this.renderer.toneMappingExposure = 1.1;
    }
    const w = this.weather;
    const base = t === 'night' ? 0.55 : 1;
    if (w === 'fog') {
      fog.near = 5;
      fog.far = 140;
      if (t !== 'night') fog.color.set(0xbfc6cc);
      s.background = fog.color.clone();
      this.sun.intensity *= 0.45;
    } else if (w === 'rain') {
      fog.near = 20;
      fog.far = 420 * base;
      if (t === 'day') fog.color.set(0x8f99a4);
      s.backgroundIntensity = 0.55;
      this.sun.intensity *= 0.45;
      s.environmentIntensity *= 0.8;
    } else {
      fog.near = 250 * base;
      fog.far = 1100 * base;
    }
    this.setRain(w === 'rain');
    for (const f of this.onEnvChange) f();
  }

  private setRain(on: boolean): void {
    if (on && !this.rain) {
      const N = this.quality === 'low' ? 1500 : 4000;
      const pos = new Float32Array(N * 6);
      for (let i = 0; i < N; i++) {
        const x = (Math.random() - 0.5) * 80, y = Math.random() * 30, z = (Math.random() - 0.5) * 80;
        pos.set([x, y, z, x + 0.05, y - 0.7, z + 0.05], i * 6);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.LineBasicMaterial({ color: 0xaab4c0, transparent: true, opacity: 0.45 });
      this.rain = new THREE.LineSegments(geo, mat);
      this.rain.frustumCulled = false;
      this.rainPos = pos;
      this.scene.add(this.rain);
    } else if (!on && this.rain) {
      this.disposeObject(this.rain);
      this.rain = null;
      this.rainPos = null;
    }
  }

  /** Per-frame environment updates: shadow camera follows focus, rain falls. */
  update(dt: number, focus: THREE.Vector3): void {
    const off = this.sun.position.clone().sub(this.sun.target.position);
    this.sun.target.position.set(Math.round(focus.x / 4) * 4, 0, Math.round(focus.z / 4) * 4);
    this.sun.position.copy(this.sun.target.position).add(off);
    if (this.rain && this.rainPos) {
      const p = this.rainPos;
      const fall = 24 * dt;
      for (let i = 0; i < p.length; i += 6) {
        p[i + 1] -= fall;
        p[i + 4] -= fall;
        if (p[i + 1] < 0) {
          p[i + 1] += 30;
          p[i + 4] += 30;
        }
      }
      this.rain.position.set(focus.x, 0, focus.z);
      (this.rain.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  // ─── Resource management (strict dispose cascade) ────────────────────────

  track<T extends { dispose(): void }>(r: T): T {
    this.disposables.add(r);
    return r;
  }

  /** parent.remove(obj) → geometry.dispose() → material(s)/textures dispose. */
  disposeObject(obj: THREE.Object3D): void {
    obj.parent?.remove(obj);
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
      for (const mat of mats) {
        for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
        mat.dispose();
      }
      if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
    });
  }

  dispose(): void {
    for (const c of [...this.scene.children]) this.disposeObject(c);
    for (const d of this.disposables) d.dispose();
    this.disposables.clear();
    for (const l of this.listeners) l();
    this.renderer.dispose();
  }
}
