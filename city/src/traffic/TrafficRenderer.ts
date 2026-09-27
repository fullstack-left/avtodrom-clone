// Instanced rendering of the AI traffic with CPU frustum culling and three
// levels of detail:
//   LOD0 (< lod0Dist): the 2.5k-triangle Avtodrom LOD models (one InstancedMesh
//        per material primitive, all sharing one instance-matrix buffer),
//        plus blinking indicators, brake/tail lamps and headlight pools.
//   LOD1 (< maxDist): 12-triangle box impostor, one draw call for all cars.
//   culled: outside the view frustum or beyond maxDist.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TrafficSim } from './TrafficSim';

interface ModelLod {
  meshes: THREE.InstancedMesh[];
  matrix: THREE.InstancedBufferAttribute;
  paint: THREE.InstancedBufferAttribute;
  lamp: THREE.InstancedBufferAttribute;
  count: number;
}

export class TrafficRenderer {
  group = new THREE.Group();
  private models: ModelLod[] = [];
  private far!: THREE.InstancedMesh;
  private blinkers!: THREE.InstancedMesh;
  private pools!: THREE.InstancedMesh;
  private frustum = new THREE.Frustum();
  private pm = new THREE.Matrix4();
  private sphere = new THREE.Sphere(new THREE.Vector3(), 2.8);
  private m = new THREE.Matrix4();
  private col = new THREE.Color();
  private t = 0;
  lod0Dist = 170;
  maxDist = 650;
  night = 0;
  visibleNear = 0;
  visibleFar = 0;

  constructor(private sim: TrafficSim, private cap: number) {}

