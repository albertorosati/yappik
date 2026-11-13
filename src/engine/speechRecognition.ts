type SpeechCallback = (alternatives: string[], isFinal: boolean) => void;
type StatusCallback = (isListening: boolean, error?: string) => void;
type VolumeCallback = (level: number) => void;

interface IWindowSpeech extends Window {
  SpeechRecognition?: any;
  webkitSpeechRecognition?: any;
}

const MAX_CONSECUTIVE_ERRORS = 5;
const SILENT_STALL_TIMEOUT_MS = 12000;

export class SmartSpeechRecognizer {
  private recognition: any = null;
  private shouldBeRunning = false;
  private isListening = false;
  private onSpeech: SpeechCallback;
  private onStatus: StatusCallback;
  private onVolume?: VolumeCallback;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private volumeDecayTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private visibilityListenerAttached = false;

  // Tracciamento per tagliare le parole già consumate nella stessa frase continua
  private activeResultIndex = 0;
  private consumedResultIndex = -1;
  private consumedWords: string[] = [];
  private consumedNormTokens: string[] = [];
  private lastConsumedToken = '';
  private lastConsumedAt = 0;
  private latestRawTranscript = '';
  private language: 'it' | 'en' = 'it';
  private consecutiveErrors = 0;
  private lastActivityAt = 0;
  private sessionStartedAt = 0;

  constructor(
    onSpeech: SpeechCallback,
    onStatus: StatusCallback,
    onVolume?: VolumeCallback,
    language: 'it' | 'en' = 'it'
  ) {
    this.onSpeech = onSpeech;
    this.onStatus = onStatus;
    this.onVolume = onVolume;
    this.language = language;
  }

  public setLanguage(lang: 'it' | 'en'): void {
    if (this.language !== lang) {
      this.language = lang;
      if (this.shouldBeRunning) {
        this.stop();
        this.start();
      }
    }
  }

  public setVocabulary(_phrases: string[]): void {
    // Mantenuto per compatibilità API: SpeechGrammarList JSGF è deprecato e genera errori bad-grammar su Chrome
  }

  public static isSupported(): boolean {
    if (typeof window === 'undefined') return false;
    const win = window as unknown as IWindowSpeech;
    return Boolean(win.SpeechRecognition || win.webkitSpeechRecognition);
  }

  public start(): void {
    this.shouldBeRunning = true;
    this.consecutiveErrors = 0;
    this.consumedResultIndex = -1;
    this.consumedWords = [];
    this.consumedNormTokens = [];
    this.latestRawTranscript = '';
    this.activeResultIndex = 0;
    this.lastActivityAt = Date.now();
    this.startWatchdog();
    this.attachVisibilityListener();
    this.createAndStartSession();
  }

  private handleVisibilityChange = (): void => {
    if (
      typeof document !== 'undefined' &&
      document.visibilityState === 'visible' &&
      this.shouldBeRunning &&
      !this.isListening
    ) {
      this.lastActivityAt = Date.now();
      this.createAndStartSession();
    }
  };

  private attachVisibilityListener(): void {
    if (typeof document === 'undefined' || this.visibilityListenerAttached) return;
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    this.visibilityListenerAttached = true;
  }

  private detachVisibilityListener(): void {
    if (typeof document === 'undefined' || !this.visibilityListenerAttached) return;
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.visibilityListenerAttached = false;
  }

