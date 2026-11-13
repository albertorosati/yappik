import React, { useEffect } from 'react';
import { RotateCcw, Home } from 'lucide-react';
import confetti from 'canvas-confetti';
import {
  DuelSummary,
  GameMode,
  PartyPlayer,
  PlayerConfig,
  PlayerId,
  AppLanguage,
} from '../types/game';
import { soundEngine } from '../engine/soundEffects';
import { rankPartyPlayers } from '../utils/partyUtils';
import { t, localizePlayerName } from '../services/i18n';
import { TheFloorBackground } from './TheFloorBackground';
import { InlineCrown } from './InlineCrown';
import { getPlayerColor } from '../utils/playerColors';
import { APP_VERSION } from '../config/version';

interface VictoryScreenProps {
  mode?: GameMode;
  winnerId: PlayerId;
  p1: PlayerConfig;
  p2: PlayerConfig;
  partyPlayers?: PartyPlayer[];
  p1Score: number;
  p2Score: number;
  history: DuelSummary[];
  language?: AppLanguage;
  onPlayAgain: () => void;
  onBackToLobby: () => void;
}

export const VictoryScreen: React.FC<VictoryScreenProps> = ({
  mode = 'duel',
  winnerId,
  p1,
  p2,
  partyPlayers = [],
  p1Score,
  p2Score,
  history,
  language = 'it',
  onPlayAgain,
  onBackToLobby,
}) => {
  const isParty = mode === 'party';

  // In Party mode, find player with highest wins
  const partyRanked = rankPartyPlayers(partyPlayers);
  const partyWinner = partyRanked[0];
  const isPartyDraw =
    isParty &&
    partyRanked.length >= 2 &&
    partyRanked[0].wins === partyRanked[1].wins &&
    partyRanked[0].duelsPlayed === partyRanked[1].duelsPlayed;
  const isDraw = isParty ? isPartyDraw : p1Score === p2Score;
  const winner = isParty ? partyWinner || p1 : winnerId === 'p1' ? p1 : p2;
  const winnerColor =
    isParty && typeof (winner as PartyPlayer).colorIndex === 'number'
      ? getPlayerColor((winner as PartyPlayer).colorIndex!)
      : getPlayerColor(winner.id);

  useEffect(() => {
    soundEngine.playDuelVictory();
    if (!isDraw) {
      soundEngine.speakAnnouncement(
        language === 'en'
          ? `${localizePlayerName(winner.name, language)} won the match!`
          : `Vince la sfida ${localizePlayerName(winner.name, language)}!`,
        language
      );

      const reduced =
        typeof window !== 'undefined' &&
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (!reduced) {
        const colors = ['#FFC933', '#2F6BFF', '#FF3D6E', '#19C37D', '#FFFDF5'];
        confetti({
          particleCount: 55,
          angle: 60,
          spread: 65,
          origin: { x: 0.08, y: 0.7 },
          colors,
        });
        confetti({
          particleCount: 55,
          angle: 120,
          spread: 65,
          origin: { x: 0.92, y: 0.7 },
          colors,
        });
        const t2 = setTimeout(() => {
          confetti({
            particleCount: 70,
            spread: 100,
            origin: { y: 0.5 },
            colors,
          });
        }, 420);
        return () => clearTimeout(t2);
      }
    }
  }, [winner.name, isDraw, language]);

  const totalP1Correct = history.reduce((acc, h) => acc + h.p1Correct, 0);
  const totalP2Correct = history.reduce((acc, h) => acc + h.p2Correct, 0);

  const activeStage = isDraw ? 'neutral' : winnerColor.id;

  return (
    <div className="min-h-[100dvh] w-full relative overflow-y-auto overflow-x-hidden flex flex-col items-center justify-center p-3 sm:p-6 text-center select-none">
      {/* 1. Signature Floor Background in winner's stage color */}
      <TheFloorBackground stage={activeStage} />

      {/* 2. Dynamic Neo-Brutalist Confetti Shapes across the stage */}
      {!isDraw && (
        <div aria-hidden="true" className="fixed inset-0 pointer-events-none z-20 overflow-hidden">
          {[
            { left: '6%', bg: 'bg-yellow', size: 'w-6 h-6', dur: '3.1s', delay: '0s' },
            { left: '14%', bg: 'bg-red', size: 'w-5 h-5 rounded-full', dur: '3.7s', delay: '0.4s' },
            { left: '24%', bg: 'bg-blue', size: 'w-7 h-5', dur: '2.9s', delay: '0.8s' },
            { left: '36%', bg: 'bg-green', size: 'w-5 h-5', dur: '3.5s', delay: '0.2s' },
            { left: '52%', bg: 'bg-paper', size: 'w-6 h-6 rotate-45', dur: '3.3s', delay: '0.6s' },
            { left: '66%', bg: 'bg-yellow', size: 'w-5 h-7', dur: '2.8s', delay: '0.1s' },
            { left: '78%', bg: 'bg-red', size: 'w-6 h-6 rounded-full', dur: '3.4s', delay: '0.9s' },
            { left: '89%', bg: 'bg-green', size: 'w-7 h-5', dur: '3.0s', delay: '0.5s' },
          ].map((c, idx) => (
            <div
              key={`v-conf-${idx}`}
              style={{
                left: c.left,
                ['--rain-dur' as string]: c.dur,
                animationDelay: c.delay,
              }}
              className={`absolute -top-8 ${c.size} ${c.bg} border-[3px] border-ink animate-victory-rain`}
            />
          ))}
        </div>
      )}

      {/* 3. Victory Card (1100px Max, Centered, Tactile) */}
      <div className="relative z-10 card-paper max-w-xl w-full p-6 sm:p-8 flex flex-col items-center gap-6 animate-starburst-pop max-h-[96dvh] overflow-y-auto">
        {/* Starburst + Large Winner Avatar with Crown */}
        <div className="relative flex items-center justify-center my-2">
          {!isDraw && (
            <div className="absolute -top-7 left-1/2 -translate-x-1/2 z-20">
              <InlineCrown size="lg" />
            </div>
          )}
          {/* Flat starburst shape behind avatar */}
          <div
            className="w-32 h-32 rounded-3xl border-[3px] border-ink shadow-hard flex items-center justify-center text-7xl animate-pip-bounce -rotate-3"
            style={{ backgroundColor: winnerColor.bgHex }}
          >
            {winner.avatar}
          </div>
        </div>

        <div>
          {/* Winner Badge Pill */}
          <span className="px-4 py-1.5 rounded-full bg-yellow border-[3px] border-ink font-display font-black text-xs uppercase tracking-wider text-ink inline-block mb-3 shadow-hard-sm">
            {isDraw
              ? t('victory.tieMatch', language)
              : isParty
              ? t('party.champion', language)
              : t('victory.champion', language)}
          </span>

          <h1 className="font-display font-black text-3xl sm:text-5xl text-ink tracking-tight -rotate-1">
            {isDraw && !isParty
              ? `${p1.avatar} ${t('victory.equalPoints', language)} ${p2.avatar}`
              : isDraw && isParty
              ? t('victory.equalPoints', language)
              : `${localizePlayerName(winner.name, language)}`}
          </h1>

          {!isDraw && !isParty && (
            <div className="font-display font-black text-2xl text-yellow bg-ink px-4 py-1 rounded-xl border-[3px] border-ink inline-block mt-2 rotate-1">
              {language === 'en' ? 'WINS!' : 'VINCE!'}
            </div>
          )}
        </div>

        {/* Final Score Recap for 1v1: Plain Numbers + Winner Crown */}
        {!isParty && (
          <div className="w-full flex items-center justify-center gap-4 sm:gap-8 py-4 px-3 bg-white/70 border-[3px] border-ink rounded-2xl shadow-hard-sm">
            {/* P1 Recap */}
            <div className="flex flex-col items-center gap-1.5 flex-1 min-w-0">
              <div className="relative flex items-center justify-center">
                <span className="text-3xl">{p1.avatar}</span>
                {p1Score > p2Score && (
                  <div className="absolute -top-4 left-1/2 -translate-x-1/2">
                    <InlineCrown size="sm" />
                  </div>
                )}
              </div>
              <span className="font-display font-black text-sm text-blue truncate max-w-full">
                {localizePlayerName(p1.name, language)}
              </span>
              <span className="font-display font-black text-3xl text-ink tabular-nums">
                {p1Score}
              </span>
            </div>

            <div className="font-display font-black text-xl text-ink/40 shrink-0">
              VS
            </div>

            {/* P2 Recap */}
            <div className="flex flex-col items-center gap-1.5 flex-1 min-w-0">
              <div className="relative flex items-center justify-center">
                <span className="text-3xl">{p2.avatar}</span>
                {p2Score > p1Score && (
                  <div className="absolute -top-4 left-1/2 -translate-x-1/2">
                    <InlineCrown size="sm" />
                  </div>
                )}
              </div>
              <span className="font-display font-black text-sm text-red truncate max-w-full">
                {localizePlayerName(p2.name, language)}
              </span>
              <span className="font-display font-black text-3xl text-ink tabular-nums">
                {p2Score}
              </span>
            </div>
          </div>
        )}

        {/* Podio / Classifica Party oppure Statistiche 1v1 */}
        {isParty ? (
          <div className="w-full flex flex-col divide-y-2 divide-ink/10 border-y-[3px] border-ink/20 py-1 max-h-52 overflow-y-auto">
            {partyRanked.map((p, idx) => {
              const pColor = getPlayerColor(
                typeof p.colorIndex === 'number' ? p.colorIndex : idx
              );
              const showCrown = !isDraw && idx === 0 && p.wins > 0;
              return (
                <div
                  key={p.id}
                  className="py-2.5 px-3 flex items-center justify-between gap-2"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="font-display font-black text-sm text-ink/70 shrink-0">
                      #{idx + 1}
                    </span>
                    <div
                      className="relative w-9 h-9 rounded-xl border-2 border-ink flex items-center justify-center text-xl shrink-0 shadow-hard-sm"
                      style={{ backgroundColor: pColor.bgHex }}
                    >
                      <span>{p.avatar}</span>
                      {showCrown && (
                        <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
                          <InlineCrown size="sm" />
                        </div>
                      )}
                    </div>
                    <span className="font-display font-bold text-sm text-ink truncate">
                      {localizePlayerName(p.name, language)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 text-right">
                    <span className="text-[11px] font-sans font-bold text-ink/50 tabular-nums">
                      ({p.duelsPlayed} {language === 'en' ? 'duels' : 'sfide'})
                    </span>
                    <span className="font-display font-black text-sm text-ink tabular-nums">
                      {p.wins} {t('party.wins', language).toLowerCase()}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="w-full flex items-center justify-around py-3 border-y-[3px] border-ink">
            <div className="text-center">
              <span className="text-xs font-bold text-ink/60 uppercase block">
                {t('victory.rounds', language)}
              </span>
              <span className="font-display font-black text-3xl text-ink tabular-nums">
                {history.length}
              </span>
            </div>
            <div className="text-center">
              <span className="text-xs font-bold text-blue uppercase block truncate">
                {localizePlayerName(p1.name, language)}
              </span>
              <span className="font-display font-black text-3xl text-blue tabular-nums">
                {totalP1Correct}
              </span>
            </div>
            <div className="text-center">
              <span className="text-xs font-bold text-red uppercase block truncate">
                {localizePlayerName(p2.name, language)}
              </span>
              <span className="font-display font-black text-3xl text-red tabular-nums">
                {totalP2Correct}
              </span>
            </div>
          </div>
        )}

        {/* Action Buttons: Rematch (Yellow) and Menu (Paper) */}
        <div className="w-full grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 shrink-0">
          <button
            type="button"
            onClick={onPlayAgain}
            className="btn-push btn-shine py-3.5 px-5 rounded-xl bg-yellow text-ink font-display font-black text-base sm:text-lg flex items-center justify-center gap-2 border-[3px] border-ink shadow-hard"
          >
            <RotateCcw className="w-5 h-5" />
            <span>{t('victory.rematch', language)}</span>
          </button>
          <button
            type="button"
            onClick={onBackToLobby}
            className="btn-push py-3.5 px-5 rounded-xl bg-paper text-ink font-display font-bold text-base sm:text-lg flex items-center justify-center gap-2 border-[3px] border-ink shadow-hard"
          >
            <Home className="w-5 h-5" />
            <span>{t('victory.backMenu', language)}</span>
          </button>
        </div>

        <div className="text-[11px] font-mono text-ink/40 pt-1">
          v{APP_VERSION}
        </div>
      </div>
    </div>
  );
};
