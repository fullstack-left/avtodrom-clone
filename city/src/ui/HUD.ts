// In-game HUD: speedometer, tachometer, gear, warning lamps (seatbelt, hand
// brake, headlights, indicators), current speed-limit sign, junction regime,
// live penalty / fine counter and violation ticker, mini-map, navigation
// instruction banner, and touch controls (steering wheel + pedals) on mobile.

import { PlayerCar } from '../vehicle/PlayerCar';
import { VehiclePhysics } from '../vehicle/VehiclePhysics';
import { InputManager } from '../input/InputManager';
import { Manoeuvre } from '../game/Navigator';
import { ViolationDef } from '../rules/PddKnowledge';
import { getLang, t, tr } from '../i18n';
import { signImageUrl } from '../world/SignTextures';
import { MiniMap } from './MiniMap';

export class HUD {
  root: HTMLDivElement;
  private speedEl!: HTMLDivElement;
  private gearEl!: HTMLDivElement;
  private rpmBar!: HTMLDivElement;
  private lampsEl!: HTMLDivElement;
  private limitEl!: HTMLImageElement;
  private regimeEl!: HTMLDivElement;
  private penaltyEl!: HTMLDivElement;
  private navEl!: HTMLDivElement;
  private tickerEl!: HTMLDivElement;
  private statsEl!: HTMLDivElement;
  private missionEl!: HTMLDivElement;
  minimap: MiniMap;
  private lastLimit = -1;

