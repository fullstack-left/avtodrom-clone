// High-quality instanced rendering for autonomous traffic.
//
// Three stable tiers are kept per vehicle instead of turning a car into two
// intersecting boxes at a fixed distance:
//   • close: the complete Avtodrom GLB (body, wheels, cabin and interior),
//   • mid: the validated ~1.6k-triangle authored GLB,
//   • far: a coherent 54-triangle sedan silhouette with a separate glass/wheel
//          shell (not two overlapping boxes).
//
// Source primitives are merged by an explicit semantic role. Paint alone uses
// per-instance colour; glass, chrome and lamps retain appropriate materials.
// LOD hysteresis prevents popping, only the body casts a shadow, and all moving
// lights are one compact instanced batch.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TrafficSim } from './TrafficSim';

type RenderRole = 'paint' | 'glass' | 'metal' | 'dark' | 'interior' | 'rubber' | 'red' | 'amber' | 'clear';

interface TierBatch {
  meshes: THREE.InstancedMesh[];
  matrix: THREE.InstancedBufferAttribute;
  paint: THREE.InstancedBufferAttribute;
  count: number;
}

interface VehicleBatches {
  close: TierBatch;
  mid: TierBatch;
}

interface FarBatch {
  body: THREE.InstancedMesh;
  detail: THREE.InstancedMesh;
  matrix: THREE.InstancedBufferAttribute;
  paint: THREE.InstancedBufferAttribute;
  count: number;
}

interface NightMaterial {
  material: THREE.MeshStandardMaterial;
  kind: 'red' | 'amber' | 'clear';
}

const FULL_FILES = ['./assets/cars/nexia2.glb', './assets/cars/cobalt.glb'];
const MID_FILES = ['./assets/cars/nexia2_lod.glb', './assets/cars/cobalt_lod.glb'];
const TMP_COLOR = new THREE.Color();

export class TrafficRenderer {
  group = new THREE.Group();
  private models: VehicleBatches[] = [];
  private far!: FarBatch;
  private lamps!: THREE.InstancedMesh;
  private pools!: THREE.InstancedMesh;
  private lodState: Uint8Array;
  private nightMaterials: NightMaterial[] = [];
  private ownedTextures: THREE.Texture[] = [];
  private frustum = new THREE.Frustum();
  private projectionView = new THREE.Matrix4();
  private sphere = new THREE.Sphere(new THREE.Vector3(), 3.0);
  private t = 0;

  /** Hysteresis thresholds (metres at normal visibility). */
  closeIn = 68;
  closeOut = 88;
  midIn = 275;
  midOut = 340;
  maxDist = 620;
  night = 0;
  visibleNear = 0;
  visibleFar = 0;
  visibleClose = 0;
  visibleMid = 0;

  constructor(private sim: TrafficSim, private cap: number) {
    this.lodState = new Uint8Array(cap);
    this.lodState.fill(1);
    this.group.name = 'AI traffic renderer';
  }

  async load(): Promise<void> {
    const loader = new GLTFLoader();
    for (let model = 0; model < FULL_FILES.length; model++) {
      // Loading is sequential per model to avoid a short but large decode peak
      // on mobile WebViews.
      const close = await this.loadTier(loader, FULL_FILES[model], true);
      const mid = await this.loadTier(loader, MID_FILES[model], false);
      this.models.push({ close, mid });
    }
    this.far = this.buildFarTier();
    this.buildLampBatch();
    this.buildHeadlightPools();
    this.setNight(this.night);
  }

