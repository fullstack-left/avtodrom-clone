// Procedural engine and tyre audio via the Web Audio API — no sample assets.
// Engine: two detuned sawtooth oscillators whose frequency tracks RPM through
// a synthetic firing order, plus a low rumble. Tyre scrub: filtered noise
// gated by the physics skid level. Indicator relay: short ticks.

import { VehiclePhysics } from './VehiclePhysics';

export class EngineAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engGain!: GainNode;
  private osc1!: OscillatorNode;
  private osc2!: OscillatorNode;
  private rumble!: OscillatorNode;
  private noise!: AudioBufferSourceNode;
  private scrubGain!: GainNode;
  private scrubFilter!: BiquadFilterNode;
  private started = false;
  private _enabled = true;

  get enabled(): boolean {
    return this._enabled;
  }
  setEnabled(v: boolean): void {
    this._enabled = v;
    if (this.master) this.master.gain.value = v ? 0.9 : 0;
  }

  /** Must be called from a user gesture (browser autoplay policy). */
  start(): void {
    if (this.started) return;
    this.started = true;
    const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this._enabled ? 0.9 : 0;
    this.master.connect(ctx.destination);

    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0.0;
    const shaper = ctx.createWaveShaper();
    shaper.curve = makeDistortion(6);
    this.engGain.connect(shaper).connect(this.master);

    this.osc1 = ctx.createOscillator();
    this.osc1.type = 'sawtooth';
    this.osc2 = ctx.createOscillator();
    this.osc2.type = 'square';
    this.rumble = ctx.createOscillator();
    this.rumble.type = 'triangle';
    const g2 = ctx.createGain();
    g2.gain.value = 0.4;
    const gr = ctx.createGain();
    gr.gain.value = 0.6;
    this.osc1.connect(this.engGain);
    this.osc2.connect(g2).connect(this.engGain);
    this.rumble.connect(gr).connect(this.engGain);
    this.osc1.start();
    this.osc2.start();
    this.rumble.start();

    // Tyre scrub noise.
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = ctx.createBufferSource();
    this.noise.buffer = buf;
    this.noise.loop = true;
    this.scrubFilter = ctx.createBiquadFilter();
    this.scrubFilter.type = 'bandpass';
    this.scrubFilter.frequency.value = 1400;
    this.scrubFilter.Q.value = 1.2;
    this.scrubGain = ctx.createGain();
    this.scrubGain.gain.value = 0;
    this.noise.connect(this.scrubFilter).connect(this.scrubGain).connect(this.master);
    this.noise.start();
  }

  resume(): void {
    this.ctx?.resume();
  }

  update(p: VehiclePhysics): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const rpm = p.running ? p.rpm : Math.max(0, p.rpm);
    const cyl = 4;
    const fire = (rpm / 60) * (cyl / 2); // firing events per second
    const f = Math.max(20, fire);
    this.osc1.frequency.setTargetAtTime(f, t, 0.03);
    this.osc2.frequency.setTargetAtTime(f * 2.01, t, 0.03);
    this.rumble.frequency.setTargetAtTime(f * 0.5, t, 0.05);
    const load = p.running ? 0.12 + 0.5 * Math.min(1, rpm / p.spec.redlineRpm) : 0;
    this.engGain.gain.setTargetAtTime(load, t, 0.08);
    const scrub = p.skid > 0.25 ? Math.min(0.5, (p.skid - 0.25) * 0.9) : 0;
    this.scrubGain.gain.setTargetAtTime(scrub, t, 0.05);
    this.scrubFilter.frequency.setTargetAtTime(900 + p.kmh * 12, t, 0.1);
  }

  tick(kind: 'on' | 'off'): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.frequency.value = kind === 'on' ? 2000 : 1300;
    o.type = 'square';
    g.gain.setValueAtTime(0.08, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    o.connect(g).connect(this.master);
    o.start();
    o.stop(t + 0.05);
  }

  horn(on: boolean): void {
    if (!this.ctx) return;
    if (on && !this.hornOsc) {
      const o = this.ctx.createOscillator();
      const o2 = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.frequency.value = 440;
      o2.frequency.value = 349;
      o.type = o2.type = 'sawtooth';
      g.gain.value = 0.25;
      o.connect(g);
      o2.connect(g);
      g.connect(this.master);
      o.start();
      o2.start();
      this.hornOsc = [o, o2, g];
    } else if (!on && this.hornOsc) {
      this.hornOsc[0].stop();
      this.hornOsc[1].stop();
      this.hornOsc = null;
    }
  }
  private hornOsc: [OscillatorNode, OscillatorNode, GainNode] | null = null;

  crash(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.3, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = 0.6;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 900;
    src.connect(f).connect(g).connect(this.master);
    src.start();
    src.stop(t + 0.3);
  }

  dispose(): void {
    this.ctx?.close();
    this.ctx = null;
    this.started = false;
  }
}

function makeDistortion(amount: number): Float32Array {
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / n) * 2 - 1;
    c[i] = ((Math.PI + amount) * x) / (Math.PI + amount * Math.abs(x));
  }
  return c;
}