  private startWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
    }
    this.watchdogTimer = setInterval(() => {
      if (!this.shouldBeRunning || !this.isListening) return;
      if (Date.now() - this.lastActivityAt > SILENT_STALL_TIMEOUT_MS) {
        this.lastActivityAt = Date.now();
        this.createAndStartSession();
      }
    }, 4000);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private cleanupRecognitionInstance(): void {
    if (!this.recognition) return;
    try {
      this.recognition.onstart = null;
      this.recognition.onsoundstart = null;
      this.recognition.onsoundend = null;
      this.recognition.onspeechstart = null;
      this.recognition.onspeechend = null;
      this.recognition.onresult = null;
      this.recognition.onerror = null;
      this.recognition.onend = null;
      this.recognition.abort();
    } catch {
      // Ignora
    }
    this.recognition = null;
  }

  private scheduleRestart(baseDelayMs: number): void {
    if (!this.shouldBeRunning) return;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.shouldBeRunning) {
        this.createAndStartSession();
      }
    }, baseDelayMs);
  }

  private createAndStartSession(): void {
    if (!this.shouldBeRunning) return;
    if (typeof window === 'undefined') return;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    this.cleanupRecognitionInstance();

    const win = window as unknown as IWindowSpeech;
    const SpeechConstructor =
      win.SpeechRecognition || win.webkitSpeechRecognition;

    if (!SpeechConstructor) {
      this.shouldBeRunning = false;
      this.stopWatchdog();
      this.onStatus(
        false,
        'Riconoscimento vocale non supportato da questo browser (Usa Chrome, Safari o Edge).'
      );
      return;
    }

    try {
      const rec = new SpeechConstructor();
      rec.lang = this.language === 'en' ? 'en-US' : 'it-IT';

      // Su iOS Safari il flag continuous: true provoca spesso l'abort immediato dell'audio engine
      const isIOS =
        typeof navigator !== 'undefined' &&
        (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
          (navigator.platform === 'MacIntel' &&
            Boolean((navigator as any).maxTouchPoints && (navigator as any).maxTouchPoints > 1)));

      rec.continuous = !isIOS;
      rec.interimResults = true;
      rec.maxAlternatives = 5;

      rec.onstart = () => {
        this.isListening = true;
        this.sessionStartedAt = Date.now();
        this.lastActivityAt = Date.now();
        this.onStatus(true);
      };

      rec.onsoundstart = () => {
        this.lastActivityAt = Date.now();
        this.pulseVolume(0.45);
      };

      rec.onsoundend = () => {
        this.pulseVolume(0);
      };

      rec.onspeechstart = () => {
        this.lastActivityAt = Date.now();
        this.consecutiveErrors = 0;
        this.pulseVolume(0.8);
      };

      rec.onspeechend = () => {
        this.pulseVolume(0);
      };

      rec.onresult = (event: any) => {
        this.lastActivityAt = Date.now();
        this.consecutiveErrors = 0;
        this.pulseVolume(1.0);
        const startIdx = event.resultIndex ?? 0;
        const totalResults = event.results?.length ?? 0;
        if (totalResults === 0) return;

        for (let idx = startIdx; idx < totalResults; idx++) {
          const result = event.results[idx];
          if (!result) continue;

          if (idx !== this.activeResultIndex) {
            this.activeResultIndex = idx;
            this.latestRawTranscript = '';
            if (this.consumedResultIndex < idx) {
              this.consumedResultIndex = -1;
              this.consumedWords = [];
              this.consumedNormTokens = [];
            }
          }

          const isConsumedIdx =
            this.consumedResultIndex === idx &&
            (this.consumedWords.length > 0 || this.consumedNormTokens.length > 0);
          const isPostConsumeEchoWindow =
            idx > this.consumedResultIndex &&
            this.lastConsumedToken.length > 0 &&
            Date.now() - this.lastConsumedAt < 1800;
          const alternatives: string[] = [];

          for (let i = 0; i < result.length; i++) {
            const fullTranscript: string = result[i].transcript || '';
            if (i === 0) {
              this.latestRawTranscript = fullTranscript;
            }

            let sliced = isConsumedIdx
              ? this.sliceAfterConsumedWords(fullTranscript)
              : fullTranscript.trim();

            if (isPostConsumeEchoWindow && sliced.length > 0) {
              const normTokens = this.tokenizeNormalized(sliced);
              if (
                normTokens.length === 1 &&
                normTokens[0] === this.lastConsumedToken
              ) {
                sliced = '';
              }
            }

            if (sliced.length > 0) {
              alternatives.push(sliced);
            }
          }

          if (alternatives.length > 0) {
            this.onSpeech(alternatives, Boolean(result.isFinal));
          }

          if (result.isFinal) {
            this.latestRawTranscript = '';
            if (this.consumedResultIndex === idx) {
              this.consumedResultIndex = -1;
              this.consumedWords = [];
              this.consumedNormTokens = [];
            }
          }
        }
      };

      rec.onerror = (event: any) => {
        const err = event?.error;
        if (err === 'no-speech' || err === 'aborted') {
          this.lastActivityAt = Date.now();
          return;
        }
        if (err === 'not-allowed' || err === 'service-not-allowed') {
          this.shouldBeRunning = false;
          this.isListening = false;
          this.stopWatchdog();
          this.onStatus(
            false,
            'Permesso microfono negato. Tocca l’icona del lucchetto nella barra per abilitarlo.'
          );
          return;
        }

        this.consecutiveErrors += 1;
        if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          this.shouldBeRunning = false;
          this.isListening = false;
          this.stopWatchdog();
          this.onStatus(
            false,
            `Microfono interrotto (${err}). Tocca il pulsante mic o i tasti per continuare.`
          );
        } else {
          this.onStatus(
            this.isListening,
            `Avviso mic: ${err} (tentativo ${this.consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})`
          );
        }
      };

      rec.onend = () => {
        this.isListening = false;
        if (this.shouldBeRunning) {
          if (
            this.sessionStartedAt > 0 &&
            Date.now() - this.sessionStartedAt > 3000 &&
            this.consecutiveErrors > 0
          ) {
            this.consecutiveErrors = 0;
          }
          this.consumedResultIndex = -1;
          this.consumedWords = [];
          this.consumedNormTokens = [];
          this.latestRawTranscript = '';
          const delayMs =
            this.consecutiveErrors > 0
              ? Math.min(2500, 150 * Math.pow(2, this.consecutiveErrors - 1))
              : 80;
          // Ricrea una NUOVA istanza fresca (evita InvalidStateError su Chrome/Safari dopo il primo stop)
          this.scheduleRestart(delayMs);
        } else {
          this.onStatus(false);
        }
      };

      this.recognition = rec;
      rec.start();
    } catch {
      this.consecutiveErrors += 1;
      if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        this.shouldBeRunning = false;
        this.isListening = false;
        this.stopWatchdog();
        this.onStatus(false, 'Impossibile avviare il microfono. Usa i pulsanti a schermo.');
      } else if (this.shouldBeRunning) {
        const delayMs = Math.min(3000, 300 * Math.pow(2, this.consecutiveErrors - 1));
        this.scheduleRestart(delayMs);
      }
    }
  }

  private pulseVolume(target: number): void {
    if (!this.onVolume) return;
    this.onVolume(target);
    if (this.volumeDecayTimer) {
      clearTimeout(this.volumeDecayTimer);
    }
    if (target > 0) {
      this.volumeDecayTimer = setTimeout(() => {
        this.onVolume?.(0);
      }, 450);
    }
  }

  private tokenizeNormalized(text: string): string[] {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  }

  /**
   * Taglia in modo sicuro tutte le parole già consumate sullo stesso resultIndex,
   * confrontando anche i token normalizzati per evitare leak sulle alternatives[1..4].
   */
  private sliceAfterConsumedWords(fullTranscript: string): string {
    const rawWords = fullTranscript.trim().split(/\s+/).filter(Boolean);
    if (rawWords.length === 0) return '';

    const consumedNormLen = this.consumedNormTokens.length;
    const consumedJoined = this.consumedNormTokens.join('');

    let sliceStart = 0;
    if (consumedNormLen > 0) {
      const normAccum: string[] = [];
      let accumJoined = '';
      for (let i = 0; i < rawWords.length; i++) {
        const wordTokens = this.tokenizeNormalized(rawWords[i]);
        normAccum.push(...wordTokens);
        accumJoined += wordTokens.join('');
        if (
          normAccum.length >= consumedNormLen ||
          (consumedJoined.length > 0 && accumJoined === consumedJoined)
        ) {
          sliceStart = i + 1;
          break;
        }
      }
      if (sliceStart === 0 && normAccum.length < consumedNormLen) {
        return '';
      }
    } else if (rawWords.length <= this.consumedWords.length) {
      return '';
    } else {
      sliceStart = this.consumedWords.length;
    }

    if (this.lastConsumedToken) {
      const searchStart = Math.max(0, sliceStart - 2);
      const searchEnd = Math.min(rawWords.length - 1, sliceStart + 2);
      for (let i = searchEnd; i >= searchStart; i--) {
        const toks = this.tokenizeNormalized(rawWords[i]);
        if (toks[toks.length - 1] === this.lastConsumedToken || toks[0] === this.lastConsumedToken) {
          sliceStart = Math.max(sliceStart, i + 1);
          break;
        }
      }
    }

    if (sliceStart >= rawWords.length) {
      return '';
    }
    return rawWords.slice(sliceStart).join(' ').trim();
  }

  /**
   * Segna il testo parlato finora come "già consumato" (appena qualcuno indovina o passa),
   * così che le parole appena pronunciate non vengano rianalizzate sulla nuova immagine!
   */
  public consumeCurrentBuffer(): void {
    const words = this.latestRawTranscript
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (words.length > 0) {
      this.consumedResultIndex = this.activeResultIndex;
      this.consumedWords = words;
      this.consumedNormTokens = this.tokenizeNormalized(this.latestRawTranscript);
      this.lastConsumedToken =
        this.consumedNormTokens[this.consumedNormTokens.length - 1] || '';
      this.lastConsumedAt = Date.now();
    }
  }

  public stop(): void {
    this.shouldBeRunning = false;
    this.isListening = false;
    this.stopWatchdog();
    this.detachVisibilityListener();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.volumeDecayTimer) {
      clearTimeout(this.volumeDecayTimer);
      this.volumeDecayTimer = null;
    }
    this.cleanupRecognitionInstance();
    this.onStatus(false);
  }
}
