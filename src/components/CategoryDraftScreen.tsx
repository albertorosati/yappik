import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Shuffle,
  Grid,
  ArrowLeft,
  Flag,
} from 'lucide-react';
import {
  Category,
  DuelSummary,
  GameMode,
  PartyPlayer,
  PlayerConfig,
  PlayerId,
  TargetWinsOption,
  AppLanguage,
} from '../types/game';
import { preloadCategoryImages, primeImage } from '../data/categories';
import { gameConfig } from '../services/configService';
import { APP_VERSION } from '../config/version';
import { soundEngine } from '../engine/soundEffects';
import {
  t,
  getCategoryTitle,
  filterCategories,
  localizePlayerName,
} from '../services/i18n';
import { TheFloorBackground } from './TheFloorBackground';
import { InlineCrown } from './InlineCrown';
import { CategoryGalleryModal } from './CategoryGalleryModal';
import { getPlayerColor } from '../utils/playerColors';

interface CategoryDraftScreenProps {
  categories: Category[];
  playedCategoryIds: string[];
  mode?: GameMode;
  p1: PlayerConfig;
  p2: PlayerConfig;
  partyPlayers?: PartyPlayer[];
  selectedOpponentId?: string;
  onSelectOpponent?: (id: string) => void;
  p1Score: number;
  p2Score: number;
  targetWins: TargetWinsOption;
  chooserId: PlayerId;
  roundNumber: number;
  language?: AppLanguage;
  lastSummary: DuelSummary | null;
  onSelectCategory: (category: Category) => void;
  onFinishMatchEarly: () => void;
  onBackToLobby: () => void;
}

const CARD_COLORS = [
  'bg-yellow text-ink',
  'bg-blue text-white',
  'bg-red text-white',
  'bg-green text-ink',
];

const CARD_TILTS = [
  '-rotate-[1.5deg]',
  'rotate-1',
  'rotate-[1.5deg]',
  '-rotate-1',
];

function pickFourRandom(
  all: Category[],
  playedIds: string[],
  excludeCurrentIds: string[] = []
): Category[] {
  const playedSet = new Set(playedIds);
  const excludeSet = new Set(excludeCurrentIds);

  const offeredCount = gameConfig.options.draftCardsCount;
  let pool = all.filter(
    (c) => !playedSet.has(c.id) && !excludeSet.has(c.id)
  );
  if (pool.length < offeredCount) {
    pool = all.filter((c) => !playedSet.has(c.id));
  }
  if (pool.length < offeredCount) {
    pool = [...all];
  }

  const copy = [...pool];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, offeredCount);
}

