import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Category,
  DuelSummary,
  GameMode,
  GameSettings,
  PartyPlayer,
  PlayerConfig,
  PlayerId,
  RemoteMicPacket,
  AppLanguage,
} from './types/game';
import { loadAllCategories } from './data/categories';
import { gameConfig } from './services/configService';
import { CategoryRepository } from './services/categoryRepository';
import { DiscordHostPeer, generateRoomCode } from './engine/discordMicSync';
import { soundEngine } from './engine/soundEffects';
import { hapticsService } from './services/hapticsService';
import { localizeCategoryForGame } from './services/i18n';
import {
  getNextChallengerId,
  getDefaultOpponentId,
  rankPartyPlayers,
} from './utils/partyUtils';
import { LobbyScreen } from './components/LobbyScreen';
import { CategoryDraftScreen } from './components/CategoryDraftScreen';
import { DuelArenaScreen } from './components/DuelArenaScreen';
import { SoloTrainingScreen } from './components/SoloTrainingScreen';
import { RemoteMicScreen } from './components/RemoteMicScreen';
import { CategoryGalleryModal } from './components/CategoryGalleryModal';
import { VictoryScreen } from './components/VictoryScreen';
import {
  discordActivityService,
  isDiscordActivity,
} from './services/discordActivityService';

function getInitialLanguage(): AppLanguage {
  if (typeof window !== 'undefined') {
    const saved =
      localStorage.getItem('yappik_lang') ||
      localStorage.getItem('the_floor_lang');
    if (saved === 'it' || saved === 'en') {
      return saved;
    } else if (navigator.language && !navigator.language.startsWith('it')) {
      return 'en';
    }
  }
  return 'it';
}

type ScreenState = 'lobby' | 'draft' | 'duel' | 'solo-arena' | 'victory';

