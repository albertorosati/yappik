import React, { useState, useEffect, useRef } from 'react';
import {
  Settings,
  Copy,
  Check,
  X,
  Download,
  Mic,
} from 'lucide-react';
import {
  Category,
  GameMode,
  GameSettings,
  PartyPlayer,
  PlayerConfig,
  TargetWinsOption,
} from '../types/game';
import { SmartSpeechRecognizer } from '../engine/speechRecognition';
import { gameConfig } from '../services/configService';
import { pwaInstallService } from '../services/pwaInstallService';
import { APP_VERSION } from '../config/version';
import { t, filterCategories, localizePlayerName, getCategoryTitle } from '../services/i18n';
import { TheFloorBackground } from './TheFloorBackground';
import { TheFloorLogo } from './TheFloorLogo';
import { PhoneMicModal } from './PhoneMicModal';
import { getPlayerColor, PLAYER_COLORS } from '../utils/playerColors';
import { blacklistService } from '../services/blacklistService';

interface LobbyScreenProps {
  p1: PlayerConfig;
  p2: PlayerConfig;
  onUpdatePlayer: (id: 'p1' | 'p2', name: string, avatar: string) => void;
  partyPlayers?: PartyPlayer[];
  onAddPartyPlayer?: () => void;
  onRemovePartyPlayer?: (id: string) => void;
  onUpdatePartyPlayer?: (id: string, name: string, avatar: string) => void;
  settings: GameSettings;
  onUpdateSettings: (partial: Partial<GameSettings>) => void;
  categories: Category[];
  roomCode: string;
  p2RemoteConnected: boolean;
  remoteTranscriptPreview?: string;
  isDiscordActivity?: boolean;
  onOpenCategoryEditor: () => void;
  onStartGame: () => void;
}

const AVATAR_OPTIONS = [
  '🦊', '🐯', '🐼', '🐸', '🐙', '🦖', '😎', '🤠',
  '👻', '🍕', '⚡', '🔥', '🦁', '🐶', '🐱', '🚀',
];

