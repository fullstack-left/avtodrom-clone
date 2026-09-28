// Responsive in-game HUD: readable speed/RPM/gear cluster, true numeric
// speed-limit sign, rule/mission/navigation feedback, contextual first-drive
// coach, live traffic health, minimap and complete pointer-based mobile controls.

import { PlayerCar } from '../vehicle/PlayerCar';
import { VehiclePhysics } from '../vehicle/VehiclePhysics';
import { InputManager, InputState } from '../input/InputManager';
import { Manoeuvre } from '../game/Navigator';
import { ViolationDef } from '../rules/PddKnowledge';
import { t, tr } from '../i18n';
import { MiniMap } from './MiniMap';

export class HUD {
  root: HTMLDivElement;
  private speedEl: HTMLDivElement;
  private speedRing: HTMLDivElement;
  private gearEl: HTMLDivElement;
  private rpmBar: HTMLDivElement;
  private clutchBar: HTMLDivElement;
  private lampsEl: HTMLDivElement;
  private limitValue: HTMLSpanElement;
  private limitSign: HTMLDivElement;
  private regimeEl: HTMLDivElement;
  private penaltyEl: HTMLDivElement;
  private navEl: HTMLDivElement;
  private tickerEl: HTMLDivElement;
  private statsEl: HTMLDivElement;
  private missionEl: HTMLDivElement;
  private coachEl: HTMLDivElement;
  private selectorEl: HTMLDivElement | null = null;
  private cleanup: (() => void)[] = [];
  private coachStart = 0;
  minimap: MiniMap;
  private lastLimit = -1;

