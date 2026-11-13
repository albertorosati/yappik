import React, { useState, useEffect, useRef, useCallback } from 'react';
import confetti from 'canvas-confetti';
import {
  Mic,
  FastForward,
  Check,
  Pause,
  Play,
  RotateCcw,
  ArrowRight,
  X,
} from 'lucide-react';
import {
  Category,
  DuelItem,
  GameSettings,
  PlayerConfig,
  SoloTrainingSummary,
} from '../types/game';
import { evaluateVoiceInput, PassCommandGuard } from '../engine/voiceMatcher';
import { SmartSpeechRecognizer } from '../engine/speechRecognition';
import { soundEngine } from '../engine/soundEffects';
import { hapticsService } from '../services/hapticsService';
import {
  getBackupImageUrl,
  getResolvedImageUrl,
  isImageCached,
  prepareArenaDeck,
  primeImage,
  getItemImagePool,
} from '../data/categories';
import { isRenderedImageHealthy, markItemSeen } from '../utils/itemUtils';
import { blacklistService } from '../services/blacklistService';
import { gameConfig } from '../services/configService';
import { soloScoreService } from '../services/soloScoreService';
import { t, localizePlayerName } from '../services/i18n';
import { TheFloorBackground } from './TheFloorBackground';
import { ScorePips } from './ScorePips';
import { FormattedTime } from './FormattedTime';
import { StreakBadge } from './StreakBadge';

interface SoloTrainingScreenProps {
  category: Category;
  player: PlayerConfig;
  settings: GameSettings;
  onBackToDraft: () => void;
  onBackToLobby: () => void;
}

