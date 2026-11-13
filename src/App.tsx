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
import {
  DiscordHostPeer,
  generateRoomCode,
  RemoteSlot,
  formatRoomTag,
  parseRoomInput,
} from './engine/discordMicSync';
import { soundEngine } from './engine/soundEffects';
import { hapticsService } from './services/hapticsService';
import { localizeCategoryForGame, filterCategories } from './services/i18n';
import {
  getNextChallengerId,
  getBalancedOpponentId,
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

const STORAGE_P1_KEY = 'yappik_p1';
const STORAGE_P2_KEY = 'yappik_p2';
const STORAGE_SETTINGS_KEY = 'yappik_settings';

function readStorageJson<T>(key: string): T | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeStorageJson(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Silenzioso in navigazione privata o quota esaurita
  }
}

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

function loadSavedPlayer(
  storageKey: string,
  id: PlayerId,
  defaultName: string,
  defaultAvatar: string
): PlayerConfig {
  const saved = readStorageJson<Partial<PlayerConfig>>(storageKey);
  if (saved && typeof saved.name === 'string' && typeof saved.avatar === 'string') {
    return {
      id,
      name: saved.name.trim() ? saved.name.slice(0, 18) : defaultName,
      avatar: saved.avatar || defaultAvatar,
    };
  }
  return { id, name: defaultName, avatar: defaultAvatar };
}

type ScreenState = 'lobby' | 'draft' | 'duel' | 'solo-arena' | 'victory';

interface RemoteSessionState {
  roomCode: string;
  slot?: RemoteSlot;
  discordAutoJoined?: boolean;
}