  /**
   * Flatten an authored GLB into one instanced draw per semantic role. Full-car
   * wheel/node transforms are baked once into each role geometry, never into
   * per-frame instance matrices.
   */
  private async loadTier(loader: GLTFLoader, file: string, close: boolean): Promise<TierBatch> {
    const gltf = await loader.loadAsync(file);
    gltf.scene.updateMatrixWorld(true);
    const byRole = new Map<RenderRole, THREE.BufferGeometry[]>();

    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || /collision|hull|debug/i.test(mesh.name)) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      // glTFLoader emits one Mesh per primitive for these assets. The guarded
      // fallback keeps a future multi-material primitive visible and valid.
      const mat = mats[0] as THREE.MeshStandardMaterial | undefined;
      const role = materialRole(mesh.name, mat?.name ?? '');
      let geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      // Runtime roles use solid colours, so normalise attributes before merge.
      // Full GLB primitives differ in UV/tangent/color sets and indexed state;
      // BufferGeometryUtils correctly rejects such incompatible inputs.
      if (geo.index) {
        const nonIndexed = geo.toNonIndexed();
        geo.dispose();
        geo = nonIndexed;
      }
      for (const name of Object.keys(geo.attributes)) {
        if (name !== 'position' && name !== 'normal') geo.deleteAttribute(name);
      }
      if (!geo.getAttribute('normal')) geo.computeVertexNormals();
      const list = byRole.get(role) ?? [];
      list.push(geo);
      byRole.set(role, list);
    });

    const matrix = dynamicAttribute(this.cap, 16);
    const paint = dynamicAttribute(this.cap, 3);
    const meshes: THREE.InstancedMesh[] = [];
    for (const role of ROLE_ORDER) {
      const geos = byRole.get(role);
      if (!geos?.length) continue;
      const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      if (!merged) {
        for (const g of geos) g.dispose();
        continue;
      }
      if (geos.length > 1) for (const g of geos) g.dispose();
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      const material = this.materialFor(role, close);
      const inst = new THREE.InstancedMesh(merged, material, this.cap);
      inst.name = `${close ? 'close' : 'mid'}:${role}:${file.split('/').pop()}`;
      inst.instanceMatrix = matrix;
      if (role === 'paint') inst.instanceColor = paint;
      inst.count = 0;
      inst.frustumCulled = false; // renderer performs per-agent culling
      inst.receiveShadow = close && role === 'paint';
      inst.castShadow = role === 'paint'; // one silhouette shadow draw per tier
      if (role === 'glass') inst.renderOrder = 4;
      meshes.push(inst);
      this.group.add(inst);
    }

    // We cloned all runtime geometry/material state. Release loader-owned GPU
    // resources now instead of retaining an invisible second model copy.
    disposeSourceScene(gltf.scene);
    return { meshes, matrix, paint, count: 0 };
  }

  private materialFor(role: RenderRole, close: boolean): THREE.Material {
    switch (role) {
      case 'paint':
        return new THREE.MeshStandardMaterial({
          color: 0xffffff,
          roughness: close ? 0.3 : 0.42,
          metalness: close ? 0.48 : 0.32,
          envMapIntensity: close ? 1.05 : 0.75,
        });
      case 'glass': {
        // Only the small close/mid vehicle set is transparent. Depth writes are
        // disabled so the window shell cannot erase cabin/body surfaces.
        const mat = new THREE.MeshPhysicalMaterial({
          color: close ? 0x7890a5 : 0x425566,
          roughness: 0.12,
          metalness: 0.05,
          transparent: true,
          opacity: close ? 0.46 : 0.62,
          depthWrite: false,
          side: THREE.FrontSide,
          clearcoat: 0.45,
          clearcoatRoughness: 0.18,
          envMapIntensity: 1.15,
        });
        return mat;
      }
      case 'metal':
        return new THREE.MeshStandardMaterial({ color: 0xb9c0c7, roughness: 0.24, metalness: 0.92, envMapIntensity: 1.25 });
      case 'rubber':
        return new THREE.MeshStandardMaterial({ color: 0x111317, roughness: 0.9, metalness: 0 });
      case 'interior':
        return new THREE.MeshStandardMaterial({ color: 0x252a31, roughness: 0.78, metalness: 0.03 });
      case 'red': {
        const mat = new THREE.MeshStandardMaterial({ color: 0x7d0909, roughness: 0.3, metalness: 0, emissive: 0xff1608, emissiveIntensity: 0.08 });
        this.nightMaterials.push({ material: mat, kind: 'red' });
        return mat;
      }
      case 'amber': {
        const mat = new THREE.MeshStandardMaterial({ color: 0xb54708, roughness: 0.28, emissive: 0xff8100, emissiveIntensity: 0.05 });
        this.nightMaterials.push({ material: mat, kind: 'amber' });
        return mat;
      }
      case 'clear': {
        const mat = new THREE.MeshStandardMaterial({ color: 0xe6edf3, roughness: 0.18, metalness: 0.08, emissive: 0xfff4d8, emissiveIntensity: 0 });
        this.nightMaterials.push({ material: mat, kind: 'clear' });
        return mat;
      }
      default:
        return new THREE.MeshStandardMaterial({ color: 0x23272d, roughness: 0.65, metalness: 0.18 });
    }
  }

  /** Coherent far sedan body + dark cabin/wheels, each a single draw call. */
  private buildFarTier(): FarBatch {
    const bodyGeo = loftGeometry([
      { z: -2.26, w: 0.62, y0: 0.24, y1: 0.56 },
      { z: -1.86, w: 0.82, y0: 0.18, y1: 0.76 },
      { z: 1.72, w: 0.84, y0: 0.18, y1: 0.8 },
      { z: 2.25, w: 0.66, y0: 0.25, y1: 0.58 },
    ]);
    const cabin = loftGeometry([
      { z: -1.28, w: 0.5, y0: 0.73, y1: 0.92 },
      { z: -0.72, w: 0.68, y0: 0.76, y1: 1.42 },
      { z: 0.9, w: 0.67, y0: 0.78, y1: 1.4 },
      { z: 1.38, w: 0.52, y0: 0.76, y1: 0.88 },
    ]);
    const wheelParts: THREE.BufferGeometry[] = [];
    for (const x of [-0.84, 0.84])
      for (const z of [-1.35, 1.35]) {
        const wheel = new THREE.CylinderGeometry(0.3, 0.3, 0.15, 8).rotateZ(Math.PI / 2).translate(x, 0.32, z);
        wheel.deleteAttribute('uv');
        wheelParts.push(wheel);
      }
    const detailGeo = mergeGeometries([cabin, ...wheelParts], false)!;
    cabin.dispose();
    for (const g of wheelParts) g.dispose();

    const matrix = dynamicAttribute(this.cap, 16);
    const paint = dynamicAttribute(this.cap, 3);
    const body = new THREE.InstancedMesh(bodyGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.22 }), this.cap);
    body.instanceMatrix = matrix;
    body.instanceColor = paint;
    body.count = 0;
    body.frustumCulled = false;
    body.name = 'far:coherent-body';
    const detail = new THREE.InstancedMesh(detailGeo, new THREE.MeshStandardMaterial({ color: 0x17202a, roughness: 0.48, metalness: 0.18 }), this.cap);
    detail.instanceMatrix = matrix;
    detail.count = 0;
    detail.frustumCulled = false;
    detail.name = 'far:cabin-wheels';
    this.group.add(body, detail);
    return { body, detail, matrix, paint, count: 0 };
  }

  /** One batch carries headlights, tail/brake lamps and indicators. */
  private buildLampBatch(): void {
    const geo = new THREE.BoxGeometry(0.2, 0.12, 0.055);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    this.lamps = new THREE.InstancedMesh(geo, mat, this.cap * 6);
    this.lamps.name = 'AI dynamic lamps';
    this.lamps.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.lamps.setColorAt(0, new THREE.Color(1, 1, 1));
    this.lamps.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.lamps.frustumCulled = false;
    this.lamps.count = 0;
    this.lamps.renderOrder = 5;
    this.group.add(this.lamps);
  }

  /** Soft, density-limited fake light pools avoid hundreds of real SpotLights. */
  private buildHeadlightPools(): void {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createRadialGradient(32, 112, 3, 32, 68, 70);
    gradient.addColorStop(0, 'rgba(255,247,225,0.8)');
    gradient.addColorStop(0.45, 'rgba(255,239,205,0.2)');
    gradient.addColorStop(1, 'rgba(255,239,205,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 128);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.ownedTextures.push(tex);
    const geo = new THREE.PlaneGeometry(3.8, 10.5).rotateX(-Math.PI / 2).translate(0, 0.035, -7.4);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      color: 0xffefd0,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0.28,
      toneMapped: false,
    });
    this.pools = new THREE.InstancedMesh(geo, mat, this.cap);
    this.pools.name = 'AI headlight pools';
    this.pools.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.pools.frustumCulled = false;
    this.pools.count = 0;
    this.pools.renderOrder = 2;
    this.group.add(this.pools);
  }

  setNight(n: number): void {
    this.night = n;
    for (const entry of this.nightMaterials) {
      const scale = entry.kind === 'clear' ? 1.25 : entry.kind === 'red' ? 0.42 : 0.24;
      entry.material.emissiveIntensity = n > 0.25 ? n * scale : entry.kind === 'red' ? 0.08 : 0.02;
    }
  }

  update(dt: number, camera: THREE.PerspectiveCamera, weatherView = 1): void {
    this.t += dt;
    const sim = this.sim;
    this.projectionView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projectionView);
    const cx = camera.position.x;
    const cz = camera.position.z;
    const view = Math.max(0.34, Math.min(1, weatherView));
    const closeIn2 = square(this.closeIn * view);
    const closeOut2 = square(this.closeOut * view);
    const midIn2 = square(this.midIn * view);
    const midOut2 = square(this.midOut * view);
    const max2 = square(this.maxDist * view); // visibility factor must be squared

    for (const model of this.models) {
      model.close.count = 0;
      model.mid.count = 0;
    }
    this.far.count = 0;

    const lampMatrices = this.lamps.instanceMatrix.array as Float32Array;
    const lampColors = this.lamps.instanceColor!.array as Float32Array;
    const poolMatrices = this.pools.instanceMatrix.array as Float32Array;
    let lampCount = 0;
    let poolCount = 0;
    let closeCount = 0;
    let midCount = 0;
    let farCount = 0;
    const blinkOn = this.t % 0.667 < 0.36; // UNECE 90 flashes/minute
    const night = this.night > 0.25;

    for (let i = 0; i < sim.count; i++) {
      const x = sim.x[i];
      const z = sim.z[i];
      const dx = x - cx;
      const dz = z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > max2) continue;
      this.sphere.center.set(x, 0.85, z);
      if (!this.frustum.intersectsSphere(this.sphere)) continue;

      let tier = this.lodState[i];
      if (tier === 0 && d2 > closeOut2) tier = 1;
      else if (tier !== 0 && d2 < closeIn2) tier = 0;
      if (tier === 1 && d2 > midOut2) tier = 2;
      else if (tier === 2 && d2 < midIn2) tier = 1;
      this.lodState[i] = tier;

      const yaw = sim.yaw[i];
      const cos = Math.cos(yaw);
      const sin = Math.sin(yaw);
      TMP_COLOR.setHex(sim.color[i], THREE.SRGBColorSpace);
      if (tier === 0) {
        writeTier(this.models[sim.model[i]].close, cos, sin, x, z, TMP_COLOR);
        closeCount++;
      } else if (tier === 1) {
        writeTier(this.models[sim.model[i]].mid, cos, sin, x, z, TMP_COLOR);
        midCount++;
      } else {
        const k = this.far.count++;
        writeMatrix(this.far.matrix.array as Float32Array, k * 16, cos, sin, x, 0, z);
        writeColor(this.far.paint.array as Float32Array, k, TMP_COLOR.r, TMP_COLOR.g, TMP_COLOR.b);
        farCount++;
      }

      // Explicit light geometry gives both vehicle models identical, correctly
      // located lamps even when an authored LOD omits a material primitive.
      if (d2 < square(260 * view)) {
        const braking = sim.brake[i] !== 0;
        if (night || braking) {
          const red = braking ? 3.8 : 1.25;
          lampCount = pushPair(lampMatrices, lampColors, lampCount, this.cap * 6, cos, sin, x, z, 0.69, 2.16, 0.61, red, 0.025, 0.012);
        }
        if (night) {
          lampCount = pushPair(lampMatrices, lampColors, lampCount, this.cap * 6, cos, sin, x, z, 0.7, -2.15, 0.62, 3.5, 2.75, 1.9);
          if (d2 < square(135 * view) && poolCount < this.cap) {
            writeMatrix(poolMatrices, poolCount * 16, cos, sin, x, 0, z);
            poolCount++;
          }
        }
        const indicator = sim.indicator[i];
        if (indicator !== 0 && blinkOn && lampCount + 2 <= this.cap * 6) {
          const side = indicator > 0 ? 0.78 : -0.78;
          lampCount = pushSingle(lampMatrices, lampColors, lampCount, cos, sin, x, z, side, 0.7, -2.17, 3.8, 1.05, 0.035);
          lampCount = pushSingle(lampMatrices, lampColors, lampCount, cos, sin, x, z, side, 0.7, 2.18, 3.8, 1.05, 0.035);
        }
      }
    }

    for (const model of this.models) {
      updateTier(model.close);
      updateTier(model.mid);
    }
    this.far.body.count = this.far.detail.count = this.far.count;
    this.far.matrix.needsUpdate = true;
    this.far.paint.needsUpdate = true;

    this.lamps.count = lampCount;
    this.lamps.visible = lampCount > 0;
    this.lamps.instanceMatrix.needsUpdate = true;
    this.lamps.instanceColor!.needsUpdate = true;
    this.pools.count = poolCount;
    this.pools.visible = poolCount > 0;
    this.pools.instanceMatrix.needsUpdate = true;

    this.visibleClose = closeCount;
    this.visibleMid = midCount;
    this.visibleNear = closeCount + midCount;
    this.visibleFar = farCount;
  }

  dispose(): void {
    this.group.parent?.remove(this.group);
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      geometries.add(mesh.geometry);
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of list) materials.add(mat);
    });
    for (const g of geometries) g.dispose();
    for (const m of materials) m.dispose();
    for (const t of this.ownedTextures) t.dispose();
    this.ownedTextures.length = 0;
    this.models.length = 0;
    this.nightMaterials.length = 0;
  }
}

