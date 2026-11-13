import React, { useState, useEffect, useRef } from 'react';
import { Mic, FastForward, Wifi, WifiOff, RefreshCw, ArrowLeft, Check } from 'lucide-react';
import {
  DiscordClientPeer,
  RemoteSlot,
  formatRoomTag,
} from '../engine/discordMicSync';
import { SmartSpeechRecognizer } from '../engine/speechRecognition';
import { APP_VERSION } from '../config/version';
import { AppLanguage, PlayerId, RemoteMicPacket } from '../types/game';

interface RemoteMicScreenProps {
  roomCode: string;
  slot?: RemoteSlot;
  onExitRoom?: () => void;
  onChangeSlot?: (slot: RemoteSlot) => void;
  isDiscordAutoJoined?: boolean;
}

function getSlotFromUrl(): RemoteSlot {
  if (typeof window === 'undefined') return 'p2';
  const raw = new URLSearchParams(window.location.search).get('slot');
  return raw === 'p1' ? 'p1' : 'p2';
}

function readDraftName(roomCode: string, slot: RemoteSlot): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const val = window.sessionStorage?.getItem(`yappik_remote_name_${roomCode}_${slot}`);
    return val && val.trim().length > 0 ? val : null;
  } catch {
    return null;
  }
}

function writeDraftName(roomCode: string, slot: RemoteSlot, name: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage?.setItem(`yappik_remote_name_${roomCode}_${slot}`, name);
  } catch {
    // Silenzioso in ambienti ristretti
  }
}

