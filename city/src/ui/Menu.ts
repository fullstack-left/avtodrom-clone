// Main menu, settings, pause, results, crash toast and the PDD reference
// screen. Pure DOM + CSS overlay so it works identically on web, Android and
// desktop builds. Settings are persisted to localStorage.

import { Lang, getLang, setLang, t, tr } from '../i18n';
import { SIGNS, SIGN_GROUPS, SignGroup, VIOLATIONS } from '../rules/PddKnowledge';
import { signImageUrl } from '../world/SignTextures';

export type GameMode = 'free' | 'missions' | 'exam' | 'spectate' | 'bench';

export interface Settings {
  car: 'nexia2' | 'cobalt_at';
  lang: Lang;
  quality: 'low' | 'medium' | 'high';
  density: number; // 0..1
  pedestrians: boolean;
  time: 'day' | 'evening' | 'night';
  weather: 'clear' | 'rain' | 'fog';
  lights: 'normal' | 'flash';
  officer: boolean;
  sound: boolean;
  manualAssist: boolean;
}

const DEFAULTS: Settings = {
  car: 'nexia2',
  lang: getLang(),
  quality: 'high',
  density: 0.5,
  pedestrians: true,
  time: 'day',
  weather: 'clear',
  lights: 'normal',
  officer: false,
  sound: true,
  manualAssist: true,
};

export function loadSettings(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem('avtoshahar.settings') || '{}');
    return { ...DEFAULTS, ...s, lang: getLang() };
  } catch {
    return { ...DEFAULTS };
  }
}
export function saveSettings(s: Settings): void {
  localStorage.setItem('avtoshahar.settings', JSON.stringify(s));
}

export class Menu {
  root: HTMLDivElement;
  settings: Settings;
  onStart: ((mode: GameMode) => void) | null = null;
  private version: string;

  constructor(version: string) {
    this.version = version;
    this.settings = loadSettings();
    this.root = document.createElement('div');
    this.root.className = 'overlay';
    this.showMain();
  }

  private clear(): void {
    this.root.innerHTML = '';
    this.root.style.display = 'flex';
  }
  hide(): void {
    this.root.style.display = 'none';
  }

  private select<T extends string>(label: string, value: T, opts: [T, string][], on: (v: T) => void): HTMLElement {
    const row = document.createElement('label');
    row.className = 'field';
    row.innerHTML = `<span>${label}</span>`;
    const sel = document.createElement('select');
    for (const [v, txt] of opts) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = txt;
      if (v === value) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => on(sel.value as T);
    row.appendChild(sel);
    return row;
  }

  showMain(): void {
    this.clear();
    const card = document.createElement('div');
    card.className = 'card main';
    card.innerHTML = `
      <div class="brand-mark"><img src="./assets/ui/icon_192.png" alt=""/></div>
      <h1>${t('title')}</h1>
      <p class="sub">${t('subtitle')}</p>
      <div class="feature-chips"><span>YHQ / PDD</span><span>IDM + MOBIL</span><span>Web · APK · EXE</span></div>
    `;
    const modes: [GameMode, string][] = [
      ['free', t('play_free')],
      ['missions', t('play_missions')],
      ['exam', t('play_exam')],
      ['spectate', t('play_spectate')],
      ['bench', t('gpu_bench')],
    ];
    const btns = document.createElement('div');
    btns.className = 'btns';
    for (const [m, label] of modes) {
      const b = document.createElement('button');
      b.className = 'btn primary';
      b.textContent = label;
      b.onclick = () => this.onStart?.(m);
      btns.appendChild(b);
    }
    card.appendChild(btns);
    const row = document.createElement('div');
    row.className = 'btns row';
    const setBtn = document.createElement('button');
    setBtn.className = 'btn';
    setBtn.textContent = t('settings');
    setBtn.onclick = () => this.showSettings(() => this.showMain());
    const rulesBtn = document.createElement('button');
    rulesBtn.className = 'btn';
    rulesBtn.textContent = t('rules');
    rulesBtn.onclick = () => this.showRules(() => this.showMain());
    row.append(setBtn, rulesBtn);
    card.appendChild(row);
    card.insertAdjacentHTML('beforeend', `<div class="ver">${t('version')} ${this.version}</div>`);
    this.root.appendChild(card);
  }

