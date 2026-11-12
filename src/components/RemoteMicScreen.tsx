import React, { useState, useEffect, useRef } from 'react';
import { Mic, FastForward, Wifi, WifiOff } from 'lucide-react';
import { DiscordClientPeer } from '../engine/discordMicSync';
import { SmartSpeechRecognizer } from '../engine/speechRecognition';
import { APP_VERSION } from '../config/version';
import { PlayerId, RemoteMicPacket } from '../types/game';

interface RemoteMicScreenProps {
  roomCode: string;
}

export const RemoteMicScreen: React.FC<RemoteMicScreenProps> = ({
  roomCode,
}) => {
  const [connStatus, setConnStatus] = useState<
    'connecting' | 'connected' | 'disconnected'
  >('connecting');
  const [statusMsg, setStatusMsg] = useState('Collegamento alla partita...');
  const [micActive, setMicActive] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState('');
  const [volume, setVolume] = useState(0);

  const [activePlayer, setActivePlayer] = useState<PlayerId>('p1');
  const [p2Name, setP2Name] = useState('Giocatore 2');
  const [categoryName, setCategoryName] = useState('In attesa del round...');
  const [timeLeftP2, setTimeLeftP2] = useState<number | null>(null);

  const clientRef = useRef<DiscordClientPeer | null>(null);
  const recognizerRef = useRef<SmartSpeechRecognizer | null>(null);
  const activePlayerRef = useRef<PlayerId>('p1');

  useEffect(() => {
    const client = new DiscordClientPeer(
      roomCode,
      (packet: RemoteMicPacket) => {
        if (packet.type === 'STATE_UPDATE') {
          if (packet.activePlayer) {
            if (packet.activePlayer !== activePlayerRef.current) {
              activePlayerRef.current = packet.activePlayer;
              setTranscript('');
              recognizerRef.current?.consumeCurrentBuffer();
            }
            setActivePlayer(packet.activePlayer);
          }
          if (packet.p2Name) setP2Name(packet.p2Name);
          if (packet.categoryName) setCategoryName(packet.categoryName);
          if (typeof packet.timeLeftP2 === 'number') {
            setTimeLeftP2(packet.timeLeftP2);
          }
        }
      },
      (status, msg) => {
        setConnStatus(status);
        if (msg) setStatusMsg(msg);
      }
    );
    clientRef.current = client;
    client.connect();

    return () => {
      recognizerRef.current?.stop();
      client.destroy();
    };
  }, [roomCode]);

  const toggleMicrophone = () => {
    if (micActive) {
      recognizerRef.current?.stop();
      setMicActive(false);
      setVolume(0);
      return;
    }

    setMicError(null);
    const rec = new SmartSpeechRecognizer(
      (alternatives, isFinal) => {
        if (activePlayerRef.current !== 'p2') {
          return;
        }
        setTranscript(alternatives[0] || '');
        clientRef.current?.sendPacket({
          type: 'TRANSCRIPT',
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
      }
    );
    recognizerRef.current = rec;
    rec.start();
  };

  const handleRemotePass = () => {
    clientRef.current?.sendPacket({ type: 'PASS_BUTTON' });
  };

  const isMyTurn = activePlayer === 'p2';

  return (
    <div className="h-[100dvh] max-h-[100dvh] w-full party-stage-bg flex flex-col items-center justify-between p-4 sm:p-6 text-center select-none overflow-hidden touch-none">
      <header className="w-full max-w-md flex items-center justify-between">
        <span className="font-display font-black text-xl text-paper">
          Yappik
        </span>
        <span className="px-3 py-1 rounded-xl bg-paper text-ink border-[2.5px] border-ink font-display font-black text-xs shadow-hard-sm">
          {roomCode.length > 8 ? `Stanza #${roomCode.slice(0, 6).toUpperCase()}` : `Stanza ${roomCode}`}
        </span>
      </header>

      <main className="card-cream w-full max-w-md my-auto rounded-3xl p-6 flex flex-col gap-5">
        <div
          className={`px-4 py-2 rounded-xl text-xs font-bold border-2 border-ink flex items-center justify-center gap-2 ${
            connStatus === 'connected'
              ? 'bg-mint text-ink'
              : connStatus === 'connecting'
              ? 'bg-gold text-ink'
              : 'bg-p2 text-white'
          }`}
        >
          {connStatus === 'connected' ? (
            <Wifi className="w-4 h-4" />
          ) : (
            <WifiOff className="w-4 h-4" />
          )}
          <span>{statusMsg}</span>
        </div>

        <div className="p-4 rounded-2xl bg-paper border-2 border-ink flex flex-col gap-1">
          <span className="text-xs font-bold text-ink/60">{p2Name}</span>
          <div className="font-display font-bold text-xl text-ink">
            {categoryName}
          </div>
          {timeLeftP2 !== null && (
            <div className="font-mono font-extrabold text-4xl text-p2 mt-1">
              {timeLeftP2.toFixed(1)}s
            </div>
          )}
          <div
            className={`mt-2 py-1.5 px-3 rounded-xl font-display font-bold text-xs border-2 border-ink ${
              isMyTurn ? 'bg-p2 text-white animate-pulse' : 'bg-white text-ink/60'
            }`}
          >
            {isMyTurn ? 'Tocca a te parlare!' : 'Turno dell’avversario'}
          </div>
        </div>

        <button
          onClick={toggleMicrophone}
          className={`btn-push w-full py-5 rounded-2xl font-display font-bold text-lg flex flex-col items-center justify-center gap-2 ${
            micActive ? 'bg-mint text-ink' : 'bg-p2 text-white'
          }`}
        >
          <Mic className="w-7 h-7" />
          <span>
            {micActive ? 'Microfono attivo' : 'Tocca per attivare il microfono'}
          </span>
        </button>

        {micActive && (
          <div className="p-3 rounded-xl bg-paper border border-ink/20 flex flex-col gap-2">
            <div className="w-full h-2.5 bg-ink/15 rounded-full overflow-hidden">
              <div
                className="h-full bg-mint transition-all duration-75"
                style={{ width: `${Math.max(8, volume * 100)}%` }}
              />
            </div>
            <p className="font-display font-bold text-sm text-ink truncate">
              {transcript ? `“${transcript}”` : 'Parla pure...'}
            </p>
          </div>
        )}

        {micError && <p className="text-xs text-p2 font-bold">{micError}</p>}

        <button
          onClick={handleRemotePass}
          disabled={!micActive}
          className="btn-push w-full py-4 rounded-2xl bg-gold text-ink font-display font-bold text-base flex items-center justify-center gap-2"
        >
          <FastForward className="w-5 h-5" />
          <span>Passo (-3s)</span>
        </button>
      </main>

      <footer className="text-xs text-cream/60 flex flex-col items-center gap-1">
        <span>Guarda le foto sullo schermo condiviso su Discord!</span>
        <span className="font-mono text-[11px] text-cream/40">v{APP_VERSION}</span>
      </footer>
    </div>
  );
};
