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
import { evaluateVoiceInput, PassCommandGuard } from '../engine/voiceMatcher';
import { SmartSpeechRecognizer } from '../engine/speechRecognition';
import { soundEngine } from '../engine/soundEffects';
import { hapticsService } from '../services/hapticsService';
import {
  getBackupImageUrl,
  isImageCached,
  prepareArenaDeck,
  primeImage,
} from '../data/categories';
import {
  buildItemImageFallbackChain,
  isRenderedImageHealthy,
  markItemSeen,
} from '../utils/itemUtils';
import { getPlayerColor } from '../utils/playerColors';
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
  p1RemoteConnected?: boolean;
  p2RemoteConnected: boolean;
  latestRemotePacket?: RemoteMicPacket | null;
  subscribeRemotePackets?: (cb: (packet: RemoteMicPacket) => void) => () => void;
  onSendRemoteState: (packet: RemoteMicPacket) => void;
  onDuelFinished: (summary: DuelSummary) => void;
  isDiscordActivity?: boolean;
  roomCode?: string;
  p1ColorIndex?: number;
  p2ColorIndex?: number;
}

export const DuelArenaScreen: React.FC<DuelArenaScreenProps> = ({
  roundNumber,
  category,
  p1,
  p2,
  initialPlayer,
  settings,
  p1RemoteConnected = false,
  p2RemoteConnected,
  latestRemotePacket = null,
  subscribeRemotePackets,
  onSendRemoteState,
  onDuelFinished,
  isDiscordActivity = false,
  roomCode = '',
  p1ColorIndex,
  p2ColorIndex,
}) => {
  const p1Color = getPlayerColor(
    typeof p1ColorIndex === 'number' ? p1ColorIndex : p1.id
  );
  const p2Color = getPlayerColor(
    typeof p2ColorIndex === 'number' ? p2ColorIndex : p2.id
  );

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
  const [fallbackIndex, setFallbackIndex] = useState(0);
  const [phoneModalOpen, setPhoneModalOpen] = useState(false);

  const actionLockRef = useRef<boolean>(false);
  const finishedTriggeredRef = useRef<boolean>(false);
  const clearBufferSeqRef = useRef<number>(0);
  const pendingTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const scheduleTimeout = useCallback((fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      pendingTimersRef.current.delete(timer);
      fn();
    }, ms);
    pendingTimersRef.current.add(timer);
    return timer;
  }, []);

  const clearAllPendingTimers = useCallback(() => {
    pendingTimersRef.current.forEach((timer) => clearTimeout(timer));
    pendingTimersRef.current.clear();
  }, []);

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
  const [reportToast, setReportToast] = useState(false);
  const reportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentItem = deck[itemIndex % deck.length];
  const fallbackChain = buildItemImageFallbackChain(currentItem, getBackupImageUrl);
  const resolvedCached = resolvedUrlsRef.current.get(currentItem.id);
  const displaySrc =
    fallbackIndex === 0 && resolvedCached
      ? resolvedCached
      : fallbackChain[fallbackIndex] || fallbackChain[0] || currentItem.imageUrl;

  useEffect(() => {
    if (currentItem?.id) {
      markItemSeen(currentItem.id);
    }
  }, [currentItem?.id]);

  const [imageLoaded, setImageLoaded] = useState(() => isImageCached(displaySrc));
  const fallbackIndexRef = useRef(0);
  fallbackIndexRef.current = fallbackIndex;

  const tryNextImageFallback = useCallback(() => {
    if (fallbackIndexRef.current + 1 < fallbackChain.length) {
      setFallbackIndex(fallbackIndexRef.current + 1);
    } else {
      if (currentItem) {
        brokenIdsRef.current.add(currentItem.id);
      }
      setImageLoaded(true);
    }
  }, [fallbackChain.length, currentItem]);

  // Preload current image
  useEffect(() => {
    let cancelled = false;
    const cached = isImageCached(displaySrc);
    setImageLoaded(cached);
    if (!cached) {
      primeImage(displaySrc)
        .then((finalSrc) => {
          if (cancelled) return;
          if (finalSrc && currentItem && fallbackIndex === 0) {
            resolvedUrlsRef.current.set(currentItem.id, finalSrc);
          }
          setImageLoaded(true);
        })
        .catch(() => {
          if (cancelled) return;
          tryNextImageFallback();
        });
    }
    return () => {
      cancelled = true;
    };
  }, [displaySrc, currentItem, fallbackIndex, tryNextImageFallback]);

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

  useEffect(() => {
    return () => {
      clearAllPendingTimers();
      if (finishTimerRef.current) clearTimeout(finishTimerRef.current);
      if (reportTimerRef.current) clearTimeout(reportTimerRef.current);
    };
  }, [clearAllPendingTimers]);

  const stateRef = useRef({
    activePlayer,
    currentItem,
    deck,
    itemIndex,
    imageLoaded,
    phoneModalOpen,
    duelFinishPhase,
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
      deck,
      itemIndex,
      imageLoaded,
      phoneModalOpen,
      duelFinishPhase,
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

  const handleTimeExpiredRef = useRef<(loser: PlayerId) => void>(() => {});
  const ignoreVoiceUntilRef = useRef<number>(0);
  const passGuardRef = useRef<PassCommandGuard>(new PassCommandGuard(320));
  const recognizerRef = useRef<SmartSpeechRecognizer | null>(null);
  const lastSecondBeepRef = useRef<number>(-1);

  useEffect(() => {
    passGuardRef.current.cancel();
  }, [activePlayer, isPaused]);

  useEffect(() => {
    const guard = passGuardRef.current;
    return () => {
      guard.cancel();
    };
  }, []);

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
    actionLockRef.current = false;
    ignoreVoiceUntilRef.current = Math.max(
      ignoreVoiceUntilRef.current,
      performance.now() + 250
    );
    clearBufferSeqRef.current += 1;
    recognizerRef.current?.consumeCurrentBuffer();
    setFallbackIndex(0);

    const { deck: curDeck, itemIndex: curIdx } = stateRef.current;
    let next = curIdx + 1;
    let safety = 0;
    while (
      next < curDeck.length &&
      brokenIdsRef.current.has(curDeck[next].id) &&
      safety < curDeck.length
    ) {
      next++;
      safety++;
    }
    if (next >= curDeck.length) {
      setDeck(prepareArenaDeck(category.items));
      setItemIndex(0);
    } else {
      setItemIndex(next);
    }
  }, [category.items]);

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

    clearBufferSeqRef.current += 1;
    recognizerRef.current?.consumeCurrentBuffer();
    setImageLoaded(false);
    advanceToNextImage();
  }, [currentItem, displaySrc, activePlayer, settings.duelDurationSeconds, advanceToNextImage]);

  // A1: Correct Guess Handler
  const triggerCorrectGuess = useCallback(
    (heardText?: string) => {
      const st = stateRef.current;
      if (
        actionLockRef.current ||
        st.duelEnded ||
        st.isPaused ||
        st.revealedAnswer !== null
      ) {
        return;
      }

      actionLockRef.current = true;
      passGuardRef.current.cancel();
      ignoreVoiceUntilRef.current = performance.now() + 1200;
      clearBufferSeqRef.current += 1;
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
            ? [p1Color.bgHex, '#FFC933', '#19C37D', '#FFF9EC']
            : [p2Color.bgHex, '#FFC933', '#19C37D', '#FFF9EC'],
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

      scheduleTimeout(() => {
        if (stateRef.current.duelEnded) return;
        setRevealedAnswer(null);
        setLiveTranscript('');
        setActivePlayer((prev) => (prev === 'p1' ? 'p2' : 'p1'));
        advanceToNextImage();
      }, 700);
    },
    [advanceToNextImage, scheduleTimeout, p1Color.bgHex, p2Color.bgHex]
  );

  // A1: Pass Handler (freeze clock during 1.4s reveal, -3s is only penalty)
  const triggerPass = useCallback(() => {
    const st = stateRef.current;
    if (
      actionLockRef.current ||
      st.duelEnded ||
      st.isPaused ||
      st.revealedAnswer !== null
    ) {
      return;
    }

    actionLockRef.current = true;
    passGuardRef.current.lockCooldown(2500);
    ignoreVoiceUntilRef.current = performance.now() + 1750;
    clearBufferSeqRef.current += 1;
    recognizerRef.current?.consumeCurrentBuffer();

    soundEngine.playPassPenalty();
    hapticsService.vibratePass();

    // Deduct -3s immediately and reset player's streak
    const isP1 = st.activePlayer === 'p1';
    const curTime = isP1 ? st.timeP1 : st.timeP2;
    const nextTime = Math.max(0, curTime - settings.passPenaltySeconds);
    if (isP1) {
      setP1Streak(0);
      setP1Passes((p) => p + 1);
      setTimeP1(nextTime);
    } else {
      setP2Streak(0);
      setP2Passes((p) => p + 1);
      setTimeP2(nextTime);
    }

    setLiveTranscript(settings.language === 'en' ? 'Pass!' : 'Passo!');
    setPhotoShake(true);
    scheduleTimeout(() => setPhotoShake(false), 300);

    // Show PASS burst
    setPassBurstVisible(true);

    // Show the sticker label overlapping bottom edge with red "ANSWER" tag for 1.4s
    // Clock is frozen while revealedAnswer !== null!
    setRevealedAnswer({
      tag: 'ANSWER',
      text: st.currentItem.answer,
      isPass: true,
    });

    if (nextTime <= 0) {
      scheduleTimeout(() => {
        setPassBurstVisible(false);
        handleTimeExpiredRef.current(isP1 ? 'p1' : 'p2');
      }, 650);
      return;
    }

    scheduleTimeout(() => {
      if (stateRef.current.duelEnded) return;
      setRevealedAnswer(null);
      setPassBurstVisible(false);
      setLiveTranscript('');
      advanceToNextImage();
    }, 1400);
  }, [
    settings.language,
    settings.passPenaltySeconds,
    advanceToNextImage,
    scheduleTimeout,
  ]);

  const processSpokenAlternatives = useCallback(
    (alternatives: string[], sourcePlayer?: PlayerId, isFinal = true) => {
      const st = stateRef.current;
      if (
        st.duelEnded ||
        st.duelFinishPhase !== null ||
        st.isPaused ||
        st.phoneModalOpen ||
        st.revealedAnswer !== null
      ) {
        return;
      }

      if (performance.now() < ignoreVoiceUntilRef.current) {
        return;
      }

      if (sourcePlayer && sourcePlayer !== st.activePlayer) {
        return;
      }

      if (alternatives[0]) {
        setLiveTranscript(alternatives[0]);
      }

      const matchResult = evaluateVoiceInput(alternatives, st.currentItem, {
        isFinal,
      });
      if (matchResult.matched) {
        passGuardRef.current.cancel();
        triggerCorrectGuess(matchResult.matchedAlias || alternatives[0]);
      } else if (matchResult.isPassCommand) {
        passGuardRef.current.triggerIfAllowed(isFinal, triggerPass);
      } else {
        passGuardRef.current.cancel();
      }
    },
    [triggerPass, triggerCorrectGuess]
  );

  const processSpokenAlternativesRef = useRef(processSpokenAlternatives);
  processSpokenAlternativesRef.current = processSpokenAlternatives;

  const p1RemoteConnectedRef = useRef(p1RemoteConnected);
  p1RemoteConnectedRef.current = p1RemoteConnected;
  const p2RemoteConnectedRef = useRef(p2RemoteConnected);
  p2RemoteConnectedRef.current = p2RemoteConnected;

  const startMicSession = useCallback(() => {
    if (isDiscordActivity || (p1RemoteConnected && p2RemoteConnected)) {
      if (recognizerRef.current) {
        recognizerRef.current.stop();
        recognizerRef.current = null;
      }
      const st = stateRef.current;
      setMicListening(
        (st.activePlayer === 'p1' && p1RemoteConnected) ||
          (st.activePlayer === 'p2' && p2RemoteConnected)
      );
      return;
    }

    if (recognizerRef.current) {
      recognizerRef.current.stop();
    }
    setMicErrorMsg(null);
    const rec = new SmartSpeechRecognizer(
      (alternatives, isFinal) => {
        const st = stateRef.current;
        const activeUsesPhone =
          (st.activePlayer === 'p1' && p1RemoteConnectedRef.current) ||
          (st.activePlayer === 'p2' && p2RemoteConnectedRef.current);
        if (activeUsesPhone) return;
        processSpokenAlternativesRef.current(
          alternatives,
          st.activePlayer,
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
        const st = stateRef.current;
        const activeUsesPhone =
          (st.activePlayer === 'p1' && p1RemoteConnectedRef.current) ||
          (st.activePlayer === 'p2' && p2RemoteConnectedRef.current);
        if (!activeUsesPhone) {
          setMicVolume(vol);
        }
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
  }, [
    isDiscordActivity,
    p1RemoteConnected,
    p2RemoteConnected,
    settings.language,
    category.items,
  ]);

  useEffect(() => {
    startMicSession();

    return () => {
      recognizerRef.current?.stop();
    };
  }, [startMicSession]);

  useEffect(() => {
    if (isDiscordActivity || (p1RemoteConnected && p2RemoteConnected)) {
      setMicListening(
        (activePlayer === 'p1' && p1RemoteConnected) ||
          (activePlayer === 'p2' && p2RemoteConnected)
      );
    }
  }, [activePlayer, p1RemoteConnected, p2RemoteConnected, isDiscordActivity]);

  const handleRemotePacket = useCallback(
    (packet: RemoteMicPacket) => {
      const slot: PlayerId = packet.slot === 'p1' ? 'p1' : 'p2';
      if (packet.type === 'TRANSCRIPT') {
        const alts =
          packet.alternatives && packet.alternatives.length > 0
            ? packet.alternatives
            : packet.transcript
            ? [packet.transcript]
            : [];
        if (alts.length > 0) {
          processSpokenAlternativesRef.current(
            alts,
            slot,
            Boolean(packet.isFinal ?? true)
          );
        }
      } else if (packet.type === 'PASS_BUTTON') {
        if (stateRef.current.activePlayer === slot) {
          triggerPass();
        }
      } else if (packet.type === 'MIC_LEVEL') {
        if (stateRef.current.activePlayer === slot) {
          setMicVolume(packet.micLevel || 0);
        }
      } else if (packet.type === 'PING') {
        const st = stateRef.current;
        onSendRemoteState({
          type: 'STATE_UPDATE',
          activePlayer: st.activePlayer,
          p1Name: p1.name,
          p2Name: p2.name,
          p1Avatar: p1.avatar,
          p2Avatar: p2.avatar,
          categoryName: category.name,
          inDuel: st.duelFinishPhase === null,
          timeLeftP1: Math.ceil(st.timeP1),
          timeLeftP2: Math.ceil(st.timeP2),
          language: settings.language,
          clearBufferSeq: clearBufferSeqRef.current,
        });
      }
    },
    [
      triggerPass,
      onSendRemoteState,
      p1.name,
      p1.avatar,
      p2.name,
      p2.avatar,
      category.name,
      settings.language,
    ]
  );

  useEffect(() => {
    if (!subscribeRemotePackets) return;
    return subscribeRemotePackets(handleRemotePacket);
  }, [subscribeRemotePackets, handleRemotePacket]);

  useEffect(() => {
    if (subscribeRemotePackets || !latestRemotePacket) return;
    handleRemotePacket(latestRemotePacket);
  }, [subscribeRemotePackets, latestRemotePacket, handleRemotePacket]);

  const lastRemoteSyncAtRef = useRef(0);
  const lastRemoteStateSigRef = useRef('');

  useEffect(() => {
    if (!p1RemoteConnected && !p2RemoteConnected) {
      lastRemoteStateSigRef.current = '';
      return;
    }

    const immediateSig = `${activePlayer}|${currentItem.id}|${duelFinishPhase ?? 'live'}|${clearBufferSeqRef.current}|${p1.name}|${p2.name}|${settings.language}|${p1RemoteConnected}|${p2RemoteConnected}`;
    const now = performance.now();
    const stateChanged = immediateSig !== lastRemoteStateSigRef.current;

    if (!stateChanged && now - lastRemoteSyncAtRef.current < 250) {
      return;
    }

    lastRemoteStateSigRef.current = immediateSig;
    lastRemoteSyncAtRef.current = now;

    onSendRemoteState({
      type: 'STATE_UPDATE',
      activePlayer,
      p1Name: p1.name,
      p2Name: p2.name,
      p1Avatar: p1.avatar,
      p2Avatar: p2.avatar,
      categoryName: category.name,
      inDuel: duelFinishPhase === null,
      timeLeftP1: Math.ceil(timeP1),
      timeLeftP2: Math.ceil(timeP2),
      language: settings.language,
      clearBufferSeq: clearBufferSeqRef.current,
    });
  }, [
    activePlayer,
    currentItem.id,
    duelFinishPhase,
    timeP1,
    timeP2,
    settings.language,
    p1RemoteConnected,
    p2RemoteConnected,
    p1.name,
    p1.avatar,
    p2.name,
    p2.avatar,
    category.name,
    onSendRemoteState,
  ]);

  const handleProceedToDraft = useCallback(() => {
    clearAllPendingTimers();
    if (finishTimerRef.current) {
      clearTimeout(finishTimerRef.current);
      finishTimerRef.current = null;
    }
    soundEngine.stopAnnouncements();
    if (duelFinishData) {
      onDuelFinished(duelFinishData.summary);
    }
  }, [clearAllPendingTimers, duelFinishData, onDuelFinished]);

  const handleTimeExpired = useCallback(
    (loser: PlayerId) => {
      if (finishedTriggeredRef.current || stateRef.current.duelEnded) return;
      finishedTriggeredRef.current = true;
      const st = stateRef.current;
      st.duelEnded = true;

      clearAllPendingTimers();
      passGuardRef.current.cancel();
      recognizerRef.current?.stop();
      soundEngine.stopAnnouncements();

      const winner: PlayerId = loser === 'p1' ? 'p2' : 'p1';
      const summary: DuelSummary = {
        roundNumber,
        winner,
        loser,
        p1PlayerId: p1.id,
        p2PlayerId: p2.id,
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

      scheduleTimeout(() => {
        setScreenShake(false);
      }, 450);

      scheduleTimeout(() => {
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
      clearAllPendingTimers,
      category.id,
      category.icon,
      category.name,
      onDuelFinished,
      p1.id,
      p2.id,
      roundNumber,
      scheduleTimeout,
    ]
  );

  handleTimeExpiredRef.current = handleTimeExpired;

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;

      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (phoneModalOpen) {
        if (e.code === 'Escape') {
          e.preventDefault();
          setPhoneModalOpen(false);
        }
        return;
      }

      if (duelFinishPhase !== null) {
        if (e.code === 'Enter' || e.code === 'Space') {
          e.preventDefault();
          handleProceedToDraft();
        }
        return;
      }

      if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        setIsPaused((prev) => !prev);
        return;
      }

      if (e.code === 'Escape' && isPaused) {
        e.preventDefault();
        setIsPaused(false);
        return;
      }

      if (isPaused) return;

      if (e.code === 'Space') {
        e.preventDefault();
        triggerPass();
      } else if (e.code === 'Enter') {
        e.preventDefault();
        triggerCorrectGuess(stateRef.current.currentItem.answer);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    phoneModalOpen,
    isPaused,
    triggerPass,
    triggerCorrectGuess,
    duelFinishPhase,
    handleProceedToDraft,
  ]);

  // Main countdown timer loop: frozen while revealedAnswer !== null, loading, hidden, or paused
  useEffect(() => {
    let lastTick = performance.now();

    const interval = setInterval(() => {
      const now = performance.now();
      const dt = Math.min(0.25, Math.max(0, (now - lastTick) / 1000));
      lastTick = now;

      if (typeof document !== 'undefined' && document.hidden) return;

      const st = stateRef.current;
      // Freeze clock while answer is revealed (1.4s on pass, 700ms on correct), image loading, paused, or duel ended
      if (
        st.duelEnded ||
        st.duelFinishPhase !== null ||
        st.isPaused ||
        st.phoneModalOpen ||
        !st.imageLoaded ||
        st.revealedAnswer !== null
      ) {
        return;
      }

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
  }, [handleTimeExpired]);

  const p1Active = activePlayer === 'p1';
  const p2Active = activePlayer === 'p2';
  const stageColor = p1Active ? p1Color.id : p2Color.id;
  const p1Urgent = p1Active && timeP1 <= 10;
  const p2Urgent = p2Active && timeP2 <= 10;
  const photoTilt = itemIndex % 2 === 0 ? '-1deg' : '1deg';

  return (
    <div
      className={`relative min-h-[100dvh] lg:h-[100dvh] lg:max-h-[100dvh] w-full flex flex-col justify-between p-3 sm:p-5 select-none overflow-y-auto lg:overflow-hidden pb-[max(0.75rem,env(safe-area-inset-bottom))] ${
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
            {(isDiscordActivity || settings.micMode === 'discord-p2p') && (
              <button
                type="button"
                onClick={() => setPhoneModalOpen(true)}
                className={`btn-push px-3 py-2 rounded-xl border-[3px] border-ink shadow-hard-sm font-display font-black text-xs flex items-center gap-1.5 transition-transform active:translate-y-0.5 ${
                  p1RemoteConnected || p2RemoteConnected
                    ? 'bg-green text-ink'
                    : 'bg-yellow text-ink'
                }`}
                title={settings.language === 'en' ? 'Smartphone Mic QR' : 'Microfono Smartphone QR'}
              >
                <Smartphone className="w-4 h-4 shrink-0" />
                <span className="hidden sm:inline">
                  {p1RemoteConnected || p2RemoteConnected
                    ? settings.language === 'en'
                      ? 'Phone Mic'
                      : 'Mic Telefono'
                    : settings.language === 'en'
                    ? 'Connect Phone'
                    : 'QR Telefono'}
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
        <main className="w-full my-auto flex-1 flex flex-col lg:grid lg:grid-cols-[200px_1fr_200px] items-center gap-4 lg:gap-6 min-h-0 py-2">
          {/* ------------------------------------------------------------ */}
          {/* Player 1 Card (Desktop: Left 200px)                           */}
          {/* ------------------------------------------------------------ */}
          <div
            style={
              p1Active
                ? { backgroundColor: p1Color.bgHex, color: p1Color.onColorHex }
                : undefined
            }
            className={`hidden lg:flex w-full min-h-[220px] rounded-card border-[3px] border-ink p-5 flex-col items-center justify-center gap-2 text-center transition-all relative ${
              p1Active
                ? 'shadow-hard-lifted tactile-lifted'
                : 'bg-paper text-ink opacity-90 tactile-pressed'
            }`}
          >
            {/* C3: Avatar 72px overlapping card's top edge */}
            <div className="absolute -top-9 left-1/2 -translate-x-1/2 z-20">
              <div
                className={`w-[72px] h-[72px] rounded-full bg-paper border-[3px] border-ink flex items-center justify-center text-4xl shadow-hard-sm relative ${
                  p1Active ? 'animate-avatar-hop ring-4 ring-yellow' : ''
                }`}
                style={{ outline: `4px solid ${p1Color.bgHex}` }}
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
                  : p1RemoteConnected
                  ? settings.language === 'en'
                    ? 'Speak into P1 phone...'
                    : 'Parla al telefono P1...'
                  : isDiscordActivity
                  ? settings.language === 'en'
                    ? 'Shout in voice chat!'
                    : 'Grida nel canale vocale!'
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
                disabled={revealedAnswer !== null || duelFinishPhase !== null}
                onClick={(e) => {
                  e.stopPropagation();
                  handleReportPhoto();
                }}
                title={t('arena.reportTooltip', settings.language)}
                aria-label={t('arena.reportPhoto', settings.language)}
                className="absolute top-2 right-2 z-30 w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-paper/90 hover:bg-red/10 active:scale-95 border-2 border-ink flex items-center justify-center text-xs sm:text-sm text-ink/70 hover:text-red transition-all cursor-pointer shadow-sm select-none disabled:opacity-40 disabled:pointer-events-none"
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

              {/* Timeout Reveal */}
              {duelFinishPhase === 'reveal' && duelFinishData && (
                <>
                  <div className="absolute -inset-2 rounded-card border-[4px] border-red pointer-events-none z-20 animate-feedback-ring" />
                  <div className="absolute inset-0 rounded-xl z-30 bg-ink/55 backdrop-blur-[2px] flex flex-col items-center justify-center gap-2.5 p-4 sm:p-6 pb-10 text-center pointer-events-none">
                    <div className="px-5 py-2.5 sm:px-7 sm:py-3.5 rounded-2xl bg-red text-white border-[3px] border-ink shadow-hard font-display font-black text-2xl sm:text-4xl uppercase tracking-tight -rotate-2 animate-pop-in flex items-center gap-2.5">
                      <span aria-hidden="true">⏰</span>
                      <span>{settings.language === 'en' ? "TIME'S UP!" : 'TEMPO SCADUTO!'}</span>
                    </div>
                    <div className="px-3.5 py-1 rounded-full bg-paper text-ink border-2 border-ink shadow-hard-sm font-display font-black text-xs sm:text-sm uppercase tracking-wider animate-pop-in">
                      {(duelFinishData.loser === 'p1' ? p1.name : p2.name)} · 0.0s
                    </div>
                  </div>
                </>
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
                  alt=""
                  referrerPolicy="no-referrer"
                  decoding="async"
                  loading="eager"
                  onLoad={(e) => {
                    const { naturalWidth, naturalHeight } = e.currentTarget;
                    if (!isRenderedImageHealthy(naturalWidth, naturalHeight)) {
                      tryNextImageFallback();
                      return;
                    }
                    setImageLoaded(true);
                  }}
                  onError={() => {
                    tryNextImageFallback();
                  }}
                  className={`max-h-[44vh] sm:max-h-[52vh] w-auto max-w-full object-contain rounded-lg transition-opacity duration-150 ${
                    imageLoaded ? 'opacity-100' : 'opacity-0'
                  }`}
                />
              </div>

              {/* A1: Sticker Label Overlapping Bottom Edge of Photo */}
              {revealedAnswer && (
                <div
                  className={`absolute bottom-2 sm:-bottom-5 left-1/2 -translate-x-1/2 z-40 max-w-[92%] sm:max-w-[85%] bg-paper border-[3px] border-ink shadow-hard rounded-2xl px-4 py-2 sm:px-6 sm:py-3 flex items-center gap-3 animate-starburst-pop select-none ${
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
                  <span style={{ color: p1Active ? p1Color.bgHex : p2Color.bgHex }}>
                    “{liveTranscript}”
                  </span>
                ) : (p1Active && p1RemoteConnected) || (p2Active && p2RemoteConnected) ? (
                  <span className="text-green font-bold">
                    📱 {settings.language === 'en' ? 'Speak into phone...' : 'Parla al telefono...'}
                  </span>
                ) : isDiscordActivity ? (
                  <span className="text-ink font-bold">
                    🎙️ {settings.language === 'en' ? 'Shout in voice chat! [Enter]/[Space]' : 'Grida nel canale vocale! [Invio]/[Spazio]'}
                  </span>
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
            style={
              p2Active
                ? { backgroundColor: p2Color.bgHex, color: p2Color.onColorHex }
                : undefined
            }
            className={`hidden lg:flex w-full min-h-[220px] rounded-card border-[3px] border-ink p-5 flex-col items-center justify-center gap-2 text-center transition-all relative ${
              p2Active
                ? 'shadow-hard-lifted tactile-lifted'
                : 'bg-paper text-ink opacity-90 tactile-pressed'
            }`}
          >
            {/* C3: Avatar 72px overlapping card's top edge */}
            <div className="absolute -top-9 left-1/2 -translate-x-1/2 z-20">
              <div
                className={`w-[72px] h-[72px] rounded-full bg-paper border-[3px] border-ink flex items-center justify-center text-4xl shadow-hard-sm relative ${
                  p2Active ? 'animate-avatar-hop ring-4 ring-yellow' : ''
                }`}
                style={{ outline: `4px solid ${p2Color.bgHex}` }}
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
                  : p2RemoteConnected
                  ? settings.language === 'en'
                    ? 'Speak into P2 phone...'
                    : 'Parla al telefono P2...'
                  : isDiscordActivity
                  ? settings.language === 'en'
                    ? 'Shout in voice chat!'
                    : 'Grida nel canale vocale!'
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
            style={
              p1Active
                ? { backgroundColor: p1Color.bgHex, color: p1Color.onColorHex }
                : undefined
            }
            className={`p-3 rounded-card border-[3px] border-ink flex items-center justify-between gap-2 transition-all relative ${
              p1Active ? 'tactile-lifted' : 'bg-paper text-ink tactile-pressed'
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
            style={
              p2Active
                ? { backgroundColor: p2Color.bgHex, color: p2Color.onColorHex }
                : undefined
            }
            className={`p-3 rounded-card border-[3px] border-ink flex items-center justify-between gap-2 transition-all relative ${
              p2Active ? 'tactile-lifted' : 'bg-paper text-ink tactile-pressed'
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
          <div className="flex items-center justify-center gap-2 sm:gap-4 w-full">
            {/* Mic indicator: Discord Voice / Phone Companion vs Web Browser Mic */}
            {(isDiscordActivity || settings.micMode === 'discord-p2p') ? (
              <button
                type="button"
                onClick={() => setPhoneModalOpen(true)}
                className="btn-push flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-3.5 py-2.5 rounded-xl bg-paper border-[3px] border-ink shadow-hard shrink-0 h-14 sm:h-16 hover:bg-yellow transition-colors"
                title={
                  p1RemoteConnected || p2RemoteConnected
                    ? settings.language === 'en'
                      ? 'Phone Mic Connected (Click for QR)'
                      : 'Microfono Telefono Connesso (Clicca per QR)'
                    : settings.language === 'en'
                    ? 'Open Phone Mic QR'
                    : 'Apri QR Telefono'
                }
              >
                <Smartphone
                  className={`w-5 h-5 ${
                    p1RemoteConnected || p2RemoteConnected ? 'text-green' : 'text-ink'
                  }`}
                />
                <span className="font-display font-black text-xs text-ink hidden sm:inline">
                  {p1RemoteConnected || p2RemoteConnected ? '📱 Mic' : '📱 QR'}
                </span>
                {(p1RemoteConnected || p2RemoteConnected) && (
                  <span className="w-2.5 h-2.5 rounded-full bg-green" />
                )}
              </button>
            ) : (
              <div
                className="relative flex items-center gap-1.5 px-2.5 sm:px-3 py-2.5 rounded-xl bg-paper border-[3px] border-ink shadow-hard shrink-0 h-14 sm:h-16"
                title="Mic level"
              >
                {micListening && micVolume > 0.12 && (
                  <span className="absolute inset-0 rounded-xl border-2 border-green bg-green/20 pointer-events-none animate-mic-ripple" />
                )}
                <Mic className={`relative z-10 w-5 h-5 ${micListening ? 'text-green' : 'text-ink/40'}`} />
                <div className="flex items-end gap-1 h-7 sm:h-8">
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
                      micListening && micVolume > 0.55 ? 'bg-green h-7 sm:h-8' : 'bg-ink/15 h-3'
                    }`}
                  />
                </div>
              </div>
            )}

            {/* Pass Button */}
            <button
              type="button"
              onClick={triggerPass}
              disabled={revealedAnswer !== null || duelFinishPhase !== null}
              className="btn-push flex-1 sm:flex-initial min-w-0 sm:min-w-[160px] min-h-[56px] sm:min-h-[64px] px-3 sm:px-6 py-2.5 rounded-2xl bg-paper text-ink font-display font-black text-base sm:text-xl flex items-center justify-center gap-1.5 sm:gap-2 border-[3px] border-ink shadow-hard disabled:opacity-50"
            >
              <FastForward className="w-5 h-5 shrink-0" />
              <span className="truncate">
                Pass (−3<span style={{ fontSize: '0.45em' }} className="lowercase ml-0.5 align-baseline">s</span>)
              </span>
            </button>

            {/* Correct Button */}
            <button
              type="button"
              onClick={() => triggerCorrectGuess(currentItem.answer)}
              disabled={revealedAnswer !== null || duelFinishPhase !== null}
              className="btn-push flex-1 sm:flex-initial min-w-0 sm:min-w-[160px] min-h-[56px] sm:min-h-[64px] px-3 sm:px-6 py-2.5 rounded-2xl bg-green text-ink font-display font-black text-base sm:text-xl flex items-center justify-center gap-1.5 sm:gap-2 border-[3px] border-ink shadow-hard disabled:opacity-50"
            >
              <Check className="w-5 h-5 sm:w-6 sm:h-6 stroke-[3] shrink-0" />
              <span className="truncate">{t('arena.correct', settings.language)}</span>
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
              style={{
                backgroundColor:
                  duelFinishData.winner === 'p1' ? p1Color.bgHex : p2Color.bgHex,
                color:
                  duelFinishData.winner === 'p1'
                    ? p1Color.onColorHex
                    : p2Color.onColorHex,
              }}
              className="w-20 h-20 rounded-2xl border-[3px] border-ink shadow-hard flex items-center justify-center text-5xl animate-bounce"
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
        <div
          className="fixed inset-0 z-50 bg-[#0F0E1A]/90 flex items-center justify-center p-4"
          onClick={() => setIsPaused(false)}
        >
          <div
            className="card-paper max-w-sm w-full p-6 text-center flex flex-col items-center gap-4 modal-slap-in"
            onClick={(e) => e.stopPropagation()}
          >
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
              disabled={revealedAnswer !== null || duelFinishPhase !== null}
              onClick={() => {
                handleReportPhoto();
                setIsPaused(false);
              }}
              className="btn-push w-full py-2.5 rounded-xl bg-paper text-ink font-display font-bold text-sm border-2 border-ink flex items-center justify-center gap-2 hover:bg-red/10 transition-colors disabled:opacity-40"
            >
              <span>🚩</span>
              <span>{t('arena.reportPhoto', settings.language)}</span>
            </button>
          </div>
        </div>
      )}

      {/* Phone Mic QR Modal (Can be opened mid-game in Discord Activity or remote pairing) */}
      <PhoneMicModal
        isOpen={phoneModalOpen}
        onClose={() => setPhoneModalOpen(false)}
        roomCode={roomCode}
        isConnected={p2RemoteConnected}
        p1Connected={p1RemoteConnected}
        p2Connected={p2RemoteConnected}
        p1Name={localizePlayerName(p1.name, settings.language)}
        p2Name={localizePlayerName(p2.name, settings.language)}
        language={settings.language}
      />
    </div>
  );
};
