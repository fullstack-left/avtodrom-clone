// Production smoke/soak harness: serves dist/, launches real Chromium, starts
// the requested mode + car, verifies the intended UI loaded, performs a short
// controlled launch, observes telemetry, optionally soaks the live simulation,
// captures a screenshot, and fails on console/page/runtime invariants.
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
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
  }
});

await new Promise((resolve) => server.listen(4180, resolve));
const mode = process.argv[2] || 'free';
const car = process.argv[3] || 'nexia2';
const soakSeconds = Math.max(0, Number(process.argv[4] || 0));
const environment = process.argv[5] || 'day-clear';
const profile = process.argv[6] || 'desktop';
const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage(profile === 'mobile' ? { viewport: { width: 960, height: 540 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 } : { viewport: { width: 1280, height: 720 } });
const errors = [];
const assertions = [];

await page.addInitScript((selected) => {
  const old = JSON.parse(localStorage.getItem('avtoshahar.settings') || '{}');
  localStorage.setItem('avtoshahar.settings', JSON.stringify({ ...old, car: selected.car, manualAssist: true, quality: 'high', density: 0.5, time: selected.environment.includes('night') ? 'night' : selected.environment.includes('evening') ? 'evening' : 'day', weather: selected.environment.includes('rain') ? 'rain' : selected.environment.includes('fog') ? 'fog' : 'clear' }));
}, { car, environment });
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
page.on('pageerror', (error) => errors.push('PAGEERROR: ' + error.message));

try {
  await page.goto('http://localhost:4180/', { waitUntil: 'load' });
  await page.waitForTimeout(350);
  const labels = { free: 'Erkin', missions: 'Taksi|Topshiriq', exam: 'imtihon', spectate: 'oqim' };
  const buttons = await page.$$('button.btn.primary');
  let clicked = false;
  for (const button of buttons) {
    const text = (await button.textContent()) || '';
    if (new RegExp(labels[mode], 'i').test(text)) {
      await button.click();
      clicked = true;
      break;
    }
  }
  if (!clicked) throw new Error(`mode button not found: ${mode}`);
  await page.waitForFunction(() => document.getElementById('loading')?.style.display === 'none', { timeout: 45000 });
  await page.waitForSelector('.hud-stats', { timeout: 15000 });
  await page.waitForTimeout(2500);

  let peakSpeed = 0;
  if (mode !== 'spectate') {
    await page.keyboard.press('b'); // seatbelt
    await page.keyboard.down('w');
    for (let i = 0; i < 16; i++) {
      await page.waitForTimeout(250);
      const speed = Number(await page.$eval('#gl', (e) => e.dataset.speed || 0));
      peakSpeed = Math.max(peakSpeed, speed);
    }
    await page.keyboard.up('w');
    await page.waitForTimeout(750);
    if (peakSpeed < 3) assertions.push(`player did not launch: peak=${peakSpeed.toFixed(1)} km/h`);
    const gear = await page.$eval('#gl', (e) => e.dataset.gear || '');
    if (car === 'cobalt_at' && !gear.startsWith('D')) assertions.push(`Cobalt not in Drive: ${gear}`);
    if (car === 'nexia2' && gear === 'N') assertions.push('Nexia remained in neutral');
  }

  if (soakSeconds > 0) await page.waitForTimeout(soakSeconds * 1000);
  const shotDir = '/projects/sandbox/.kiro/artifacts/screenshots';
  const suffix = `${mode}-${car}-${environment}-${profile}`;
  await page.screenshot({ path: `${shotDir}/avtoshahar-${suffix}.png` }).catch(() => page.screenshot({ path: `/tmp/avtoshahar-${suffix}.png` }));
  const stats = await page.$eval('.hud-stats', (e) => e.textContent).catch(() => '(no hud)');
  const telemetry = await page.$eval('#gl', (e) => ({ ...e.dataset })).catch(() => ({}));
  if (!stats || stats === '(no hud)' || !stats.includes('FPS')) assertions.push('HUD stats missing');
  const stopped = /(?:To'xtaganlar|Остановившиеся):\s*(\d+)%/.exec(stats || '');
  if (stopped && Number(stopped[1]) > 65) assertions.push(`traffic gridlock: stopped=${stopped[1]}%`);
  console.log('MODE', mode, '| CAR:', car, '| ENV:', environment, '| PROFILE:', profile, '| PEAK:', peakSpeed.toFixed(1), 'km/h | STATS:', stats);
  console.log('TELEMETRY:', telemetry);
} finally {
  await browser.close();
  server.close();
}

console.log('ERRORS:', errors.length, '| ASSERTIONS:', assertions.length);
for (const e of errors.slice(0, 25)) console.log(' -', e);
for (const a of assertions) console.log(' - ASSERT:', a);
process.exit(errors.length || assertions.length ? 1 : 0);
