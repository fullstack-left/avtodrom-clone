// Headless smoke test: serve dist/, load the app in Chromium, start a game
// mode, run a few seconds, and report console errors + a screenshot.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

const ROOT = new URL('../dist/', import.meta.url).pathname;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.hdr': 'image/vnd.radiance', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json', '.ttf': 'font/ttf' };

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT) || !existsSync(file)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' });
    res.end(buf);
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
  }
});

await new Promise((r) => server.listen(4180, r));
const mode = process.argv[2] || 'free';
const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

await page.goto('http://localhost:4180/', { waitUntil: 'load' });
await page.waitForTimeout(500);
// Click the mode button by its text.
const labels = { free: 'Erkin', missions: 'Taksi|Topshiriq', exam: 'imtihon', spectate: 'oqim' };
const btns = await page.$$('button.btn.primary');
let clicked = false;
for (const b of btns) {
  const txt = (await b.textContent()) || '';
  if (new RegExp(labels[mode], 'i').test(txt)) {
    await b.click();
    clicked = true;
    break;
  }
}
if (!clicked && btns[0]) await btns[0].click();
// Wait for load to finish + a few seconds of simulation.
await page.waitForFunction(() => document.getElementById('loading')?.style.display === 'none', { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(6000);
// Nudge some driving keys.
for (const k of ['b', 'i', 'w']) {
  await page.keyboard.down(k);
  await page.waitForTimeout(1200);
}
await page.waitForTimeout(2000);
const shotDir = '/projects/sandbox/.kiro/artifacts/screenshots';
await page.screenshot({ path: `${shotDir}/avtoshahar-${mode}.png` }).catch(() => page.screenshot({ path: `/tmp/avtoshahar-${mode}.png` }));
// Grab FPS from the stats HUD.
const stats = await page.$eval('.hud-stats', (e) => e.textContent).catch(() => '(no hud)');
console.log('MODE', mode, '| STATS:', stats);
console.log('ERRORS:', errors.length);
for (const e of errors.slice(0, 25)) console.log(' -', e);
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