export const App: React.FC = () => {
  const [remoteRoomParam] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const r = params.get('room');
    return r ? r.toUpperCase().trim() : null;
  });

  const [screen, setScreen] = useState<ScreenState>('lobby');
  const [categories, setCategories] = useState<Category[]>(() =>
    loadAllCategories()
  );
  const [galleryOpen, setGalleryOpen] = useState(false);

  const initialLang = getInitialLanguage();
  const defaultPrefix = initialLang === 'en' ? 'Player' : 'Giocatore';

  // Giocatori 1v1 Classico
  const [p1, setP1] = useState<PlayerConfig>({
    id: 'p1',
    name: `${defaultPrefix} 1`,
    avatar: gameConfig.players.defaultP1.avatar,
  });

  const [p2, setP2] = useState<PlayerConfig>({
    id: 'p2',
    name: `${defaultPrefix} 2`,
    avatar: gameConfig.players.defaultP2.avatar,
  });

  // Giocatori Modalità Party (da 2 a 8 partecipanti)
  const [partyPlayers, setPartyPlayers] = useState<PartyPlayer[]>([
    {
      id: 'p1',
      name: `${defaultPrefix} 1`,
      avatar: gameConfig.players.defaultP1.avatar,
      wins: 0,
      duelsPlayed: 0,
    },
    {
      id: 'p2',
      name: `${defaultPrefix} 2`,
      avatar: gameConfig.players.defaultP2.avatar,
      wins: 0,
      duelsPlayed: 0,
    },
    {
      id: 'p3',
      name: `${defaultPrefix} 3`,
      avatar: '🐼',
      wins: 0,
      duelsPlayed: 0,
    },
    {
      id: 'p4',
      name: `${defaultPrefix} 4`,
      avatar: '🐸',
      wins: 0,
      duelsPlayed: 0,
    },
  ]);

  const [isDiscord] = useState<boolean>(() => isDiscordActivity());

  const [settings, setSettings] = useState<GameSettings>(() => {
    return {
      mode: (gameConfig.defaults.mode as GameMode) || 'duel',
      targetWins: gameConfig.defaults.targetWins,
      duelDurationSeconds: gameConfig.defaults.duelDurationSeconds,
      soloDurationSeconds: gameConfig.defaults.soloDurationSeconds || 60,
      passPenaltySeconds: gameConfig.defaults.passPenaltySeconds,
      micMode: isDiscordActivity() ? 'discord-p2p' : gameConfig.defaults.micMode,
      soundEnabled: gameConfig.defaults.soundEnabled,
      announcerEnabled: gameConfig.defaults.announcerEnabled,
      hapticsEnabled: true,
      language: initialLang,
    };
  });

  // Stato Match a Round con scelta categoria alternata
  const [p1Score, setP1Score] = useState(0);
  const [p2Score, setP2Score] = useState(0);
  const [chooserId, setChooserId] = useState<PlayerId>('p1');
  const [selectedOpponentId, setSelectedOpponentId] = useState<string>('p2');
  const [activeCategory, setActiveCategory] = useState<Category | null>(null);
  const [playedCategoryIds, setPlayedCategoryIds] = useState<string[]>([]);
  const [duelHistory, setDuelHistory] = useState<DuelSummary[]>([]);
  const [winnerId, setWinnerId] = useState<PlayerId>('p1');

  // Stato Discord P2P Host
  const [roomCode] = useState<string>(() => {
    const derived = discordActivityService.getDerivedRoomCode();
    return derived || generateRoomCode();
  });
  const [p2RemoteConnected, setP2RemoteConnected] = useState(false);
  const [latestRemotePacket, setLatestRemotePacket] =
    useState<RemoteMicPacket | null>(null);
  const [remoteTranscriptPreview, setRemoteTranscriptPreview] = useState('');
  const hostPeerRef = useRef<DiscordHostPeer | null>(null);

  useEffect(() => {
    soundEngine.enabled = settings.soundEnabled;
    soundEngine.announcerEnabled = settings.announcerEnabled;
    hapticsService.enabled = settings.hapticsEnabled;
  }, [settings.soundEnabled, settings.announcerEnabled, settings.hapticsEnabled]);

  // Handshake Discord Activity se avviato all'interno di Discord
  useEffect(() => {
    if (isDiscord) {
      discordActivityService.init().catch(() => {});
    }
  }, [isDiscord]);

  useEffect(() => {
    if (remoteRoomParam) return;
    if (settings.micMode !== 'discord-p2p' || settings.mode !== 'duel') {
      hostPeerRef.current?.destroy();
      hostPeerRef.current = null;
      setP2RemoteConnected(false);
      return;
    }

    const host = new DiscordHostPeer(
      roomCode,
      (packet) => {
        setLatestRemotePacket({ ...packet });
        if (packet.type === 'TRANSCRIPT' && packet.transcript) {
          setRemoteTranscriptPreview(packet.transcript);
        } else if (
          packet.type === 'PLAYER_UPDATE' &&
          typeof packet.p2Name === 'string'
        ) {
          const cleanName = packet.p2Name.slice(0, 18);
          setP2((prev) => ({
            ...prev,
            name: cleanName,
            avatar: packet.p2Avatar || prev.avatar,
          }));
        }
      },
      (connected) => {
        setP2RemoteConnected(connected);
      }
    );
    hostPeerRef.current = host;
    host.start();

    return () => {
      host.destroy();
    };
  }, [settings.micMode, settings.mode, roomCode, remoteRoomParam]);

  // Sincronizza nomi, avatar e fase corrente verso il secondo giocatore in Discord P2P
  useEffect(() => {
    if (
      !p2RemoteConnected ||
      settings.micMode !== 'discord-p2p' ||
      settings.mode !== 'duel' ||
      screen === 'duel'
    ) {
      return;
    }

    const phaseLabel =
      screen === 'draft'
        ? settings.language === 'en'
          ? 'Choosing category...'
          : 'Scelta categoria...'
        : screen === 'victory'
        ? settings.language === 'en'
          ? 'Match finished!'
          : 'Partita conclusa!'
        : settings.language === 'en'
        ? 'Waiting in lobby...'
        : 'In lobby, pronti!';

    hostPeerRef.current?.sendState({
      type: 'STATE_UPDATE',
      p1Name: p1.name,
      p2Name: p2.name,
      p1Avatar: p1.avatar,
      p2Avatar: p2.avatar,
      categoryName: phaseLabel,
      inDuel: false,
    });
  }, [
    p2RemoteConnected,
    settings.micMode,
    settings.mode,
    settings.language,
    screen,
    p1.name,
    p1.avatar,
    p2.name,
    p2.avatar,
  ]);

  const handleSendRemoteState = useCallback((packet: RemoteMicPacket) => {
    hostPeerRef.current?.sendState(packet);
  }, []);

  if (remoteRoomParam) {
    return <RemoteMicScreen roomCode={remoteRoomParam} />;
  }

  const handleUpdatePlayer = (
    id: 'p1' | 'p2',
    name: string,
    avatar: string
  ) => {
    if (id === 'p1') {
      setP1((prev) => ({ ...prev, name, avatar }));
    } else {
      setP2((prev) => ({ ...prev, name, avatar }));
    }
  };

  const handleAddPartyPlayer = () => {
    if (partyPlayers.length >= 8) return;
    const usedAvatars = new Set(partyPlayers.map((p) => p.avatar));
    const nextAvatar =
      gameConfig.players.avatars.find((a) => !usedAvatars.has(a)) || '⭐';
    const nextId = `p${Date.now().toString().slice(-4)}`;
    const defaultPrefix = settings.language === 'en' ? 'Player' : 'Giocatore';
    setPartyPlayers((prev) => [
      ...prev,
      {
        id: nextId,
        name: `${defaultPrefix} ${prev.length + 1}`,
        avatar: nextAvatar,
        wins: 0,
        duelsPlayed: 0,
      },
    ]);
  };

  const handleRemovePartyPlayer = (id: string) => {
    if (partyPlayers.length <= 2) return;
    setPartyPlayers((prev) => {
      const filtered = prev.filter((p) => p.id !== id);
      const defaultPrefix = settings.language === 'en' ? 'Player' : 'Giocatore';
      const defaultRegex = /^(?:Player|Giocatore)\s+(\d+)$/i;
      return filtered.map((player, idx) => {
        if (defaultRegex.test(player.name.trim())) {
          return { ...player, name: `${defaultPrefix} ${idx + 1}` };
        }
        return player;
      });
    });
  };

  const handleUpdatePartyPlayer = (
    id: string,
    name: string,
    avatar: string
  ) => {
    setPartyPlayers((prev) =>
      prev.map((p) => (p.id === id ? { ...p, name, avatar } : p))
    );
  };

  const handleUpdateSettings = (partial: Partial<GameSettings>) => {
    if (partial.language && partial.language !== settings.language) {
      const newLang = partial.language;
      const newPrefix = newLang === 'en' ? 'Player' : 'Giocatore';
      const defaultRegex = /^(?:Player|Giocatore)\s+(\d+)$/i;

      setP1((prev) => {
        const match = prev.name.trim().match(defaultRegex);
        if (match) return { ...prev, name: `${newPrefix} ${match[1]}` };
        return prev;
      });

      setP2((prev) => {
        const match = prev.name.trim().match(defaultRegex);
        if (match) return { ...prev, name: `${newPrefix} ${match[1]}` };
        return prev;
      });

      setPartyPlayers((prev) =>
        prev.map((player, idx) => {
          const match = player.name.trim().match(defaultRegex);
          if (match) return { ...player, name: `${newPrefix} ${idx + 1}` };
          return player;
        })
      );
    }

    setSettings((prev) => {
      const updated = { ...prev, ...partial };
      if (partial.language && typeof window !== 'undefined') {
        localStorage.setItem('yappik_lang', partial.language);
        localStorage.setItem('the_floor_lang', partial.language);
      }
      return updated;
    });
  };

  const handleStartNewGame = () => {
    if (
      settings.mode === 'duel' &&
      settings.micMode === 'discord-p2p' &&
      !isDiscord &&
      !p2RemoteConnected
    ) {
      return;
    }

    const allCats = loadAllCategories();
    setCategories(allCats);
    setP1Score(0);
    setP2Score(0);
    setPlayedCategoryIds([]);
    setDuelHistory([]);

    if (settings.mode === 'party') {
      setPartyPlayers((prev) =>
        prev.map((p) => ({ ...p, wins: 0, duelsPlayed: 0 }))
      );
      setChooserId(partyPlayers[0]?.id || 'p1');
      setSelectedOpponentId(partyPlayers[1]?.id || 'p2');
    } else {
      setChooserId('p1');
    }

    setScreen('draft');
  };

  const handleSelectCategory = async (cat: Category) => {
    const freshCat = await CategoryRepository.fetchCategoryById(cat.id);
    const chosen = freshCat || cat;
    const localized = localizeCategoryForGame(chosen, settings.language);
    setActiveCategory(localized);
    setPlayedCategoryIds((prev) => [...prev, cat.id]);

    if (settings.mode === 'solo') {
      setScreen('solo-arena');
    } else {
      setScreen('duel');
    }
  };

  const handleDuelFinished = (summary: DuelSummary) => {
    if (settings.mode === 'party') {
      // Calcola vincitore e perdente nel Party
      const p1Contestant = partyPlayers.find((p) => p.id === chooserId);
      const p2Contestant = partyPlayers.find((p) => p.id === selectedOpponentId);

      const winnerPlayer = summary.winner === 'p1' ? p1Contestant : p2Contestant;

      setPartyPlayers((prev) =>
        prev.map((p) => {
          if (p.id === winnerPlayer?.id) {
            return { ...p, wins: p.wins + 1, duelsPlayed: p.duelsPlayed + 1 };
          }
          if (
            p.id === p1Contestant?.id ||
            p.id === p2Contestant?.id
          ) {
            return { ...p, duelsPlayed: p.duelsPlayed + 1 };
          }
          return p;
        })
      );

      setDuelHistory((prev) => [...prev, summary]);

      // Verifica vittoria del torneo party
      const maxWins = (winnerPlayer?.wins || 0) + 1;
      if (settings.targetWins > 0 && maxWins >= settings.targetWins) {
        setWinnerId(winnerPlayer?.id || 'p1');
        setScreen('victory');
        return;
      }

      // Prossimo turno: passa il ruolo di sfidante al giocatore successivo nel party
      const nextChooser = getNextChallengerId(partyPlayers, chooserId);
      setChooserId(nextChooser);
      setSelectedOpponentId(getDefaultOpponentId(partyPlayers, nextChooser));

      setScreen('draft');
      return;
    }

    // Modalità Duello 1v1 Classico
    const newP1Score = summary.winner === 'p1' ? p1Score + 1 : p1Score;
    const newP2Score = summary.winner === 'p2' ? p2Score + 1 : p2Score;

    setP1Score(newP1Score);
    setP2Score(newP2Score);
    setDuelHistory((prev) => [...prev, summary]);

    if (
      settings.targetWins > 0 &&
      (newP1Score >= settings.targetWins || newP2Score >= settings.targetWins)
    ) {
      setWinnerId(newP1Score >= newP2Score ? 'p1' : 'p2');
      setScreen('victory');
      return;
    }

    setChooserId((prev) => (prev === 'p1' ? 'p2' : 'p1'));
    setScreen('draft');
  };

  const handleFinishMatchEarly = () => {
    if (settings.mode === 'party') {
      const topPlayer = rankPartyPlayers(partyPlayers)[0];
      setWinnerId(topPlayer?.id || 'p1');
    } else {
      setWinnerId(p1Score >= p2Score ? 'p1' : 'p2');
    }
    setScreen('victory');
  };

  const currentRound = duelHistory.length + 1;

  // Risolve i due giocatori attivi per il duello corrente
  const activeDuelP1: PlayerConfig =
    settings.mode === 'party'
      ? partyPlayers.find((p) => p.id === chooserId) || p1
      : p1;

  const activeDuelP2: PlayerConfig =
    settings.mode === 'party'
      ? partyPlayers.find((p) => p.id === selectedOpponentId) || p2
      : p2;

  return (
    <>
      {screen === 'lobby' && (
        <LobbyScreen
          p1={p1}
          p2={p2}
          onUpdatePlayer={handleUpdatePlayer}
          partyPlayers={partyPlayers}
          onAddPartyPlayer={handleAddPartyPlayer}
          onRemovePartyPlayer={handleRemovePartyPlayer}
          onUpdatePartyPlayer={handleUpdatePartyPlayer}
          settings={settings}
          onUpdateSettings={handleUpdateSettings}
          categories={categories}
          roomCode={roomCode}
          p2RemoteConnected={p2RemoteConnected}
          remoteTranscriptPreview={remoteTranscriptPreview}
          isDiscordActivity={isDiscord}
          onOpenCategoryEditor={() => setGalleryOpen(true)}
          onStartGame={handleStartNewGame}
        />
      )}

      {screen === 'draft' && (
        <CategoryDraftScreen
          categories={categories}
          playedCategoryIds={playedCategoryIds}
          mode={settings.mode}
          p1={activeDuelP1}
          p2={activeDuelP2}
          partyPlayers={partyPlayers}
          selectedOpponentId={selectedOpponentId}
          onSelectOpponent={(oppId) => setSelectedOpponentId(oppId)}
          p1Score={p1Score}
          p2Score={p2Score}
          targetWins={settings.targetWins}
          chooserId={settings.mode === 'party' ? 'p1' : chooserId}
          roundNumber={currentRound}
          language={settings.language}
          lastSummary={
            duelHistory.length > 0
              ? duelHistory[duelHistory.length - 1]
              : null
          }
          onSelectCategory={handleSelectCategory}
          onFinishMatchEarly={handleFinishMatchEarly}
          onBackToLobby={() => setScreen('lobby')}
        />
      )}

      {screen === 'solo-arena' && activeCategory && (
        <SoloTrainingScreen
          category={activeCategory}
          player={p1}
          settings={settings}
          onBackToDraft={() => setScreen('draft')}
          onBackToLobby={() => setScreen('lobby')}
        />
      )}

      {screen === 'duel' && activeCategory && (
        <DuelArenaScreen
          roundNumber={currentRound}
          category={activeCategory}
          p1={activeDuelP1}
          p2={activeDuelP2}
          initialPlayer="p1"
          settings={settings}
          p2RemoteConnected={p2RemoteConnected}
          latestRemotePacket={latestRemotePacket}
          onSendRemoteState={handleSendRemoteState}
          onDuelFinished={handleDuelFinished}
          isDiscordActivity={isDiscord}
          roomCode={roomCode}
        />
      )}

      {screen === 'victory' && (
        <VictoryScreen
          mode={settings.mode}
          winnerId={winnerId}
          p1={p1}
          p2={p2}
          partyPlayers={partyPlayers}
          p1Score={p1Score}
          p2Score={p2Score}
          history={duelHistory}
          language={settings.language}
          onPlayAgain={handleStartNewGame}
          onBackToLobby={() => setScreen('lobby')}
        />
      )}

      <CategoryGalleryModal
        isOpen={galleryOpen}
        categories={categories}
        language={settings.language}
        mode="browse"
        onClose={() => setGalleryOpen(false)}
      />
    </>
  );
};
