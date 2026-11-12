import React, { useState, useEffect, useRef, useCallback } from 'react';
import confetti from 'canvas-confetti';
import {
  Mic,
  FastForward,
  Check,
  Pause,
  Play,
  ArrowRight,
  X,
  Smartphone,
} from 'lucide-react';
import {
  Category,
  DuelItem,
  DuelSummary,
  GameSettings,
  PlayerConfig,
  PlayerId,
  RemoteMicPacket,
} from '../types/game';
import { evaluateVoiceInput } from '../engine/voiceMatcher';
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
import { isRenderedImageHealthy } from '../utils/itemUtils';
import { blacklistService } from '../services/blacklistService';
import { gameConfig } from '../services/configService';
import { t, localizePlayerName } from '../services/i18n';
import { TheFloorBackground } from './TheFloorBackground';
import { FormattedTime } from './FormattedTime';
import { StreakBadge } from './StreakBadge';
import { InlineCrown } from './InlineCrown';
import { PhoneMicModal } from './PhoneMicModal';

interface DuelArenaScreenProps {
  roundNumber: number;
  category: Category;
  p1: PlayerConfig;
  p2: PlayerConfig;
  initialPlayer: PlayerId;
  settings: GameSettings;
  p2RemoteConnected: boolean;
  latestRemotePacket: RemoteMicPacket | null;
  onSendRemoteState: (packet: RemoteMicPacket) => void;
  onDuelFinished: (summary: DuelSummary) => void;
  isDiscordActivity?: boolean;
  roomCode?: string;
}