  constructor(private input: InputManager) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="hud-tl">
        <div class="hud-stats"></div>
      </div>
      <div class="hud-tr">
        <div class="hud-penalty"><span class="p-pts">0</span></div>
        <div class="hud-regime"></div>
      </div>
      <div class="hud-nav" style="display:none"></div>
      <div class="hud-mission" style="display:none"></div>
      <div class="hud-ticker"></div>
      <div class="hud-limit"><img alt="limit"/></div>
      <div class="hud-cluster">
        <div class="gauge speed"><div class="val"></div><div class="unit">km/h</div></div>
        <div class="rpm"><div class="rpm-fill"></div></div>
        <div class="gear"></div>
        <div class="lamps"></div>
      </div>
    `;
    this.statsEl = this.root.querySelector('.hud-stats')!;
    this.penaltyEl = this.root.querySelector('.hud-penalty')!;
    this.regimeEl = this.root.querySelector('.hud-regime')!;
    this.navEl = this.root.querySelector('.hud-nav')!;
    this.missionEl = this.root.querySelector('.hud-mission')!;
    this.tickerEl = this.root.querySelector('.hud-ticker')!;
    this.limitEl = this.root.querySelector('.hud-limit img')!;
    this.speedEl = this.root.querySelector('.gauge.speed .val')!;
    this.rpmBar = this.root.querySelector('.rpm-fill')!;
    this.gearEl = this.root.querySelector('.gear')!;
    this.lampsEl = this.root.querySelector('.lamps')!;
    this.minimap = new MiniMap();
    this.root.appendChild(this.minimap.canvas);
    if (input.hasTouch) this.buildTouch();
  }

  showPenalty(show: boolean): void {
    this.penaltyEl.style.display = show ? 'block' : 'none';
  }

  private buildTouch(): void {
    const wheel = document.createElement('div');
    wheel.className = 'touch-wheel';
    wheel.innerHTML = `<img src="./assets/ui/steering_wheel.png" alt="wheel"/>`;
    const img = wheel.querySelector('img')!;
    let cx = 0, active = false, angle = 0;
    const rectC = () => wheel.getBoundingClientRect();
    const start = (e: TouchEvent) => {
      active = true;
      const r = rectC();
      cx = r.left + r.width / 2;
      e.preventDefault();
    };
    const move = (e: TouchEvent) => {
      if (!active) return;
      const tx = e.touches[0].clientX;
      angle = Math.max(-1, Math.min(1, (cx - tx) / 90));
      this.input.touch.steer = angle;
      img.style.transform = `rotate(${-angle * 120}deg)`;
    };
    const end = () => {
      active = false;
      this.input.touch.steer = 0;
      img.style.transform = 'rotate(0deg)';
    };
    wheel.addEventListener('touchstart', start, { passive: false });
    wheel.addEventListener('touchmove', move, { passive: false });
    wheel.addEventListener('touchend', end);
    this.root.appendChild(wheel);

    const pedals = document.createElement('div');
    pedals.className = 'touch-pedals';
    const mkBtn = (label: string, cls: string, on: () => void, off: () => void) => {
      const b = document.createElement('div');
      b.className = 'touch-btn ' + cls;
      b.textContent = label;
      b.addEventListener('touchstart', (e) => {
        e.preventDefault();
        b.classList.add('down');
        on();
      });
      b.addEventListener('touchend', () => {
        b.classList.remove('down');
        off();
      });
      return b;
    };
    pedals.appendChild(mkBtn('▲', 'gas', () => (this.input.touch.throttle = 1), () => (this.input.touch.throttle = 0)));
    pedals.appendChild(mkBtn('▼', 'brk', () => (this.input.touch.brake = 1), () => (this.input.touch.brake = 0)));
    pedals.appendChild(mkBtn('P', 'hb', () => (this.input.touch.handbrake = true), () => (this.input.touch.handbrake = false)));
    this.root.appendChild(pedals);

    // Small action buttons for lights/indicators/camera.
    const acts = document.createElement('div');
    acts.className = 'touch-acts';
    const act = (label: string, fn: () => void) => {
      const b = document.createElement('div');
      b.className = 'touch-act';
      b.textContent = label;
      b.addEventListener('touchstart', (e) => {
        e.preventDefault();
        fn();
      });
      return b;
    };
    acts.appendChild(act('◀', () => ((this.input as any).edges.toggleIndicatorLeft = true)));
    acts.appendChild(act('▶', () => ((this.input as any).edges.toggleIndicatorRight = true)));
    acts.appendChild(act('💡', () => ((this.input as any).edges.toggleHeadlights = true)));
    acts.appendChild(act('🎥', () => ((this.input as any).edges.cycleCamera = true)));
    acts.appendChild(act('⇅', () => ((this.input as any).edges.gearUp = true)));
    acts.appendChild(act('B', () => ((this.input as any).edges.toggleSeatbelt = true)));
    this.root.appendChild(acts);
  }

  private lampChip(on: boolean, color: string, label: string): string {
    return `<span class="lamp ${on ? 'on' : ''}" style="--c:${color}">${label}</span>`;
  }

  update(car: PlayerCar, p: VehiclePhysics, penalty: number, fines: number, regime: string, limit: number, blink: boolean): void {
    this.speedEl.textContent = String(Math.round(p.kmh));
    this.gearEl.textContent = p.gearLabel();
    const frac = Math.min(1, p.rpm / p.spec.limiterRpm);
    this.rpmBar.style.width = (frac * 100).toFixed(0) + '%';
    this.rpmBar.style.background = frac > 0.88 ? '#ff3b30' : frac > 0.7 ? '#ffcc00' : '#39d353';
    this.lampsEl.innerHTML = [
      this.lampChip(!car.seatbelt && p.kmh > 3, '#ff3b30', '⛊'),
      this.lampChip(this.input.state.handbrake, '#ff3b30', 'P'),
      this.lampChip(car.headlights, '#39d353', '💡'),
      this.lampChip((car.indicator === -1 || car.hazard) && blink, '#39d353', '◀'),
      this.lampChip((car.indicator === 1 || car.hazard) && blink, '#39d353', '▶'),
      this.lampChip(!p.running, '#ff3b30', '⚙'),
    ].join('');
    const pts = this.penaltyEl.querySelector('.p-pts')!;
    pts.textContent = `${t('penalty')}: ${penalty} ${t('points')}` + (fines ? ` · ${fines.toLocaleString()} ${t('money')}` : '');
    (this.penaltyEl as HTMLElement).style.color = penalty >= 20 ? '#ff3b30' : penalty >= 10 ? '#ffcc00' : '#fff';
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
      const code = limit >= 70 ? '3.25' : `3.24-${limit}`;
      this.limitEl.src = limit >= 70 ? signImageUrl('3.24') : signImageUrl(code) || signImageUrl('3.24');
      this.limitEl.parentElement!.querySelector('span')?.remove();
      const span = document.createElement('span');
      span.textContent = String(limit);
      this.limitEl.parentElement!.appendChild(span);
    }
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
    el.innerHTML = `<b>+${v.points}</b> ${tr(v.text)} <i>(${tr(v.rule)})</i>`;
    this.tickerEl.appendChild(el);
    setTimeout(() => el.classList.add('show'), 10);
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 500);
    }, 4200);
  }

  dispose(): void {
    this.root.remove();
  }
}
