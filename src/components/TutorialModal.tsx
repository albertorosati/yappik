import React, { useEffect, useState } from 'react';
import {
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  Crown,
  EyeOff,
  FastForward,
  Gamepad2,
  Mic,
  Radio,
  Rocket,
  Smartphone,
  Sparkles,
  Users,
  X,
  Zap,
} from 'lucide-react';
import { AppLanguage } from '../types/game';
import { soundEngine } from '../engine/soundEffects';
import {
  isTutorialDismissedForever,
  setTutorialDismissedForever,
} from '../utils/tutorialStorage';

interface TutorialModalProps {
  isOpen: boolean;
  language: AppLanguage;
  onClose: (dismissForever: boolean) => void;
}

const DEMO_CARDS = [
  { emoji: '🍕', answerIt: 'PIZZA!', answerEn: 'PIZZA!' },
  { emoji: '🗽', answerIt: 'STATUA DELLA LIBERTÀ!', answerEn: 'STATUE OF LIBERTY!' },
  { emoji: '🎸', answerIt: 'CHITARRA!', answerEn: 'GUITAR!' },
  { emoji: '🚀', answerIt: 'RAZZO!', answerEn: 'ROCKET!' },
];

const ModesStage: React.FC<{ language: AppLanguage }> = ({ language }) => {
  const [activeIdx, setActiveIdx] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => {
      setActiveIdx((prev) => (prev + 1) % 3);
    }, 1800);
    return () => window.clearInterval(id);
  }, []);

  const cards = [
    {
      id: 'duel',
      icon: Zap,
      label: '1v1',
      badge: language === 'en' ? 'HEAD TO HEAD' : 'TESTA A TESTA',
      tip:
        language === 'en'
          ? 'Two players race against alternating chess clocks!'
          : 'Due giocatori si sfidano con orologio alternato!',
      bg: 'bg-blue text-white',
      avatars: ['🦊', '🐯'],
    },
    {
      id: 'solo',
      icon: Sparkles,
      label: 'Solo',
      badge: language === 'en' ? 'PERSONAL BEST' : 'RECORD SOLO',
      tip:
        language === 'en'
          ? 'Practice 30s to infinite mode and beat your records!'
          : 'Allenati da 30s a infinito e batti i tuoi record!',
      bg: 'bg-yellow text-ink',
      avatars: ['🐼'],
    },
    {
      id: 'party',
      icon: Crown,
      label: 'Party',
      badge: language === 'en' ? '3-8 PLAYERS' : '3-8 AMICI',
      tip:
        language === 'en'
          ? 'Rotating mini-tournament with a championship podium!'
          : 'Torneo a rotazione con podio e classifica finale!',
      bg: 'bg-red text-white',
      avatars: ['🦁', '🐙', '🐸'],
    },
  ];

  const current = cards[activeIdx];

  return (
    <div className="w-full h-full flex flex-col justify-between gap-3 p-3 sm:p-4">
      <div className="grid grid-cols-3 gap-2 sm:gap-3 flex-1 items-center">
        {cards.map((card, idx) => {
          const Icon = card.icon;
          const isActive = idx === activeIdx;
          return (
            <button
              key={card.id}
              type="button"
              onClick={() => {
                soundEngine.playRandomizerStep(1.15);
                setActiveIdx(idx);
              }}
              className={`relative rounded-2xl border-[3px] border-ink p-2.5 sm:p-3 flex flex-col items-center justify-center gap-1.5 transition-all duration-300 cursor-pointer ${
                card.bg
              } ${
                isActive
                  ? 'scale-[1.06] -translate-y-1.5 shadow-[0_0_0_3px_#FFC933,6px_6px_0px_#14121F] z-10'
                  : 'opacity-80 hover:opacity-100 shadow-hard-sm'
              }`}
            >
              <span className="text-[9px] sm:text-[10px] font-display font-black uppercase tracking-wider px-2 py-0.5 rounded-full bg-paper text-ink border-[2px] border-ink">
                {card.badge}
              </span>
              <Icon className={`w-6 h-6 sm:w-7 sm:h-7 ${isActive ? 'animate-float-gentle' : ''}`} />
              <span className="font-display font-black text-base sm:text-xl leading-none">
                {card.label}
              </span>
              <div className="flex items-center justify-center -space-x-1 mt-0.5">
                {card.avatars.map((avatar, aIdx) => (
                  <span
                    key={avatar}
                    style={{ animationDelay: `${aIdx * 90}ms` }}
                    className={`w-6 h-6 sm:w-7 sm:h-7 rounded-full bg-paper border-2 border-ink flex items-center justify-center text-xs sm:text-sm ${
                      isActive ? 'animate-avatar-hop' : ''
                    }`}
                  >
                    {avatar}
                  </span>
                ))}
              </div>
            </button>
          );
        })}
      </div>

      <div className="mx-auto px-3.5 py-1.5 rounded-xl bg-paper border-[2.5px] border-ink shadow-hard-sm text-center">
        <span className="font-display font-bold text-xs sm:text-sm text-ink">
          {current.tip}
        </span>
      </div>
    </div>
  );
};

