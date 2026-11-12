type SpeechCallback = (alternatives: string[], isFinal: boolean) => void;
type StatusCallback = (isListening: boolean, error?: string) => void;
type VolumeCallback = (level: number) => void;

interface IWindowSpeech extends Window {
  SpeechRecognition?: any;
  webkitSpeechRecognition?: any;
  SpeechGrammarList?: any;
  webkitSpeechGrammarList?: any;
}

export class SmartSpeechRecognizer {
  private recognition: any = null;
  private shouldBeRunning = false;
  private isListening = false;
  private onSpeech: SpeechCallback;
  private onStatus: StatusCallback;
  private onVolume?: VolumeCallback;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private volumeDecayTimer: ReturnType<typeof setTimeout> | null = null;

  // Tracciamento per tagliare le parole già consumate nella stessa frase continua
  private activeResultIndex = 0;
  private consumedResultIndex = -1;
  private consumedWords: string[] = [];
  private lastConsumedToken = '';
  private lastConsumedAt = 0;
  private latestRawTranscript = '';
  private language: 'it' | 'en' = 'it';
  private vocabulary: string[] = [];

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
      if (this.isListening) {
        this.stop();
        this.start();
      }
    }
  }

  public setVocabulary(phrases: string[]): void {
    this.vocabulary = phrases;
  }

  public static isSupported(): boolean {
    if (typeof window === 'undefined') return false;
    const win = window as unknown as IWindowSpeech;
    return Boolean(win.SpeechRecognition || win.webkitSpeechRecognition);
  }

  public start(): void {
    this.shouldBeRunning = true;
    this.consumedResultIndex = -1;
    this.consumedWords = [];
    this.latestRawTranscript = '';
    this.activeResultIndex = 0;
    this.createAndStartSession();
  }

  private createAndStartSession(): void {
    if (!this.shouldBeRunning) return;
    if (typeof window === 'undefined') return;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.recognition) {
      try {
        this.recognition.onstart = null;
        this.recognition.onresult = null;
        this.recognition.onerror = null;
        this.recognition.onend = null;
        this.recognition.abort();
      } catch {
        // Ignora
      }
      this.recognition = null;
    }

    const win = window as unknown as IWindowSpeech;
    const SpeechConstructor =
      win.SpeechRecognition || win.webkitSpeechRecognition;

    if (!SpeechConstructor) {
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

      if (this.vocabulary.length > 0) {
        try {
          const GrammarConstructor =
            win.SpeechGrammarList || win.webkitSpeechGrammarList;
          if (GrammarConstructor) {
            const speechList = new GrammarConstructor();
            const cleanPhrases = Array.from(
              new Set(
                this.vocabulary
                  .map((p) => p.replace(/[^\p{L}0-9\s]/gu, '').trim())
                  .filter((p) => p.length >= 2)
              )
            );
            if (cleanPhrases.length > 0) {
              const grammar = `#JSGF V1.0; grammar items; public <item> = ${cleanPhrases.join(
                ' | '
              )} ;`;
              speechList.addFromString(grammar, 1);
              rec.grammars = speechList;
            }
          }
        } catch {
          // Fallback trasparente se non supportato
        }
      }

      rec.onstart = () => {
        this.isListening = true;
        this.onStatus(true);
      };

      rec.onspeechstart = () => {
        this.pulseVolume(0.8);
      };

      rec.onspeechend = () => {
        this.pulseVolume(0);
      };

      rec.onresult = (event: any) => {
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
            }
          }

          const isConsumedIdx =
            this.consumedResultIndex === idx && this.consumedWords.length > 0;
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
            }
          }
        }
      };

      rec.onerror = (event: any) => {
        const err = event?.error;
        if (err === 'no-speech' || err === 'aborted') {
          // Normale durante brevi silenzi, non bloccare il loop
          return;
        }
        if (err === 'not-allowed' || err === 'service-not-allowed') {
          this.shouldBeRunning = false;
          this.isListening = false;
          this.onStatus(
            false,
            'Permesso microfono negato. Tocca l’icona del lucchetto nella barra per abilitarlo.'
          );
        } else {
          this.onStatus(this.isListening, `Avviso mic: ${err}`);
        }
      };

      rec.onend = () => {
        this.isListening = false;
        if (this.shouldBeRunning) {
          this.consumedResultIndex = -1;
          this.consumedWords = [];
          this.latestRawTranscript = '';
          // Ricrea una NUOVA istanza fresca (evita InvalidStateError su Chrome/Safari dopo il primo stop)
          this.restartTimer = setTimeout(() => {
            if (this.shouldBeRunning) {
              this.createAndStartSession();
            }
          }, 80);
        } else {
          this.onStatus(false);
        }
      };

      this.recognition = rec;
      rec.start();
    } catch {
      if (this.shouldBeRunning) {
        this.restartTimer = setTimeout(() => {
          if (this.shouldBeRunning) {
            this.createAndStartSession();
          }
        }, 300);
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
   * evitando che leggere revisioni ASR (punteggiatura, accenti, inserimento filler "eh passo")
   * causino il replay della risposta o del Passo precedente sull'immagine successiva.
   */
  private sliceAfterConsumedWords(fullTranscript: string): string {
    const rawWords = fullTranscript.trim().split(/\s+/).filter(Boolean);
    const consumedLen = this.consumedWords.length;
    if (rawWords.length <= consumedLen) {
      return '';
    }

    let sliceStart = consumedLen;
    if (this.lastConsumedToken) {
      const searchStart = Math.max(0, consumedLen - 1);
      const searchEnd = Math.min(rawWords.length - 1, consumedLen + 2);
      for (let i = searchEnd; i >= searchStart; i--) {
        const toks = this.tokenizeNormalized(rawWords[i]);
        if (toks[0] === this.lastConsumedToken) {
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
      const lastNorm = this.tokenizeNormalized(words[words.length - 1]);
      this.lastConsumedToken = lastNorm[lastNorm.length - 1] || '';
      this.lastConsumedAt = Date.now();
    }
  }

  public stop(): void {
    this.shouldBeRunning = false;
    this.isListening = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.volumeDecayTimer) {
      clearTimeout(this.volumeDecayTimer);
      this.volumeDecayTimer = null;
    }
    if (this.recognition) {
      try {
        this.recognition.onstart = null;
        this.recognition.onresult = null;
        this.recognition.onerror = null;
        this.recognition.onend = null;
        this.recognition.abort();
      } catch {
        // Ignora
      }
      this.recognition = null;
    }
    this.onStatus(false);
  }
}