  constructor(private input: InputManager) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="hud-tl"><div class="hud-stats"></div></div>
      <div class="hud-tr">
        <div class="hud-penalty"><span class="p-pts">0</span></div>
        <div class="hud-regime"></div>
      </div>
      <div class="hud-nav" style="display:none"></div>
      <div class="hud-mission" style="display:none"></div>
      <div class="hud-ticker" aria-live="polite"></div>
      <div class="drive-coach" style="display:none" aria-live="polite"></div>
      <div class="hud-limit" title="${t('speed_limit')}">
        <div class="speed-limit-sign"><span class="limit-value">70</span></div>
        <small>${t('speed_limit')}</small>
      </div>
      <div class="hud-cluster">
        <div class="gauge speed"><div class="speed-ring"><div class="speed-core"><div class="val">0</div><div class="unit">km/h</div></div></div></div>
        <div class="power-bars">
          <div class="bar-row"><span>RPM</span><div class="rpm"><div class="rpm-fill"></div></div></div>
          <div class="bar-row clutch-row"><span>${t('clutch')}</span><div class="clutch-meter"><div class="clutch-fill"></div></div></div>
        </div>
        <div class="gear" aria-label="${t('gear')}">N</div>
        <div class="lamps"></div>
      </div>
    `;
    this.statsEl = this.root.querySelector('.hud-stats')!;
    this.penaltyEl = this.root.querySelector('.hud-penalty')!;
    this.regimeEl = this.root.querySelector('.hud-regime')!;
    this.navEl = this.root.querySelector('.hud-nav')!;
    this.missionEl = this.root.querySelector('.hud-mission')!;
    this.tickerEl = this.root.querySelector('.hud-ticker')!;
    this.coachEl = this.root.querySelector('.drive-coach')!;
    this.limitValue = this.root.querySelector('.limit-value')!;
    this.limitSign = this.root.querySelector('.speed-limit-sign')!;
    this.speedEl = this.root.querySelector('.gauge.speed .val')!;
    this.speedRing = this.root.querySelector('.speed-ring')!;
    this.rpmBar = this.root.querySelector('.rpm-fill')!;
    this.clutchBar = this.root.querySelector('.clutch-fill')!;
    this.gearEl = this.root.querySelector('.gear')!;
    this.lampsEl = this.root.querySelector('.lamps')!;
    this.minimap = new MiniMap();
    this.root.appendChild(this.minimap.canvas);
    if (input.hasTouch) this.buildTouch();
  }

  showPenalty(show: boolean): void {
    this.penaltyEl.style.display = show ? 'block' : 'none';
  }

  /** Pointer events track their initiating pointer and always receive cancel. */
  private buildTouch(): void {
    this.root.classList.add('touch-enabled');
    const wheel = document.createElement('div');
    wheel.className = 'touch-wheel';
    wheel.innerHTML = `<img src="./assets/ui/steering_wheel.png" alt="${t('controls')}" draggable="false"/>`;
    const img = wheel.querySelector('img')!;
    let pointer = -1;
    const steer = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      const r = wheel.getBoundingClientRect();
      const value = Math.max(-1, Math.min(1, (r.left + r.width / 2 - e.clientX) / (r.width * 0.46)));
      this.input.touch.steer = value;
      img.style.transform = `rotate(${-value * 125}deg)`;
    };
    const start = (e: PointerEvent) => {
      pointer = e.pointerId;
      wheel.setPointerCapture(e.pointerId);
      steer(e);
      e.preventDefault();
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      pointer = -1;
      this.input.touch.steer = 0;
      img.style.transform = 'rotate(0deg)';
    };
    wheel.addEventListener('pointerdown', start);
    wheel.addEventListener('pointermove', steer);
    wheel.addEventListener('pointerup', end);
    wheel.addEventListener('pointercancel', end);
    this.root.appendChild(wheel);

    const holdButton = (label: string, cls: string, press: () => void, release: () => void, aria: string) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `touch-btn ${cls}`;
      button.textContent = label;
      button.setAttribute('aria-label', aria);
      const down = (e: PointerEvent) => {
        button.setPointerCapture(e.pointerId);
        button.classList.add('down');
        press();
        e.preventDefault();
      };
      const up = () => {
        button.classList.remove('down');
        release();
      };
      button.addEventListener('pointerdown', down);
      button.addEventListener('pointerup', up);
      button.addEventListener('pointercancel', up);
      button.addEventListener('lostpointercapture', up);
      return button;
    };
    const pedals = document.createElement('div');
    pedals.className = 'touch-pedals';
    pedals.append(
      holdButton('GAZ', 'gas', () => (this.input.touch.throttle = 1), () => (this.input.touch.throttle = 0), t('coach_drive')),
      holdButton('TORMOZ', 'brk', () => (this.input.touch.brake = 1), () => (this.input.touch.brake = 0), t('coach_drive')),
      holdButton('P', 'hb', () => (this.input.touch.handbrake = true), () => (this.input.touch.handbrake = false), t('handbrake')),
      holdButton('MUFTA', 'clutch', () => (this.input.touch.clutch = 1), () => (this.input.touch.clutch = 0), t('clutch')),
    );
    this.root.appendChild(pedals);

    const action = (label: string, name: keyof InputState, aria = label) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'touch-act';
      button.textContent = label;
      button.setAttribute('aria-label', aria);
      button.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.input.trigger(name);
      });
      return button;
    };
    const actions = document.createElement('div');
    actions.className = 'touch-acts';
    actions.append(
      action('Q', 'toggleIndicatorLeft'),
      action('E', 'toggleIndicatorRight'),
      action('H', 'toggleHazard'),
      action('L', 'toggleHeadlights', t('headlights')),
      action('C', 'cycleCamera', t('camera')),
      action('B', 'toggleSeatbelt', t('seatbelt')),
    );
    this.root.appendChild(actions);

    const selector = document.createElement('div');
    selector.className = 'touch-selector';
    selector.innerHTML = `<span>${t('selector')}</span>`;
    selector.append(
      action('P', 'selectPark'),
      action('R', 'selectReverse'),
      action('N', 'neutral'),
      action('D', 'selectDrive'),
      action('−', 'gearDown'),
      action('+', 'gearUp'),
    );
    this.selectorEl = selector;
    this.root.appendChild(selector);

    const release = () => {
      pointer = -1;
      img.style.transform = 'rotate(0deg)';
      this.input.releaseControls();
      this.root.querySelectorAll('.touch-btn.down').forEach((b) => b.classList.remove('down'));
    };
    window.addEventListener('blur', release);
    this.cleanup.push(() => window.removeEventListener('blur', release));
  }

  private lampChip(on: boolean, color: string, label: string, title: string): string {
    return `<span class="lamp ${on ? 'on' : ''}" style="--c:${color}" title="${title}">${label}</span>`;
  }

  update(car: PlayerCar, p: VehiclePhysics, penalty: number, fines: number, regime: string, limit: number, blink: boolean): void {
    this.speedEl.textContent = String(Math.round(p.kmh));
    this.gearEl.textContent = p.gearLabel();
    this.gearEl.classList.toggle('not-ready', p.gearLabel() === 'N' || p.gearLabel() === 'P');
    const speedFraction = Math.min(1, p.kmh / 140);
    this.speedRing.style.setProperty('--speed-angle', `${speedFraction * 300}deg`);
    const rpmFraction = Math.min(1, p.rpm / p.spec.limiterRpm);
    this.rpmBar.style.width = (rpmFraction * 100).toFixed(0) + '%';
    this.rpmBar.style.background = rpmFraction > 0.88 ? '#ff3b30' : rpmFraction > 0.7 ? '#ffcc00' : '#39d353';
    this.clutchBar.style.width = `${Math.round(p.clutchEngagement * 100)}%`;
    const clutchRow = this.root.querySelector('.clutch-row') as HTMLElement;
    clutchRow.style.display = p.spec.transmission === 'manual' ? 'flex' : 'none';
    this.lampsEl.innerHTML = [
      this.lampChip(!car.seatbelt, '#ff3b30', '⛊', t('seatbelt')),
      this.lampChip(this.input.state.handbrake, '#ff3b30', 'P', t('handbrake')),
      this.lampChip(car.headlights, '#39d353', '💡', t('headlights')),
      this.lampChip((car.indicator === -1 || car.hazard) && blink, '#39d353', '◀', ''),
      this.lampChip((car.indicator === 1 || car.hazard) && blink, '#39d353', '▶', ''),
      this.lampChip(!p.running, '#ff3b30', '⚙', t('engine_stalled')),
    ].join('');

    const pts = this.penaltyEl.querySelector('.p-pts')!;
    pts.textContent = `${t('penalty')}: ${penalty} ${t('points')}` + (fines ? ` · ${fines.toLocaleString()} ${t('money')}` : '');
    this.penaltyEl.style.color = penalty >= 20 ? '#ff3b30' : penalty >= 10 ? '#ffcc00' : '#fff';
    const regimeText: Record<string, string> = {
      regulator: t('regime_regulator'),
      light: t('regime_light'),
      permanent_sign: t('regime_signs'),
      temporary_sign: t('regime_signs'),
      equal: t('regime_equal'),
    };
    this.regimeEl.textContent = regimeText[regime] ?? '';

    if (limit !== this.lastLimit) {
      this.lastLimit = limit;
      this.limitValue.textContent = String(Math.round(limit));
      this.limitSign.classList.toggle('temporary', limit === 30);
      this.limitSign.setAttribute('aria-label', `${t('speed_limit')}: ${limit} km/h`);
    }
    this.updateCoach(car, p);
  }

  private updateCoach(car: PlayerCar, p: VehiclePhysics): void {
    if (this.coachStart === 0) this.coachStart = performance.now();
    if (!p.running) {
      this.coachEl.style.display = 'block';
      this.coachEl.className = 'drive-coach danger';
      this.coachEl.innerHTML = `<b>${t('engine_stalled')}</b>`;
      return;
    }
    const ready = p.gearLabel() !== 'N' && p.gearLabel() !== 'P';
    const elapsed = (performance.now() - this.coachStart) / 1000;
    if (car.seatbelt && ready && p.kmh > 8 && elapsed > 2) {
      this.coachEl.style.display = 'none';
      return;
    }
    if (elapsed > 18 && ready) {
      this.coachEl.style.display = 'none';
      return;
    }
    this.coachEl.className = 'drive-coach';
    this.coachEl.style.display = 'block';
    const item = (ok: boolean, text: string) => `<div class="coach-item ${ok ? 'done' : ''}"><span>${ok ? '✓' : '○'}</span>${text}</div>`;
    this.coachEl.innerHTML = `
      <b>${t('coach_title')}</b>
      ${item(car.seatbelt, t('coach_belt'))}
      ${item(ready, ready ? `${t('coach_ready')}: ${p.gearLabel()}` : (p.spec.transmission === 'automatic' ? t('coach_selector') : t('coach_manual')))}
      <div class="coach-controls">${t('coach_drive')} · ${t('coach_steer')}</div>
    `;
  }

  setStats(html: string): void {
    this.statsEl.innerHTML = html;
  }

  setNav(m: Manoeuvre | null): void {
    if (!m) {
      this.navEl.style.display = 'none';
      return;
    }
    this.navEl.style.display = 'flex';
    const icon = m.mov === 'left' ? '↰' : m.mov === 'right' ? '↱' : m.mov === 'uturn' ? '⟲' : m.mov === 'arrive' ? '🏁' : '↑';
    const key = m.mov === 'left' ? 'next_turn_left' : m.mov === 'right' ? 'next_turn_right' : m.mov === 'arrive' ? 'arrive' : 'next_straight';
    this.navEl.innerHTML = `<span class="nav-icon">${icon}</span><span>${t(key)}</span><span class="nav-dist">${Math.max(0, Math.round(m.distance))} m</span>`;
  }

  setMission(html: string | null): void {
    if (!html) {
      this.missionEl.style.display = 'none';
      return;
    }
    this.missionEl.style.display = 'block';
    this.missionEl.innerHTML = html;
  }

  /** Neutral message (mission progress, earnings). */
  toast(msg: string): void {
    const el = document.createElement('div');
    el.className = 'ticker-item good';
    el.textContent = msg;
    this.tickerEl.appendChild(el);
    setTimeout(() => el.classList.add('show'), 10);
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 500);
    }, 4200);
  }

  flashViolation(v: ViolationDef): void {
    const el = document.createElement('div');
    el.className = 'ticker-item';
    el.innerHTML = `<b>+${v.points}</b> ${tr(v.text)} <i>${tr(v.rule)}</i>`;
    this.tickerEl.appendChild(el);
    setTimeout(() => el.classList.add('show'), 10);
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 500);
    }, 4200);
  }

  dispose(): void {
    for (const fn of this.cleanup) fn();
    this.cleanup.length = 0;
    this.root.remove();
  }
}