export const LobbyScreen: React.FC<LobbyScreenProps> = ({
  p1,
  p2,
  onUpdatePlayer,
  partyPlayers = [],
  onAddPartyPlayer,
  onRemovePartyPlayer,
  onUpdatePartyPlayer,
  settings,
  onUpdateSettings,
  categories,
  roomCode,
  p2RemoteConnected,
  remoteTranscriptPreview,
  isDiscordActivity = false,
  onOpenCategoryEditor,
  onStartGame,
}) => {
  const [testingMic, setTestingMic] = useState(false);
  const [testTranscript, setTestTranscript] = useState('');
  const [testVolume, setTestVolume] = useState(0);
  const [copiedLink, setCopiedLink] = useState(false);
  const [phoneModalOpen, setPhoneModalOpen] = useState(false);
  const [canInstallPwa, setCanInstallPwa] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [avatarPickerFor, setAvatarPickerFor] = useState<string | null>(null);
  const [flaggedCount, setFlaggedCount] = useState(() => blacklistService.getFlaggedCount());
  const [copiedBlacklist, setCopiedBlacklist] = useState(false);

  const recognizerRef = useRef<SmartSpeechRecognizer | null>(null);

  useEffect(() => {
    setCanInstallPwa(pwaInstallService.canInstall());
    const unsubPwa = pwaInstallService.subscribe((canInstall) => {
      setCanInstallPwa(canInstall);
    });
    const unsubBlacklist = blacklistService.subscribe(() => {
      setFlaggedCount(blacklistService.getFlaggedCount());
    });
    return () => {
      unsubPwa();
      unsubBlacklist();
    };
  }, []);

  // Esc closes settings or avatar picker
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowSettingsModal(false);
        setAvatarPickerFor(null);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  const handleInstallClick = async () => {
    await pwaInstallService.triggerInstall();
  };

  const toggleMicTest = () => {
    if (testingMic) {
      recognizerRef.current?.stop();
      recognizerRef.current = null;
      setTestingMic(false);
      setTestVolume(0);
      setTestTranscript('');
      return;
    }

    setTestTranscript(t('lobby.testingMic', settings.language));
    const rec = new SmartSpeechRecognizer(
      (alternatives) => {
        if (alternatives[0]) {
          setTestTranscript(alternatives[0]);
        }
      },
      (listening) => {
        setTestingMic(listening);
      },
      (vol) => setTestVolume(vol),
      settings.language || 'it'
    );
    recognizerRef.current = rec;
    rec.start();
  };

  const getCompanionUrl = () => {
    if (isDiscordActivity) {
      return `https://albertorosati.github.io/yappik/?room=${encodeURIComponent(roomCode)}`;
    }
    const baseUrl = `${window.location.origin}${window.location.pathname}`;
    return `${baseUrl}?room=${encodeURIComponent(roomCode)}`;
  };

  const handleCopyCompanionUrl = () => {
    navigator.clipboard.writeText(getCompanionUrl());
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const isDefaultP1 = p1.name === 'Giocatore 1' || p1.name === 'Player 1';
  const isDefaultP2 = p2.name === 'Giocatore 2' || p2.name === 'Player 2';
  const p1Value = isDefaultP1 ? t('lobby.p1', settings.language) : p1.name;
  const p2Value = isDefaultP2 ? t('lobby.p2', settings.language) : p2.name;

  const handleSelectAvatar = (avatar: string) => {
    if (avatarPickerFor === 'p1') {
      onUpdatePlayer('p1', p1.name, avatar);
    } else if (avatarPickerFor === 'p2') {
      onUpdatePlayer('p2', p2.name, avatar);
    } else if (avatarPickerFor && onUpdatePartyPlayer) {
      const pl = partyPlayers.find((p) => p.id === avatarPickerFor);
      if (pl) {
        onUpdatePartyPlayer(pl.id, pl.name, avatar);
      }
    }
    setAvatarPickerFor(null);
  };

  const currentMode = settings.mode;
  const availableCategories = filterCategories(categories, settings.language, 'all');

  return (
    <div className="relative min-h-[100dvh] w-full flex flex-col justify-between p-4 sm:p-6 select-none overflow-x-hidden pb-[max(1rem,env(safe-area-inset-bottom))]">
      {/* 1. Signature Floor Background with home random flip every 2.5s (C1) */}
      <TheFloorBackground
        stage={showSettingsModal ? 'modal' : 'neutral'}
        isHome={!showSettingsModal}
      />

      {/* Main Single Container: Max 1100px Centered */}
      <div
        aria-hidden={showSettingsModal}
        className={`w-full max-w-[1100px] mx-auto flex-1 flex flex-col justify-between py-2 sm:py-4 gap-6 transition-opacity ${
          showSettingsModal ? 'opacity-0 pointer-events-none' : 'opacity-100'
        }`}
      >
        {/* ============================================================== */}
        {/* HEADER: DISCORD / PWA (LEFT) | SETTINGS BUTTON (RIGHT)         */}
        {/* ============================================================== */}
        <header className="w-full flex items-center justify-between">
          <div className="flex items-center gap-2">
            {isDiscordActivity ? (
              <div className="px-3.5 py-1.5 rounded-xl bg-[#5865F2] text-white font-display font-black text-xs sm:text-sm border-[3px] border-ink shadow-hard-sm flex items-center gap-1.5">
                <span>🎮 DISCORD ACTIVITY</span>
              </div>
            ) : canInstallPwa ? (
              <button
                type="button"
                onClick={handleInstallClick}
                className="btn-push px-3.5 py-2 rounded-xl bg-yellow text-ink font-display font-bold text-xs sm:text-sm border-[3px] border-ink shadow-hard-sm flex items-center gap-1.5"
              >
                <span>{t('app.install', settings.language)}</span>
              </button>
            ) : null}
          </div>

          <button
            type="button"
            onClick={() => setShowSettingsModal(true)}
            aria-label={t('lobby.settings', settings.language)}
            className="btn-push w-12 h-12 rounded-2xl bg-paper border-[3px] border-ink text-ink flex items-center justify-center hover:bg-yellow shadow-hard-sm"
          >
            <Settings className="w-6 h-6 stroke-[2.5]" />
          </button>
        </header>

        {/* ============================================================== */}
        {/* C1: HOME HERO WORDMARK (~35vh)                                 */}
        {/* ============================================================== */}
        <div className="w-full flex flex-col items-center justify-center my-1 sm:my-3">
          <TheFloorLogo size="hero" />
        </div>

        {/* ============================================================== */}
        {/* MODE: 3-OPTION SEGMENTED CONTROL (LABEL ONLY)                  */}
        {/* ============================================================== */}
        <div className="card-paper p-1.5 flex gap-2 w-full max-w-md mx-auto">
          <button
            type="button"
            onClick={() => onUpdateSettings({ mode: 'duel' })}
            className={`flex-1 min-h-[44px] py-2.5 rounded-xl font-display font-black text-lg transition-all ${
              currentMode === 'duel'
                ? 'bg-yellow text-ink border-[3px] border-ink shadow-hard-sm'
                : 'bg-transparent text-ink/70 hover:text-ink border-[3px] border-transparent'
            }`}
          >
            1v1
          </button>
          <button
            type="button"
            onClick={() => onUpdateSettings({ mode: 'solo' })}
            className={`flex-1 min-h-[44px] py-2.5 rounded-xl font-display font-black text-lg transition-all ${
              currentMode === 'solo'
                ? 'bg-yellow text-ink border-[3px] border-ink shadow-hard-sm'
                : 'bg-transparent text-ink/70 hover:text-ink border-[3px] border-transparent'
            }`}
          >
            Solo
          </button>
          <button
            type="button"
            onClick={() => onUpdateSettings({ mode: 'party' })}
            className={`flex-1 min-h-[44px] py-2.5 rounded-xl font-display font-black text-lg transition-all ${
              currentMode === 'party'
                ? 'bg-yellow text-ink border-[3px] border-ink shadow-hard-sm'
                : 'bg-transparent text-ink/70 hover:text-ink border-[3px] border-transparent'
            }`}
          >
            Party
          </button>
        </div>

        {/* ============================================================== */}
        {/* 1V1 MODE: FACE-OFF (BLUE CARD vs RED CARD)                     */}
        {/* ============================================================== */}
        {currentMode === 'duel' && (
          <div className="w-full flex flex-col gap-6 max-w-3xl mx-auto animate-card-deal">
            {/* The 2 Face-Off Cards */}
            <div className="w-full flex flex-col sm:flex-row items-center justify-between gap-4 sm:gap-6 relative">
              {/* Player 1 Card (Blue Left) */}
              <div className="flex-1 w-full bg-blue text-white rounded-card border-[3px] border-ink shadow-hard p-5 sm:p-6 flex flex-col items-center gap-3 transition-transform duration-200 hover:-translate-y-1">
                <span className="font-display font-bold text-xs uppercase tracking-wider text-white/90">
                  {t('lobby.p1', settings.language)}
                </span>
                <button
                  type="button"
                  onClick={() => setAvatarPickerFor('p1')}
                  aria-label="Player 1 Avatar"
                  className="w-20 h-20 sm:w-24 sm:h-24 rounded-2xl bg-paper text-ink border-[3px] border-ink shadow-hard-sm text-5xl sm:text-6xl flex items-center justify-center hover:scale-110 hover:-rotate-6 active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-transform duration-150"
                >
                  {p1.avatar}
                </button>
                <input
                  type="text"
                  value={p1Value}
                  maxLength={18}
                  onChange={(e) => onUpdatePlayer('p1', e.target.value, p1.avatar)}
                  placeholder={t('lobby.p1Placeholder', settings.language)}
                  className="w-full min-w-0 bg-paper text-ink border-[3px] border-ink rounded-xl px-3.5 py-2 font-display font-bold text-center text-lg focus:outline-none focus:ring-2 focus:ring-yellow"
                />
              </div>

              {/* Round Yellow VS Badge (Animated Pulse & Tilted) */}
              <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-full bg-yellow border-[3px] border-ink shadow-hard flex items-center justify-center text-ink font-display font-black text-2xl shrink-0 my-[-10px] sm:my-0 sm:mx-[-24px] z-10 animate-vs-pulse select-none">
                VS
              </div>

              {/* Player 2 Card (Red Right) */}
              <div className="flex-1 w-full bg-red text-white rounded-card border-[3px] border-ink shadow-hard p-5 sm:p-6 flex flex-col items-center gap-3 transition-transform duration-200 hover:-translate-y-1">
                <span className="font-display font-bold text-xs uppercase tracking-wider text-white/90">
                  {t('lobby.p2', settings.language)}
                </span>
                <button
                  type="button"
                  onClick={() => setAvatarPickerFor('p2')}
                  aria-label="Player 2 Avatar"
                  className="w-20 h-20 sm:w-24 sm:h-24 rounded-2xl bg-paper text-ink border-[3px] border-ink shadow-hard-sm text-5xl sm:text-6xl flex items-center justify-center hover:scale-110 hover:rotate-6 active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-transform duration-150"
                >
                  {p2.avatar}
                </button>
                <input
                  type="text"
                  value={p2Value}
                  maxLength={18}
                  onChange={(e) => onUpdatePlayer('p2', e.target.value, p2.avatar)}
                  placeholder={t('lobby.p2Placeholder', settings.language)}
                  className="w-full min-w-0 bg-paper text-ink border-[3px] border-ink rounded-xl px-3.5 py-2 font-display font-bold text-center text-lg focus:outline-none focus:ring-2 focus:ring-yellow"
                />
              </div>
            </div>

            {/* "How do you play?" / Discord Mode Section */}
            {isDiscordActivity ? (
              <div className="card-paper p-5 flex flex-col gap-3 border-[3px] border-ink bg-paper shadow-hard">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="w-11 h-11 rounded-2xl bg-[#5865F2] text-white flex items-center justify-center font-display font-black text-2xl border-[3px] border-ink shadow-hard-sm shrink-0">
                      🎙️
                    </div>
                    <div>
                      <h4 className="font-display font-black text-base text-ink leading-tight flex items-center gap-2">
                        <span>{settings.language === 'en' ? 'Discord Voice Channel' : 'Canale Vocale Discord'}</span>
                        <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-[#5865F2] text-white">Activity</span>
                      </h4>
                      <p className="font-sans font-semibold text-xs text-ink/75 mt-0.5">
                        {settings.language === 'en'
                          ? 'Shout guesses in voice chat • Use Enter for Correct, Space to Pass'
                          : 'Grida le risposte in chiamata • Premi Invio (Corretto) o Spazio (Passa)'}
                      </p>
                    </div>
                  </div>

                  {p2RemoteConnected && (
                    <span className="px-3 py-1 rounded-full bg-green text-ink font-display font-bold text-xs border-[2px] border-ink shadow-hard-sm shrink-0 self-start sm:self-center">
                      📱 {settings.language === 'en' ? 'Phone Connected' : 'Telefono Connesso'}
                    </span>
                  )}
                </div>

                {/* Smartphone QR Companion Promo */}
                <div className="pt-3 border-t-2 border-ink/15 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
                  <p className="font-sans font-medium text-xs text-ink/80 leading-snug">
                    {settings.language === 'en'
                      ? 'Want real speech recognition? Connect your smartphone via QR code.'
                      : 'Vuoi il riconoscimento vocale automatico? Collega il tuo smartphone con il QR code.'}
                  </p>

                  <button
                    type="button"
                    onClick={() => setPhoneModalOpen(true)}
                    className="btn-push py-2.5 px-4 rounded-xl bg-yellow text-ink font-display font-black text-xs flex items-center justify-center gap-2 shrink-0 shadow-hard-sm"
                  >
                    <span>📱</span>
                    <span>
                      {p2RemoteConnected
                        ? (settings.language === 'en' ? 'Phone Mic Active' : 'Microfono Telefono Attivo')
                        : (settings.language === 'en' ? 'Connect Phone Mic (QR)' : 'Collega Microfono Telefono (QR)')}
                    </span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <span className="font-display font-bold text-sm text-paper tracking-wide">
                  {t('lobby.howToPlay', settings.language)}
                </span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {/* Same Room Card */}
                  <button
                    type="button"
                    onClick={() => onUpdateSettings({ micMode: 'local-shared' })}
                    className={`p-4 rounded-card border-[3px] border-ink text-left transition-all ${
                      settings.micMode === 'local-shared'
                        ? 'bg-yellow text-ink shadow-hard tactile-lifted'
                        : 'bg-paper text-ink shadow-hard-sm hover:translate-y-[-2px]'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-2xl">🏠</span>
                      <span className="font-display font-black text-lg">
                        {t('lobby.sameRoom', settings.language)}
                      </span>
                    </div>
                    <p className="text-xs font-sans font-semibold opacity-90 leading-snug">
                      {t('lobby.sameRoomDesc', settings.language)}
                    </p>
                  </button>

                  {/* Remote P2P Card */}
                  <button
                    type="button"
                    onClick={() => onUpdateSettings({ micMode: 'discord-p2p' })}
                    className={`p-4 rounded-card border-[3px] border-ink text-left transition-all ${
                      settings.micMode === 'discord-p2p'
                        ? 'bg-yellow text-ink shadow-hard tactile-lifted'
                        : 'bg-paper text-ink shadow-hard-sm hover:translate-y-[-2px]'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-2xl">🌐</span>
                          <span className="font-display font-black text-lg">
                            {t('lobby.onDiscord', settings.language)}
                          </span>
                        </div>
                        {p2RemoteConnected && (
                          <span className="px-2 py-0.5 rounded-full bg-green text-ink font-display font-bold text-xs border border-ink">
                            Connected
                          </span>
                        )}
                      </div>
                    </div>
                    <p className="text-xs font-sans font-semibold opacity-90 leading-snug">
                      {t('lobby.onDiscordDesc', settings.language)}
                    </p>
                  </button>
                </div>

                {settings.micMode === 'discord-p2p' && (
                  <div className="card-paper p-3 mt-1 flex flex-col sm:flex-row items-center gap-2">
                    <input
                      type="text"
                      readOnly
                      value={getCompanionUrl()}
                      className="min-w-0 flex-1 px-3 py-2 rounded-xl bg-white border-[3px] border-ink text-xs text-ink select-all font-sans"
                    />
                    <button
                      type="button"
                      onClick={handleCopyCompanionUrl}
                      className="btn-push px-4 py-2 rounded-xl bg-yellow text-ink font-display font-bold text-xs flex items-center gap-1.5 shrink-0"
                    >
                      {copiedLink ? (
                        <>
                          <Check className="w-4 h-4 text-green" />
                          <span>{t('lobby.copied', settings.language)}</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-4 h-4" />
                          <span>{t('lobby.copyLink', settings.language)}</span>
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Match Settings: Points to win + Time per player */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Points to win */}
              <div className="card-paper p-4 flex flex-col gap-2">
                <span className="font-display font-bold text-xs uppercase tracking-wider text-ink/70">
                  {t('lobby.pointsToWin', settings.language)}
                </span>
                <div className="grid grid-cols-4 gap-2">
                  {([3, 5, 7, 0] as TargetWinsOption[]).map((opt) => (
                    <button
                      key={`pts-${opt}`}
                      type="button"
                      onClick={() => onUpdateSettings({ targetWins: opt })}
                      className={`min-h-[44px] py-2 rounded-xl font-display text-sm border-[3px] border-ink transition-all ${
                        settings.targetWins === opt
                          ? 'bg-yellow text-ink shadow-hard-sm font-black'
                          : 'bg-white text-ink/80 hover:bg-paper font-bold'
                      }`}
                    >
                      {opt === 0 ? t('lobby.freePlay', settings.language) : `${opt} pt`}
                    </button>
                  ))}
                </div>
              </div>

              {/* Time per player (A2 lowercase 's') */}
              <div className="card-paper p-4 flex flex-col gap-2">
                <span className="font-display font-bold text-xs uppercase tracking-wider text-ink/70">
                  {t('lobby.timePerPlayer', settings.language)}
                </span>
                <div className="grid grid-cols-3 gap-2">
                  {gameConfig.options.duelDurations.map((sec) => (
                    <button
                      key={`dur-${sec}`}
                      type="button"
                      onClick={() => onUpdateSettings({ duelDurationSeconds: sec })}
                      className={`min-h-[44px] py-2 rounded-xl font-display text-sm border-[3px] border-ink transition-all ${
                        settings.duelDurationSeconds === sec
                          ? 'bg-yellow text-ink shadow-hard-sm font-black'
                          : 'bg-white text-ink/80 hover:bg-paper font-bold'
                      }`}
                    >
                      {sec}<span style={{ fontSize: '0.45em' }} className="lowercase ml-0.5 align-baseline">s</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Test Mic link (Only for Standalone Web App) */}
            {!isDiscordActivity && (
              <div className="text-left">
                <button
                  type="button"
                  onClick={toggleMicTest}
                  className="text-xs font-bold text-paper hover:text-yellow underline cursor-pointer"
                >
                  {testingMic
                    ? t('lobby.closeVoiceBtn', settings.language)
                    : t('lobby.testVoiceBtn', settings.language)}
                </button>
                {testingMic && (
                  <div className="card-paper p-3 mt-2 flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2 min-w-0">
                      <Mic className="w-4 h-4 text-green shrink-0 animate-pulse" />
                      <span className="font-display font-bold text-ink truncate">
                        {testTranscript || t('lobby.testingMic', settings.language)}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <span
                        className={`w-2.5 h-4 rounded-sm border border-ink ${
                          testVolume > 0.05 ? 'bg-green' : 'bg-ink/20'
                        }`}
                      />
                      <span
                        className={`w-2.5 h-6 rounded-sm border border-ink ${
                          testVolume > 0.25 ? 'bg-green' : 'bg-ink/20'
                        }`}
                      />
                      <span
                        className={`w-2.5 h-8 rounded-sm border border-ink ${
                          testVolume > 0.5 ? 'bg-green' : 'bg-ink/20'
                        }`}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ONE BIG YELLOW START BUTTON */}
            <button
              type="button"
              onClick={() => {
                recognizerRef.current?.stop();
                onStartGame();
              }}
              className="btn-push btn-shine w-full py-4 sm:py-5 rounded-2xl bg-yellow text-ink font-display font-black text-2xl sm:text-3xl border-[3px] border-ink shadow-hard active:translate-x-[3px] active:translate-y-[3px] active:shadow-hard-pressed transition-all cursor-pointer uppercase tracking-wider"
            >
              {t('lobby.startDuel', settings.language)}
            </button>
          </div>
        )}

        {/* ============================================================== */}
        {/* SOLO MODE SETUP                                                */}
        {/* ============================================================== */}
        {currentMode === 'solo' && (
          <div className="card-paper p-6 sm:p-8 flex flex-col gap-6 w-full max-w-xl mx-auto animate-card-deal">
            <div className="flex flex-col gap-1.5">
              <label className="font-display font-bold text-sm text-ink/80">
                {t('lobby.playerName', settings.language)}
              </label>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setAvatarPickerFor('p1')}
                  aria-label="Player Avatar"
                  className="w-14 h-14 rounded-2xl bg-white border-[3px] border-ink shadow-hard-sm text-3xl flex items-center justify-center shrink-0 hover:bg-yellow active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-all"
                >
                  {p1.avatar}
                </button>
                <input
                  type="text"
                  value={p1Value}
                  maxLength={18}
                  onChange={(e) => onUpdatePlayer('p1', e.target.value, p1.avatar)}
                  placeholder={t('lobby.p1Placeholder', settings.language)}
                  className="min-w-0 flex-1 bg-white border-[3px] border-ink rounded-xl px-3.5 py-2.5 font-display font-bold text-base text-ink focus:outline-none focus:ring-2 focus:ring-yellow"
                />
              </div>
            </div>

            {/* Duration Selector */}
            <div className="flex flex-col gap-1.5">
              <label className="font-display font-bold text-sm text-ink/80">
                {t('lobby.duration', settings.language)}
              </label>
              <div className="grid grid-cols-4 gap-2">
                {gameConfig.options.soloDurations.map((sec) => (
                  <button
                    key={`solo-dur-${sec}`}
                    type="button"
                    onClick={() => onUpdateSettings({ soloDurationSeconds: sec })}
                    className={`min-h-[44px] py-2 rounded-xl font-display text-sm border-[3px] border-ink transition-all ${
                      settings.soloDurationSeconds === sec
                        ? 'bg-yellow text-ink shadow-hard-sm font-black'
                        : 'bg-white text-ink/80 hover:bg-paper font-bold'
                    }`}
                  >
                    {sec === 0 ? (
                      t('lobby.freePlay', settings.language)
                    ) : (
                      <span>
                        {sec}<span style={{ fontSize: '0.45em' }} className="lowercase ml-0.5 align-baseline">s</span>
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            {/* ONE BIG YELLOW START BUTTON */}
            <button
              type="button"
              onClick={() => {
                recognizerRef.current?.stop();
                onStartGame();
              }}
              className="btn-push btn-shine w-full py-4 rounded-xl bg-yellow text-ink font-display font-black text-2xl border-[3px] border-ink shadow-hard active:translate-x-[3px] active:translate-y-[3px] active:shadow-hard-pressed transition-all mt-2 cursor-pointer uppercase tracking-wider"
            >
              {t('solo.startTraining', settings.language)}
            </button>
          </div>
        )}

        {/* ============================================================== */}
        {/* PARTY MODE SETUP (Part D: 8 players, color dots, remove btns)   */}
        {/* ============================================================== */}
        {currentMode === 'party' && (
          <div className="card-paper p-6 sm:p-8 flex flex-col gap-6 w-full max-w-xl mx-auto animate-card-deal">
            <div className="flex flex-col gap-2">
              <label className="font-display font-bold text-sm text-ink/80">
                {t('party.players', settings.language, { n: partyPlayers.length })}
              </label>
              <div className="flex flex-col gap-2.5 max-h-60 overflow-y-auto pr-1">
                {partyPlayers.map((player, idx) => {
                  const colorDef = getPlayerColor(idx);
                  return (
                    <div key={player.id} className="flex items-center gap-2.5">
                      {/* Player Color Indicator Ring + Avatar */}
                      <button
                        type="button"
                        onClick={() => setAvatarPickerFor(player.id)}
                        aria-label="Player Avatar"
                        style={{
                          backgroundColor: colorDef.bgHex,
                          color: colorDef.onColorHex,
                        }}
                        className="w-11 h-11 rounded-xl border-[3px] border-ink shadow-hard-sm text-2xl flex items-center justify-center shrink-0 hover:scale-105 active:translate-x-[2px] active:translate-y-[2px] transition-transform"
                      >
                        {player.avatar}
                      </button>

                      <input
                        type="text"
                        value={localizePlayerName(player.name, settings.language)}
                        maxLength={18}
                        onChange={(e) =>
                          onUpdatePartyPlayer &&
                          onUpdatePartyPlayer(player.id, e.target.value, player.avatar)
                        }
                        placeholder={t('party.playerNamePlaceholder', settings.language)}
                        className="min-w-0 flex-1 bg-white border-[3px] border-ink rounded-xl px-3 py-2 font-display text-base text-ink focus:outline-none focus:ring-2 focus:ring-yellow"
                      />

                      {/* Part D: Every player row beyond the 2 minimum has a visible remove button */}
                      {partyPlayers.length > 2 && onRemovePartyPlayer && (
                        <button
                          type="button"
                          onClick={() => onRemovePartyPlayer(player.id)}
                          aria-label="Remove player"
                          className="w-9 h-9 rounded-xl bg-white border-[3px] border-ink text-red font-black text-lg flex items-center justify-center hover:bg-red hover:text-white shrink-0 shadow-hard-sm"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>

              {partyPlayers.length < 8 && onAddPartyPlayer && (
                <button
                  type="button"
                  onClick={onAddPartyPlayer}
                  className="btn-push py-2.5 rounded-xl bg-paper text-ink font-display font-bold text-sm border-[3px] border-ink shadow-hard-sm"
                >
                  {t('party.addPlayer', settings.language)}
                </button>
              )}
            </div>

            {/* Time per turn */}
            <div className="flex flex-col gap-1.5">
              <label className="font-display font-bold text-sm text-ink/80">
                {t('lobby.timePerPlayer', settings.language)}
              </label>
              <div className="grid grid-cols-3 gap-2">
                {gameConfig.options.duelDurations.map((sec) => (
                  <button
                    key={`dur-${sec}`}
                    type="button"
                    onClick={() => onUpdateSettings({ duelDurationSeconds: sec })}
                    className={`min-h-[44px] py-2 rounded-xl font-display text-sm border-[3px] border-ink transition-all ${
                      settings.duelDurationSeconds === sec
                        ? 'bg-yellow text-ink shadow-hard-sm font-black'
                        : 'bg-white text-ink/80 hover:bg-paper font-bold'
                    }`}
                  >
                    {sec}<span style={{ fontSize: '0.45em' }} className="lowercase ml-0.5 align-baseline">s</span>
                  </button>
                ))}
              </div>
            </div>

            {/* ONE BIG YELLOW START BUTTON */}
            <button
              type="button"
              onClick={() => {
                recognizerRef.current?.stop();
                onStartGame();
              }}
              className="btn-push btn-shine w-full py-4 rounded-xl bg-yellow text-ink font-display font-black text-2xl border-[3px] border-ink shadow-hard active:translate-x-[3px] active:translate-y-[3px] active:shadow-hard-pressed transition-all mt-2 cursor-pointer uppercase tracking-wider"
            >
              {t('lobby.startParty', settings.language)}
            </button>
          </div>
        )}

        {/* ============================================================== */}
        {/* B5: HOME TEASER - 6 TILTED STICKERS CROPPED AT BOTTOM EDGE     */}
        {/* ============================================================== */}
        <div className="w-full flex flex-col items-center mt-6 relative overflow-hidden pt-4 pb-0">
          <button
            type="button"
            onClick={onOpenCategoryEditor}
            className="btn-push btn-shine px-8 py-3.5 rounded-2xl bg-paper text-ink font-display font-black text-base sm:text-lg border-[3px] border-ink shadow-hard uppercase tracking-wider relative z-20"
          >
            {t('lobby.browseAllCount', settings.language, { n: availableCategories.length })}
          </button>

          {/* Fanned row of 6 tilted category stickers cropped by bottom edge */}
          <div className="flex items-end justify-center -space-x-4 sm:-space-x-6 mt-4 -mb-10 pointer-events-auto overflow-hidden max-w-full px-4">
            {availableCategories.slice(0, 6).map((cat, i) => {
              const tilts = [-12, -7, -2, 3, 8, 13];
              const tilt = tilts[i] || 0;
              return (
                <div
                  key={`teaser-${cat.id}`}
                  style={{
                    transform: `rotate(${tilt}deg) translateY(${Math.abs(tilt) * 1.5}px)`,
                  }}
                  className="shrink-0 transition-transform duration-300 ease-out hover:-translate-y-6 hover:scale-105 hover:rotate-0 hover:z-30"
                >
                  <button
                    type="button"
                    onClick={onOpenCategoryEditor}
                    style={{
                      backgroundColor: cat.themeHex || '#FFC933',
                      animationDelay: `${i * 55}ms`,
                    }}
                    className="animate-card-deal group w-28 sm:w-36 h-36 sm:h-44 rounded-2xl border-[3px] border-ink shadow-hard p-2.5 sm:p-3 flex flex-col justify-between cursor-pointer"
                  >
                    <span className="text-3xl sm:text-4xl inline-block transition-transform duration-300 group-hover:scale-125 group-hover:-rotate-6">{cat.icon}</span>
                    <span className="font-display font-black text-xs sm:text-sm text-ink leading-tight line-clamp-2 text-left">
                      {getCategoryTitle(cat, settings.language)}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Quiet footer hint */}
        <footer className="text-center text-xs text-paper/70 font-medium py-1 flex items-center justify-center gap-2">
          <span>
            {currentMode === 'solo'
              ? t('lobby.footerSolo', settings.language)
              : t('lobby.footerDuel', settings.language)}
          </span>
          <span className="text-[10px] font-mono text-paper/40 font-bold">
            v{APP_VERSION}
          </span>
        </footer>
      </div>

      {/* ============================================================== */}
      {/* AVATAR POPOVER                                                 */}
      {/* ============================================================== */}
      {avatarPickerFor && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="card-paper max-w-xs w-full p-5 modal-slap-in">
            <div className="flex items-center justify-between mb-4 pb-2 border-b-2 border-ink">
              <h3 className="font-display font-black text-xl text-ink">
                Choose Avatar
              </h3>
              <button
                type="button"
                onClick={() => setAvatarPickerFor(null)}
                aria-label="Close"
                className="w-8 h-8 rounded-lg bg-paper border-[2.5px] border-ink flex items-center justify-center text-ink"
              >
                <X className="w-4 h-4 stroke-[3]" />
              </button>
            </div>
            <div className="grid grid-cols-4 gap-2.5">
              {AVATAR_OPTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => handleSelectAvatar(emoji)}
                  className="w-12 h-12 rounded-xl bg-white border-[3px] border-ink shadow-hard-sm text-2xl flex items-center justify-center hover:bg-yellow active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-all"
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ============================================================== */}
      {/* B2: SETTINGS MODAL (SLAPS IN, 28px TITLE, 16px BODY, SWITCHES) */}
      {/* ============================================================== */}
      {showSettingsModal && (
        <div className="fixed inset-0 z-50 bg-[#0F0E1A]/90 flex items-center justify-center p-4">
          <div className="card-paper max-w-md w-full p-6 sm:p-8 flex flex-col gap-5 modal-slap-in">
            <div className="flex items-center justify-between pb-3 border-b-2 border-ink">
              <h2 className="font-display font-black text-[28px] text-ink leading-tight">
                {t('lobby.settings', settings.language)}
              </h2>
              <button
                type="button"
                onClick={() => setShowSettingsModal(false)}
                aria-label="Close"
                className="btn-push w-10 h-10 rounded-xl bg-paper text-ink flex items-center justify-center border-[2.5px] border-ink shadow-hard-sm"
              >
                <X className="w-5 h-5 stroke-[3]" />
              </button>
            </div>

            {/* Language Selector */}
            <div className="flex flex-col gap-2">
              <label className="font-display font-bold text-base text-ink">
                {t('app.language', settings.language)}
              </label>
              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => onUpdateSettings({ language: 'it' })}
                  className={`py-3 rounded-xl font-display text-base border-[3px] border-ink transition-all ${
                    settings.language === 'it'
                      ? 'bg-yellow text-ink shadow-hard font-black'
                      : 'bg-white text-ink/80 hover:bg-paper font-bold'
                  }`}
                >
                  Italiano
                </button>
                <button
                  type="button"
                  onClick={() => onUpdateSettings({ language: 'en' })}
                  className={`py-3 rounded-xl font-display text-base border-[3px] border-ink transition-all ${
                    settings.language === 'en'
                      ? 'bg-yellow text-ink shadow-hard font-black'
                      : 'bg-white text-ink/80 hover:bg-paper font-bold'
                  }`}
                >
                  English
                </button>
              </div>
            </div>

            {/* Sound Real Toggle Switch */}
            <div className="flex items-center justify-between py-3 border-y-2 border-ink">
              <span className="font-display font-bold text-base text-ink">
                {t('lobby.sound', settings.language)}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={settings.soundEnabled}
                onClick={() => onUpdateSettings({ soundEnabled: !settings.soundEnabled })}
                className={`w-18 h-10 rounded-full border-[3px] border-ink p-1 transition-colors relative flex items-center ${
                  settings.soundEnabled ? 'bg-green justify-end' : 'bg-paper justify-start'
                }`}
              >
                <span className="font-display font-black text-xs px-1.5 text-ink select-none">
                  {settings.soundEnabled
                    ? t('lobby.switchOn', settings.language)
                    : t('lobby.switchOff', settings.language)}
                </span>
                <span className="w-7 h-7 rounded-full bg-white border-2 border-ink shadow-hard-sm block shrink-0" />
              </button>
            </div>

            {/* Haptics Real Toggle Switch */}
            <div className="flex items-center justify-between py-3 border-b-2 border-ink">
              <span className="font-display font-bold text-base text-ink">
                {t('lobby.haptics', settings.language)}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={settings.hapticsEnabled}
                onClick={() => onUpdateSettings({ hapticsEnabled: !settings.hapticsEnabled })}
                className={`w-18 h-10 rounded-full border-[3px] border-ink p-1 transition-colors relative flex items-center ${
                  settings.hapticsEnabled ? 'bg-green justify-end' : 'bg-paper justify-start'
                }`}
              >
                <span className="font-display font-black text-xs px-1.5 text-ink select-none">
                  {settings.hapticsEnabled
                    ? t('lobby.switchOn', settings.language)
                    : t('lobby.switchOff', settings.language)}
                </span>
                <span className="w-7 h-7 rounded-full bg-white border-2 border-ink shadow-hard-sm block shrink-0" />
              </button>
            </div>

            {/* Install App Button */}
            {canInstallPwa && (
              <button
                type="button"
                onClick={handleInstallClick}
                className="btn-push w-full py-3 rounded-xl bg-paper text-ink font-display font-bold text-base flex items-center justify-center gap-2 border-[3px] border-ink shadow-hard-sm"
              >
                <Download className="w-5 h-5" />
                <span>{t('app.install', settings.language)}</span>
              </button>
            )}

            {/* Reported Photos Management (Zero-Backend Blacklist & Export) */}
            <div className="flex flex-col gap-2.5 p-3.5 bg-paper/60 rounded-xl border-2 border-ink">
              <div className="flex items-center justify-between">
                <span className="font-display font-bold text-sm text-ink flex items-center gap-1.5">
                  <span>🚩</span>
                  <span>
                    {flaggedCount > 0
                      ? t('arena.flaggedCount', settings.language, { count: flaggedCount })
                      : t('arena.noFlaggedPhotos', settings.language)}
                  </span>
                </span>
                {flaggedCount > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      blacklistService.clearUserFlags();
                      setFlaggedCount(0);
                    }}
                    className="text-xs font-sans font-bold text-red hover:underline cursor-pointer"
                  >
                    {settings.language === 'en' ? 'Reset' : 'Ripristina'}
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                {/* Download File JSON */}
                <button
                  type="button"
                  onClick={() => {
                    const json = blacklistService.exportBlacklistJson();
                    const blob = new Blob([json], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement('a');
                    link.href = url;
                    link.download = `yappik-blacklist-${new Date().toISOString().slice(0, 10)}.json`;
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                    URL.revokeObjectURL(url);
                  }}
                  className="btn-push py-2 px-3 rounded-lg bg-white text-ink font-display font-bold text-xs border-2 border-ink flex items-center justify-center gap-1.5 hover:bg-yellow transition-colors cursor-pointer"
                >
                  <Download className="w-4 h-4 shrink-0" />
                  <span className="truncate">{t('arena.downloadBlacklistFile', settings.language)}</span>
                </button>

                {/* Copia JSON negli appunti */}
                <button
                  type="button"
                  onClick={() => {
                    const json = blacklistService.exportBlacklistJson();
                    if (navigator.clipboard) {
                      navigator.clipboard.writeText(json).then(() => {
                        setCopiedBlacklist(true);
                        setTimeout(() => setCopiedBlacklist(false), 2000);
                      });
                    }
                  }}
                  className="btn-push py-2 px-3 rounded-lg bg-white text-ink font-display font-bold text-xs border-2 border-ink flex items-center justify-center gap-1.5 hover:bg-yellow transition-colors cursor-pointer"
                >
                  <span>📋</span>
                  <span className="truncate">
                    {copiedBlacklist
                      ? t('arena.copiedToClipboard', settings.language)
                      : t('arena.exportBlacklistJson', settings.language)}
                  </span>
                </button>
              </div>
            </div>

            {/* B2: Done primary button */}
            <button
              type="button"
              onClick={() => setShowSettingsModal(false)}
              className="btn-push w-full py-3.5 rounded-xl bg-yellow text-ink font-display font-black text-base uppercase border-[3px] border-ink shadow-hard"
            >
              Done
            </button>

            <div className="text-center text-[11px] font-mono font-bold text-ink/40 pt-1">
              Yappik v{APP_VERSION}
            </div>
          </div>
        </div>
      )}

      {/* Phone Mic QR Modal (Exclusive for Discord Activity or remote pairing) */}
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