  showSettings(back: () => void): void {
    this.clear();
    const s = this.settings;
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<h2>${t('settings')}</h2>`;
    const form = document.createElement('div');
    form.className = 'form';
    form.append(
      this.select(t('language'), s.lang, [['uz_lat', "O'zbekcha (lotin)"], ['uz_cyr', 'Ўзбекча (кирилл)'], ['ru', 'Русский']], (v) => {
        s.lang = v;
        setLang(v);
        saveSettings(s);
        this.showSettings(back);
      }),
      this.select(t('car'), s.car, [['nexia2', t('car_nexia2')], ['cobalt_at', t('car_cobalt_at')]], (v) => (s.car = v)),
      this.select(t('clutch_mode'), s.manualAssist ? 'assist' : 'full', [['assist', t('clutch_assist')], ['full', t('clutch_full')]], (v) => (s.manualAssist = v === 'assist')),
      this.select(t('quality'), s.quality, [['low', t('q_low')], ['medium', t('q_medium')], ['high', t('q_high')]], (v) => (s.quality = v)),
      this.select(t('time_of_day'), s.time, [['day', t('day')], ['evening', t('evening')], ['night', t('night')]], (v) => (s.time = v)),
      this.select(t('weather'), s.weather, [['clear', t('clear')], ['rain', t('rain')], ['fog', t('fog')]], (v) => (s.weather = v)),
      this.select(t('lights_mode'), s.lights, [['normal', t('lights_normal')], ['flash', t('lights_flash')]], (v) => (s.lights = v)),
      this.select(t('officer'), s.officer ? 'on' : 'off', [['off', t('off')], ['on', t('on')]], (v) => (s.officer = v === 'on')),
      this.select(t('pedestrians'), s.pedestrians ? 'on' : 'off', [['on', t('on')], ['off', t('off')]], (v) => (s.pedestrians = v === 'on')),
      this.select(t('sound'), s.sound ? 'on' : 'off', [['on', t('on')], ['off', t('off')]], (v) => (s.sound = v === 'on')),
    );
    // density slider
    const dRow = document.createElement('label');
    dRow.className = 'field';
    dRow.innerHTML = `<span>${t('traffic_density')}</span>`;
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = '1';
    range.step = '0.05';
    range.value = String(s.density);
    range.oninput = () => (s.density = parseFloat(range.value));
    dRow.appendChild(range);
    form.appendChild(dRow);
    card.appendChild(form);
    const ctrls = document.createElement('div');
    ctrls.className = 'controls-help';
    ctrls.innerHTML = `<h3>${t('controls')}</h3><p>${t('controls_text')}</p>`;
    card.appendChild(ctrls);
    const b = document.createElement('button');
    b.className = 'btn primary';
    b.textContent = t('back');
    b.onclick = () => {
      saveSettings(s);
      back();
    };
    card.appendChild(b);
    this.root.appendChild(card);
  }

  showRules(back: () => void): void {
    this.clear();
    const card = document.createElement('div');
    card.className = 'card wide';
    card.innerHTML = `<h2>${t('rules')}</h2>`;
    const groups = [1, 2, 3, 4, 5, 6, 7] as SignGroup[];
    for (const gnum of groups) {
      const gsigns = SIGNS.filter((s) => s.group === gnum);
      if (!gsigns.length) continue;
      const h = document.createElement('h3');
      h.textContent = tr(SIGN_GROUPS[gnum]);
      card.appendChild(h);
      const grid = document.createElement('div');
      grid.className = 'sign-grid';
      for (const s of gsigns) {
        const item = document.createElement('div');
        item.className = 'sign-item';
        item.innerHTML = `<img loading="lazy" src="${signImageUrl(s.code)}" alt="${s.code}"/><span>${tr(s.name)}</span>`;
        grid.appendChild(item);
      }
      card.appendChild(grid);
    }
    const h = document.createElement('h3');
    h.textContent = t('violations');
    card.appendChild(h);
    const table = document.createElement('div');
    table.className = 'viol-table';
    for (const v of Object.values(VIOLATIONS)) {
      const r = document.createElement('div');
      r.className = 'viol-row';
      r.innerHTML = `<b>${v.points}</b><span>${tr(v.text)}</span><i>${tr(v.rule)}</i>`;
      table.appendChild(r);
    }
    card.appendChild(table);
    const b = document.createElement('button');
    b.className = 'btn primary';
    b.textContent = t('back');
    b.onclick = back;
    card.appendChild(b);
    this.root.appendChild(card);
  }

  showPause(onResume: () => void, onRestart: () => void): void {
    this.clear();
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<h2>${t('paused')}</h2>`;
    const mk = (label: string, fn: () => void, cls = 'btn') => {
      const b = document.createElement('button');
      b.className = cls;
      b.textContent = label;
      b.onclick = fn;
      return b;
    };
    card.append(
      mk(t('resume'), onResume, 'btn primary'),
      mk(t('restart'), onRestart),
      mk(t('settings'), () => this.showSettings(() => this.showPause(onResume, onRestart))),
      mk(t('main_menu'), () => this.showMain()),
    );
    this.root.appendChild(card);
  }

  showResults(title: string, pass: boolean | null, lines: string[], onClose: () => void, onMenu: () => void): void {
    this.clear();
    const card = document.createElement('div');
    card.className = 'card';
    const cls = pass === null ? '' : pass ? 'pass' : 'fail';
    card.innerHTML = `<h2 class="${cls}">${title}</h2><div class="result-lines">${lines.map((l) => `<div>${l}</div>`).join('')}</div>`;
    const b1 = document.createElement('button');
    b1.className = 'btn primary';
    b1.textContent = t('restart');
    b1.onclick = onClose;
    const b2 = document.createElement('button');
    b2.className = 'btn';
    b2.textContent = t('main_menu');
    b2.onclick = onMenu;
    card.append(b1, b2);
    this.root.appendChild(card);
  }
}