const ROLE_ORDER: RenderRole[] = ['paint', 'dark', 'metal', 'rubber', 'interior', 'red', 'amber', 'clear', 'glass'];

function materialRole(meshName: string, materialName: string): RenderRole {
  const n = `${meshName} ${materialName}`.toLowerCase();
  if (/paint|bodypaint|kuzov/.test(n)) return 'paint';
  if (/window|glass|windscreen|windshield|mirror/.test(n) && !/lamp/.test(n)) return 'glass';
  if (/turn|orange|amber/.test(n)) return 'amber';
  if (/tail|brake|lamp_red|lod_red/.test(n)) return 'red';
  if (/head|fog|reverse|lamp_glass|headlamp/.test(n)) return 'clear';
  if (/rubber|tire|tyre/.test(n)) return 'rubber';
  if (/chrome|metal|rim|disc/.test(n)) return 'metal';
  if (/interior|dash|gauge|seat|steering/.test(n)) return 'interior';
  return 'dark';
}

function dynamicAttribute(count: number, itemSize: number): THREE.InstancedBufferAttribute {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(count * itemSize), itemSize);
  a.setUsage(THREE.DynamicDrawUsage);
  return a;
}

function writeTier(batch: TierBatch, cos: number, sin: number, x: number, z: number, color: THREE.Color): void {
  const k = batch.count++;
  writeMatrix(batch.matrix.array as Float32Array, k * 16, cos, sin, x, 0, z);
  writeColor(batch.paint.array as Float32Array, k, color.r, color.g, color.b);
}

