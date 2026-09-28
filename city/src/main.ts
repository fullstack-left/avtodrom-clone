// Application entry: wires the menu → game lifecycle, loading screen, pause
// handling and the standalone WebGPU benchmark screen.

import './style.css';
import { Game, GameResult } from './game/Game';
import { InputManager } from './input/InputManager';
import { Menu, loadSettings } from './ui/Menu';
import { GpuTrafficBenchmark } from './gpu/GpuTrafficBenchmark';
import { setLang, t } from './i18n';

const VERSION = '2.0.0';

const app = document.getElementById('app')!;
const canvas = document.getElementById('gl') as HTMLCanvasElement;
const loading = document.getElementById('loading')!;

const input = new InputManager();
const menu = new Menu(VERSION);
app.appendChild(menu.root);

let game: Game | null = null;
let bench: GpuTrafficBenchmark | null = null;

function showLoading(on: boolean): void {
  loading.style.display = on ? 'flex' : 'none';
  loading.querySelector('span')!.textContent = t('loading');
}

async function startGame(mode: 'free' | 'missions' | 'exam' | 'spectate'): Promise<void> {
  menu.hide();
  showLoading(true);
  const settings = { ...menu.settings };
  setLang(settings.lang);
  // Fresh game each run so resources are clean.
  await teardown();
  game = new Game(canvas, input, settings);
  try {
    await game.load();
    await game.startMode(mode);
  } catch (e) {
    console.error(e);
    showLoading(false);
    alert('Xatolik / Ошибка: ' + (e as Error).message);
    menu.showMain();
    return;
  }
  app.appendChild(game.hudRoot);
  game.onResult = (r: GameResult) => showResult(r);
  showLoading(false);

  // Pause handling via Esc / gamepad start.
  const pauseCheck = () => {
    if (game && game.running && !game.paused && input.take('pause')) {
      game.pause();
      menu.showPause(
        () => {
          menu.hide();
          game!.resume();
        },
        () => {
          menu.hide();
          restart(mode);
        },
      );
    }
    if (game) requestAnimationFrame(pauseCheck);
  };
  requestAnimationFrame(pauseCheck);
}

function showResult(r: GameResult): void {
  const mode = game?.mode ?? 'free';
  menu.showResults(
    r.title,
    r.pass,
    r.lines,
    () => {
      menu.hide();
      restart(mode as any);
    },
    () => backToMenu(),
  );
}

async function restart(mode: 'free' | 'missions' | 'exam' | 'spectate'): Promise<void> {
  await startGame(mode);
}

async function backToMenu(): Promise<void> {
  await teardown();
  menu.showMain();
}

async function teardown(): Promise<void> {
  if (game) {
    game.dispose(true);
    game.hudRoot.remove();
    game = null;
  }
  if (bench) {
    bench.dispose();
    bench.canvas.remove();
    bench = null;
  }
}

async function startBench(): Promise<void> {
  menu.hide();
  await teardown();
  if (!GpuTrafficBenchmark.supported()) {
    alert(t('webgpu_missing'));
    menu.showMain();
    return;
  }
  showLoading(true);
  bench = new GpuTrafficBenchmark(100000);
  const ok = await bench.init();
  if (!ok) {
    showLoading(false);
    alert(t('webgpu_missing'));
    menu.showMain();
    return;
  }
  app.appendChild(bench.canvas);
  const stats = document.createElement('div');
  stats.className = 'bench-stats';
  app.appendChild(stats);
  bench.onStats = (fps, count) => (stats.innerHTML = `<b>${count.toLocaleString()}</b> ${t('cars')} · <b>${fps.toFixed(0)}</b> ${t('fps')} · WebGPU compute (IDM+MOBIL)`);
  const backBtn = document.createElement('button');
  backBtn.className = 'btn primary bench-back';
  backBtn.textContent = t('back');
  backBtn.onclick = () => {
    stats.remove();
    backBtn.remove();
    backToMenu();
  };
  app.appendChild(backBtn);
  window.addEventListener('resize', () => bench?.resize());
  bench.start();
  showLoading(false);
}

menu.onStart = (mode) => {
  if (mode === 'bench') startBench();
  else startGame(mode);
};

// Kick the audio context alive on the first gesture (autoplay policy).
window.addEventListener('pointerdown', () => game?.audio.resume(), { once: false });

// Service-worker for offline PWA (web build only).
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

showLoading(false);