export const App: React.FC = () => {
  const [remoteSession, setRemoteSession] = useState<RemoteSessionState | null>(() => {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    const r = params.get('room')?.trim();
    if (!r) return null;
    const rawSlot = params.get('slot');
    return {
      roomCode: r,
      slot: rawSlot === 'p1' || rawSlot === 'p2' ? rawSlot : undefined,
    };
  });

  const [screen, setScreen] = useState<ScreenState>('lobby');
  const [categories, setCategories] = useState<Category[]>(() =>
    loadAllCategories()
  );
  const [galleryOpen, setGalleryOpen] = useState(false);

  const initialLang = getInitialLanguage();
  const defaultPrefix = initialLang === 'en' ? 'Player' : 'Giocatore';

  // Giocatori 1v1 Classico (persistenti)
  const [p1, setP1] = useState<PlayerConfig>(() =>
    loadSavedPlayer(
      STORAGE_P1_KEY,
      'p1',
      `${defaultPrefix} 1`,
      gameConfig.players.defaultP1.avatar
    )
  );

  const [p2, setP2] = useState<PlayerConfig>(() =>
    loadSavedPlayer(
      STORAGE_P2_KEY,
      'p2',
      `${defaultPrefix} 2`,
      gameConfig.players.defaultP2.avatar
    )
  );

  // Giocatori Modalità Party (da 3 a 8 partecipanti)
  const [partyPlayers, setPartyPlayers] = useState<PartyPlayer[]>([
    {
      id: 'p1',
      name: `${defaultPrefix} 1`,
      avatar: gameConfig.players.defaultP1.avatar,
      wins: 0,
      duelsPlayed: 0,
      colorIndex: 0,
    },
    {
      id: 'p2',
      name: `${defaultPrefix} 2`,
      avatar: gameConfig.players.defaultP2.avatar,
      wins: 0,
      duelsPlayed: 0,
      colorIndex: 1,
    },
    {
      id: 'p3',
      name: `${defaultPrefix} 3`,
      avatar: '🐼',
      wins: 0,
      duelsPlayed: 0,
      colorIndex: 2,
    },
    {
      id: 'p4',
      name: `${defaultPrefix} 4`,
      avatar: '🐸',
      wins: 0,
      duelsPlayed: 0,
      colorIndex: 3,
    },
  ]);

  const [isDiscord] = useState<boolean>(() => isDiscordActivity());

  const [settings, setSettings] = useState<GameSettings>(() => {
    const defaults: GameSettings = {
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
    const saved = readStorageJson<Partial<GameSettings>>(STORAGE_SETTINGS_KEY);
    if (!saved) return defaults;
    return {
      ...defaults,
      ...saved,
      language:
        saved.language === 'en' || saved.language === 'it'
          ? saved.language
          : defaults.language,
      micMode: isDiscordActivity()
        ? 'discord-p2p'
        : saved.micMode === 'discord-p2p' || saved.micMode === 'local-shared'
        ? saved.micMode
        : defaults.micMode,
    };
  });

  useEffect(() => {
    if (remoteSession) return;
    writeStorageJson(STORAGE_P1_KEY, p1);
  }, [p1, remoteSession]);

  useEffect(() => {
    if (remoteSession) return;
    writeStorageJson(STORAGE_P2_KEY, p2);
  }, [p2, remoteSession]);

  useEffect(() => {
    if (remoteSession) return;
    writeStorageJson(STORAGE_SETTINGS_KEY, settings);
    try {
      localStorage.setItem('yappik_lang', settings.language);
    } catch {
      // Silenzioso
    }
  }, [settings, remoteSession]);

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
  const [roomCode, setRoomCode] = useState<string>(() => {
    const derived = discordActivityService.getDerivedRoomCode();
    if (derived) return derived;
    if (typeof window !== 'undefined') {
      try {
        const saved = window.sessionStorage?.getItem('yappik_host_room_code');
        if (saved && saved.trim()) return saved.trim();
      } catch {
        // Silenzioso
      }
    }
    return generateRoomCode();
  });
  useEffect(() => {
    if (isDiscord || typeof window === 'undefined') return;
    try {
      window.sessionStorage?.setItem('yappik_host_room_code', roomCode);
    } catch {
      // Silenzioso
    }
  }, [roomCode, isDiscord]);
  const [hostNetworkReady, setHostNetworkReady] = useState(false);
  const [p1RemoteConnected, setP1RemoteConnected] = useState(false);
  const [p2RemoteConnected, setP2RemoteConnected] = useState(false);
  const [latestRemotePacket, setLatestRemotePacket] =
    useState<RemoteMicPacket | null>(null);
  const [remoteTranscriptPreview, setRemoteTranscriptPreview] = useState('');
  const [remoteJoinNotice, setRemoteJoinNotice] = useState<string | null>(null);
  const joinNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hostPeerRef = useRef<DiscordHostPeer | null>(null);
  const remotePacketListenersRef = useRef<Set<(pkt: RemoteMicPacket) => void>>(
    new Set()
  );

  const screenRef = useRef<ScreenState>(screen);
  screenRef.current = screen;
  const modeRef = useRef<GameMode>(settings.mode);
  modeRef.current = settings.mode;
  const languageRef = useRef(settings.language);
  languageRef.current = settings.language;
  const p1RemoteConnectedRef = useRef(p1RemoteConnected);
  p1RemoteConnectedRef.current = p1RemoteConnected;
  const p2RemoteConnectedRef = useRef(p2RemoteConnected);
  p2RemoteConnectedRef.current = p2RemoteConnected;
  const userEditedPlayersRef = useRef<{ p1: boolean; p2: boolean }>({
    p1: false,
    p2: false,
  });
  const activeContestantIdsRef = useRef<{ p1Id: string; p2Id: string }>({
    p1Id: 'p1',
    p2Id: 'p2',
  });
  const latestRemoteStateRef = useRef<RemoteMicPacket>({
    type: 'STATE_UPDATE',
    p1Name: p1.name,
    p2Name: p2.name,
    p1Avatar: p1.avatar,
    p2Avatar: p2.avatar,
    language: settings.language,
    categoryName: '',
    inDuel: false,
  });

  const showJoinNotice = useCallback((msg: string) => {
    setRemoteJoinNotice(msg);
    if (joinNoticeTimerRef.current) clearTimeout(joinNoticeTimerRef.current);
    joinNoticeTimerRef.current = setTimeout(() => {
      setRemoteJoinNotice(null);
    }, 4000);
  }, []);

  useEffect(() => {
    return () => {
      if (joinNoticeTimerRef.current) clearTimeout(joinNoticeTimerRef.current);
    };
  }, []);

  const subscribeRemotePackets = useCallback(
    (listener: (pkt: RemoteMicPacket) => void) => {
      remotePacketListenersRef.current.add(listener);
      return () => {
        remotePacketListenersRef.current.delete(listener);
      };
    },
    []
  );

  useEffect(() => {
    soundEngine.enabled = settings.soundEnabled;
    soundEngine.announcerEnabled = settings.announcerEnabled;
    hapticsService.enabled = settings.hapticsEnabled;
  }, [settings.soundEnabled, settings.announcerEnabled, settings.hapticsEnabled]);

  // Handshake Discord Activity se avviato all'interno di Discord
  useEffect(() => {
    if (!isDiscord) return;
    let unsubParticipants = () => {};
    discordActivityService
      .init()
      .then(async (ready) => {
        if (!ready) return;
        const derived = discordActivityService.getDerivedRoomCode();
        if (
          derived &&
          !p1RemoteConnectedRef.current &&
          !p2RemoteConnectedRef.current
        ) {
          setRoomCode((prev) => (prev === derived ? prev : derived));
        }

        const applyParticipants = (
          list: Array<{ id: string; displayName: string }>
        ) => {
          if (list.length === 0) return;
          setP1((prev) => {
            if (
              !userEditedPlayersRef.current.p1 &&
              (prev.name === 'Giocatore 1' || prev.name === 'Player 1') &&
              list[0]
            ) {
              return { ...prev, name: list[0].displayName.slice(0, 18) };
            }
            return prev;
          });
          setP2((prev) => {
            if (
              !userEditedPlayersRef.current.p2 &&
              (prev.name === 'Giocatore 2' || prev.name === 'Player 2') &&
              list[1]
            ) {
              return { ...prev, name: list[1].displayName.slice(0, 18) };
            }
            return prev;
          });
        };

        const initialList = await discordActivityService.getConnectedParticipants();
        applyParticipants(initialList);
        unsubParticipants = await discordActivityService.subscribeParticipants(
          applyParticipants
        );
      })
      .catch(() => {});

    return () => {
      unsubParticipants();
    };
  }, [isDiscord]);

  useEffect(() => {
    if (remoteSession) {
      hostPeerRef.current?.destroy();
      hostPeerRef.current = null;
      setHostNetworkReady(false);
      return;
    }
    if (settings.micMode !== 'discord-p2p' || settings.mode === 'solo') {
      hostPeerRef.current?.destroy();
      hostPeerRef.current = null;
      setHostNetworkReady(false);
      setP1RemoteConnected(false);
      setP2RemoteConnected(false);
      return;
    }

    const host = new DiscordHostPeer(
      roomCode,
      (packet) => {
        setLatestRemotePacket({ ...packet });
        remotePacketListenersRef.current.forEach((listener) => listener(packet));
        const pktSlot: RemoteSlot = packet.slot === 'p1' ? 'p1' : 'p2';

        if (packet.type === 'PING') {
          if (pktSlot === 'p1') setP1RemoteConnected(true);
          else setP2RemoteConnected(true);
          if (screenRef.current !== 'duel') {
            hostPeerRef.current?.sendState(latestRemoteStateRef.current, pktSlot);
          }
          return;
        }

        if (packet.type === 'TRANSCRIPT' && packet.transcript) {
          setRemoteTranscriptPreview(packet.transcript);
        } else if (packet.type === 'PLAYER_UPDATE') {
          const isEn = languageRef.current === 'en';
          if (typeof packet.p1Name === 'string') {
            const cleanName = packet.p1Name.slice(0, 18);
            userEditedPlayersRef.current.p1 = true;
            setP1((prev) => ({
              ...prev,
              name: cleanName,
              avatar: packet.p1Avatar || prev.avatar,
            }));
            if (modeRef.current === 'party') {
              const targetId = activeContestantIdsRef.current.p1Id;
              setPartyPlayers((prev) =>
                prev.map((p) =>
                  p.id === targetId
                    ? { ...p, name: cleanName, avatar: packet.p1Avatar || p.avatar }
                    : p
                )
              );
            }
            if (cleanName.trim()) {
              showJoinNotice(
                isEn
                  ? `P1 updated name: ${cleanName}`
                  : `G1 ora si chiama: ${cleanName}`
              );
            }
          }
          if (typeof packet.p2Name === 'string') {
            const cleanName = packet.p2Name.slice(0, 18);
            userEditedPlayersRef.current.p2 = true;
            setP2((prev) => ({
              ...prev,
              name: cleanName,
              avatar: packet.p2Avatar || prev.avatar,
            }));
            if (modeRef.current === 'party') {
              const targetId = activeContestantIdsRef.current.p2Id;
              setPartyPlayers((prev) =>
                prev.map((p) =>
                  p.id === targetId
                    ? { ...p, name: cleanName, avatar: packet.p2Avatar || p.avatar }
                    : p
                )
              );
            }
            if (cleanName.trim()) {
              showJoinNotice(
                isEn
                  ? `P2 updated name: ${cleanName}`
                  : `G2 ora si chiama: ${cleanName}`
              );
            }
          }
        }
      },
      (connected, _info, slot) => {
        const isEn = languageRef.current === 'en';
        const resolvedSlot: RemoteSlot = slot === 'p1' ? 'p1' : 'p2';
        if (resolvedSlot === 'p1') {
          setP1RemoteConnected(connected);
        } else {
          setP2RemoteConnected(connected);
        }
        if (connected) {
          const tag = formatRoomTag(roomCode);
          showJoinNotice(
            isEn
              ? `${resolvedSlot.toUpperCase()} joined room ${tag}!`
              : `${resolvedSlot === 'p1' ? 'G1' : 'G2'} è entrato nella stanza ${tag}!`
          );
          if (screenRef.current !== 'duel') {
            hostPeerRef.current?.sendState(latestRemoteStateRef.current, resolvedSlot);
          }
        }
      },
      (errType) => {
        if (errType === 'unavailable-id') {
          if (isDiscord) {
            setRemoteSession({
              roomCode,
              slot: 'p2',
              discordAutoJoined: true,
            });
          } else {
            setRoomCode(generateRoomCode());
          }
        }
      },
      (ready) => {
        setHostNetworkReady(ready);
      }
    );
    hostPeerRef.current = host;
    host.start();

    return () => {
      setHostNetworkReady(false);
      host.destroy();
    };
  }, [settings.micMode, settings.mode, roomCode, remoteSession, isDiscord, showJoinNotice]);

  // Risoluzione dinamica giocatori attivi (1v1 vs Party) usata anche per la sincronizzazione remota
  const activeDuelP1: PlayerConfig =
    settings.mode === 'party'
      ? partyPlayers.find((p) => p.id === chooserId) || partyPlayers[0] || p1
      : p1;

  const activeDuelP2: PlayerConfig =
    settings.mode === 'party'
      ? partyPlayers.find((p) => p.id === selectedOpponentId) ||
        partyPlayers[1] ||
        p2
      : p2;

  activeContestantIdsRef.current = {
    p1Id: activeDuelP1.id,
    p2Id: activeDuelP2.id,
  };

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
      ? `In room ${formatRoomTag(roomCode)} — Ready!`
      : `Nella stanza ${formatRoomTag(roomCode)} — Pronti!`;

  latestRemoteStateRef.current = {
    type: 'STATE_UPDATE',
    p1Name: activeDuelP1.name,
    p2Name: activeDuelP2.name,
    p1Avatar: activeDuelP1.avatar,
    p2Avatar: activeDuelP2.avatar,
    language: settings.language,
    categoryName: phaseLabel,
    inDuel: false,
  };

  // Sincronizza nomi, avatar, lingua e fase corrente verso gli smartphone remoti
  useEffect(() => {
    if (
      remoteSession ||
      (!p1RemoteConnected && !p2RemoteConnected) ||
      settings.micMode !== 'discord-p2p' ||
      settings.mode === 'solo' ||
      screen === 'duel'
    ) {
      return;
    }

    hostPeerRef.current?.sendState(latestRemoteStateRef.current);
  }, [
    remoteSession,
    p1RemoteConnected,
    p2RemoteConnected,
    settings.micMode,
    settings.mode,
    settings.language,
    screen,
    activeDuelP1.name,
    activeDuelP1.avatar,
    activeDuelP2.name,
    activeDuelP2.avatar,
    roomCode,
  ]);

  const handleSendRemoteState = useCallback((packet: RemoteMicPacket) => {
    hostPeerRef.current?.sendState(packet);
  }, []);

  const handleJoinRemoteRoom = useCallback(
    (rawInput: string, preferredSlot: RemoteSlot = 'p2') => {
      const parsed = parseRoomInput(rawInput);
      if (!parsed) return false;
      const targetSlot = parsed.slot ?? preferredSlot;
      if (typeof window !== 'undefined') {
        try {
          const url = new URL(window.location.href);
          url.searchParams.set('room', parsed.roomCode);
          url.searchParams.set('slot', targetSlot);
          window.history.replaceState({}, '', url.toString());
        } catch {
          // Silenzioso
        }
      }
      setRemoteSession({
        roomCode: parsed.roomCode,
        slot: targetSlot,
      });
      return true;
    },
    []
  );

  const handleLeaveRemoteRoom = useCallback(() => {
    if (typeof window !== 'undefined') {
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete('room');
        url.searchParams.delete('slot');
        window.history.replaceState({}, '', url.toString());
      } catch {
        // Silenzioso
      }
    }
    setRemoteSession((prev) => {
      if (prev?.discordAutoJoined) {
        setRoomCode(generateRoomCode());
      }
      return null;
    });
  }, []);

  if (remoteSession) {
    return (
      <RemoteMicScreen
        roomCode={remoteSession.roomCode}
        slot={remoteSession.slot}
        isDiscordAutoJoined={remoteSession.discordAutoJoined}
        onChangeSlot={(nextSlot) =>
          setRemoteSession((prev) =>
            prev ? { ...prev, slot: nextSlot } : prev
          )
        }
        onExitRoom={handleLeaveRemoteRoom}
      />
    );
  }

  const handleUpdatePlayer = (
    id: 'p1' | 'p2',
    name: string,
    avatar: string
  ) => {
    userEditedPlayersRef.current[id] = true;
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
    const usedColors = new Set(
      partyPlayers.map((p, idx) =>
        typeof p.colorIndex === 'number' ? p.colorIndex : idx
      )
    );
    let nextColorIndex = partyPlayers.length % 8;
    for (let c = 0; c < 8; c++) {
      if (!usedColors.has(c)) {
        nextColorIndex = c;
        break;
      }
    }
    const defaultPrefix = settings.language === 'en' ? 'Player' : 'Giocatore';
    setPartyPlayers((prev) => [
      ...prev,
      {
        id: nextId,
        name: `${defaultPrefix} ${prev.length + 1}`,
        avatar: nextAvatar,
        wins: 0,
        duelsPlayed: 0,
        colorIndex: nextColorIndex,
      },
    ]);
  };

  const handleRemovePartyPlayer = (id: string) => {
    if (partyPlayers.length <= 3) return;
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
      !p1RemoteConnected &&
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
      const resetPlayers = partyPlayers.map((p) => ({
        ...p,
        wins: 0,
        duelsPlayed: 0,
      }));
      setPartyPlayers(resetPlayers);
      const nextChooser = resetPlayers[0]?.id || 'p1';
      setChooserId(nextChooser);
      setSelectedOpponentId(getBalancedOpponentId(resetPlayers, nextChooser));
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
      // Calcola vincitore e perdente reali nel Party (usando ID espliciti se presenti)
      const p1Id = summary.p1PlayerId || chooserId;
      const p2Id = summary.p2PlayerId || selectedOpponentId;
      const p1Contestant = partyPlayers.find((p) => p.id === p1Id);
      const p2Contestant = partyPlayers.find((p) => p.id === p2Id);

      const winnerPlayer = summary.winner === 'p1' ? p1Contestant : p2Contestant;
      const updatedPartyPlayers = partyPlayers.map((p) => {
        if (p.id === winnerPlayer?.id) {
          return { ...p, wins: p.wins + 1, duelsPlayed: p.duelsPlayed + 1 };
        }
        if (p.id === p1Contestant?.id || p.id === p2Contestant?.id) {
          return { ...p, duelsPlayed: p.duelsPlayed + 1 };
        }
        return p;
      });

      setPartyPlayers(updatedPartyPlayers);
      setDuelHistory((prev) => [...prev, { ...summary, p1PlayerId: p1Id, p2PlayerId: p2Id }]);

      // Verifica vittoria del torneo party
      const maxWins = winnerPlayer ? winnerPlayer.wins + 1 : 0;
      if (settings.targetWins > 0 && maxWins >= settings.targetWins) {
        setWinnerId(winnerPlayer?.id || p1Id);
        setScreen('victory');
        return;
      }

      // Prossimo turno: ruota lo sfidante e bilancia l'avversario tra chi ha giocato meno duelli
      const nextChooser = getNextChallengerId(updatedPartyPlayers, p1Id);
      setChooserId(nextChooser);
      setSelectedOpponentId(getBalancedOpponentId(updatedPartyPlayers, nextChooser));

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

  const draftP1Score =
    settings.mode === 'party'
      ? partyPlayers.find((p) => p.id === activeDuelP1.id)?.wins ?? 0
      : p1Score;

  const draftP2Score =
    settings.mode === 'party'
      ? partyPlayers.find((p) => p.id === activeDuelP2.id)?.wins ?? 0
      : p2Score;

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
          hostNetworkReady={hostNetworkReady}
          p1RemoteConnected={p1RemoteConnected}
          p2RemoteConnected={p2RemoteConnected}
          remoteTranscriptPreview={remoteTranscriptPreview}
          remoteJoinNotice={remoteJoinNotice}
          onJoinRoom={handleJoinRemoteRoom}
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
          p1Score={draftP1Score}
          p2Score={draftP2Score}
          targetWins={settings.targetWins}
          chooserId={chooserId}
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
          initialPlayer={settings.mode === 'duel' ? chooserId : 'p1'}
          settings={settings}
          p1RemoteConnected={p1RemoteConnected}
          p2RemoteConnected={p2RemoteConnected}
          latestRemotePacket={latestRemotePacket}
          subscribeRemotePackets={subscribeRemotePackets}
          onSendRemoteState={handleSendRemoteState}
          onDuelFinished={handleDuelFinished}
          isDiscordActivity={isDiscord}
          roomCode={roomCode}
          p1ColorIndex={
            settings.mode === 'party'
              ? partyPlayers.find((p) => p.id === activeDuelP1.id)?.colorIndex
              : 0
          }
          p2ColorIndex={
            settings.mode === 'party'
              ? partyPlayers.find((p) => p.id === activeDuelP2.id)?.colorIndex
              : 1
          }
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
        categories={filterCategories(categories, settings.language, 'all')}
        language={settings.language}
        mode="browse"
        onClose={() => setGalleryOpen(false)}
      />
    </>
  );
};
