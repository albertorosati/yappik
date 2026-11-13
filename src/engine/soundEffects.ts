import type { AppLanguage } from '../types/game';

class SoundEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private outputNode: AudioNode | null = null;
  public enabled = true;
  public announcerEnabled = true;

  private ensureContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
        const gain = this.ctx.createGain();
        gain.gain.value = 0.85;
        if (typeof this.ctx.createDynamicsCompressor === 'function') {
          const comp = this.ctx.createDynamicsCompressor();
          comp.threshold.value = -14;
          comp.knee.value = 18;
          comp.ratio.value = 6;
          comp.attack.value = 0.003;
          comp.release.value = 0.15;
          gain.connect(comp);
          comp.connect(this.ctx.destination);
        } else {
          gain.connect(this.ctx.destination);
        }
        this.masterGain = gain;
        this.outputNode = gain;
      }
    }
    if (this.ctx) {
      const state = this.ctx.state as string;
      if (state === 'suspended' || state === 'interrupted') {
        this.ctx.resume().catch(() => {});
      }
    }
    return this.ctx;
  }

  private getContext(): AudioContext | null {
    if (!this.enabled) return null;
    return this.ensureContext();
  }

  private getDestination(ctx: AudioContext): AudioNode {
    return this.outputNode || ctx.destination;
  }

  /** Sblocca esplicitamente AudioContext al primo tap (necessario su iOS Safari) */
  public unlock(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    if (this.masterGain && ctx.state === 'running') {
      try {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, ctx.currentTime);
        osc.connect(g);
        g.connect(this.getDestination(ctx));
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.01);
      } catch {
        // Ignora
      }
    }
  }

  /** Tick del Randomizer sulla griglia */
  public playRandomizerStep(pitchFactor = 1): void {
    const ctx = this.getContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(320 * pitchFactor, now);
    osc.frequency.exponentialRampToValueAtTime(640 * pitchFactor, now + 0.06);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.18, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);

    osc.connect(gain);
    gain.connect(this.getDestination(ctx));
    osc.start(now);
    osc.stop(now + 0.075);
  }

  /** Suono drammatico quando viene scelta la casella da sfidare */
  public playChallengeLocked(): void {
    const ctx = this.getContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const freqs = [220, 277.18, 329.63, 440];
    freqs.forEach((f, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      const start = now + idx * 0.05;
      osc.frequency.setValueAtTime(f, start);

      gain.gain.setValueAtTime(0.001, start);
      gain.gain.linearRampToValueAtTime(0.14, start + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.55);

      osc.connect(gain);
      gain.connect(this.getDestination(ctx));
      osc.start(start);
      osc.stop(start + 0.56);
    });
  }

  /** Beep del conto alla rovescia 3 - 2 - 1 - VIA! */
  public playCountdownBeep(isGo = false): void {
    const ctx = this.getContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = isGo ? 'sawtooth' : 'sine';
    const baseFreq = isGo ? 880 : 440;
    osc.frequency.setValueAtTime(baseFreq, now);
    if (isGo) {
      osc.frequency.exponentialRampToValueAtTime(1320, now + 0.25);
    }

    const duration = isGo ? 0.38 : 0.16;
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.24, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    osc.connect(gain);
    gain.connect(this.getDestination(ctx));
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  /** Jingle cristallino di RISPOSTA ESATTA (sale di tono con la streak e aggiunge armoniche arcade su combo!) */
  public playCorrectAnswer(streak = 1): void {
    const ctx = this.getContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const boost = Math.min(streak - 1, 8) * 45;
    const notes = [
      523.25 + boost,
      659.25 + boost,
      783.99 + boost,
      1046.5 + boost,
      ...(streak >= 3 ? [1318.51 + boost] : []),
      ...(streak >= 5 ? [1567.98 + boost] : []),
    ];

    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = streak >= 3 ? 'sine' : 'triangle';
      const start = now + i * 0.048;
      osc.frequency.setValueAtTime(freq, start);

      const vol = streak >= 5 ? 0.22 : streak >= 3 ? 0.2 : 0.18;
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.linearRampToValueAtTime(vol, start + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.28);

      osc.connect(gain);
      gain.connect(this.getDestination(ctx));
      osc.start(start);
      osc.stop(start + 0.3);
    });
  }

  /** Suono di PASSO (penalità 3 secondi) */
  public playPassPenalty(): void {
    const ctx = this.getContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(190, now);
    osc.frequency.linearRampToValueAtTime(130, now + 0.28);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.2, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

    osc.connect(gain);
    gain.connect(this.getDestination(ctx));
    osc.start(now);
    osc.stop(now + 0.32);
  }

  /** Buzzer drammatico da Game Show TV per TEMPO SCADUTO */
  public playTimeOutBuzzer(): void {
    const ctx = this.getContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    // Doppio oscillatore sawtooth scordato per il classico buzz TV
    [135, 142].forEach((freq) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, now);
      osc.frequency.linearRampToValueAtTime(freq * 0.75, now + 0.55);

      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(0.22, now + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.58);

      osc.connect(gain);
      gain.connect(this.getDestination(ctx));
      osc.start(now);
      osc.stop(now + 0.6);
    });

    // Sub-bass hit per dare peso e impatto
    const subOsc = ctx.createOscillator();
    const subGain = ctx.createGain();
    subOsc.type = 'sine';
    subOsc.frequency.setValueAtTime(85, now);
    subOsc.frequency.exponentialRampToValueAtTime(35, now + 0.5);
    subGain.gain.setValueAtTime(0.001, now);
    subGain.gain.linearRampToValueAtTime(0.3, now + 0.006);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.52);

    subOsc.connect(subGain);
    subGain.connect(this.getDestination(ctx));
    subOsc.start(now);
    subOsc.stop(now + 0.55);
  }

  /** Jingle di svelamento dell'ultima risposta non data (leggermente sfalsato rispetto al buzzer) */
  public playRevealAnswer(): void {
    const ctx = this.getContext();
    if (!ctx) return;

    const now = ctx.currentTime + 0.28;
    const revealNotes = [349.23, 440.0, 523.25, 698.46, 880.0];
    revealNotes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      const start = now + i * 0.06;
      osc.frequency.setValueAtTime(freq, start);

      gain.gain.setValueAtTime(0.001, start);
      gain.gain.linearRampToValueAtTime(0.16, start + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.45);

      osc.connect(gain);
      gain.connect(this.getDestination(ctx));
      osc.start(start);
      osc.stop(start + 0.48);
    });
  }

  /** Grande fanfara trionfale per la vittoria del giocatore nel duello */
  public playGrandFanfare(): void {
    const ctx = this.getContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    // Riff trionfale da ottoni di Game Show: C4 - E4 - G4 - C5 tenuto
    const melody = [
      { f: 261.63, t: 0.0, d: 0.12 },
      { f: 329.63, t: 0.13, d: 0.12 },
      { f: 392.0, t: 0.26, d: 0.14 },
      { f: 523.25, t: 0.42, d: 0.55 },
      { f: 659.25, t: 0.42, d: 0.55 },
      { f: 783.99, t: 0.42, d: 0.55 },
    ];

    melody.forEach(({ f, t, d }) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      const start = now + t;
      osc.frequency.setValueAtTime(f, start);

      gain.gain.setValueAtTime(0.001, start);
      gain.gain.linearRampToValueAtTime(0.15, start + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.001, start + d);

      osc.connect(gain);
      gain.connect(this.getDestination(ctx));
      osc.start(start);
      osc.stop(start + d + 0.02);
    });
  }

  /** Ticchettio dell'orologio durante il duello (più incalzante sotto i 10 secondi) */
  public playClockTick(urgent = false): void {
    const ctx = this.getContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(urgent ? 920 : 600, now);
    osc.frequency.exponentialRampToValueAtTime(urgent ? 420 : 300, now + 0.035);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(urgent ? 0.14 : 0.06, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);

    osc.connect(gain);
    gain.connect(this.getDestination(ctx));
    osc.start(now);
    osc.stop(now + 0.045);
  }

  /** Conquista del territorio e fine duello */
  public playDuelVictory(): void {
    const ctx = this.getContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const chord = [261.63, 329.63, 392.0, 523.25, 659.25];
    chord.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      const start = now + idx * 0.07;
      osc.frequency.setValueAtTime(freq, start);

      gain.gain.setValueAtTime(0.001, start);
      gain.gain.linearRampToValueAtTime(0.16, start + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.75);

      osc.connect(gain);
      gain.connect(this.getDestination(ctx));
      osc.start(start);
      osc.stop(start + 0.78);
    });
  }

  /** Annunciatore vocale TV (solo fuori dal riconoscimento attivo per non interferire col mic!) */
  public speakAnnouncement(text: string, language: AppLanguage = 'it'): void {
    if (!this.enabled || !this.announcerEnabled) return;
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = language === 'en' ? 'en-US' : 'it-IT';
      utter.rate = 1.08;
      utter.pitch = 0.95;
      window.speechSynthesis.speak(utter);
    } catch {
      // Ignora
    }
  }

  public stopAnnouncements(): void {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Ignora
      }
    }
  }
}

export const soundEngine = new SoundEngine();
