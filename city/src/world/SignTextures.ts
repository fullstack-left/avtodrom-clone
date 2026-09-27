// Sign face textures. Official images come from the Avtodrom art set
// (game/assets/signs, copied by scripts/sync-assets.mjs); signs that are not in
// that set are drawn procedurally following the GOST/O'z DSt 2850 geometry.

import * as THREE from 'three';
import { SIGN_BY_CODE } from '../rules/PddKnowledge';

const RED = '#d0121b';
const BLUE = '#1f5fbf';
const YELLOW = '#f5c400';

function canvas(w = 256, h = 256): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function triangle(ctx: CanvasRenderingContext2D, bg: string): void {
  const W = 256;
  ctx.beginPath();
  ctx.moveTo(W / 2, 12);
  ctx.lineTo(W - 8, W - 30);
  ctx.lineTo(8, W - 30);
  ctx.closePath();
  ctx.fillStyle = RED;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(W / 2, 48);
  ctx.lineTo(W - 40, W - 48);
  ctx.lineTo(40, W - 48);
  ctx.closePath();
  ctx.fillStyle = bg;
  ctx.fill();
}

function roundSpeed(ctx: CanvasRenderingContext2D, n: number, bg: string): void {
  ctx.beginPath();
  ctx.arc(128, 128, 124, 0, Math.PI * 2);
  ctx.fillStyle = RED;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(128, 128, 96, 0, Math.PI * 2);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.fillStyle = '#111';
  ctx.font = 'bold 112px Inter, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(n), 128, 136);
}

function person(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  ctx.fillStyle = '#111';
  ctx.beginPath();
  ctx.arc(x, y - 30 * s, 9 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 9 * s;
  ctx.strokeStyle = '#111';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y - 18 * s);
  ctx.lineTo(x, y + 10 * s);
  ctx.lineTo(x - 12 * s, y + 34 * s);
  ctx.moveTo(x, y + 10 * s);
  ctx.lineTo(x + 12 * s, y + 34 * s);
  ctx.moveTo(x - 14 * s, y - 6 * s);
  ctx.lineTo(x, y - 14 * s);
  ctx.lineTo(x + 14 * s, y - 4 * s);
  ctx.stroke();
}

function drawProcedural(code: string): HTMLCanvasElement {
  if (code === '3.24-50') {
    const [c, x] = canvas();
    roundSpeed(x, 50, '#fff');
    return c;
  }
  if (code === '3.24-60') {
    const [c, x] = canvas();
    roundSpeed(x, 60, '#fff');
    return c;
  }
  if (code === '3.24-30T') {
    const [c, x] = canvas();
    roundSpeed(x, 30, YELLOW);
    return c;
  }
  if (code === '1.8') {
    const [c, x] = canvas();
    triangle(x, '#fff');
    x.fillStyle = '#111';
    x.fillRect(110, 92, 36, 100);
    const cols = [RED, YELLOW, '#16a34a'];
    cols.forEach((col, k) => {
      x.beginPath();
      x.arc(128, 110 + k * 32, 12, 0, Math.PI * 2);
      x.fillStyle = col;
      x.fill();
    });
    return c;
  }
  if (code === '1.21') {
    const [c, x] = canvas();
    triangle(x, '#fff');
    person(x, 108, 160, 1.0);
    person(x, 150, 168, 0.8);
    return c;
  }
  if (code === '1.23') {
    const [c, x] = canvas();
    triangle(x, YELLOW);
    person(x, 118, 160, 1.0);
    x.fillStyle = '#111';
    x.beginPath();
    x.moveTo(140, 196);
    x.lineTo(186, 196);
    x.lineTo(163, 160);
    x.fill();
    return c;
  }
  if (code === '6.1' || code === '6.7') {
    const [c, x] = canvas(256, 384);
    x.fillStyle = BLUE;
    x.fillRect(0, 0, 256, 384);
    x.fillStyle = '#fff';
    x.fillRect(22, 22, 212, 212);
    if (code === '6.1') {
      x.fillStyle = RED;
      x.fillRect(108, 50, 40, 156);
      x.fillRect(50, 108, 156, 40);
    } else {
      x.fillStyle = '#111';
      x.fillRect(80, 60, 70, 140);
      x.fillRect(150, 90, 30, 12);
      x.fillRect(170, 90, 10, 90);
      x.fillStyle = '#fff';
      x.fillRect(92, 74, 46, 36);
    }
    return c;
  }
  if (code === '7.17') {
    const [c, x] = canvas(256, 128);
    x.fillStyle = '#fff';
    x.fillRect(0, 0, 256, 128);
    x.strokeStyle = '#111';
    x.lineWidth = 6;
    x.strokeRect(3, 3, 250, 122);
    x.fillStyle = '#111';
    x.beginPath();
    x.arc(128, 30, 10, 0, Math.PI * 2);
    x.fill();
    x.lineWidth = 9;
    x.beginPath();
    x.moveTo(128, 44);
    x.lineTo(124, 78);
    x.lineTo(158, 78);
    x.lineTo(166, 104);
    x.stroke();
    x.beginPath();
    x.arc(122, 90, 24, 0.3, Math.PI * 1.6);
    x.stroke();
    return c;
  }
  // Generic fallback: code on a white plate.
  const [c, x] = canvas();
  x.fillStyle = '#fff';
  x.fillRect(0, 0, 256, 256);
  x.fillStyle = '#111';
  x.font = 'bold 60px Inter, Arial';
  x.textAlign = 'center';
  x.fillText(code, 128, 150);
  return c;
}

const cache = new Map<string, THREE.Texture>();
const loader = new THREE.TextureLoader();

export function signTexture(code: string, anisotropy = 4): THREE.Texture {
  const hit = cache.get(code);
  if (hit) return hit;
  const def = SIGN_BY_CODE[code];
  let tex: THREE.Texture;
  if (def?.file) tex = loader.load(`./assets/signs/${def.file}`);
  else tex = new THREE.CanvasTexture(drawProcedural(code));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  cache.set(code, tex);
  return tex;
}

/** Physical face size (m) — "I" size group used in towns. */
export function signSize(code: string): [number, number] {
  const def = SIGN_BY_CODE[code];
  if (!def) return [0.7, 0.7];
  switch (def.shape) {
    case 'triangle':
      return [0.9, 0.8];
    case 'triangle_down':
      return [0.9, 0.8];
    case 'rect':
      return [0.6, 0.9];
    case 'plate':
      return [0.7, code === '7.17' ? 0.35 : 0.34];
    case 'diamond':
      return [0.75, 0.75];
    default:
      return [0.7, 0.7];
  }
}

/** Image URL (for the HUD / reference UI). */
export function signImageUrl(code: string): string {
  const def = SIGN_BY_CODE[code];
  if (def?.file) return `./assets/signs/${def.file}`;
  return drawProcedural(code).toDataURL();
}

export function disposeSignTextures(): void {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}