  async load(): Promise<void> {
    const loader = new GLTFLoader();
    const files = ['./assets/cars/nexia2_lod.glb', './assets/cars/cobalt_lod.glb'];
    for (const f of files) {
      const gltf = await loader.loadAsync(f);
      const prims: { geo: THREE.BufferGeometry; mat: THREE.MeshStandardMaterial }[] = [];
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
        prims.push({ geo, mat: mesh.material as THREE.MeshStandardMaterial });
      });
      const matrix = new THREE.InstancedBufferAttribute(new Float32Array(this.cap * 16), 16);
      matrix.setUsage(THREE.DynamicDrawUsage);
      const paint = new THREE.InstancedBufferAttribute(new Float32Array(this.cap * 3), 3);
      paint.setUsage(THREE.DynamicDrawUsage);
      const lamp = new THREE.InstancedBufferAttribute(new Float32Array(this.cap * 3), 3);
      lamp.setUsage(THREE.DynamicDrawUsage);
      const meshes: THREE.InstancedMesh[] = [];
      for (const p of prims) {
        const name = p.mat.name || '';
        let mat: THREE.Material;
        let colorAttr: THREE.InstancedBufferAttribute | null = null;
        if (name.includes('paint')) {
          mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.45 });
          colorAttr = paint;
        } else if (name.includes('red')) {
          mat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
          colorAttr = lamp;
        } else if (name.includes('glass')) {
          mat = new THREE.MeshStandardMaterial({ color: 0x1c2530, roughness: 0.1, metalness: 0.6 });
        } else if (name.includes('bright')) {
          mat = new THREE.MeshStandardMaterial({ color: 0xdadada, roughness: 0.25, metalness: 0.9, emissive: 0xfff3d6, emissiveIntensity: 0 });
        } else {
          mat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.8 });
        }
        const im = new THREE.InstancedMesh(p.geo, mat, this.cap);
        im.instanceMatrix = matrix;
        if (colorAttr) im.instanceColor = colorAttr;
        im.frustumCulled = false;
        im.castShadow = true;
        im.receiveShadow = true;
        im.count = 0;
        meshes.push(im);
        this.group.add(im);
      }
      this.models.push({ meshes, matrix, paint, lamp, count: 0 });
    }
    // Far impostor: body + cabin boxes.
    const body = new THREE.BoxGeometry(1.7, 0.75, 4.4).translate(0, 0.62, 0);
    const cabin = new THREE.BoxGeometry(1.45, 0.5, 2.2).translate(0, 1.22, 0.25);
    const farGeo = mergeGeometries([body, cabin])!;
    this.far = new THREE.InstancedMesh(farGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.3 }), this.cap);
    this.far.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.far.frustumCulled = false;
    this.far.count = 0;
    this.far.setColorAt(0, this.col.set(0xffffff));
    this.group.add(this.far);
    // Indicators: 4 lamps per car max (front + rear of one side).
    const bl = new THREE.BoxGeometry(0.12, 0.08, 0.06);
    this.blinkers = new THREE.InstancedMesh(bl, new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 1.6, 0.1), toneMapped: false }), this.cap * 2);
    this.blinkers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.blinkers.frustumCulled = false;
    this.blinkers.count = 0;
    this.group.add(this.blinkers);
    // Headlight pools (fake lights for hundreds of cars at night).
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 128;
    const x = c.getContext('2d')!;
    const gr = x.createRadialGradient(32, 112, 4, 32, 70, 70);
    gr.addColorStop(0, 'rgba(255,245,220,0.95)');
    gr.addColorStop(1, 'rgba(255,245,220,0)');
    x.fillStyle = gr;
    x.fillRect(0, 0, 64, 128);
    const tex = new THREE.CanvasTexture(c);
    const poolGeo = new THREE.PlaneGeometry(4.2, 12).rotateX(-Math.PI / 2).translate(0, 0.04, -8.2);
    this.pools = new THREE.InstancedMesh(poolGeo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.6 }), this.cap);
    this.pools.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.pools.frustumCulled = false;
    this.pools.count = 0;
    this.pools.renderOrder = 3;
    this.group.add(this.pools);
  }

  setNight(n: number): void {
    this.night = n;
    for (const md of this.models)
      for (const m of md.meshes) {
        const mat = m.material as THREE.MeshStandardMaterial;
        if (mat.emissive && mat.metalness > 0.8) mat.emissiveIntensity = n > 0.3 ? 2.2 : 0;
      }
  }

  update(dt: number, camera: THREE.PerspectiveCamera, weatherView = 1): void {
    this.t += dt;
    const sim = this.sim;
    this.pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pm);
    const cx = camera.position.x, cz = camera.position.z;
    const lod0 = this.lod0Dist * Math.max(0.5, weatherView);
    const lod0Sq = lod0 * lod0;
    const maxSq = this.maxDist * this.maxDist * weatherView;
    for (const md of this.models) md.count = 0;
    let farN = 0, blinkN = 0, poolN = 0;
    const blinkOn = this.t % 0.67 < 0.36; // 90 flashes per minute
    const farArr = this.far.instanceMatrix.array as Float32Array;
    const farCol = this.far.instanceColor!.array as Float32Array;
    const blArr = this.blinkers.instanceMatrix.array as Float32Array;
    const poolArr = this.pools.instanceMatrix.array as Float32Array;
    const night = this.night > 0.3;
    for (let i = 0; i < sim.count; i++) {
      const x = sim.x[i], z = sim.z[i];
      const dx = x - cx, dz = z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > maxSq) continue;
      this.sphere.center.set(x, 0.8, z);
      if (!this.frustum.intersectsSphere(this.sphere)) continue;
      const yaw = sim.yaw[i];
      const c = Math.cos(yaw), s = Math.sin(yaw);
      const hex = sim.color[i];
      const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
      if (d2 < lod0Sq) {
        const md = this.models[sim.model[i]];
        const k = md.count++;
        writeMatrix(md.matrix.array as Float32Array, k * 16, c, s, x, 0, z);
        // sRGB → linear for vertex colours
        (md.paint.array as Float32Array).set([r * r, g * g, b * b], k * 3);
        const br = sim.brake[i];
        const lampR = br ? 3.2 : night ? 0.9 : 0.25;
        (md.lamp.array as Float32Array).set([lampR, lampR * 0.05, lampR * 0.04], k * 3);
        const ind = sim.indicator[i];
        if (ind !== 0 && blinkOn && blinkN < this.cap * 2 - 2) {
          const side = ind > 0 ? 0.8 : -0.8;
          for (const fz of [-2.18, 2.2]) {
            // local (side, 0.72, fz) → world
            const wx = x + c * side + s * fz, wz = z - s * side + c * fz;
            writeMatrix(blArr, blinkN * 16, c, s, wx, 0.72, wz);
            blinkN++;
          }
        }
        if (night && d2 < 150 * 150) {
          writeMatrix(poolArr, poolN * 16, c, s, x, 0, z);
          poolN++;
        }
      } else {
        writeMatrix(farArr, farN * 16, c, s, x, 0, z);
        farCol[farN * 3] = r * r;
        farCol[farN * 3 + 1] = g * g;
        farCol[farN * 3 + 2] = b * b;
        farN++;
      }
    }
    let near = 0;
    for (const md of this.models) {
      for (const m of md.meshes) m.count = md.count;
      md.matrix.needsUpdate = true;
      md.paint.needsUpdate = true;
      md.lamp.needsUpdate = true;
      md.matrix.addUpdateRange(0, md.count * 16);
      near += md.count;
    }
    this.far.count = farN;
    this.far.instanceMatrix.needsUpdate = true;
    this.far.instanceColor!.needsUpdate = true;
    this.blinkers.count = blinkN;
    this.blinkers.instanceMatrix.needsUpdate = true;
    this.pools.count = poolN;
    this.pools.visible = poolN > 0;
    this.pools.instanceMatrix.needsUpdate = true;
    this.visibleNear = near;
    this.visibleFar = farN;
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.InstancedMesh;
      if (m.isInstancedMesh) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });
    this.group.parent?.remove(this.group);
  }
}

/** Column-major rotation about Y by yaw (c = cos, s = sin) + translation. */
function writeMatrix(a: Float32Array, o: number, c: number, s: number, x: number, y: number, z: number): void {
  a[o] = c; a[o + 1] = 0; a[o + 2] = -s; a[o + 3] = 0;
  a[o + 4] = 0; a[o + 5] = 1; a[o + 6] = 0; a[o + 7] = 0;
  a[o + 8] = s; a[o + 9] = 0; a[o + 10] = c; a[o + 11] = 0;
  a[o + 12] = x; a[o + 13] = y; a[o + 14] = z; a[o + 15] = 1;
}