function updateTier(batch: TierBatch): void {
  for (const mesh of batch.meshes) mesh.count = batch.count;
  batch.matrix.needsUpdate = true;
  batch.paint.needsUpdate = true;
}

function writeColor(array: Float32Array, index: number, r: number, g: number, b: number): void {
  const o = index * 3;
  array[o] = r;
  array[o + 1] = g;
  array[o + 2] = b;
}

function pushPair(
  matrices: Float32Array,
  colors: Float32Array,
  count: number,
  capacity: number,
  cos: number,
  sin: number,
  x: number,
  z: number,
  y: number,
  localZ: number,
  side: number,
  r: number,
  g: number,
  b: number,
): number {
  if (count + 2 > capacity) return count;
  count = pushSingle(matrices, colors, count, cos, sin, x, z, -side, y, localZ, r, g, b);
  return pushSingle(matrices, colors, count, cos, sin, x, z, side, y, localZ, r, g, b);
}

function pushSingle(
  matrices: Float32Array,
  colors: Float32Array,
  count: number,
  cos: number,
  sin: number,
  x: number,
  z: number,
  localX: number,
  y: number,
  localZ: number,
  r: number,
  g: number,
  b: number,
): number {
  const wx = x + cos * localX + sin * localZ;
  const wz = z - sin * localX + cos * localZ;
  writeMatrix(matrices, count * 16, cos, sin, wx, y, wz);
  writeColor(colors, count, r, g, b);
  return count + 1;
}

