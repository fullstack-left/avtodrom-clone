// Copies the shared art from the Godot project (../game/assets) into
// public/assets so the web build uses the very same car models, sign images
// and PBR textures as the Avtodrom exam simulator — no duplicate copies in git.
import { cpSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, '..', 'game', 'assets');
const dst = join(root, 'public', 'assets');
const skip = (p) => p.endsWith('.import') || p.endsWith('.uid');

const jobs = [
  ['cars/nexia2/nexia2.glb', 'cars/nexia2.glb'],
  ['cars/cobalt/cobalt.glb', 'cars/cobalt.glb'],
  ['cars/lod/nexia2_lod.glb', 'cars/nexia2_lod.glb'],
  ['cars/lod/cobalt_lod.glb', 'cars/cobalt_lod.glb'],
  ['signs', 'signs'],
  ['textures/asphalt', 'textures/asphalt'],
  ['textures/concrete', 'textures/concrete'],
  ['textures/grass', 'textures/grass'],
  ['sky/sky_1k.hdr', 'sky/sky_1k.hdr'],
  ['fonts/Inter.ttf', 'fonts/Inter.ttf'],
  ['ui/steering_wheel.png', 'ui/steering_wheel.png'],
  ['ui/icon_192.png', 'ui/icon_192.png'],
  ['ui/icon_1024.png', 'ui/icon_1024.png'],
];
if (!existsSync(src)) {
  console.error('game/assets not found at', src);
  process.exit(1);
}
for (const [from, to] of jobs) {
  const a = join(src, from);
  const b = join(dst, to);
  mkdirSync(dirname(b), { recursive: true });
  cpSync(a, b, { recursive: true, filter: (p) => !skip(p) });
}
console.log('assets synced →', dst, readdirSync(dst).join(', '));