const ChessClockStage: React.FC<{ language: AppLanguage }> = ({ language }) => {
  const [turn, setTurn] = useState<'p1' | 'p2'>('p1');
  const [t1, setT1] = useState(45.0);
  const [t2, setT2] = useState(45.0);
  const [s1, setS1] = useState(2);
  const [s2, setS2] = useState(1);
  const [cardIdx, setCardIdx] = useState(0);
  const [burstKey, setBurstKey] = useState(0);
  const [showBurst, setShowBurst] = useState(false);

  const triggerCorrectSwitch = () => {
    setShowBurst(true);
    setBurstKey((k) => k + 1);
    setTurn((prevTurn) => {
      if (prevTurn === 'p1') {
        setS1((s) => s + 1);
        return 'p2';
      }
      setS2((s) => s + 1);
      return 'p1';
    });
    setCardIdx((idx) => (idx + 1) % DEMO_CARDS.length);
  };

  useEffect(() => {
    const tick = window.setInterval(() => {
      setTurn((currentTurn) => {
        if (currentTurn === 'p1') {
          setT1((prev) => (prev <= 32 ? 45.0 : Number((prev - 0.1).toFixed(1))));
        } else {
          setT2((prev) => (prev <= 32 ? 45.0 : Number((prev - 0.1).toFixed(1))));
        }
        return currentTurn;
      });
    }, 100);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    const cycle = window.setInterval(() => {
      triggerCorrectSwitch();
    }, 2800);
    return () => window.clearInterval(cycle);
  }, []);

  useEffect(() => {
    if (!showBurst) return;
    const hideId = window.setTimeout(() => setShowBurst(false), 900);
    return () => window.clearTimeout(hideId);
  }, [burstKey, showBurst]);

  const card = DEMO_CARDS[cardIdx];

  return (
    <div className="w-full h-full flex flex-col justify-between gap-2.5 p-3 sm:p-4">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 sm:gap-3 flex-1">
        {/* P1 Clock */}
        <div
          className={`relative rounded-2xl border-[3px] border-ink p-2.5 sm:p-3 flex flex-col items-center gap-1 transition-all duration-200 ${
            turn === 'p1'
              ? 'bg-blue text-white scale-[1.03] shadow-[0_0_0_3px_#FFC933,4px_4px_0px_#14121F]'
              : 'bg-paper/90 text-ink/70 opacity-80'
          }`}
        >
          {showBurst && turn === 'p2' && (
            <div
              key={`b1-${burstKey}`}
              className="absolute -top-6 left-1/2 -translate-x-1/2 px-2.5 py-0.5 rounded-full bg-green text-ink border-2 border-ink font-display font-black text-xs whitespace-nowrap shadow-hard-sm animate-starburst-pop z-20"
            >
              ✓ +1!
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <span className="text-base sm:text-lg">🦊</span>
            <span className="font-display font-black text-xs sm:text-sm">G1</span>
          </div>
          <span className="font-mono font-black text-xl sm:text-2xl tabular-nums">
            {t1.toFixed(1)}s
          </span>
          <span
            className={`text-[10px] font-display font-black uppercase px-2 py-0.5 rounded-full border border-ink ${
              turn === 'p1' ? 'bg-yellow text-ink animate-pulse' : 'bg-ink/10 text-ink/60'
            }`}
          >
            {turn === 'p1'
              ? language === 'en'
                ? 'TICKING'
                : 'SCORRE'
              : language === 'en'
              ? 'PAUSED'
              : 'FERMO'}
          </span>
          <span className="text-[11px] font-display font-bold opacity-90">
            {language === 'en' ? `Score: ${s1}` : `Punti: ${s1}`}
          </span>
        </div>

        {/* Center Photo Card */}
        <div className="flex flex-col items-center gap-1.5">
          <div
            key={cardIdx}
            className="w-20 h-20 sm:w-24 sm:h-24 rounded-2xl bg-paper border-[3px] border-ink shadow-hard flex flex-col items-center justify-center animate-photo-slap relative"
          >
            <span className="text-4xl sm:text-5xl leading-none">{card.emoji}</span>
            {showBurst && (
              <div
                key={`pop-${burstKey}`}
                className="absolute -bottom-2.5 px-2 py-0.5 rounded-lg bg-green text-ink border-2 border-ink font-display font-black text-[10px] whitespace-nowrap animate-starburst-pop"
              >
                {language === 'en' ? card.answerEn : card.answerIt}
              </div>
            )}
          </div>
        </div>

        {/* P2 Clock */}
        <div
          className={`relative rounded-2xl border-[3px] border-ink p-2.5 sm:p-3 flex flex-col items-center gap-1 transition-all duration-200 ${
            turn === 'p2'
              ? 'bg-red text-white scale-[1.03] shadow-[0_0_0_3px_#FFC933,4px_4px_0px_#14121F]'
              : 'bg-paper/90 text-ink/70 opacity-80'
          }`}
        >
          {showBurst && turn === 'p1' && (
            <div
              key={`b2-${burstKey}`}
              className="absolute -top-6 left-1/2 -translate-x-1/2 px-2.5 py-0.5 rounded-full bg-green text-ink border-2 border-ink font-display font-black text-xs whitespace-nowrap shadow-hard-sm animate-starburst-pop z-20"
            >
              ✓ +1!
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <span className="text-base sm:text-lg">🐯</span>
            <span className="font-display font-black text-xs sm:text-sm">G2</span>
          </div>
          <span className="font-mono font-black text-xl sm:text-2xl tabular-nums">
            {t2.toFixed(1)}s
          </span>
          <span
            className={`text-[10px] font-display font-black uppercase px-2 py-0.5 rounded-full border border-ink ${
              turn === 'p2' ? 'bg-yellow text-ink animate-pulse' : 'bg-ink/10 text-ink/60'
            }`}
          >
            {turn === 'p2'
              ? language === 'en'
                ? 'TICKING'
                : 'SCORRE'
              : language === 'en'
              ? 'PAUSED'
              : 'FERMO'}
          </span>
          <span className="text-[11px] font-display font-bold opacity-90">
            {language === 'en' ? `Score: ${s2}` : `Punti: ${s2}`}
          </span>
        </div>
      </div>

      <div className="flex justify-center">
        <button
          type="button"
          onClick={() => {
            soundEngine.playCorrectAnswer(1);
            triggerCorrectSwitch();
          }}
          className="px-3.5 py-1.5 rounded-xl bg-green text-ink border-[2.5px] border-ink shadow-hard-sm font-display font-black text-xs sm:text-sm flex items-center gap-1.5 hover:-translate-y-0.5 active:translate-y-0.5 transition-all cursor-pointer"
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span>
            {language === 'en' ? 'Simulate Correct Answer!' : 'Simula Risposta Giusta!'}
          </span>
        </button>
      </div>
    </div>
  );
};

const VoiceAndPassStage: React.FC<{ language: AppLanguage }> = ({ language }) => {
  const samplePhrase = language === 'en' ? 'Statue of Liberty!' : 'Statua della Libertà!';
  const [charCount, setCharCount] = useState(6);
  const [passDemoCount, setPassDemoCount] = useState(0);
  const [clockPreview, setClockPreview] = useState(38.0);
  const [showPassPenalty, setShowPassPenalty] = useState(false);

  useEffect(() => {
    const typer = window.setInterval(() => {
      setCharCount((prev) => (prev >= samplePhrase.length ? 2 : prev + 1));
    }, 115);
    return () => window.clearInterval(typer);
  }, [samplePhrase]);

  const handlePassDemo = () => {
    setPassDemoCount((c) => c + 1);
    setShowPassPenalty(true);
    setClockPreview((prev) => (prev <= 8 ? 38.0 : Number((prev - 3).toFixed(1))));
  };

  useEffect(() => {
    if (!showPassPenalty) return;
    const tId = window.setTimeout(() => setShowPassPenalty(false), 850);
    return () => window.clearTimeout(tId);
  }, [passDemoCount, showPassPenalty]);

  const bars = [
    { dur: '620ms', delay: '0ms', h: 'h-6' },
    { dur: '480ms', delay: '120ms', h: 'h-9' },
    { dur: '760ms', delay: '60ms', h: 'h-11' },
    { dur: '520ms', delay: '180ms', h: 'h-8' },
    { dur: '690ms', delay: '90ms', h: 'h-10' },
    { dur: '540ms', delay: '150ms', h: 'h-7' },
  ];

  const isMatched = charCount >= samplePhrase.length - 1;

  return (
    <div className="w-full h-full flex flex-col justify-between gap-2.5 p-3 sm:p-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 flex-1 items-center">
        {/* Voice Demo Card */}
        <div className="rounded-2xl bg-paper border-[3px] border-ink p-3 shadow-hard-sm flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="relative w-9 h-9 rounded-xl bg-green border-2 border-ink flex items-center justify-center">
                <span className="absolute inset-0 rounded-xl border-2 border-green animate-mic-ripple" />
                <Mic className="w-4 h-4 text-ink stroke-[2.5] relative z-10" />
              </div>
              <span className="font-display font-black text-xs sm:text-sm text-ink">
                {language === 'en' ? 'Shout Answer' : 'Parla al Microfono'}
              </span>
            </div>
            <div className="flex items-end gap-1 h-7">
              {bars.map((bar, idx) => (
                <span
                  key={idx}
                  style={
                    {
                      '--bar-dur': bar.dur,
                      '--bar-delay': bar.delay,
                    } as React.CSSProperties
                  }
                  className={`w-1.5 ${bar.h} max-h-full rounded-full bg-blue border border-ink animate-voice-bar`}
                />
              ))}
            </div>
          </div>

          <div
            className={`px-3 py-2 rounded-xl border-2 border-ink font-display font-black text-xs sm:text-sm flex items-center justify-between gap-2 transition-colors ${
              isMatched ? 'bg-green text-ink' : 'bg-white text-ink'
            }`}
          >
            <span className="truncate">"{samplePhrase.slice(0, charCount)}"</span>
            {isMatched && (
              <span className="px-1.5 py-0.5 rounded-md bg-paper text-[10px] border border-ink shrink-0 animate-pop-in">
                ✓ MATCH!
              </span>
            )}
          </div>
        </div>

        {/* Pass (-3s) & Manual Card */}
        <div className="rounded-2xl bg-paper border-[3px] border-ink p-3 shadow-hard-sm flex flex-col justify-between gap-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span
                key={passDemoCount}
                className="w-10 h-10 rounded-xl bg-yellow/40 border-2 border-ink flex items-center justify-center text-2xl animate-photo-slap"
              >
                {passDemoCount % 2 === 0 ? '❓' : '🏔️'}
              </span>
              <div className="flex flex-col">
                <span className="font-display font-black text-xs text-ink">
                  {language === 'en' ? 'Stuck? Skip!' : 'Non la sai?'}
                </span>
                <span className="font-mono font-black text-xs text-ink/70 tabular-nums">
                  ⏱ {clockPreview.toFixed(1)}s
                </span>
              </div>
            </div>
            {showPassPenalty && (
              <span
                key={`pen-${passDemoCount}`}
                className="px-2 py-0.5 rounded-lg bg-red text-white border-2 border-ink font-display font-black text-xs animate-pass-burst"
              >
                -3s!
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                soundEngine.playPassPenalty();
                handlePassDemo();
              }}
              className="flex-1 py-1.5 px-2.5 rounded-xl bg-yellow text-ink border-2 border-ink shadow-hard-sm font-display font-black text-xs flex items-center justify-center gap-1 cursor-pointer hover:brightness-105 active:translate-y-0.5"
            >
              <FastForward className="w-3.5 h-3.5" />
              <span>{language === 'en' ? 'Try Pass (-3s)' : 'Prova Passo (-3s)'}</span>
            </button>
          </div>
        </div>
      </div>

      <div className="mx-auto px-3 py-1 rounded-xl bg-paper/95 border-[2px] border-ink text-center">
        <span className="font-display font-bold text-[11px] sm:text-xs text-ink">
          {language === 'en'
            ? 'In noisy rooms you can also tap the manual "Correct" button!'
            : 'In ambienti rumorosi puoi usare anche il tasto manuale "Buona"!'}
        </span>
      </div>
    </div>
  );
};

const MultiplayerStage: React.FC<{ language: AppLanguage }> = ({ language }) => {
  const [setupMode, setSetupMode] = useState<'local' | 'discord'>('discord');

  useEffect(() => {
    const id = window.setInterval(() => {
      setSetupMode((prev) => (prev === 'discord' ? 'local' : 'discord'));
    }, 3600);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="w-full h-full flex flex-col justify-between gap-2.5 p-3 sm:p-4">
      <div className="flex items-center justify-center gap-2">
        <button
          type="button"
          onClick={() => {
            soundEngine.playRandomizerStep(1.15);
            setSetupMode('local');
          }}
          className={`px-3 py-1 rounded-xl border-2 border-ink font-display font-black text-xs flex items-center gap-1.5 transition-all cursor-pointer ${
            setupMode === 'local'
              ? 'bg-yellow text-ink shadow-hard-sm'
              : 'bg-paper/80 text-ink/70'
          }`}
        >
          <Users className="w-3.5 h-3.5" />
          <span>{language === 'en' ? 'Same Device' : 'Dal Vivo (1 Mic)'}</span>
        </button>
        <button
          type="button"
          onClick={() => {
            soundEngine.playRandomizerStep(1.15);
            setSetupMode('discord');
          }}
          className={`px-3 py-1 rounded-xl border-2 border-ink font-display font-black text-xs flex items-center gap-1.5 transition-all cursor-pointer ${
            setupMode === 'discord'
              ? 'bg-[#5865F2] text-white shadow-hard-sm'
              : 'bg-paper/80 text-ink/70'
          }`}
        >
          <Radio className="w-3.5 h-3.5" />
          <span>{language === 'en' ? 'Discord & Remote Phones' : 'Su Discord / Telefoni'}</span>
        </button>
      </div>

      {setupMode === 'local' ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="card-paper px-5 py-4 flex items-center gap-4 max-w-md w-full justify-center animate-stage-in">
            <div className="w-12 h-12 rounded-2xl bg-blue text-white border-[3px] border-ink flex items-center justify-center shadow-hard-sm animate-float-gentle">
              <Users className="w-6 h-6" />
            </div>
            <div className="flex flex-col text-left">
              <span className="font-display font-black text-sm sm:text-base text-ink">
                {language === 'en'
                  ? 'One Screen, Shared Mic!'
                  : 'Uno schermo solo, microfono condiviso!'}
              </span>
              <span className="text-xs font-bold text-ink/70">
                {language === 'en'
                  ? 'Great on TV, laptop or tablet around the couch.'
                  : 'Perfetto su TV, PC o tablet dal vivo sul divano.'}
              </span>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center gap-2 sm:gap-4 animate-stage-in">
          <div className="px-3 py-2.5 rounded-2xl bg-paper border-[3px] border-ink shadow-hard-sm flex flex-col items-center gap-1">
            <span className="px-2 py-0.5 rounded-md bg-[#5865F2] text-white font-mono font-black text-[10px]">
              #YPK842
            </span>
            <Gamepad2 className="w-6 h-6 text-ink" />
            <span className="font-display font-black text-[11px] text-ink">Host TV / PC</span>
          </div>

          <div className="flex flex-col items-center gap-1">
            <div className="relative w-10 sm:w-14 h-2 flex items-center">
              <div className="w-full h-1 rounded-full bg-green/40" />
              <span className="w-2.5 h-2.5 rounded-full bg-green border border-ink absolute left-0 animate-signal-travel" />
            </div>
            <span className="text-[9px] font-mono font-black text-green uppercase tracking-wider">
              WebRTC Live
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="px-2.5 py-1.5 rounded-xl bg-blue text-white border-2 border-ink shadow-hard-sm flex items-center gap-1.5">
              <Smartphone className="w-3.5 h-3.5" />
              <span className="font-display font-black text-[11px]">G1: Alex • OK</span>
            </div>
            <div className="px-2.5 py-1.5 rounded-xl bg-red text-white border-2 border-ink shadow-hard-sm flex items-center gap-1.5">
              <Smartphone className="w-3.5 h-3.5" />
              <span className="font-display font-black text-[11px]">G2: Sara • OK</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export const TutorialModal: React.FC<TutorialModalProps> = ({
  isOpen,
  language,
  onClose,
}) => {
  const [step, setStep] = useState(0);
  const [dismissedForever, setDismissedForever] = useState(() =>
    isTutorialDismissedForever()
  );

  useEffect(() => {
    if (!isOpen) return;
    setStep(0);
    setDismissedForever(isTutorialDismissedForever());
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose(false);
      } else if (e.key === 'ArrowRight') {
        setStep((s) => Math.min(3, s + 1));
      } else if (e.key === 'ArrowLeft') {
        setStep((s) => Math.max(0, s - 1));
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const steps =
    language === 'en'
      ? [
          {
            kicker: 'STEP 1 OF 4 • GAME MODES',
            title: 'Pick Your Arena Style',
            desc: 'Train alone in Solo, duel 1v1 TV-style against a friend, or host a 3–8 player Party tournament.',
          },
          {
            kicker: 'STEP 2 OF 4 • ALTERNATING CLOCKS',
            title: 'Only the Active Clock Ticks',
            desc: 'While a photo is on your turn, your timer drains. Nail the answer and your clock freezes while your opponent’s starts!',
          },
          {
            kicker: 'STEP 3 OF 4 • VOICE & PASS',
            title: 'Shout It Out — Or Pass (-3s)',
            desc: 'Just say the answer aloud to score automatically. Stuck on an image? Hit Pass (-3s) to swap immediately for a fresh one.',
          },
          {
            kicker: 'STEP 4 OF 4 • COUCH OR DISCORD',
            title: 'Play Live or Over Discord',
            desc: 'Share one mic on the couch, open a Discord Activity room, or pair separate phones via QR / room code so everyone has their own mic.',
          },
        ]
      : [
          {
            kicker: 'PASSO 1 DI 4 • LE MODALITÀ',
            title: 'Scegli la Tua Sfida',
            desc: 'Allenati in Solo contro il tempo, sfida un amico in 1v1 stile TV oppure lancia un torneo Party da 3 a 8 giocatori.',
          },
          {
            kicker: 'PASSO 2 DI 4 • OROLOGIO A SCACCHI',
            title: 'Vince Chi Tiene Più Tempo',
            desc: 'Finché tocca a te scende solo il tuo timer. Appena indovini la foto, il tuo orologio si blocca e parte quello dell’avversario!',
          },
          {
            kicker: 'PASSO 3 DI 4 • VOCE & PASSO',
            title: 'Rispondi a Voce o Usa Passo (-3s)',
            desc: 'Pronuncia la risposta ad alta voce per fare punto automatico. Se una foto ti blocca, premi Passo (-3s) e cambiala subito!',
          },
          {
            kicker: 'PASSO 4 DI 4 • DAL VIVO O DISCORD',
            title: 'Gioca sul Divano o Su Discord',
            desc: 'Usa un microfono unico dal vivo oppure crea una stanza Discord / Telefono Remoto per far parlare ogni giocatore dal proprio device.',
          },
        ];

  const currentStep = steps[step];
  const isLastStep = step === steps.length - 1;
  const progressPct = ((step + 1) / steps.length) * 100;

  return (
    <div
      className="fixed inset-0 z-50 bg-[#0B0A16]/90 backdrop-blur-sm flex items-center justify-center p-3 sm:p-5"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tutorial-modal-title"
      onClick={() => onClose(false)}
    >
      <div
        className="card-paper max-w-2xl w-full max-h-[92dvh] overflow-y-auto p-4 sm:p-6 flex flex-col gap-3.5 modal-slap-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Bar: Badge + Step Progress + Skip */}
        <div className="flex items-center justify-between gap-2 pb-2.5 border-b-2 border-ink">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-9 h-9 rounded-xl bg-yellow border-[2.5px] border-ink shadow-hard-sm flex items-center justify-center shrink-0">
              <BookOpen className="w-5 h-5 text-ink stroke-[2.5]" />
            </span>
            <div className="flex flex-col min-w-0">
              <span className="font-display font-black text-base sm:text-lg text-ink leading-tight truncate">
                {language === 'en' ? 'How to Play Yappik' : 'Come si gioca a Yappik'}
              </span>
              <span className="text-[11px] font-display font-bold text-ink/60">
                {currentStep.kicker}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => {
                soundEngine.playRandomizerStep(1.15);
                onClose(false);
              }}
              className="px-3 py-1.5 rounded-xl bg-white hover:bg-yellow/30 border-[2.5px] border-ink font-display font-black text-xs sm:text-sm text-ink shadow-hard-sm transition-colors cursor-pointer"
            >
              {language === 'en' ? 'Skip' : 'Salta'}
            </button>
            <button
              type="button"
              onClick={() => onClose(false)}
              aria-label={language === 'en' ? 'Close tutorial' : 'Chiudi tutorial'}
              className="w-9 h-9 rounded-xl bg-paper hover:bg-yellow text-ink flex items-center justify-center border-[2.5px] border-ink shadow-hard-sm cursor-pointer"
            >
              <X className="w-4 h-4 stroke-[3]" />
            </button>
          </div>
        </div>

        {/* Interactive Progress Bar + Step Dots */}
        <div className="flex flex-col gap-2">
          <div className="w-full h-2.5 rounded-full bg-ink/10 border-2 border-ink overflow-hidden">
            <div
              className="h-full bg-yellow transition-all duration-300 ease-out"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {steps.map((s, idx) => {
              const active = idx === step;
              const visited = idx < step;
              return (
                <button
                  key={s.kicker}
                  type="button"
                  onClick={() => {
                    soundEngine.playRandomizerStep(1.15);
                    setStep(idx);
                  }}
                  className={`py-1 px-2 rounded-xl border-2 border-ink font-display font-black text-[11px] sm:text-xs flex items-center justify-center gap-1 transition-all cursor-pointer ${
                    active
                      ? 'bg-yellow text-ink shadow-hard-sm -translate-y-0.5'
                      : visited
                      ? 'bg-green/30 text-ink'
                      : 'bg-white/80 text-ink/60 hover:bg-white'
                  }`}
                >
                  {visited ? <Check className="w-3 h-3 stroke-[3]" /> : <span>{idx + 1}.</span>}
                  <span className="truncate hidden sm:inline">
                    {idx === 0
                      ? language === 'en'
                        ? 'Modes'
                        : 'Modalità'
                      : idx === 1
                      ? language === 'en'
                        ? 'Clocks'
                        : 'Timer'
                      : idx === 2
                      ? language === 'en'
                        ? 'Voice'
                        : 'Voce'
                      : 'Discord'}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Animated Interactive Stage */}
        <div
          key={step}
          className="w-full min-h-[225px] sm:min-h-[245px] rounded-2xl bg-[#1B1B3A] border-[3px] border-ink shadow-hard overflow-hidden animate-stage-in flex items-center justify-center"
        >
          {step === 0 && <ModesStage language={language} />}
          {step === 1 && <ChessClockStage language={language} />}
          {step === 2 && <VoiceAndPassStage language={language} />}
          {step === 3 && <MultiplayerStage language={language} />}
        </div>

        {/* Step Copy */}
        <div className="flex flex-col gap-1 text-center px-1">
          <h2
            id="tutorial-modal-title"
            className="font-display font-black text-xl sm:text-2xl text-ink leading-tight"
          >
            {currentStep.title}
          </h2>
          <p className="text-sm sm:text-base font-bold text-ink/80 leading-snug max-w-xl mx-auto">
            {currentStep.desc}
          </p>
        </div>

        {/* Bottom Controls: Don't Show Again + Prev/Next */}
        <div className="pt-2.5 border-t-2 border-ink/15 flex flex-wrap items-center justify-between gap-2.5">
          {!dismissedForever ? (
            <button
              type="button"
              onClick={() => {
                soundEngine.playRandomizerStep(1.15);
                onClose(true);
              }}
              className="px-3 py-2 rounded-xl bg-white hover:bg-red/10 border-2 border-ink text-ink/85 hover:text-ink font-display font-bold text-xs sm:text-sm flex items-center gap-1.5 shadow-hard-sm transition-colors cursor-pointer"
            >
              <EyeOff className="w-4 h-4 shrink-0" />
              <span>
                {language === 'en' ? "Don't show again" : 'Non mostrare più'}
              </span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                soundEngine.playRandomizerStep(1.15);
                setTutorialDismissedForever(false);
                setDismissedForever(false);
              }}
              className="px-3 py-2 rounded-xl bg-green/20 hover:bg-green/35 border-2 border-ink text-ink font-display font-bold text-xs flex items-center gap-1.5 cursor-pointer"
              title={
                language === 'en'
                  ? 'Click to re-enable auto-open at startup'
                  : 'Clicca per riattivare apertura automatica'
              }
            >
              <Check className="w-3.5 h-3.5 stroke-[3]" />
              <span>
                {language === 'en'
                  ? 'Hidden on startup'
                  : 'Nascosto all’avvio'}
              </span>
            </button>
          )}

          <div className="flex items-center gap-2 ml-auto">
            {step > 0 && (
              <button
                type="button"
                onClick={() => {
                  soundEngine.playRandomizerStep(1.15);
                  setStep((s) => Math.max(0, s - 1));
                }}
                className="btn-push px-3.5 py-2 rounded-xl bg-white hover:bg-paper text-ink font-display font-black text-xs sm:text-sm flex items-center gap-1"
              >
                <ChevronLeft className="w-4 h-4 stroke-[3]" />
                <span>{language === 'en' ? 'Back' : 'Indietro'}</span>
              </button>
            )}

            {!isLastStep ? (
              <button
                type="button"
                onClick={() => {
                  soundEngine.playRandomizerStep(1.15);
                  setStep((s) => Math.min(steps.length - 1, s + 1));
                }}
                className="btn-push btn-shine px-4 py-2 rounded-xl bg-yellow text-ink font-display font-black text-xs sm:text-sm flex items-center gap-1"
              >
                <span>{language === 'en' ? 'Next' : 'Avanti'}</span>
                <ChevronRight className="w-4 h-4 stroke-[3]" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  soundEngine.playRandomizerStep(1.15);
                  onClose(true);
                }}
                className="btn-push btn-shine px-4 py-2 rounded-xl bg-green text-ink font-display font-black text-xs sm:text-sm flex items-center gap-1.5"
              >
                <Rocket className="w-4 h-4 stroke-[2.5]" />
                <span>
                  {language === 'en' ? "Let's Play!" : 'Inizia a giocare!'}
                </span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