export const RemoteMicScreen: React.FC<RemoteMicScreenProps> = ({
  roomCode,
  slot: propSlot,
  onExitRoom,
  onChangeSlot,
  isDiscordAutoJoined = false,
}) => {
  const [slot, setSlot] = useState<RemoteSlot>(() => propSlot ?? getSlotFromUrl());
  useEffect(() => {
    if (propSlot && propSlot !== slot) {
      setSlot(propSlot);
    }
  }, [propSlot, slot]);

  const isP1Slot = slot === 'p1';
  const roomTag = formatRoomTag(roomCode);

  const initialSavedName = readDraftName(roomCode, slot);

  const [connStatus, setConnStatus] = useState<
    'connecting' | 'connected' | 'disconnected'
  >('connecting');
  const [statusMsg, setStatusMsg] = useState(
    `Collegamento alla stanza ${roomTag}...`
  );
  const [micActive, setMicActive] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState('');
  const [volume, setVolume] = useState(0);

  const [language, setLanguage] = useState<AppLanguage>('it');
  const [activePlayer, setActivePlayer] = useState<PlayerId>('p1');
  const [p1Name, setP1Name] = useState(() =>
    slot === 'p1' && initialSavedName ? initialSavedName : 'Giocatore 1'
  );
  const [p2Name, setP2Name] = useState(() =>
    slot === 'p2' && initialSavedName ? initialSavedName : 'Giocatore 2'
  );
  const [p1Avatar, setP1Avatar] = useState('🦊');
  const [p2Avatar, setP2Avatar] = useState('🐯');
  const [inDuel, setInDuel] = useState(false);
  const [categoryName, setCategoryName] = useState('In attesa del round...');
  const [timeLeftP1, setTimeLeftP1] = useState<number | null>(null);
  const [timeLeftP2, setTimeLeftP2] = useState<number | null>(null);

  const clientRef = useRef<DiscordClientPeer | null>(null);
  const recognizerRef = useRef<SmartSpeechRecognizer | null>(null);
  const activePlayerRef = useRef<PlayerId>('p1');
  const languageRef = useRef<AppLanguage>('it');
  const lastClearSeqRef = useRef<number>(0);
  const isEditingNameRef = useRef(false);
  const localNameEditedAtRef = useRef<number>(0);
  const hasLocalCustomNameRef = useRef<boolean>(Boolean(initialSavedName));
  const lastSyncedHostNameRef = useRef<string>('');
  const myNameRef = useRef<string>(
    initialSavedName || (slot === 'p1' ? 'Giocatore 1' : 'Giocatore 2')
  );
  const wakeLockRef = useRef<any>(null);

  myNameRef.current = isP1Slot ? p1Name : p2Name;

  const isIt = language === 'it';

  const handleSelectSlot = (nextSlot: RemoteSlot) => {
    if (inDuel || nextSlot === slot) return;
    setSlot(nextSlot);
    onChangeSlot?.(nextSlot);
    if (typeof window !== 'undefined') {
      try {
        const url = new URL(window.location.href);
        url.searchParams.set('room', roomCode);
        url.searchParams.set('slot', nextSlot);
        window.history.replaceState({}, '', url.toString());
      } catch {
        // Silenzioso
      }
    }
    const saved = readDraftName(roomCode, nextSlot);
    hasLocalCustomNameRef.current = Boolean(saved);
    localNameEditedAtRef.current = 0;
    lastSyncedHostNameRef.current = '';
    if (saved) {
      if (nextSlot === 'p1') setP1Name(saved);
      else setP2Name(saved);
    }
  };

  const releaseWakeLock = async () => {
    try {
      if (wakeLockRef.current) {
        await wakeLockRef.current.release();
        wakeLockRef.current = null;
      }
    } catch {
      wakeLockRef.current = null;
    }
  };

  const requestWakeLock = async () => {
    if (typeof navigator === 'undefined') return;
    const wakeLock = (navigator as any).wakeLock;
    if (!wakeLock?.request) return;
    try {
      wakeLockRef.current = await wakeLock.request('screen');
    } catch {
      // Silenzioso su browser non supportati
    }
  };

  useEffect(() => {
    const client = new DiscordClientPeer(
      roomCode,
      (packet: RemoteMicPacket) => {
        if (packet.type === 'STATE_UPDATE') {
          if (packet.language && packet.language !== languageRef.current) {
            languageRef.current = packet.language;
            setLanguage(packet.language);
            recognizerRef.current?.setLanguage(packet.language);
          }

          if (
            typeof packet.clearBufferSeq === 'number' &&
            packet.clearBufferSeq > lastClearSeqRef.current
          ) {
            lastClearSeqRef.current = packet.clearBufferSeq;
            setTranscript('');
            recognizerRef.current?.consumeCurrentBuffer();
          }

          if (packet.activePlayer) {
            if (packet.activePlayer !== activePlayerRef.current) {
              activePlayerRef.current = packet.activePlayer;
              setTranscript('');
              recognizerRef.current?.consumeCurrentBuffer();
            }
            setActivePlayer(packet.activePlayer);
          }

          const withinLocalEchoWindow =
            Date.now() - localNameEditedAtRef.current < 1500;

          if (typeof packet.p1Name === 'string') {
            if (!isP1Slot) {
              setP1Name(packet.p1Name);
            } else {
              const hostChanged = packet.p1Name !== lastSyncedHostNameRef.current;
              const matchesSelf = packet.p1Name === myNameRef.current;
              if (matchesSelf) {
                lastSyncedHostNameRef.current = packet.p1Name;
              } else if (
                !isEditingNameRef.current &&
                !withinLocalEchoWindow &&
                (!hasLocalCustomNameRef.current || hostChanged)
              ) {
                setP1Name(packet.p1Name);
                lastSyncedHostNameRef.current = packet.p1Name;
              }
            }
          }

          if (typeof packet.p2Name === 'string') {
            if (isP1Slot) {
              setP2Name(packet.p2Name);
            } else {
              const hostChanged = packet.p2Name !== lastSyncedHostNameRef.current;
              const matchesSelf = packet.p2Name === myNameRef.current;
              if (matchesSelf) {
                lastSyncedHostNameRef.current = packet.p2Name;
              } else if (
                !isEditingNameRef.current &&
                !withinLocalEchoWindow &&
                (!hasLocalCustomNameRef.current || hostChanged)
              ) {
                setP2Name(packet.p2Name);
                lastSyncedHostNameRef.current = packet.p2Name;
              }
            }
          }

          if (packet.p1Avatar) setP1Avatar(packet.p1Avatar);
          if (packet.p2Avatar) setP2Avatar(packet.p2Avatar);
          if (typeof packet.inDuel === 'boolean') setInDuel(packet.inDuel);
          if (packet.categoryName) setCategoryName(packet.categoryName);
          if (typeof packet.timeLeftP1 === 'number') setTimeLeftP1(packet.timeLeftP1);
          if (typeof packet.timeLeftP2 === 'number') setTimeLeftP2(packet.timeLeftP2);
        }
      },
      (status, msg) => {
        setConnStatus(status);
        if (msg) setStatusMsg(msg);
      },
      slot
    );
    clientRef.current = client;
    client.connect();

    const pingInterval = setInterval(() => {
      clientRef.current?.sendPacket({ type: 'PING', slot });
    }, 10000);

    const handlePageHide = () => {
      clientRef.current?.sendPacket({ type: 'BYE', slot });
    };
    window.addEventListener('pagehide', handlePageHide);

    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      clearInterval(pingInterval);
      recognizerRef.current?.stop();
      recognizerRef.current = null;
      releaseWakeLock();
      client.destroy();
    };
  }, [roomCode, slot, isP1Slot]);

  useEffect(() => {
    if (connStatus === 'connected' && hasLocalCustomNameRef.current) {
      const trimmed = myNameRef.current.trim();
      if (trimmed.length > 0) {
        clientRef.current?.sendPacket({
          type: 'PLAYER_UPDATE',
          slot,
          ...(isP1Slot ? { p1Name: trimmed } : { p2Name: trimmed }),
        });
      }
    }
  }, [connStatus, slot, isP1Slot]);

  useEffect(() => {
    if (!micActive) {
      releaseWakeLock();
      return;
    }
    requestWakeLock();

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && micActive) {
        requestWakeLock();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [micActive]);

  const toggleMicrophone = () => {
    if (micActive) {
      recognizerRef.current?.stop();
      recognizerRef.current = null;
      setMicActive(false);
      setVolume(0);
      return;
    }

    setMicError(null);
    const rec = new SmartSpeechRecognizer(
      (alternatives, isFinal) => {
        if (activePlayerRef.current !== slot) {
          return;
        }
        setTranscript(alternatives[0] || '');
        clientRef.current?.sendPacket({
          type: 'TRANSCRIPT',
          slot,
          transcript: alternatives[0],
          alternatives,
          isFinal,
        });
      },
      (listening, err) => {
        setMicActive(listening);
        if (err) setMicError(err);
      },
      (vol) => {
        setVolume(vol);
      },
      languageRef.current
    );
    recognizerRef.current = rec;
    rec.start();
  };

  const handleRemotePass = () => {
    if (!micActive || !inDuel || activePlayer !== slot) return;
    setTranscript('');
    recognizerRef.current?.consumeCurrentBuffer();
    clientRef.current?.sendPacket({ type: 'PASS_BUTTON', slot });
  };

  const handleManualReconnect = () => {
    clientRef.current?.connect();
  };

  const isMyTurn = activePlayer === slot;
  const myTimeLeft = isP1Slot ? timeLeftP1 : timeLeftP2;
  const myName = isP1Slot ? p1Name : p2Name;
  const otherName = isP1Slot ? p2Name : p1Name;

  return (
    <div className="min-h-[100dvh] w-full party-stage-bg flex flex-col items-center justify-between p-4 sm:p-6 text-center select-none overflow-y-auto">
      <header className="w-full max-w-md flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {onExitRoom && (
            <button
              type="button"
              onClick={onExitRoom}
              aria-label={isIt ? 'Esci dalla stanza' : 'Leave room'}
              className="btn-push px-2 py-1 rounded-xl bg-paper text-ink border-2 border-ink font-display font-black text-xs flex items-center gap-1 shadow-hard-sm"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>{isIt ? 'Lobby' : 'Lobby'}</span>
            </button>
          )}
          <span className="font-display font-black text-xl text-paper">
            Yappik
          </span>
          <span
            className={`px-2 py-0.5 rounded-lg border-2 border-ink font-display font-black text-[11px] shadow-hard-sm ${
              isP1Slot ? 'bg-blue text-paper' : 'bg-red text-paper'
            }`}
          >
            {slot.toUpperCase()}
          </span>
        </div>
        <span className="px-3 py-1 rounded-xl bg-paper text-ink border-[2.5px] border-ink font-display font-black text-xs shadow-hard-sm">
          {`${isIt ? 'Stanza' : 'Room'} ${roomTag}`}
        </span>
      </header>

      <main className="card-paper w-full max-w-md my-auto rounded-3xl p-5 sm:p-6 flex flex-col gap-4 my-4">
        <div
          className={`px-3.5 py-2.5 rounded-xl text-xs font-bold border-2 border-ink flex items-center justify-between gap-2 ${
            connStatus === 'connected'
              ? 'bg-green text-ink'
              : connStatus === 'connecting'
              ? 'bg-yellow text-ink'
              : 'bg-red text-paper'
          }`}
        >
          <div className="flex items-center gap-2 min-w-0 text-left">
            {connStatus === 'connected' ? (
              <Wifi className="w-4 h-4 shrink-0" />
            ) : (
              <WifiOff className="w-4 h-4 shrink-0" />
            )}
            <div className="flex flex-col min-w-0">
              <span className="truncate font-display font-black">
                {connStatus === 'connected'
                  ? isIt
                    ? `Sei nella stanza ${roomTag} (${isP1Slot ? 'Giocatore 1' : 'Giocatore 2'})`
                    : `In room ${roomTag} (${isP1Slot ? 'Player 1' : 'Player 2'})`
                  : statusMsg}
              </span>
              {isDiscordAutoJoined && (
                <span className="text-[10px] opacity-80 truncate">
                  {isIt
                    ? 'Collegato automaticamente all’attività Discord del canale'
                    : 'Auto-joined active Discord channel room'}
                </span>
              )}
            </div>
          </div>
          {connStatus !== 'connected' && (
            <button
              type="button"
              onClick={handleManualReconnect}
              className="shrink-0 px-2.5 py-1 rounded-lg bg-paper text-ink border-2 border-ink font-display font-black text-[11px] flex items-center gap-1"
            >
              <RefreshCw className="w-3 h-3" />
              <span>{isIt ? 'Riconnetti' : 'Reconnect'}</span>
            </button>
          )}
        </div>

        <div className="p-4 rounded-2xl bg-paper border-2 border-ink flex flex-col gap-2.5">
          {!inDuel && (
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => handleSelectSlot('p1')}
                className={`py-1.5 px-2 rounded-xl border-2 border-ink font-display font-black text-xs transition-all ${
                  isP1Slot
                    ? 'bg-blue text-paper shadow-hard-sm'
                    : 'bg-white text-ink/70 hover:text-ink'
                }`}
              >
                {isIt ? 'Giocatore 1 (G1)' : 'Player 1 (P1)'}
              </button>
              <button
                type="button"
                onClick={() => handleSelectSlot('p2')}
                className={`py-1.5 px-2 rounded-xl border-2 border-ink font-display font-black text-xs transition-all ${
                  !isP1Slot
                    ? 'bg-red text-paper shadow-hard-sm'
                    : 'bg-white text-ink/70 hover:text-ink'
                }`}
              >
                {isIt ? 'Giocatore 2 (G2)' : 'Player 2 (P2)'}
              </button>
            </div>
          )}

          <div className="flex items-center justify-center gap-2 text-xs font-display font-black text-ink">
            <span className="px-2 py-0.5 rounded-lg bg-blue/15 border border-ink/20 truncate max-w-[42%]">
              {p1Avatar} {p1Name || (isIt ? 'Giocatore 1' : 'Player 1')}
            </span>
            <span className="text-[10px] font-black text-ink/50">VS</span>
            <span className="px-2 py-0.5 rounded-lg bg-red/15 border border-ink/20 truncate max-w-[42%]">
              {p2Avatar} {p2Name || (isIt ? 'Giocatore 2' : 'Player 2')}
            </span>
          </div>

          <div className="font-display font-bold text-xl text-ink">
            {categoryName}
          </div>
          {myTimeLeft !== null && inDuel && (
            <div
              className={`font-mono font-extrabold text-4xl mt-1 ${
                isP1Slot ? 'text-blue' : 'text-red'
              }`}
            >
              {myTimeLeft.toFixed(1)}s
            </div>
          )}

          {!inDuel ? (
            <div className="mt-1 flex flex-col gap-1.5 text-left">
              <label
                htmlFor="remote-player-name-input"
                className="text-[11px] font-display font-bold uppercase tracking-wider text-ink/60 text-center"
              >
                {isIt ? 'Il tuo nome nella stanza' : 'Your name in room'}
              </label>
              <input
                id="remote-player-name-input"
                type="text"
                value={myName}
                maxLength={18}
                onFocus={() => {
                  isEditingNameRef.current = true;
                }}
                onBlur={() => {
                  isEditingNameRef.current = false;
                }}
                onChange={(e) => {
                  const next = e.target.value;
                  localNameEditedAtRef.current = Date.now();
                  hasLocalCustomNameRef.current = true;
                  writeDraftName(roomCode, slot, next);
                  if (isP1Slot) {
                    setP1Name(next);
                    clientRef.current?.sendPacket({
                      type: 'PLAYER_UPDATE',
                      slot: 'p1',
                      p1Name: next,
                    });
                  } else {
                    setP2Name(next);
                    clientRef.current?.sendPacket({
                      type: 'PLAYER_UPDATE',
                      slot: 'p2',
                      p2Name: next,
                    });
                  }
                }}
                placeholder={
                  isIt
                    ? `Nome Giocatore ${isP1Slot ? 1 : 2}...`
                    : `Player ${isP1Slot ? 1 : 2} Name...`
                }
                className="w-full bg-white text-ink border-2 border-ink rounded-xl px-3 py-2 font-display font-bold text-center text-sm focus:outline-none focus:ring-2 focus:ring-yellow shadow-hard-sm"
              />
              <p className="text-[11px] font-sans font-semibold text-ink/70 text-center flex items-center justify-center gap-1">
                {connStatus === 'connected' ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-green shrink-0" />
                    <span>
                      {isIt
                        ? `Sincronizzato nella stanza ${roomTag}`
                        : `Synced in room ${roomTag}`}
                    </span>
                  </>
                ) : (
                  <span>
                    {isIt
                      ? `Appena connesso invieremo il nome alla stanza ${roomTag}`
                      : `Will sync to room ${roomTag} once connected`}
                  </span>
                )}
              </p>
            </div>
          ) : (
            <div
              className={`mt-1 py-1.5 px-3 rounded-xl font-display font-bold text-xs border-2 border-ink ${
                isMyTurn
                  ? `${isP1Slot ? 'bg-blue' : 'bg-red'} text-paper animate-pulse`
                  : 'bg-paper text-ink/60'
              }`}
            >
              {isMyTurn
                ? isIt
                  ? 'Tocca a te parlare!'
                  : 'Your turn — speak!'
                : isIt
                ? `Turno di ${otherName || (isP1Slot ? 'Giocatore 2' : 'Giocatore 1')}`
                : `${otherName || (isP1Slot ? 'Player 2' : 'Player 1')}'s turn`}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={toggleMicrophone}
          className={`btn-push w-full py-5 rounded-2xl font-display font-bold text-lg flex flex-col items-center justify-center gap-2 ${
            micActive
              ? 'bg-green text-ink'
              : isP1Slot
              ? 'bg-blue text-paper'
              : 'bg-red text-paper'
          }`}
        >
          <Mic className="w-7 h-7" />
          <span>
            {micActive
              ? isIt
                ? 'Microfono attivo'
                : 'Microphone Active'
              : isIt
              ? 'Tocca per attivare il microfono'
              : 'Tap to Enable Microphone'}
          </span>
        </button>

        {micActive && (
          <div className="p-3 rounded-xl bg-paper border-2 border-ink/20 flex flex-col gap-2">
            <div className="w-full h-2.5 bg-ink/15 rounded-full overflow-hidden">
              <div
                className="h-full bg-green transition-all duration-75"
                style={{ width: `${Math.max(8, volume * 100)}%` }}
              />
            </div>
            <p className="font-display font-bold text-sm text-ink truncate">
              {transcript
                ? `“${transcript}”`
                : isIt
                ? 'Parla pure...'
                : 'Listening...'}
            </p>
          </div>
        )}

        {micError && <p className="text-xs text-red font-bold">{micError}</p>}

        <button
          type="button"
          onClick={handleRemotePass}
          disabled={!micActive || !inDuel || !isMyTurn}
          className={`btn-push w-full py-4 rounded-2xl font-display font-bold text-base flex items-center justify-center gap-2 ${
            !micActive || !inDuel || !isMyTurn
              ? 'bg-paper/60 text-ink/40'
              : 'bg-yellow text-ink'
          }`}
        >
          <FastForward className="w-5 h-5" />
          <span>{isIt ? 'Passo (-3s)' : 'Pass (-3s)'}</span>
        </button>
      </main>

      <footer className="text-xs text-paper/70 flex flex-col items-center gap-1 pb-2">
        <span>
          {isIt
            ? 'Guarda le foto sullo schermo principale!'
            : 'Watch the photos on the main screen!'}
        </span>
        <span className="font-mono text-[11px] text-paper/45">v{APP_VERSION}</span>
      </footer>
    </div>
  );
};