export const CategoryDraftScreen: React.FC<CategoryDraftScreenProps> = ({
  categories,
  playedCategoryIds,
  mode = 'duel',
  p1,
  p2,
  partyPlayers = [],
  selectedOpponentId,
  onSelectOpponent,
  p1Score,
  p2Score,
  targetWins,
  chooserId,
  language = 'it',
  onSelectCategory,
  onFinishMatchEarly,
  onBackToLobby,
}) => {
  const isSolo = mode === 'solo';
  const isParty = mode === 'party';

  const availableCategories = useMemo(() => {
    return filterCategories(categories, language);
  }, [categories, language]);

  const [offered, setOffered] = useState<Category[]>(() =>
    pickFourRandom(filterCategories(categories, language), playedCategoryIds)
  );
  const [selectedCat, setSelectedCat] = useState<Category | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [countdownPhase, setCountdownPhase] = useState<'card-scale' | 'full-countdown'>('card-scale');
  const [showGalleryModal, setShowGalleryModal] = useState(false);

  const chooser = chooserId === 'p1' ? p1 : p2;
  const chooserColor = getPlayerColor(chooser.id);

  useEffect(() => {
    offered.forEach((cat) => {
      const cover = cat.coverImage || cat.items[0]?.imageUrl;
      if (cover) {
        primeImage(cover).catch(() => {});
      }
    });
  }, [offered]);

  useEffect(() => {
    if (countdown === null || !selectedCat) return;

    if (countdown === 3 && countdownPhase === 'card-scale') {
      const scaleTimer = setTimeout(() => {
        setCountdownPhase('full-countdown');
      }, 300);
      return () => clearTimeout(scaleTimer);
    }

    if (countdown > 0) {
      soundEngine.playCountdownBeep(false);
      const timer = setTimeout(() => {
        setCountdown((prev) => (prev !== null ? prev - 1 : null));
      }, 850);
      return () => clearTimeout(timer);
    } else {
      soundEngine.playCountdownBeep(true);
      soundEngine.stopAnnouncements();
      const launch = setTimeout(() => {
        onSelectCategory(selectedCat);
      }, 450);
      return () => clearTimeout(launch);
    }
  }, [countdown, countdownPhase, selectedCat, onSelectCategory]);

  const handleReroll = useCallback(() => {
    if (countdown !== null) return;
    soundEngine.playRandomizerStep(1.15);
    setOffered((prev) =>
      pickFourRandom(
        availableCategories,
        playedCategoryIds,
        prev.map((c) => c.id)
      )
    );
  }, [availableCategories, playedCategoryIds, countdown]);

  const handleChooseCard = (cat: Category) => {
    if (countdown !== null) return;
    setShowGalleryModal(false);
    preloadCategoryImages(cat, 20);
    soundEngine.playChallengeLocked();
    const catName = getCategoryTitle(cat, language);
    soundEngine.speakAnnouncement(
      language === 'en'
        ? `${catName}! Ready, set, go!`
        : `${catName}! Pronti al via!`
    );
    setSelectedCat(cat);
    setCountdownPhase('card-scale');
    setCountdown(3);
  };

  const isP1Leading = p1Score > p2Score && p1Score > 0;
  const isP2Leading = p2Score > p1Score && p2Score > 0;

  return (
    <div className="relative h-[100dvh] max-h-[100dvh] w-full flex flex-col justify-between p-4 sm:p-6 select-none overflow-hidden touch-none">
      {/* Signature Floor Background in chooser's stage color */}
      <TheFloorBackground stage={chooser.id} />

      {/* Main Container: Max 1100px Centered */}
      <div className="w-full max-w-[1100px] mx-auto flex-1 flex flex-col justify-between py-2 min-h-0">
        {/* ============================================================== */}
        {/* TOP BAR: MENU (LEFT) | SCOREBOARD PILLS (CENTER) | QUIT (RIGHT)*/}
        {/* ============================================================== */}
        <header className="w-full flex items-center justify-between gap-3 shrink-0">
          <button
            type="button"
            onClick={onBackToLobby}
            aria-label="Back to menu"
            className="btn-push px-4 py-2 rounded-xl bg-paper text-ink font-display font-bold text-sm flex items-center gap-1.5"
          >
            <ArrowLeft className="w-4 h-4 stroke-[2.5]" />
            <span>{t('draft.menu', language)}</span>
          </button>

          {/* Compact Scoreboard in Top Center: Plain Numbers, Crown on Leader */}
          {!isSolo && (
            <div className="flex items-center gap-2 sm:gap-3">
              {/* P1 Pill */}
              <div className="px-3.5 py-1.5 rounded-full bg-paper border-[3px] border-ink shadow-hard-sm flex items-center gap-2">
                <div className="relative flex items-center justify-center">
                  <span className="text-xl shrink-0">{p1.avatar}</span>
                  {isP1Leading && (
                    <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
                      <InlineCrown size="sm" />
                    </div>
                  )}
                </div>
                <span className="font-display font-black text-xs sm:text-sm text-ink truncate max-w-[80px] sm:max-w-[110px]">
                  {p1.name}
                </span>
                <span className="font-display font-black text-sm sm:text-base text-ink tabular-nums">
                  {p1Score}
                </span>
              </div>

              {/* P2 Pill */}
              <div className="px-3.5 py-1.5 rounded-full bg-paper border-[3px] border-ink shadow-hard-sm flex items-center gap-2">
                <div className="relative flex items-center justify-center">
                  <span className="text-xl shrink-0">{p2.avatar}</span>
                  {isP2Leading && (
                    <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
                      <InlineCrown size="sm" />
                    </div>
                  )}
                </div>
                <span className="font-display font-black text-xs sm:text-sm text-ink truncate max-w-[80px] sm:max-w-[110px]">
                  {p2.name}
                </span>
                <span className="font-display font-black text-sm sm:text-base text-ink tabular-nums">
                  {p2Score}
                </span>
              </div>
            </div>
          )}

          {isSolo && (
            <div className="px-4 py-1.5 rounded-full bg-paper border-[3px] border-ink shadow-hard-sm flex items-center gap-2">
              <span className="text-xl">{p1.avatar}</span>
              <span className="font-display font-black text-sm text-ink">
                {p1.name}
              </span>
            </div>
          )}

          {!isSolo && (p1Score + p2Score > 0 || isParty) ? (
            <button
              type="button"
              onClick={onFinishMatchEarly}
              className="btn-push px-3.5 py-2 rounded-xl bg-paper text-ink font-display font-bold text-sm flex items-center gap-1.5"
            >
              <Flag className="w-4 h-4 text-red" />
              <span className="hidden sm:inline">{t('draft.finishEarly', language)}</span>
            </button>
          ) : (
            <div className="w-16" />
          )}
        </header>

        {/* ============================================================== */}
        {/* RIBBON BANNER IN ACTIVE PLAYER'S REAL COLOR (-1deg)            */}
        {/* ============================================================== */}
        <div className="w-full text-center my-2 shrink-0">
          <div
            className="inline-block px-6 py-2.5 rounded-2xl border-[3px] border-ink shadow-hard -rotate-1 font-display font-black text-lg sm:text-2xl uppercase tracking-wider"
            style={{
              backgroundColor: chooserColor.bgHex,
              color: chooserColor.onColorHex,
            }}
          >
            {isSolo
              ? t('solo.chooseCategory', language)
              : t('draft.pickCategory', language, {
                  name: localizePlayerName(chooser.name, language),
                })}
          </div>

          {/* Party challenge step: 48px avatar chips (selected = yellow outline) */}
          {isParty && partyPlayers.length > 2 && onSelectOpponent && (
            <div className="mt-3 flex flex-col items-center justify-center gap-1.5">
              <span className="font-display font-black text-xs sm:text-sm text-paper uppercase tracking-wider">
                {t('party.challengeStep', language)}
              </span>
              <div className="flex items-center justify-center gap-2 flex-wrap">
                {partyPlayers
                  .filter((p) => p.id !== chooser.id)
                  .map((p) => {
                    const isSelected = selectedOpponentId === p.id;
                    return (
                      <button
                        key={`opp-${p.id}`}
                        type="button"
                        onClick={() => onSelectOpponent(p.id)}
                        className={`w-12 h-12 rounded-xl text-2xl flex items-center justify-center border-[3px] border-ink transition-all active:scale-95 ${
                          isSelected
                            ? 'bg-yellow shadow-hard-lifted -translate-y-1 ring-4 ring-yellow/80'
                            : 'bg-paper shadow-hard hover:-translate-y-0.5'
                        }`}
                        title={p.name}
                      >
                        {p.avatar}
                      </button>
                    );
                  })}
              </div>
            </div>
          )}
        </div>

        {/* ============================================================== */}
        {/* 2X2 GRID OF CATEGORY CARDS (FLAT FILLS, TILT, ICON + TITLE)    */}
        {/* ============================================================== */}
        <main className="w-full max-w-3xl mx-auto my-auto grid grid-cols-2 gap-4 sm:gap-6 items-stretch relative min-h-0">
          {offered.map((cat, idx) => {
            const isChosen = selectedCat?.id === cat.id;
            const isOthers = selectedCat !== null && !isChosen;
            const colorClass = CARD_COLORS[idx % CARD_COLORS.length];
            const tiltClass = CARD_TILTS[idx % CARD_TILTS.length];

            return (
              <button
                key={cat.id}
                type="button"
                onClick={() => handleChooseCard(cat)}
                disabled={countdown !== null}
                style={{ animationDelay: `${idx * 70}ms` }}
                className={`group animate-card-deal btn-shine min-h-[190px] sm:min-h-[220px] p-5 sm:p-7 rounded-card border-[3px] border-ink shadow-hard flex flex-col items-center justify-center gap-2 text-center cursor-pointer transition-all duration-300 ${colorClass} ${tiltClass} hover:rotate-0 hover:-translate-y-2 hover:scale-[1.03] hover:shadow-hard-lifted active:translate-x-[3px] active:translate-y-[3px] active:shadow-none ${
                  isChosen
                    ? 'scale-105 z-20 shadow-hard-lifted rotate-0'
                    : isOthers
                    ? 'opacity-0 scale-75 pointer-events-none'
                    : ''
                }`}
              >
                <span className="text-6xl sm:text-7xl select-none mb-1 transition-transform duration-200 group-hover:scale-115 group-hover:-rotate-6">
                  {cat.icon}
                </span>
                <h2 className="font-display font-black text-xl sm:text-2xl leading-tight">
                  {getCategoryTitle(cat, language)}
                </h2>
              </button>
            );
          })}
        </main>

        {/* ============================================================== */}
        {/* ACTIONS RIGHT UNDER THE GRID (CENTERED, NEVER PINNED TO BOTTOM)*/}
        {/* ============================================================== */}
        <div className="w-full max-w-md mx-auto flex items-center justify-center gap-3 my-2 shrink-0">
          <button
            type="button"
            onClick={handleReroll}
            disabled={countdown !== null}
            className="btn-push h-12 flex-1 px-4 rounded-xl bg-paper text-ink font-display font-bold text-sm flex items-center justify-center gap-2"
          >
            <Shuffle className="w-4 h-4" />
            <span>{t('draft.shuffle', language)}</span>
          </button>

          <button
            type="button"
            onClick={() => setShowGalleryModal(true)}
            disabled={countdown !== null}
            className="btn-push h-12 flex-1 px-4 rounded-xl bg-paper text-ink font-display font-bold text-sm flex items-center justify-center gap-2"
          >
            <Grid className="w-4 h-4" />
            <span>{t('draft.allCategories', language)}</span>
          </button>
        </div>

        <span className="font-mono text-[11px] text-paper/40 self-center">
          v{APP_VERSION}
        </span>
      </div>

      {/* ============================================================== */}
      {/* CATEGORY REVEAL + FULL-SCREEN COUNTDOWN (NO MODAL BOX!)        */}
      {/* ============================================================== */}
      {countdown !== null && selectedCat && countdownPhase === 'full-countdown' && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center p-4 bg-black/85 select-none animate-screen-shake-6px overflow-hidden">
          {/* Category sticker above */}
          <div className="px-6 py-2 rounded-2xl bg-paper border-[3px] border-ink shadow-hard font-display font-black text-2xl sm:text-4xl text-ink inline-flex items-center gap-3 -rotate-2 mb-4 animate-starburst-pop relative z-10">
            <span className="text-3xl sm:text-5xl animate-float-gentle">{selectedCat.icon}</span>
            <span>{getCategoryTitle(selectedCat, language)}</span>
          </div>

          {/* Giant Number / Starburst "GO!" */}
          {countdown > 0 ? (
            <div key={countdown} className="relative flex items-center justify-center">
              <div
                aria-hidden="true"
                className="absolute w-64 h-64 sm:w-80 sm:h-80 rounded-full border-[6px] border-yellow/70 animate-feedback-ring pointer-events-none"
              />
              <div className="font-display font-black text-[28vh] sm:text-[38vh] leading-none text-paper drop-shadow-[6px_6px_0_#14121F] animate-countdown-slam relative z-10">
                {countdown}
              </div>
            </div>
          ) : (
            <div className="relative flex items-center justify-center animate-starburst-pop">
              {/* Outer Expanding Shockwave Ring */}
              <div
                aria-hidden="true"
                className="absolute w-80 h-80 sm:w-[440px] sm:h-[440px] rounded-full border-[8px] border-yellow/80 animate-feedback-ring pointer-events-none"
              />
              {/* Starburst SVG with Slow Spin */}
              <svg
                viewBox="0 0 200 200"
                className="w-64 h-64 sm:w-96 sm:h-96 drop-shadow-[8px_8px_0_#14121F] animate-slow-spin"
              >
                <polygon
                  points="100,0 125,45 175,25 160,75 200,100 160,125 175,175 125,155 100,200 75,155 25,175 40,125 0,100 40,75 25,25 75,45"
                  fill="#FFC933"
                  stroke="#14121F"
                  strokeWidth="6"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="absolute font-display font-black text-6xl sm:text-8xl text-ink -rotate-6">
                GO!
              </span>
            </div>
          )}
        </div>
      )}

      {/* ============================================================== */}
      {/* CATEGORY GALLERY MODAL (STICKER TILES, 3-CARD PEEK, SEARCH)   */}
      {/* ============================================================== */}
      <CategoryGalleryModal
        isOpen={showGalleryModal}
        categories={availableCategories}
        language={language}
        mode="pick"
        onSelectCategory={(cat) => handleChooseCard(cat)}
        onClose={() => setShowGalleryModal(false)}
      />
    </div>
  );
};