interface LoftSection {
  z: number;
  w: number;
  y0: number;
  y1: number;
}

/** Four-vertex cross-sections joined into one watertight low-poly body. */
function loftGeometry(sections: LoftSection[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const s of sections) positions.push(-s.w, s.y0, s.z, s.w, s.y0, s.z, s.w, s.y1, s.z, -s.w, s.y1, s.z);
  for (let k = 0; k < sections.length - 1; k++) {
    const a = k * 4;
    const b = (k + 1) * 4;
    for (let edge = 0; edge < 4; edge++) {
      const e2 = (edge + 1) % 4;
      indices.push(a + edge, b + edge, b + e2, a + edge, b + e2, a + e2);
    }
  }
  indices.push(0, 3, 2, 0, 2, 1);
  const o = (sections.length - 1) * 4;
  indices.push(o, o + 1, o + 2, o, o + 2, o + 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

function disposeSourceScene(scene: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    geometries.add(m.geometry);
    const list = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of list) materials.add(mat);
  });
  for (const g of geometries) g.dispose();
  for (const m of materials) {
    for (const value of Object.values(m)) if (value instanceof THREE.Texture) value.dispose();
    m.dispose();
  }
}

const square = (n: number): number => n * n;

/** Column-major rotation about Y by yaw (cos/sin) + translation. */
function writeMatrix(array: Float32Array, o: number, cos: number, sin: number, x: number, y: number, z: number): void {
  array[o] = cos;
  array[o + 1] = 0;
  array[o + 2] = -sin;
  array[o + 3] = 0;
  array[o + 4] = 0;
  array[o + 5] = 1;
  array[o + 6] = 0;
  array[o + 7] = 0;
  array[o + 8] = sin;
  array[o + 9] = 0;
  array[o + 10] = cos;
  array[o + 11] = 0;
  array[o + 12] = x;
  array[o + 13] = y;
  array[o + 14] = z;
  array[o + 15] = 1;
}