export const DuelArenaScreen: React.FC<DuelArenaScreenProps> = ({
  roundNumber,
  category,
  p1,
  p2,
  initialPlayer,
  settings,
  p2RemoteConnected,
  latestRemotePacket,
  onSendRemoteState,
  onDuelFinished,
  isDiscordActivity = false,
  roomCode = '',
}) => {
  const [deck, setDeck] = useState<DuelItem[]>(() =>
    prepareArenaDeck(category.items)
  );
  const [itemIndex, setItemIndex] = useState(0);
  const [activePlayer, setActivePlayer] = useState<PlayerId>(initialPlayer);

  const [timeP1, setTimeP1] = useState(settings.duelDurationSeconds);
  const [timeP2, setTimeP2] = useState(settings.duelDurationSeconds);
  const [isPaused, setIsPaused] = useState(false);

  // A1: Sticker label overlapping bottom edge on Pass (1.4s), Correct (700ms), and Timeout
  const [revealedAnswer, setRevealedAnswer] = useState<{
    tag: 'ANSWER' | 'YES';
    text: string;
    isPass: boolean;
  } | null>(null);

  // PASS -3s burst
  const [passBurstVisible, setPassBurstVisible] = useState(false);

  // Separate player stats and streaks (A4)
  const [p1Correct, setP1Correct] = useState(0);
  const [p2Correct, setP2Correct] = useState(0);
  const [p1Passes, setP1Passes] = useState(0);
  const [p2Passes, setP2Passes] = useState(0);
  const [p1Streak, setP1Streak] = useState(0);
  const [p2Streak, setP2Streak] = useState(0);

  // Leader announcement (A5)
  const [leadAnnouncement, setLeadAnnouncement] = useState('');
  const prevLeaderRef = useRef<PlayerId | null>(null);

  const [liveTranscript, setLiveTranscript] = useState('');
  const [micVolume, setMicVolume] = useState(0);
  const [micListening, setMicListening] = useState(false);
  const [micErrorMsg, setMicErrorMsg] = useState<string | null>(null);
  const [usingBackupUrl, setUsingBackupUrl] = useState(false);
  const [phoneModalOpen, setPhoneModalOpen] = useState(false);

  // End of duel sequences:
  const [duelFinishPhase, setDuelFinishPhase] = useState<'reveal' | 'winner' | null>(null);
  const [duelFinishData, setDuelFinishData] = useState<{
    winner: PlayerId;
    loser: PlayerId;
    lastItem: DuelItem;
    summary: DuelSummary;
  } | null>(null);
  const [screenShake, setScreenShake] = useState(false);
  const [photoShake, setPhotoShake] = useState(false);
  const finishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const brokenIdsRef = useRef<Set<string>>(new Set());
  const resolvedUrlsRef = useRef<Map<string, string>>(new Map());

  const [photoOverride, setPhotoOverride] = useState<string | null>(null);
  const [reportToast, setReportToast] = useState(false);
  const reportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentItem = deck[itemIndex % deck.length];
  const displaySrc =
    photoOverride ||
    (usingBackupUrl
      ? getBackupImageUrl(currentItem.imageUrl)
      : resolvedUrlsRef.current.get(currentItem.id) ||
        getResolvedImageUrl(currentItem.imageUrl));

  const [imageLoaded, setImageLoaded] = useState(() => isImageCached(displaySrc));

  // Preload current image
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

  // Rolling preloader
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

  const stateRef = useRef({
    activePlayer,
    currentItem,
    isPaused,
    revealedAnswer,
    p1Streak,
    p2Streak,
    timeP1,
    timeP2,
    p1Correct,
    p2Correct,
    p1Passes,
    p2Passes,
    duelEnded: false,
  });

  useEffect(() => {
    stateRef.current = {
      activePlayer,
      currentItem,
      isPaused,
      revealedAnswer,
      p1Streak,
      p2Streak,
      timeP1,
      timeP2,
      p1Correct,
      p2Correct,
      p1Passes,
      p2Passes,
      duelEnded: stateRef.current.duelEnded,
    };
  });

  const ignoreVoiceUntilRef = useRef<number>(0);
  const recognizerRef = useRef<SmartSpeechRecognizer | null>(null);
  const lastSecondBeepRef = useRef<number>(-1);

  // Leader calculation (A5)
  const currentLeader: PlayerId | null =
    p1Correct > p2Correct ? 'p1' : p2Correct > p1Correct ? 'p2' : null;

  useEffect(() => {
    if (currentLeader && currentLeader !== prevLeaderRef.current) {
      const leaderName = currentLeader === 'p1' ? p1.name : p2.name;
      const localized = localizePlayerName(leaderName, settings.language);
      setLeadAnnouncement(
        t('arena.takesLead', settings.language, { name: localized })
      );
    }
    prevLeaderRef.current = currentLeader;
  }, [currentLeader, p1.name, p2.name, settings.language]);

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

    // Rimborso del tempo perso sulla foto errata (+5s all'orologio del giocatore di turno)
    if (activePlayer === 'p1') {
      setTimeP1(prev => Math.min(settings.duelDurationSeconds, prev + 5));
    } else {
      setTimeP2(prev => Math.min(settings.duelDurationSeconds, prev + 5));
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
  }, [currentItem, displaySrc, activePlayer, settings.duelDurationSeconds, advanceToNextImage]);

  // A1: Correct Guess Handler
  const triggerCorrectGuess = useCallback(
    (heardText?: string) => {
      const st = stateRef.current;
      if (
        st.duelEnded ||
        st.isPaused ||
        st.revealedAnswer !== null
      ) {
        return;
      }

      ignoreVoiceUntilRef.current = performance.now() + 800;
      recognizerRef.current?.consumeCurrentBuffer();

      const isP1 = st.activePlayer === 'p1';
      const nextStreak = (isP1 ? st.p1Streak : st.p2Streak) + 1;

      if (isP1) {
        setP1Streak(nextStreak);
        setP1Correct((c) => c + 1);
      } else {
        setP2Streak(nextStreak);
        setP2Correct((c) => c + 1);
      }

      soundEngine.playCorrectAnswer(nextStreak);
      hapticsService.vibrateCorrect();

      if (
        nextStreak >= 3 &&
        typeof window !== 'undefined' &&
        !window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ) {
        confetti({
          particleCount: nextStreak >= 5 ? 30 : 18,
          angle: isP1 ? 60 : 120,
          spread: 55,
          origin: { x: isP1 ? 0.18 : 0.82, y: 0.58 },
          colors: isP1
            ? ['#2F6BFF', '#FFC933', '#19C37D', '#FFF9EC']
            : ['#FF3D6E', '#FFC933', '#19C37D', '#FFF9EC'],
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
        if (stateRef.current.duelEnded) return;
        setRevealedAnswer(null);
        setLiveTranscript('');
        setActivePlayer((prev) => (prev === 'p1' ? 'p2' : 'p1'));
        advanceToNextImage();
      }, 700);
    },
    [advanceToNextImage]
  );

  // A1: Pass Handler (freeze clock during 1.4s reveal, -3s is only penalty)
  const triggerPass = useCallback(() => {
    const st = stateRef.current;
    if (
      st.duelEnded ||
      st.isPaused ||
      st.revealedAnswer !== null
    ) {
      return;
    }

    ignoreVoiceUntilRef.current = performance.now() + 1500;
    recognizerRef.current?.consumeCurrentBuffer();

    soundEngine.playPassPenalty();
    hapticsService.vibratePass();

    // Deduct -3s immediately and reset player's streak
    if (st.activePlayer === 'p1') {
      setP1Streak(0);
      setP1Passes((p) => p + 1);
      setTimeP1((t) => Math.max(0, t - settings.passPenaltySeconds));
    } else {
      setP2Streak(0);
      setP2Passes((p) => p + 1);
      setTimeP2((t) => Math.max(0, t - settings.passPenaltySeconds));
    }

    setLiveTranscript('Passo!');
    setPhotoShake(true);
    setTimeout(() => setPhotoShake(false), 300);

    // Show PASS burst
    setPassBurstVisible(true);

    // Show the sticker label overlapping bottom edge with red "ANSWER" tag for 1.4s
    // Clock is frozen while revealedAnswer !== null!
    setRevealedAnswer({
      tag: 'ANSWER',
      text: st.currentItem.answer,
      isPass: true,
    });

    setTimeout(() => {
      if (stateRef.current.duelEnded) return;
      setRevealedAnswer(null);
      setPassBurstVisible(false);
      setLiveTranscript('');
      advanceToNextImage();
    }, 1400);
  }, [settings.passPenaltySeconds, advanceToNextImage]);

  const processSpokenAlternatives = useCallback(
    (alternatives: string[], sourcePlayer?: PlayerId, isFinal = true) => {
      const st = stateRef.current;
      if (
        st.duelEnded ||
        st.isPaused ||
        st.revealedAnswer !== null
      ) {
        return;
      }

      if (performance.now() < ignoreVoiceUntilRef.current) {
        return;
      }

      if (
        settings.micMode === 'discord-p2p' &&
        p2RemoteConnected &&
        sourcePlayer &&
        sourcePlayer !== st.activePlayer
      ) {
        return;
      }

      if (alternatives[0]) {
        setLiveTranscript(alternatives[0]);
      }

      const matchResult = evaluateVoiceInput(alternatives, st.currentItem, {
        isFinal,
      });
      if (matchResult.isPassCommand) {
        triggerPass();
      } else if (matchResult.matched) {
        triggerCorrectGuess(matchResult.matchedAlias || alternatives[0]);
      }
    },
    [settings.micMode, p2RemoteConnected, triggerPass, triggerCorrectGuess]
  );

  const processSpokenAlternativesRef = useRef(processSpokenAlternatives);
  processSpokenAlternativesRef.current = processSpokenAlternatives;

  const startMicSession = useCallback(() => {
    if (isDiscordActivity) {
      // In Discord Activity iframe, direct mic capture is blocked by Discord CSP sandbox.
      // Speech recognition comes from the paired smartphone companion via PeerJS.
      setMicListening(p2RemoteConnected);
      return;
    }

    if (recognizerRef.current) {
      recognizerRef.current.stop();
    }
    setMicErrorMsg(null);
    const rec = new SmartSpeechRecognizer(
      (alternatives, isFinal) => {
        processSpokenAlternativesRef.current(
          alternatives,
          stateRef.current.activePlayer,
          isFinal
        );
      },
      (listening, err) => {
        setMicListening(listening);
        if (err) {
          setMicErrorMsg(err);
        } else if (listening) {
          setMicErrorMsg(null);
        }
      },
      (vol) => {
        setMicVolume(vol);
      },
      settings.language || 'it'
    );
    const vocab = category.items.flatMap((i) => [
      i.answer,
      ...(i.aliases || []),
    ]);
    rec.setVocabulary(vocab);
    recognizerRef.current = rec;
    rec.start();
  }, [isDiscordActivity, p2RemoteConnected, settings.language, category.items]);

  useEffect(() => {
    startMicSession();

    return () => {
      recognizerRef.current?.stop();
    };
  }, [startMicSession]);

  useEffect(() => {
    if (!latestRemotePacket) return;
    if (latestRemotePacket.type === 'TRANSCRIPT') {
      const alts =
        latestRemotePacket.alternatives &&
        latestRemotePacket.alternatives.length > 0
          ? latestRemotePacket.alternatives
          : latestRemotePacket.transcript
          ? [latestRemotePacket.transcript]
          : [];
      if (alts.length > 0) {
        processSpokenAlternatives(
          alts,
          stateRef.current.activePlayer,
          Boolean(latestRemotePacket.isFinal ?? true)
        );
      }
    } else if (latestRemotePacket.type === 'PASS_BUTTON') {
      if (stateRef.current.activePlayer === 'p2') {
        triggerPass();
      }
    } else if (
      latestRemotePacket.type === 'MIC_LEVEL' &&
      stateRef.current.activePlayer === 'p2'
    ) {
      setMicVolume(latestRemotePacket.micLevel || 0);
    }
  }, [latestRemotePacket, processSpokenAlternatives, triggerPass]);

  useEffect(() => {
    if (settings.micMode === 'discord-p2p' && p2RemoteConnected) {
      onSendRemoteState({
        type: 'STATE_UPDATE',
        activePlayer,
        p1Name: p1.name,
        p2Name: p2.name,
        categoryName: category.name,
        inDuel: true,
        timeLeftP2: timeP2,
      });
    }
  }, [
    activePlayer,
    timeP2,
    settings.micMode,
    p2RemoteConnected,
    p1.name,
    p2.name,
    category.name,
    onSendRemoteState,
  ]);

  const handleProceedToDraft = useCallback(() => {
    if (finishTimerRef.current) {
      clearTimeout(finishTimerRef.current);
    }
    soundEngine.stopAnnouncements();
    if (duelFinishData) {
      onDuelFinished(duelFinishData.summary);
    }
  }, [duelFinishData, onDuelFinished]);

  const handleTimeExpired = useCallback(
    (loser: PlayerId) => {
      const st = stateRef.current;
      if (st.duelEnded) return;
      st.duelEnded = true;

      recognizerRef.current?.stop();
      soundEngine.stopAnnouncements();

      const winner: PlayerId = loser === 'p1' ? 'p2' : 'p1';
      const summary: DuelSummary = {
        roundNumber,
        winner,
        loser,
        categoryId: category.id,
        categoryName: category.name,
        categoryIcon: category.icon,
        winnerTimeLeft: winner === 'p1' ? st.timeP1 : st.timeP2,
        p1Correct: st.p1Correct,
        p2Correct: st.p2Correct,
        p1Passes: st.p1Passes,
        p2Passes: st.p2Passes,
      };

      setDuelFinishData({
        winner,
        loser,
        lastItem: st.currentItem,
        summary,
      });

      // A1: Show canonical answer of last photo with red ANSWER sticker overlapping bottom edge
      setRevealedAnswer({
        tag: 'ANSWER',
        text: st.currentItem.answer,
        isPass: true,
      });

      setScreenShake(true);
      soundEngine.playTimeOutBuzzer();
      soundEngine.playRevealAnswer();
      setDuelFinishPhase('reveal');

      setTimeout(() => {
        setScreenShake(false);
      }, 450);

      setTimeout(() => {
        setDuelFinishPhase('winner');
        soundEngine.playGrandFanfare();
        soundEngine.playDuelVictory();
        hapticsService.vibrateVictory();

        finishTimerRef.current = setTimeout(() => {
          onDuelFinished(summary);
        }, 3400);
      }, 2200);
    },
    [
      category.id,
      category.icon,
      category.name,
      onDuelFinished,
      roundNumber,
    ]
  );

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (duelFinishPhase !== null) {
        if (e.code === 'Enter' || e.code === 'Space') {
          e.preventDefault();
          handleProceedToDraft();
        }
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        triggerPass();
      } else if (e.code === 'Enter') {
        e.preventDefault();
        triggerCorrectGuess(stateRef.current.currentItem.answer);
      } else if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        setIsPaused((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [triggerPass, triggerCorrectGuess, duelFinishPhase, handleProceedToDraft]);

  // Main countdown timer loop: frozen while revealedAnswer !== null
  useEffect(() => {
    let lastTick = performance.now();

    const interval = setInterval(() => {
      const now = performance.now();
      const dt = (now - lastTick) / 1000;
      lastTick = now;

      const st = stateRef.current;
      // Freeze clock while answer is revealed (1.4s on pass, 700ms on correct) or paused or duel ended
      if (st.duelEnded || st.isPaused || st.revealedAnswer !== null) return;

      if (st.activePlayer === 'p1') {
        const nextP1 = Math.max(0, st.timeP1 - dt);
        setTimeP1(nextP1);

        const wholeSec = Math.ceil(nextP1);
        if (wholeSec !== lastSecondBeepRef.current && nextP1 > 0) {
          lastSecondBeepRef.current = wholeSec;
          const isUrgent = nextP1 <= gameConfig.options.urgentThresholdSeconds;
          soundEngine.playClockTick(isUrgent);
          if (isUrgent) {
            hapticsService.vibrateUrgentTick();
          }
        }

        if (nextP1 <= 0) {
          handleTimeExpired('p1');
        }
      } else {
        const nextP2 = Math.max(0, st.timeP2 - dt);
        setTimeP2(nextP2);

        const wholeSec = Math.ceil(nextP2);
        if (wholeSec !== lastSecondBeepRef.current && nextP2 > 0) {
          lastSecondBeepRef.current = wholeSec;
          const isUrgent = nextP2 <= gameConfig.options.urgentThresholdSeconds;
          soundEngine.playClockTick(isUrgent);
          if (isUrgent) {
            hapticsService.vibrateUrgentTick();
          }
        }

        if (nextP2 <= 0) {
          handleTimeExpired('p2');
        }
      }
    }, 50);

    return () => clearInterval(interval);
  }, [advanceToNextImage, handleTimeExpired]);

  const p1Active = activePlayer === 'p1';
  const p2Active = activePlayer === 'p2';
  const stageColor = p1Active ? 'p1' : 'p2';
  const p1Urgent = p1Active && timeP1 <= 10;
  const p2Urgent = p2Active && timeP2 <= 10;
  const photoTilt = itemIndex % 2 === 0 ? '-1deg' : '1deg';

  return (
    <div
      className={`relative h-[100dvh] max-h-[100dvh] w-full flex flex-col justify-between p-3 sm:p-5 select-none overflow-hidden touch-none pb-[max(0.75rem,env(safe-area-inset-bottom))] ${
        screenShake ? 'animate-screen-shake-6px' : ''
      }`}
    >
      {/* 1. Dynamic Floor Background Following Active Player (250ms wave max) */}
      <TheFloorBackground
        stage={isPaused ? 'modal' : stageColor}
        urgent={!isPaused && (p1Urgent || p2Urgent)}
      />

      {/* Screen Reader Announcement for Crown Lead Change */}
      <div className="sr-only" aria-live="polite">
        {leadAnnouncement}
      </div>

      {/* Main Single Width Container: Max 1100px Centered */}
      <div className="w-full max-w-[1100px] mx-auto flex-1 flex flex-col justify-between py-1 min-h-0">
        {/* ============================================================== */}
        {/* TOP BAR: Category (emoji + name 28px) left, Pause right        */}
        {/* ============================================================== */}
        <header className="w-full flex items-center justify-between gap-3 shrink-0 py-1">
          <div className="flex items-center gap-2.5 bg-paper border-[3px] border-ink rounded-full px-4 py-1.5 shadow-hard-sm -rotate-1 min-w-0">
            <span className="text-3xl sm:text-4xl shrink-0">{category.icon}</span>
            <h1 className="font-display font-black text-xl sm:text-[28px] text-ink truncate tracking-wide leading-none">
              {category.name}
            </h1>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {isDiscordActivity && (
              <button
                type="button"
                onClick={() => setPhoneModalOpen(true)}
                className={`btn-push px-3 py-2 rounded-xl border-[3px] border-ink shadow-hard-sm font-display font-black text-xs flex items-center gap-1.5 transition-transform active:translate-y-0.5 ${
                  p2RemoteConnected
                    ? 'bg-green text-ink'
                    : 'bg-yellow text-ink'
                }`}
                title={settings.language === 'en' ? 'Smartphone Mic QR' : 'Microfono Smartphone QR'}
              >
                <Smartphone className="w-4 h-4 shrink-0" />
                <span className="hidden sm:inline">
                  {p2RemoteConnected
                    ? (settings.language === 'en' ? 'Phone Mic' : 'Mic Telefono')
                    : (settings.language === 'en' ? 'Connect Phone' : 'QR Telefono')}
                </span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setIsPaused((p) => !p)}
              className="btn-push px-4 py-2 rounded-xl bg-paper text-ink font-display font-bold text-sm flex items-center gap-1.5 shrink-0 border-[3px] border-ink shadow-hard-sm"
              aria-label={isPaused ? t('arena.resume', settings.language) : t('arena.pause', settings.language)}
            >
              {isPaused ? <Play className="w-4 h-4 text-green" /> : <Pause className="w-4 h-4 stroke-[2.5]" />}
              <span>{isPaused ? t('arena.resume', settings.language) : t('arena.pause', settings.language)}</span>
            </button>
          </div>
        </header>

        {/* ============================================================== */}
        {/* CENTER GRID: [Card 200px] [Photo Hero] [Card 200px] (A6)       */}
        {/* ============================================================== */}
        <main className="w-full my-auto flex-1 flex flex-col lg:grid lg:grid-cols-[200px_1fr_200px] items-center gap-6 min-h-0 py-2">
          {/* ------------------------------------------------------------ */}
          {/* Player 1 Card (Desktop: Left 200px)                           */}
          {/* ------------------------------------------------------------ */}
          <div
            className={`hidden lg:flex w-full min-h-[220px] rounded-card border-[3px] border-ink p-5 flex-col items-center justify-center gap-2 text-center transition-all relative ${
              p1Active
                ? 'bg-blue text-white shadow-hard-lifted tactile-lifted'
                : 'bg-paper text-ink opacity-90 tactile-pressed'
            }`}
          >
            {/* C3: Avatar 72px overlapping card's top edge */}
            <div className="absolute -top-9 left-1/2 -translate-x-1/2 z-20">
              <div
                className={`w-[72px] h-[72px] rounded-full bg-paper border-[3px] border-ink flex items-center justify-center text-4xl shadow-hard-sm relative ${
                  p1Active ? 'animate-avatar-hop ring-4 ring-yellow' : ''
                }`}
                style={{ outline: '4px solid #2F6BFF' }}
              >
                {/* A5: Inline Crown if Leader */}
                {currentLeader === 'p1' && (
                  <InlineCrown className="absolute -top-7 left-1/2 -translate-x-1/2" />
                )}
                {p1.avatar}
              </div>
            </div>

            {/* A4: Streak Badge slot */}
            <StreakBadge streak={p1Streak} />

            <div className="mt-4 w-full">
              <span className="font-display font-black text-lg truncate block leading-tight max-w-full">
                {localizePlayerName(p1.name, settings.language)}
              </span>
            </div>

            {/* C2: In-Game Clock 72px+ on desktop with lowercase "s" at 0.45em (A2) */}
            <div
              className={`tabular-nums font-display font-black text-5xl xl:text-6xl tracking-tight my-1 ${
                p1Urgent ? 'text-yellow animate-urgent-pulse-hard' : ''
              }`}
            >
              <FormattedTime
                seconds={timeP1}
                decimals={p1Active && timeP1 < 10 ? 1 : 0}
              />
            </div>

            {/* Speech bubble anchored to P1 when active */}
            {p1Active && (
              <div className="speech-bubble speech-bubble-tail-bottom absolute -bottom-16 left-1/2 -translate-x-1/2 bg-yellow text-ink border-[3px] border-ink px-4 py-1.5 rounded-2xl shadow-hard font-display font-black text-sm whitespace-nowrap z-30">
                {liveTranscript
                  ? `“${liveTranscript}”`
                  : isDiscordActivity
                  ? p2RemoteConnected
                    ? (settings.language === 'en' ? 'Speak into phone...' : 'Parla al telefono...')
                    : (settings.language === 'en' ? 'Shout in voice chat!' : 'Grida nel canale vocale!')
                  : t('arena.listening', settings.language)}
              </div>
            )}
          </div>

          {/* ------------------------------------------------------------ */}
          {/* Photo Hero: Real aspect ratio, 12px mat, alternating ±1deg   */}
          {/* ------------------------------------------------------------ */}
          <div className="flex-1 min-h-0 w-full flex flex-col items-center justify-center relative">
            <div
              key={`${currentItem.id}-${itemIndex}`}
              style={{ transform: `rotate(${photoTilt})` }}
              className={`relative bg-paper p-3 rounded-card border-[3px] border-ink shadow-hard max-h-[56vh] max-w-full flex items-center justify-center animate-photo-slap transition-transform duration-200 ${
                photoShake ? 'animate-screen-shake-6px' : ''
              }`}
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
                <div className="absolute top-3 left-1/2 -translate-x-1/2 z-50 px-3.5 py-1.5 bg-yellow border-2 border-ink rounded-xl shadow-hard font-display font-black text-xs sm:text-sm text-ink animate-pop-in pointer-events-none whitespace-nowrap">
                  {t('arena.photoReported', settings.language)}
                </div>
              )}

              {/* Timeout Reveal */}
              {duelFinishPhase === 'reveal' && duelFinishData && (
                <div className="absolute inset-0 bg-paper rounded-xl z-30 flex flex-col items-center justify-center p-6 text-center text-ink animate-pop-in">
                  <span className="font-display font-bold text-xs uppercase tracking-wider text-ink/70 mb-1">
                    {settings.language === 'en' ? 'Time ran out!' : 'Tempo scaduto!'}
                  </span>
                </div>
              )}

              {/* Feedback: PASS -3s Burst Over Photo (A1, A2) */}
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
                    +1{(p1Active ? p1Streak : p2Streak) >= 3 ? ` 🔥×${p1Active ? p1Streak : p2Streak}` : '!'}
                  </div>
                </>
              )}

              {/* The Photo Itself: Fits Real Aspect Ratio */}
              <div className="min-h-[190px] min-w-[220px] flex items-center justify-center bg-paper/50 rounded-lg overflow-hidden relative">
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
                  className={`max-h-[48vh] sm:max-h-[52vh] w-auto max-w-full object-contain rounded-lg transition-opacity duration-150 ${
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

            {/* Mobile speech bubble centered under photo */}
            <div className="lg:hidden mt-3 w-full max-w-md mx-auto speech-bubble speech-bubble-tail-bottom px-4 py-2 text-center">
              <span className="font-display font-black text-base sm:text-lg text-ink leading-tight line-clamp-2">
                {liveTranscript ? (
                  <span className={p1Active ? 'text-blue' : 'text-red'}>
                    “{liveTranscript}”
                  </span>
                ) : isDiscordActivity ? (
                  p2RemoteConnected ? (
                    <span className="text-green font-bold">📱 {settings.language === 'en' ? 'Speak into phone...' : 'Parla al telefono...'}</span>
                  ) : (
                    <span className="text-ink font-bold">🎙️ {settings.language === 'en' ? 'Shout in voice chat! [Enter]/[Space]' : 'Grida nel canale vocale! [Invio]/[Spazio]'}</span>
                  )
                ) : micListening ? (
                  t('arena.listening', settings.language)
                ) : micErrorMsg ? (
                  <span className="text-red">{micErrorMsg}</span>
                ) : (
                  t('arena.micActive', settings.language)
                )}
              </span>
            </div>
          </div>

          {/* ------------------------------------------------------------ */}
          {/* Player 2 Card (Desktop: Right 200px)                          */}
          {/* ------------------------------------------------------------ */}
          <div
            className={`hidden lg:flex w-full min-h-[220px] rounded-card border-[3px] border-ink p-5 flex-col items-center justify-center gap-2 text-center transition-all relative ${
              p2Active
                ? 'bg-red text-white shadow-hard-lifted tactile-lifted'
                : 'bg-paper text-ink opacity-90 tactile-pressed'
            }`}
          >
            {/* C3: Avatar 72px overlapping card's top edge */}
            <div className="absolute -top-9 left-1/2 -translate-x-1/2 z-20">
              <div
                className={`w-[72px] h-[72px] rounded-full bg-paper border-[3px] border-ink flex items-center justify-center text-4xl shadow-hard-sm relative ${
                  p2Active ? 'animate-avatar-hop ring-4 ring-yellow' : ''
                }`}
                style={{ outline: '4px solid #FF3D6E' }}
              >
                {/* A5: Inline Crown if Leader */}
                {currentLeader === 'p2' && (
                  <InlineCrown className="absolute -top-7 left-1/2 -translate-x-1/2" />
                )}
                {p2.avatar}
              </div>
            </div>

            {/* A4: Streak Badge slot */}
            <StreakBadge streak={p2Streak} />

            <div className="mt-4 w-full">
              <span className="font-display font-black text-lg truncate block leading-tight max-w-full">
                {localizePlayerName(p2.name, settings.language)}
              </span>
            </div>

            {/* C2: In-Game Clock 72px+ on desktop with lowercase "s" at 0.45em (A2) */}
            <div
              className={`tabular-nums font-display font-black text-5xl xl:text-6xl tracking-tight my-1 ${
                p2Urgent ? 'text-yellow animate-urgent-pulse-hard' : ''
              }`}
            >
              <FormattedTime
                seconds={timeP2}
                decimals={p2Active && timeP2 < 10 ? 1 : 0}
              />
            </div>

            {/* Speech bubble anchored to P2 when active */}
            {p2Active && (
              <div className="speech-bubble speech-bubble-tail-bottom absolute -bottom-16 left-1/2 -translate-x-1/2 bg-yellow text-ink border-[3px] border-ink px-4 py-1.5 rounded-2xl shadow-hard font-display font-black text-sm whitespace-nowrap z-30">
                {liveTranscript
                  ? `“${liveTranscript}”`
                  : isDiscordActivity
                  ? p2RemoteConnected
                    ? (settings.language === 'en' ? 'Speak into phone...' : 'Parla al telefono...')
                    : (settings.language === 'en' ? 'Shout in voice chat!' : 'Grida nel canale vocale!')
                  : t('arena.listening', settings.language)}
              </div>
            )}
          </div>
        </main>

        {/* ============================================================== */}
        {/* Mobile Player Cards (Row Stacked under Photo)                  */}
        {/* ============================================================== */}
        <div className="grid grid-cols-2 gap-3 w-full my-2 lg:hidden shrink-0">
          {/* P1 Card Mobile */}
          <div
            className={`p-3 rounded-card border-[3px] border-ink flex items-center justify-between gap-2 transition-all relative ${
              p1Active
                ? 'bg-blue text-white tactile-lifted'
                : 'bg-paper text-ink tactile-pressed'
            }`}
          >
            <StreakBadge streak={p1Streak} className="scale-75 -top-2 -right-2" />
            <div className="flex items-center gap-2 min-w-0">
              <div className="relative">
                {currentLeader === 'p1' && (
                  <InlineCrown size="sm" className="absolute -top-4 left-1/2 -translate-x-1/2" />
                )}
                <span className="text-2xl shrink-0">{p1.avatar}</span>
              </div>
              <div className="min-w-0">
                <span className="font-display font-black text-xs truncate block leading-tight">
                  {localizePlayerName(p1.name, settings.language)}
                </span>
              </div>
            </div>
            <FormattedTime
              seconds={timeP1}
              decimals={p1Active && timeP1 < 10 ? 1 : 0}
              className={`text-2xl shrink-0 ${p1Urgent ? 'text-yellow animate-urgent-pulse-hard' : ''}`}
            />
          </div>

          {/* P2 Card Mobile */}
          <div
            className={`p-3 rounded-card border-[3px] border-ink flex items-center justify-between gap-2 transition-all relative ${
              p2Active
                ? 'bg-red text-white tactile-lifted'
                : 'bg-paper text-ink tactile-pressed'
            }`}
          >
            <StreakBadge streak={p2Streak} className="scale-75 -top-2 -right-2" />
            <FormattedTime
              seconds={timeP2}
              decimals={p2Active && timeP2 < 10 ? 1 : 0}
              className={`text-2xl shrink-0 ${p2Urgent ? 'text-yellow animate-urgent-pulse-hard' : ''}`}
            />
            <div className="flex items-center gap-2 min-w-0 text-right justify-end">
              <div className="min-w-0">
                <span className="font-display font-black text-xs truncate block leading-tight">
                  {localizePlayerName(p2.name, settings.language)}
                </span>
              </div>
              <div className="relative">
                {currentLeader === 'p2' && (
                  <InlineCrown size="sm" className="absolute -top-4 left-1/2 -translate-x-1/2" />
                )}
                <span className="text-2xl shrink-0">{p2.avatar}</span>
              </div>
            </div>
          </div>
        </div>

        {/* ============================================================== */}
        {/* BOTTOM ACTION BAR: 3-Bar Mic Meter | Pass (paper) | Correct    */}
        {/* ============================================================== */}
        <div className="w-full shrink-0 flex flex-col items-center gap-2 py-1">
          <div className="flex items-center justify-center gap-4 w-full">
            {/* Mic indicator: Discord Voice / Phone Companion vs Web Browser Mic */}
            {isDiscordActivity ? (
              p2RemoteConnected ? (
                <button
                  type="button"
                  onClick={() => setPhoneModalOpen(true)}
                  className="btn-push flex items-center gap-2 px-3.5 py-3 rounded-xl bg-paper border-[3px] border-ink shadow-hard shrink-0 h-16 hover:bg-yellow transition-colors"
                  title={settings.language === 'en' ? 'Phone Mic Connected (Click for QR)' : 'Microfono Telefono Connesso (Clicca per QR)'}
                >
                  <Smartphone className="w-5 h-5 text-green" />
                  <span className="font-display font-black text-xs text-ink hidden sm:inline">📱 Mic</span>
                  <span className="w-2.5 h-2.5 rounded-full bg-green animate-ping" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setPhoneModalOpen(true)}
                  className="btn-push flex items-center gap-2 px-3 py-3 rounded-xl bg-paper border-[3px] border-ink shadow-hard shrink-0 h-16 hover:bg-yellow transition-colors"
                  title={settings.language === 'en' ? 'Discord Voice Channel (Click for Phone QR)' : 'Canale Vocale Discord (Clicca per QR Telefono)'}
                >
                  <span className="text-xl">🎙️</span>
                  <div className="flex flex-col text-left leading-tight hidden sm:flex">
                    <span className="font-display font-black text-xs text-ink">Vocale</span>
                    <span className="text-[10px] text-ink/70 font-bold">📱 Telefono</span>
                  </div>
                </button>
              )
            ) : (
              <div
                className="relative flex items-center gap-1.5 px-3 py-3 rounded-xl bg-paper border-[3px] border-ink shadow-hard shrink-0 h-16"
                title="Mic level"
              >
                {micListening && micVolume > 0.12 && (
                  <span className="absolute inset-0 rounded-xl border-2 border-green bg-green/20 pointer-events-none animate-mic-ripple" />
                )}
                <Mic className={`relative z-10 w-5 h-5 ${micListening ? 'text-green' : 'text-ink/40'}`} />
                <div className="flex items-end gap-1 h-8">
                  <span
                    className={`w-2 rounded-sm border border-ink transition-all ${
                      micListening && micVolume > 0.05 ? 'bg-green h-4' : 'bg-ink/15 h-3'
                    }`}
                  />
                  <span
                    className={`w-2 rounded-sm border border-ink transition-all ${
                      micListening && micVolume > 0.25 ? 'bg-green h-6' : 'bg-ink/15 h-3'
                    }`}
                  />
                  <span
                    className={`w-2 rounded-sm border border-ink transition-all ${
                      micListening && micVolume > 0.55 ? 'bg-green h-8' : 'bg-ink/15 h-3'
                    }`}
                  />
                </div>
              </div>
            )}

            {/* Pass Button: min 64px tall, min 160px wide, A2 lowercase 's' */}
            <button
              type="button"
              onClick={triggerPass}
              disabled={revealedAnswer !== null}
              className="btn-push flex-1 sm:flex-initial min-h-[64px] min-w-[140px] sm:min-w-[160px] px-6 py-3 rounded-2xl bg-paper text-ink font-display font-black text-xl flex items-center justify-center gap-2 border-[3px] border-ink shadow-hard disabled:opacity-50"
            >
              <FastForward className="w-5 h-5" />
              <span>
                Pass (−3<span style={{ fontSize: '0.45em' }} className="lowercase ml-0.5 align-baseline">s</span>)
              </span>
            </button>

            {/* Correct Button: min 64px tall, min 160px wide */}
            <button
              type="button"
              onClick={() => triggerCorrectGuess(currentItem.answer)}
              disabled={revealedAnswer !== null}
              className="btn-push flex-1 sm:flex-initial min-h-[64px] min-w-[140px] sm:min-w-[160px] px-6 py-3 rounded-2xl bg-green text-ink font-display font-black text-xl flex items-center justify-center gap-2 border-[3px] border-ink shadow-hard disabled:opacity-50"
            >
              <Check className="w-6 h-6 stroke-[3]" />
              <span>{t('arena.correct', settings.language)}</span>
            </button>
          </div>

          {/* Desktop keyboard hint: Never clipped */}
          <span className="hidden lg:block text-xs font-display font-bold text-paper/70 tracking-wider">
            {t('arena.keyboardHelp', settings.language)}
          </span>
        </div>
      </div>

      {/* Round Winner Celebration Modal */}
      {duelFinishPhase === 'winner' && duelFinishData && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="card-paper max-w-sm w-full p-6 text-center flex flex-col items-center gap-4 modal-slap-in">
            <div
              className={`w-20 h-20 rounded-2xl border-[3px] border-ink shadow-hard flex items-center justify-center text-5xl animate-bounce ${
                duelFinishData.winner === 'p1' ? 'bg-blue text-white' : 'bg-red text-white'
              }`}
            >
              {duelFinishData.winner === 'p1' ? p1.avatar : p2.avatar}
            </div>

            <div>
              <span className="text-xs font-bold text-ink/70 uppercase tracking-wider block mb-1">
                {t('arena.pointScoredTitle', settings.language)}
              </span>
              <h2 className="font-display font-black text-3xl text-ink">
                {t('arena.hasWon', settings.language, {
                  name: localizePlayerName(
                    duelFinishData.winner === 'p1' ? p1.name : p2.name,
                    settings.language
                  ),
                })}
              </h2>
            </div>

            <div className="w-full flex items-center justify-around py-3 border-y-[3px] border-ink/20">
              <div>
                <span className="text-xs text-ink/70 block">{t('arena.timeLeft', settings.language)}</span>
                <span className="font-display font-black text-2xl text-green">
                  <FormattedTime seconds={duelFinishData.summary.winnerTimeLeft} decimals={1} />
                </span>
              </div>
              <div>
                <span className="text-xs text-ink/70 block">{t('arena.correctPhotos', settings.language)}</span>
                <span className="font-display font-black text-2xl text-ink">
                  {duelFinishData.winner === 'p1'
                    ? duelFinishData.summary.p1Correct
                    : duelFinishData.summary.p2Correct}
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={handleProceedToDraft}
              className="btn-push btn-shine w-full py-3.5 px-6 rounded-xl bg-yellow text-ink font-display font-black text-lg flex items-center justify-center gap-2 uppercase tracking-wide border-[3px] border-ink shadow-hard"
            >
              <span>{t('arena.chooseNextCategory', settings.language)}</span>
              <ArrowRight className="w-5 h-5" />
            </button>
          </div>
        </div>
      )}

      {/* B2: Game Paused Modal (Slaps in, dark stage, 28px title, 16px body, 2px ink divider, Esc closes) */}
      {isPaused && (
        <div className="fixed inset-0 z-50 bg-[#0F0E1A]/90 flex items-center justify-center p-4">
          <div className="card-paper max-w-sm w-full p-6 text-center flex flex-col items-center gap-4 modal-slap-in">
            <div className="w-full flex items-center justify-between pb-3 border-b-2 border-ink">
              <h2 className="font-display font-black text-[28px] text-ink leading-tight">
                {t('arena.pausedTitle', settings.language)}
              </h2>
              <button
                type="button"
                onClick={() => setIsPaused(false)}
                aria-label="Close"
                className="btn-push w-8 h-8 rounded-lg bg-paper border-[2.5px] border-ink flex items-center justify-center text-ink"
              >
                <X className="w-5 h-5 stroke-[3]" />
              </button>
            </div>

            <p className="text-base font-sans font-bold text-ink/80 py-2">
              {t('arena.pausedDesc', settings.language)}
            </p>

            <button
              type="button"
              onClick={() => setIsPaused(false)}
              className="btn-push w-full py-3.5 rounded-xl bg-yellow text-ink font-display font-black text-lg uppercase tracking-wide border-[3px] border-ink shadow-hard"
            >
              {t('arena.resume', settings.language)}
            </button>

            <button
              type="button"
              onClick={() => {
                handleReportPhoto();
                setIsPaused(false);
              }}
              className="btn-push w-full py-2.5 rounded-xl bg-paper text-ink font-display font-bold text-sm border-2 border-ink flex items-center justify-center gap-2 hover:bg-red/10 transition-colors"
            >
              <span>🚩</span>
              <span>{t('arena.reportPhoto', settings.language)}</span>
            </button>
          </div>
        </div>
      )}

      {/* Phone Mic QR Modal (Can be opened mid-game in Discord Activity) */}
      <PhoneMicModal
        isOpen={phoneModalOpen}
        onClose={() => setPhoneModalOpen(false)}
        roomCode={roomCode}
        isConnected={p2RemoteConnected}
        language={settings.language}
      />
    </div>
  );
};