export const SoloTrainingScreen: React.FC<SoloTrainingScreenProps> = ({
  category,
  player,
  settings,
  onBackToDraft,
  onBackToLobby,
}) => {
  const isFreeMode = settings.soloDurationSeconds === 0;
  const initialDuration = isFreeMode ? 0 : settings.soloDurationSeconds;

  const [deck, setDeck] = useState<DuelItem[]>(() =>
    prepareArenaDeck(category.items)
  );
  const [itemIndex, setItemIndex] = useState(0);
  const [timeRemaining, setTimeRemaining] = useState(
    isFreeMode ? 0 : settings.soloDurationSeconds
  );
  const [isPaused, setIsPaused] = useState(false);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [passPenaltyLeft, setPassPenaltyLeft] = useState(0);

  // Statistiche sessione
  const [totalCorrect, setTotalCorrect] = useState(0);
  const [totalPasses, setTotalPasses] = useState(0);
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [revealedAnswer, setRevealedAnswer] = useState<{
    tag: 'ANSWER' | 'YES';
    text: string;
    isPass: boolean;
  } | null>(null);
  const [passBurstVisible, setPassBurstVisible] = useState(false);

  // Microfono e riconoscimento
  const [isListening, setIsListening] = useState(false);
  const [micVolume, setMicVolume] = useState(0);
  const [liveTranscript, setLiveTranscript] = useState('');
  const [micErrorMsg, setMicErrorMsg] = useState<string | null>(null);

  // Immagini e preloading
  const [usingBackupUrl, setUsingBackupUrl] = useState(false);
  const brokenIdsRef = useRef<Set<string>>(new Set());
  const resolvedUrlsRef = useRef<Map<string, string>>(new Map());

  // Record personale
  const [initialPersonalBest] = useState<number>(() =>
    soloScoreService.getSoloBest(category.id)
  );
  const [summaryData, setSummaryData] = useState<SoloTrainingSummary | null>(
    null
  );
  const [showExitConfirm, setShowExitConfirm] = useState(false);

  const recognizerRef = useRef<SmartSpeechRecognizer | null>(null);
  const ignoreVoiceUntilRef = useRef<number>(0);
  const passGuardRef = useRef<PassCommandGuard>(new PassCommandGuard(320));
  const lastSecondBeepRef = useRef<number>(-1);

  useEffect(() => {
    if (isPaused || sessionEnded) {
      passGuardRef.current.cancel();
    }
  }, [isPaused, sessionEnded]);

  useEffect(() => {
    const guard = passGuardRef.current;
    return () => {
      guard.cancel();
    };
  }, []);

  const [photoOverride, setPhotoOverride] = useState<string | null>(null);
  const [reportToast, setReportToast] = useState(false);
  const reportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentItem = deck[itemIndex % deck.length];
  const rawDisplaySrc =
    photoOverride ||
    (usingBackupUrl
      ? getBackupImageUrl(currentItem.imageUrl)
      : resolvedUrlsRef.current.get(currentItem.id) ||
        getResolvedImageUrl(currentItem.imageUrl));
  const displaySrc = rawDisplaySrc;

  const [imageLoaded, setImageLoaded] = useState(() =>
    isImageCached(displaySrc)
  );

  // Gestione stato sincronizzato via ref per event loop e timer
  const stateRef = useRef({
    timeRemaining,
    isPaused,
    sessionEnded,
    passPenaltyLeft,
    totalCorrect,
    totalPasses,
    streak,
    bestStreak,
    isFreeMode,
    revealedAnswer,
    currentItem,
  });

  useEffect(() => {
    if (currentItem?.id) {
      markItemSeen(currentItem.id);
    }
  }, [currentItem?.id]);

  useEffect(() => {
    stateRef.current = {
      timeRemaining,
      isPaused,
      sessionEnded,
      passPenaltyLeft,
      totalCorrect,
      totalPasses,
      streak,
      bestStreak,
      isFreeMode,
      revealedAnswer,
      currentItem,
    };
  });

  // Precarica l'immagine corrente
  useEffect(() => {
    const cached = isImageCached(displaySrc);
    setImageLoaded(cached);
    if (!cached) {
      primeImage(displaySrc)
        .then((finalSrc) => {
          if (finalSrc && currentItem) {
            resolvedUrlsRef.current.set(currentItem.id, finalSrc);
          }
          setImageLoaded(true);
        })
        .catch(() => {
          if (!usingBackupUrl) {
            setUsingBackupUrl(true);
          } else {
            setImageLoaded(true);
          }
        });
    }
  }, [displaySrc, currentItem, usingBackupUrl]);

  // Rolling preloader per le immagini successive
  useEffect(() => {
    const preloadCount = gameConfig.options.preloaderWindowSize;
    for (let offset = 1; offset <= preloadCount; offset++) {
      const candidate = deck[(itemIndex + offset) % deck.length];
      if (
        !candidate ||
        brokenIdsRef.current.has(candidate.id) ||
        resolvedUrlsRef.current.has(candidate.id)
      ) {
        continue;
      }

      primeImage(candidate.imageUrl)
        .then((resolvedSrc) => {
          resolvedUrlsRef.current.set(candidate.id, resolvedSrc);
        })
        .catch(() => {
          brokenIdsRef.current.add(candidate.id);
        });
    }
  }, [deck, itemIndex]);

  // Passa all'immagine successiva
  const advanceToNextImage = useCallback(() => {
    ignoreVoiceUntilRef.current = Math.max(
      ignoreVoiceUntilRef.current,
      performance.now() + 250
    );
    recognizerRef.current?.consumeCurrentBuffer();
    setUsingBackupUrl(false);
    setPhotoOverride(null);
    setItemIndex((prev) => {
      let next = prev + 1;
      let safety = 0;
      while (
        next < deck.length &&
        brokenIdsRef.current.has(deck[next].id) &&
        safety < deck.length
      ) {
        next++;
        safety++;
      }
      if (next >= deck.length) {
        setDeck(prepareArenaDeck(category.items));
        return 0;
      }
      return next;
    });
  }, [deck, category.items]);

  // Gestione segnalazione foto inadatta/sbagliata
  const handleReportPhoto = useCallback(() => {
    if (!currentItem) return;

    blacklistService.flagImage(displaySrc, {
      itemId: currentItem.id,
      answer: currentItem.answer,
      reason: 'user_reported',
    });

    hapticsService.vibrateTap();

    // Rimborso del tempo perso sulla foto errata (+5s in modalità timer o -3s in free mode)
    if (isFreeMode) {
      setTimeRemaining(prev => Math.max(0, prev - 3));
    } else {
      setTimeRemaining(prev => Math.min(initialDuration, prev + 5));
    }

    setReportToast(true);
    if (reportTimerRef.current) clearTimeout(reportTimerRef.current);
    reportTimerRef.current = setTimeout(() => {
      setReportToast(false);
    }, 2000);

    // Salta subito alla foto successiva senza rimanere bloccati
    setPhotoOverride(null);
    setImageLoaded(false);
    advanceToNextImage();
  }, [currentItem, displaySrc, isFreeMode, initialDuration, advanceToNextImage]);

  // Risposta corretta
  // Risposta corretta (A1)
  const triggerCorrectGuess = useCallback(
    (heardText?: string) => {
      const st = stateRef.current;
      if (
        st.sessionEnded ||
        st.isPaused ||
        st.revealedAnswer !== null
      ) {
        return;
      }

      passGuardRef.current.cancel();
      ignoreVoiceUntilRef.current =
        performance.now() + 900;
      recognizerRef.current?.consumeCurrentBuffer();

      const newStreak = st.streak + 1;
      setStreak(newStreak);
      setBestStreak((b) => Math.max(b, newStreak));
      setTotalCorrect((c) => c + 1);

      soundEngine.playCorrectAnswer(newStreak);
      hapticsService.vibrateCorrect();

      if (
        newStreak >= 3 &&
        typeof window !== 'undefined' &&
        !window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ) {
        confetti({
          particleCount: newStreak >= 5 ? 28 : 16,
          spread: 55,
          origin: { x: 0.5, y: 0.55 },
          colors: ['#FFC933', '#19C37D', '#2F6BFF', '#FF3D6E'],
          disableForReducedMotion: true,
        });
      }

      if (heardText) {
        setLiveTranscript(heardText);
      }

      // Show sticker label overlapping bottom edge with green "YES" tag + canonical answer for 700ms
      setRevealedAnswer({
        tag: 'YES',
        text: st.currentItem.answer,
        isPass: false,
      });

      setTimeout(() => {
        if (stateRef.current.sessionEnded) return;
        setRevealedAnswer(null);
        advanceToNextImage();
      }, 700);
    },
    [advanceToNextImage]
  );

  // Passo (A1)
  const triggerPass = useCallback(() => {
    const st = stateRef.current;
    if (st.sessionEnded || st.isPaused || st.revealedAnswer !== null) return;

    passGuardRef.current.lockCooldown(2500);
    ignoreVoiceUntilRef.current =
      performance.now() + 1700;
    recognizerRef.current?.consumeCurrentBuffer();

    soundEngine.playPassPenalty();
    hapticsService.vibratePass();

    setStreak(0);
    setTotalPasses((p) => p + 1);

    if (!isFreeMode) {
      // Deduct -3s immediately
      setTimeRemaining((prev) =>
        Math.max(0, prev - settings.passPenaltySeconds)
      );
    }

    setPassBurstVisible(true);

    // Show sticker label overlapping bottom edge with red "ANSWER" tag for 1.4s
    setRevealedAnswer({
      tag: 'ANSWER',
      text: st.currentItem.answer,
      isPass: true,
    });

    setTimeout(() => {
      if (stateRef.current.sessionEnded) return;
      setRevealedAnswer(null);
      setPassBurstVisible(false);
      advanceToNextImage();
    }, 1400);
  }, [
    isFreeMode,
    settings.passPenaltySeconds,
    advanceToNextImage,
  ]);

  // Fine sessione allenamento
  const finishTrainingSession = useCallback(() => {
    const st = stateRef.current;
    if (st.sessionEnded) return;

    setSessionEnded(true);
    recognizerRef.current?.stop();
    soundEngine.playTimeOutBuzzer();
    hapticsService.vibrateVictory();

    // Show answer of last item
    setRevealedAnswer({
      tag: 'ANSWER',
      text: st.currentItem.answer,
      isPass: true,
    });

    const finalCorrect = st.totalCorrect;
    const finalBest = Math.max(st.bestStreak, st.streak);
    const saveResult = soloScoreService.saveSoloBest(
      category.id,
      finalCorrect
    );

    if (saveResult.isNewBest && finalCorrect > 0) {
      setTimeout(() => {
        soundEngine.playGrandFanfare();
        confetti({
          particleCount: 80,
          spread: 70,
          origin: { y: 0.6 },
          colors: ['#FFE66D', '#FF6B6B', '#4ECDC4', '#2E294E'],
        });
      }, 250);
    }

    setSummaryData({
      categoryId: category.id,
      categoryName: category.name,
      categoryIcon: category.icon,
      totalCorrect: finalCorrect,
      totalPasses: st.totalPasses,
      bestStreak: finalBest,
      durationSeconds: initialDuration,
      timeLeft: Math.max(0, st.timeRemaining),
      isNewPersonalBest: saveResult.isNewBest && finalCorrect > 0,
      previousBest: saveResult.previousBest,
    });
  }, [category, initialDuration]);

  // Restart rapido per riprovare la stessa categoria
  const handleRestart = () => {
    setDeck(prepareArenaDeck(category.items));
    setItemIndex(0);
    setTimeRemaining(isFreeMode ? 0 : settings.soloDurationSeconds);
    setIsPaused(false);
    setSessionEnded(false);
    setPassPenaltyLeft(0);
    setTotalCorrect(0);
    setTotalPasses(0);
    setStreak(0);
    setBestStreak(0);
    setRevealedAnswer(null);
    setPassBurstVisible(false);
    setSummaryData(null);
    setLiveTranscript('');
  };

  // Timer loop principale: frozen while revealedAnswer !== null
  useEffect(() => {
    if (sessionEnded || isPaused) return;

    const interval = setInterval(() => {
      const st = stateRef.current;
      // Clock is frozen while answer is revealed (A1)
      if (st.revealedAnswer !== null) return;

      if (isFreeMode) {
        // Modalità libera: conta verso l'alto come cronometro
        setTimeRemaining((prev) => prev + 0.1);
      } else {
        // Modalità con conto alla rovescia
        setTimeRemaining((prev) => {
          const next = prev - 0.1;
          if (next <= 0) {
            clearInterval(interval);
            finishTrainingSession();
            return 0;
          }

          // Segnale sonoro per gli ultimi secondi
          const wholeSec = Math.ceil(next);
          if (wholeSec <= 5 && wholeSec > 0 && wholeSec !== lastSecondBeepRef.current) {
            lastSecondBeepRef.current = wholeSec;
            soundEngine.playClockTick(true);
          }

          return next;
        });
      }
    }, 100);

    return () => clearInterval(interval);
  }, [sessionEnded, isPaused, isFreeMode, finishTrainingSession]);

  const processSpokenRef = useRef<
    (alternatives: string[], isFinal: boolean) => void
  >(() => {});

  processSpokenRef.current = (alternatives: string[], isFinal: boolean) => {
    const st = stateRef.current;
    if (st.sessionEnded || st.isPaused || st.revealedAnswer !== null) return;
    if (performance.now() < ignoreVoiceUntilRef.current) return;

    const bestTranscript = alternatives[0] || '';
    if (bestTranscript) {
      setLiveTranscript(bestTranscript);
    }

    const matchResult = evaluateVoiceInput(alternatives, st.currentItem, {
      isFinal,
    });

    if (matchResult.matched) {
      passGuardRef.current.cancel();
      triggerCorrectGuess(matchResult.matchedAlias || bestTranscript);
      return;
    }

    if (matchResult.isPassCommand) {
      passGuardRef.current.triggerIfAllowed(isFinal, triggerPass);
      return;
    }

    passGuardRef.current.cancel();
  };

  // Riconoscimento Vocale (sessione continua senza riavvii tra una foto e l'altra)
  useEffect(() => {
    if (sessionEnded || isPaused) {
      recognizerRef.current?.stop();
      return;
    }

    const rec = new SmartSpeechRecognizer(
      (alternatives, isFinal) => {
        processSpokenRef.current(alternatives, isFinal);
      },
      (listening, err) => {
        setIsListening(listening);
        if (err) setMicErrorMsg(err);
        else if (listening) setMicErrorMsg(null);
      },
      (vol) => setMicVolume(vol),
      settings.language || 'it'
    );

    const vocab = category.items.flatMap((i) => [
      i.answer,
      ...(i.aliases || []),
    ]);
    rec.setVocabulary(vocab);
    recognizerRef.current = rec;
    rec.start();

    return () => {
      rec.stop();
    };
  }, [sessionEnded, isPaused, settings.language, category.items]);

  // Scorciatoie da tastiera (Spazio per Passo, Invio per Esatto)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (sessionEnded) return;
      if (e.code === 'Space') {
        e.preventDefault();
        triggerPass();
      } else if (e.code === 'Enter') {
        e.preventDefault();
        triggerCorrectGuess();
      } else if (e.code === 'KeyP') {
        setIsPaused((p) => !p);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [sessionEnded, triggerPass, triggerCorrectGuess]);

  return (
    <div className="h-[100dvh] max-h-[100dvh] w-full relative overflow-hidden flex flex-col justify-between p-3 sm:p-5 select-none touch-none">
      {/* 1. Signature Floor Background */}
      <TheFloorBackground
        activeStage={isPaused ? 'modal' : 'neutral'}
        urgent={!isFreeMode && !isPaused && timeRemaining > 0 && timeRemaining <= 8}
      />

      {/* 2. Top Bar: Category name sticker left, Pause & Exit right */}
      <header className="relative z-10 max-w-[1100px] w-full mx-auto flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2 bg-paper border-[3px] border-ink rounded-full px-4 py-1.5 shadow-hard-sm -rotate-1 min-w-0">
          <span className="text-2xl sm:text-3xl shrink-0">{category.icon}</span>
          <h1 className="font-display font-black text-lg sm:text-xl text-ink truncate">
            {category.name}
          </h1>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setIsPaused((p) => !p)}
            className="btn-push px-4 py-2 rounded-xl bg-paper border-[3px] border-ink shadow-hard-sm text-ink font-display font-bold text-sm flex items-center gap-1.5"
            aria-label={isPaused ? t('arena.resume', settings.language) : t('arena.pause', settings.language)}
          >
            {isPaused ? <Play className="w-4 h-4 text-green" /> : <Pause className="w-4 h-4" />}
            <span>{isPaused ? t('arena.resume', settings.language) : t('arena.pause', settings.language)}</span>
          </button>

          <button
            type="button"
            onClick={() => setShowExitConfirm(true)}
            className="btn-push p-2 rounded-xl bg-paper border-[3px] border-ink shadow-hard-sm text-ink font-display font-bold text-sm"
            aria-label={t('solo.finishEarly', settings.language)}
            title={t('solo.finishEarly', settings.language)}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* 3. Main Stage: [Player Card] [Hero Photo] (Centered in 1100px container) */}
      <main className="relative z-10 max-w-[1100px] w-full mx-auto my-auto flex-1 flex flex-col lg:flex-row items-center justify-center gap-4 sm:gap-6 min-h-0">
        {/* Desktop Single Player Card (Left) */}
        <div className="hidden lg:flex w-64 min-h-[220px] p-5 rounded-card border-[3px] border-ink flex-col items-center justify-center gap-2 text-center bg-blue text-white shadow-hard-lifted tactile-lifted shrink-0 relative">
          {/* C3: Avatar 72px overlapping card's top edge */}
          <div className="absolute -top-9 left-1/2 -translate-x-1/2 z-20">
            <div
              className="w-[72px] h-[72px] rounded-full bg-paper border-[3px] border-ink flex items-center justify-center text-4xl shadow-hard-sm relative animate-avatar-hop ring-4 ring-yellow"
              style={{ outline: '4px solid #2F6BFF' }}
            >
              {player.avatar}
            </div>
          </div>

          <div className="mt-4 w-full">
            <span className="font-display font-black text-xl truncate block leading-tight max-w-full">
              {localizePlayerName(player.name, settings.language)}
            </span>
          </div>

          {/* Giant Timer (A2 Units) */}
          <div className="font-display font-black text-5xl xl:text-6xl tabular-nums tracking-tight my-2">
            <FormattedTime
              seconds={timeRemaining}
              decimals={isFreeMode ? 0 : 1}
            />
          </div>

          {/* Score count */}
          <div className="flex items-center gap-2 bg-paper/20 px-4 py-1.5 rounded-full border border-white/30 font-display font-black text-sm">
            <span>{totalCorrect} pts</span>
          </div>

          {streak >= 2 && (
            <div className="mt-1">
              <StreakBadge streak={streak} />
            </div>
          )}

          {/* Comic speech bubble with transcript pointing toward player */}
          {liveTranscript && (
            <div className="speech-bubble absolute -top-14 left-1/2 -translate-x-1/2 bg-yellow text-ink border-[3px] border-ink px-4 py-2 rounded-2xl shadow-hard font-display font-black text-sm whitespace-nowrap z-30">
              &ldquo;{liveTranscript}&rdquo;
            </div>
          )}
        </div>

        {/* Hero Photo: Real aspect ratio, max 58vh, 12px paper mat, alternating ±1deg tilt (C4) */}
        <div className="flex-1 min-h-0 w-full h-full max-h-[58vh] flex items-center justify-center relative">
          <div
            key={`${currentItem.id}-${itemIndex}`}
            style={{ transform: `rotate(${itemIndex % 2 === 0 ? '-1deg' : '1deg'})` }}
            className="p-3 bg-paper rounded-card border-[3px] border-ink shadow-hard max-h-full max-w-full flex items-center justify-center relative animate-photo-slap transition-transform duration-200"
          >
            {/* Report Bad Photo Quick Button (Top-Right on photo mat) */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handleReportPhoto();
              }}
              title={t('arena.reportTooltip', settings.language)}
              aria-label={t('arena.reportPhoto', settings.language)}
              className="absolute top-2 right-2 z-30 w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-paper/90 hover:bg-red/10 active:scale-95 border-2 border-ink flex items-center justify-center text-xs sm:text-sm text-ink/70 hover:text-red transition-all cursor-pointer shadow-sm select-none"
            >
              🚩
            </button>

            {/* Toast Notification when photo is reported */}
            {reportToast && (
              <div className="absolute top-3 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
                <div className="px-3.5 py-1.5 bg-yellow border-2 border-ink rounded-xl shadow-hard font-display font-black text-xs sm:text-sm text-ink animate-pop-in whitespace-nowrap">
                  {t('arena.photoReported', settings.language)}
                </div>
              </div>
            )}

            {/* PASS -3s Burst (A1, A2) */}
            {passBurstVisible && (
              <>
                <div className="absolute -inset-2 rounded-card border-[4px] border-red pointer-events-none z-20 animate-feedback-ring" />
                <div className="absolute inset-0 z-30 flex flex-col items-center justify-center pointer-events-none animate-pass-burst">
                  <div className="px-6 py-3 rounded-2xl bg-red text-white border-[3px] border-ink shadow-hard font-display font-black text-2xl sm:text-4xl -rotate-3">
                    PASS −3<span style={{ fontSize: '0.45em' }} className="lowercase ml-0.5 align-baseline">s</span>
                  </div>
                </div>
              </>
            )}

            {/* Correct Answer Shockwave Ring + Floating +1 Score Pop */}
            {revealedAnswer?.tag === 'YES' && (
              <>
                <div className="absolute -inset-2 rounded-card border-[4px] border-green pointer-events-none z-20 animate-feedback-ring" />
                <div className="absolute -top-5 right-4 z-50 px-3.5 py-1 rounded-full bg-green text-ink border-[3px] border-ink shadow-hard font-display font-black text-lg sm:text-xl pointer-events-none animate-score-float">
                  +1{streak >= 3 ? ` 🔥×${streak}` : '!'}
                </div>
              </>
            )}

            {/* The Photo with 12px mat */}
            <div className="w-full h-full min-h-[200px] min-w-[220px] flex items-center justify-center bg-paper/50 rounded-lg overflow-hidden relative">
              {!imageLoaded && (
                <div className="absolute inset-0 flex items-center justify-center bg-ink/5 animate-pulse rounded-lg">
                  <div className="w-8 h-8 rounded-full border-[3px] border-ink/20 border-t-ink animate-spin" />
                </div>
              )}
              <img
                key={displaySrc}
                src={displaySrc}
                alt={currentItem.answer}
                decoding="async"
                loading="eager"
                onLoad={(e) => {
                  const { naturalWidth, naturalHeight } = e.currentTarget;
                  if (!isRenderedImageHealthy(naturalWidth, naturalHeight)) {
                    const cleanPool = getItemImagePool(currentItem).filter(
                      (u) => u !== displaySrc
                    );
                    if (cleanPool.length > 0 && !photoOverride) {
                      setPhotoOverride(cleanPool[0]);
                      return;
                    }
                    brokenIdsRef.current.add(currentItem.id);
                    advanceToNextImage();
                    return;
                  }
                  setImageLoaded(true);
                }}
                onError={() => {
                  if (!usingBackupUrl) {
                    setUsingBackupUrl(true);
                  } else {
                    const cleanPool = getItemImagePool(currentItem).filter(
                      (u) => u !== displaySrc
                    );
                    if (cleanPool.length > 0 && !photoOverride) {
                      setUsingBackupUrl(false);
                      setPhotoOverride(cleanPool[0]);
                      return;
                    }
                    brokenIdsRef.current.add(currentItem.id);
                    advanceToNextImage();
                  }
                }}
                className={`max-w-full max-h-[52vh] w-auto h-auto object-contain rounded-lg transition-opacity duration-150 ${
                  imageLoaded ? 'opacity-100' : 'opacity-0'
                }`}
              />
            </div>

            {/* A1: Sticker Label Overlapping Bottom Edge of Photo */}
            {revealedAnswer && (
              <div
                className={`absolute -bottom-6 left-1/2 -translate-x-1/2 z-40 max-w-[92%] sm:max-w-[85%] bg-paper border-[3px] border-ink shadow-hard rounded-2xl px-4 py-2 sm:px-6 sm:py-3 flex items-center gap-3 animate-starburst-pop select-none ${
                  revealedAnswer.isPass ? '-rotate-1' : 'rotate-1'
                }`}
              >
                <span
                  className={`px-2.5 py-1 rounded-lg border-2 border-ink font-display font-black text-xs sm:text-sm uppercase tracking-wider shrink-0 ${
                    revealedAnswer.tag === 'YES'
                      ? 'bg-green text-ink'
                      : 'bg-red text-white'
                  }`}
                >
                  {revealedAnswer.tag === 'YES'
                    ? t('arena.yesTag', settings.language)
                    : t('arena.answerTag', settings.language)}
                </span>
                <span className="font-display font-black text-xl sm:text-2xl md:text-[28px] text-ink leading-tight truncate">
                  {revealedAnswer.text}
                </span>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Mobile Player Bar (Directly below photo on smaller screens) */}
      <div className="relative z-10 w-full max-w-[1100px] mx-auto my-2 lg:hidden shrink-0">
        <div className="p-3 rounded-card border-[3px] border-ink flex items-center justify-between gap-3 bg-blue text-white shadow-hard-lifted tactile-lifted">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="text-3xl shrink-0">{player.avatar}</span>
            <div className="min-w-0">
              <span className="font-display font-black text-sm truncate block leading-tight">
                {localizePlayerName(player.name, settings.language)}
              </span>
              <span className="text-xs font-bold opacity-90 block">
                {totalCorrect} pts
              </span>
            </div>
          </div>
          <FormattedTime
            seconds={timeRemaining}
            decimals={isFreeMode ? 0 : 1}
            className="text-3xl shrink-0"
          />
        </div>
      </div>

      {/* 4. Bottom Action Bar: Mic meter left, big Pass and Correct buttons right */}
      <div className="relative z-10 w-full max-w-[1100px] mx-auto shrink-0 card-paper p-3 sm:p-4 flex items-center justify-between gap-3">
        {/* Mic Meter & Status */}
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className="relative shrink-0">
            {isListening && micVolume > 0.12 && (
              <span className="absolute inset-0 rounded-xl bg-green/45 border-2 border-green pointer-events-none animate-mic-ripple" />
            )}
            <div
              aria-label="Microphone"
              className={`relative z-10 w-12 h-12 rounded-xl border-[3px] border-ink shadow-hard-sm flex items-center justify-center transition-colors ${
                isListening ? 'bg-green text-ink' : 'bg-paper text-ink'
              }`}
            >
              <Mic className="w-6 h-6" />
            </div>
          </div>

          {/* 3-Bar Volume Level Indicator */}
          <div className="flex items-end gap-1 h-9 px-2 py-1.5 bg-white border-[3px] border-ink rounded-lg shrink-0">
            <div
              className={`w-2.5 rounded-sm transition-all duration-75 ${
                micVolume > 0.05 ? 'bg-green h-full' : 'bg-ink/20 h-2'
              }`}
            />
            <div
              className={`w-2.5 rounded-sm transition-all duration-75 ${
                micVolume > 0.25 ? 'bg-yellow h-full' : 'bg-ink/20 h-3'
              }`}
            />
            <div
              className={`w-2.5 rounded-sm transition-all duration-75 ${
                micVolume > 0.55 ? 'bg-red h-full' : 'bg-ink/20 h-4'
              }`}
            />
          </div>

          <div className="min-w-0 flex-1">
            <div className="text-xs sm:text-sm font-display font-bold text-ink truncate">
              {liveTranscript ? (
                <span className="text-blue font-black">&ldquo;{liveTranscript}&rdquo;</span>
              ) : isListening ? (
                <span className="text-ink/80">{t('arena.listening', settings.language)}</span>
              ) : micErrorMsg ? (
                <span className="text-red font-bold">{micErrorMsg}</span>
              ) : (
                <span className="text-ink/60">{t('arena.micActive', settings.language)}</span>
              )}
            </div>
          </div>
        </div>

        {/* Action Buttons: Min 64x160px */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={triggerPass}
            disabled={revealedAnswer !== null}
            className="btn-push min-w-[130px] sm:min-w-[160px] min-h-[54px] sm:min-h-[64px] px-4 py-2.5 rounded-xl bg-paper text-ink font-display font-black text-base sm:text-lg border-[3px] border-ink shadow-hard flex items-center justify-center gap-2 disabled:opacity-50"
          >
            <FastForward className="w-5 h-5" />
            <span>
              Pass (−3<span style={{ fontSize: '0.45em' }} className="lowercase ml-0.5 align-baseline">s</span>)
            </span>
          </button>

          <button
            type="button"
            onClick={() => triggerCorrectGuess()}
            disabled={revealedAnswer !== null}
            className="btn-push min-w-[130px] sm:min-w-[160px] min-h-[54px] sm:min-h-[64px] px-4 py-2.5 rounded-xl bg-green text-ink font-display font-black text-base sm:text-lg border-[3px] border-ink shadow-hard flex items-center justify-center gap-2 disabled:opacity-50"
          >
            <Check className="w-6 h-6 stroke-[3]" />
            <span>{t('arena.correct', settings.language)}</span>
          </button>
        </div>
      </div>

      {/* Desktop Keyboard Hints */}
      <div className="relative z-10 hidden lg:block text-center text-xs text-paper/70 font-display font-bold mt-1">
        [Space] Pass • [Enter] Correct • [P] Pause
      </div>

      {/* Exit Confirm Modal */}
      {showExitConfirm && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <div className="card-paper max-w-sm w-full p-6 text-center flex flex-col items-center gap-4 animate-starburst-pop">
            <h3 className="font-display font-black text-2xl text-ink">
              {t('solo.exitConfirmTitle', settings.language)}
            </h3>
            <p className="text-sm font-sans text-ink/80 font-semibold">
              {t('solo.exitConfirmDesc', settings.language)}
            </p>
            <div className="grid grid-cols-2 gap-3 w-full pt-2">
              <button
                type="button"
                onClick={() => setShowExitConfirm(false)}
                className="btn-push py-2.5 rounded-xl bg-paper border-[3px] border-ink text-ink font-display font-bold text-sm shadow-hard-sm"
              >
                {t('solo.continueBtn', settings.language)}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowExitConfirm(false);
                  finishTrainingSession();
                }}
                className="btn-push py-2.5 rounded-xl bg-yellow border-[3px] border-ink text-ink font-display font-black text-sm shadow-hard-sm"
              >
                {t('solo.endNowBtn', settings.language)}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Training Results Modal */}
      {summaryData && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <div className="card-paper max-w-md w-full p-6 sm:p-8 text-center flex flex-col items-center gap-5 animate-starburst-pop relative">
            {/* Flat Confetti Elements */}
            <div className="absolute -top-4 -left-4 w-6 h-6 bg-yellow border-[3px] border-ink rotate-12 animate-confetti-flat" />
            <div className="absolute -top-3 -right-3 w-5 h-5 bg-red border-[3px] border-ink -rotate-12 animate-confetti-flat" />
            <div className="absolute -bottom-3 left-8 w-5 h-5 bg-blue border-[3px] border-ink rotate-45 animate-confetti-flat" />
            <div className="absolute -bottom-4 right-10 w-6 h-6 bg-green border-[3px] border-ink -rotate-6 animate-confetti-flat" />

            <div className="w-24 h-24 rounded-2xl bg-yellow border-[3px] border-ink shadow-hard flex items-center justify-center text-6xl shrink-0 -rotate-2">
              {summaryData.isNewPersonalBest ? '👑' : summaryData.categoryIcon}
            </div>

            <div>
              <span className="px-3.5 py-1 rounded-full bg-yellow border-[3px] border-ink font-display font-black text-xs uppercase tracking-wider text-ink inline-block mb-2">
                {summaryData.isNewPersonalBest
                  ? t('solo.newRecord', settings.language)
                  : t('solo.completed', settings.language)}
              </span>
              <h2 className="font-display font-black text-3xl sm:text-4xl text-ink">
                {summaryData.categoryName}
              </h2>
            </div>

            {/* Clean Stats Row without nested outlined cards */}
            <div className="w-full grid grid-cols-3 py-4 border-y-[3px] border-ink">
              <div className="text-center">
                <span className="text-xs font-bold text-ink/70 uppercase block mb-1">
                  {t('solo.correct', settings.language)}
                </span>
                <span className="font-display font-black text-3xl sm:text-4xl text-green">
                  {summaryData.totalCorrect}
                </span>
              </div>
              <div className="text-center border-x-[3px] border-ink">
                <span className="text-xs font-bold text-ink/70 uppercase block mb-1">
                  {t('solo.streak', settings.language)}
                </span>
                <span className="font-display font-black text-3xl sm:text-4xl text-yellow">
                  {summaryData.bestStreak}
                </span>
              </div>
              <div className="text-center">
                <span className="text-xs font-bold text-ink/70 uppercase block mb-1">
                  {t('solo.passes', settings.language)}
                </span>
                <span className="font-display font-black text-3xl sm:text-4xl text-red">
                  {summaryData.totalPasses}
                </span>
              </div>
            </div>

            {summaryData.previousBest > 0 && (
              <p className="text-xs font-sans text-ink/80 font-bold">
                {t('solo.previousBest', settings.language, { n: summaryData.previousBest })}
              </p>
            )}

            <div className="w-full flex flex-col gap-3 pt-2">
              <button
                type="button"
                onClick={handleRestart}
                className="btn-push btn-shine w-full py-3.5 px-5 rounded-xl bg-yellow text-ink font-display font-black text-base sm:text-lg border-[3px] border-ink shadow-hard flex items-center justify-center gap-2"
              >
                <RotateCcw className="w-5 h-5" />
                <span>{t('solo.playAgain', settings.language)}</span>
              </button>

              <button
                type="button"
                onClick={onBackToDraft}
                className="btn-push w-full py-3 px-5 rounded-xl bg-paper text-ink font-display font-bold text-sm sm:text-base border-[3px] border-ink shadow-hard flex items-center justify-center gap-2"
              >
                <span>{t('solo.changeCategory', settings.language)}</span>
                <ArrowRight className="w-4 h-4" />
              </button>

              <button
                type="button"
                onClick={onBackToLobby}
                className="text-xs font-sans font-bold text-ink/70 hover:text-ink pt-1"
              >
                {t('solo.backHome', settings.language)}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
