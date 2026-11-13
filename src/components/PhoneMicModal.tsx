import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { X, Smartphone, Wifi, Check, Copy } from 'lucide-react';
import { formatRoomTag } from '../engine/discordMicSync';
import { AppLanguage } from '../types/game';

interface PhoneMicModalProps {
  isOpen: boolean;
  onClose: () => void;
  roomCode: string;
  isConnected: boolean;
  p1Connected?: boolean;
  p2Connected?: boolean;
  p1Name?: string;
  p2Name?: string;
  language?: AppLanguage;
}

export const PhoneMicModal: React.FC<PhoneMicModalProps> = ({
  isOpen,
  onClose,
  roomCode,
  isConnected,
  p1Connected = false,
  p2Connected,
  p1Name = 'Giocatore 1',
  p2Name = 'Giocatore 2',
  language = 'it',
}) => {
  const [selectedSlot, setSelectedSlot] = useState<'p1' | 'p2'>('p2');
  const [qrSvg, setQrSvg] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isDiscordEmbed =
    typeof window !== 'undefined' &&
    window.location.hostname.toLowerCase().endsWith('.discordsays.com');
  const roomTag = formatRoomTag(roomCode);
  const baseUrl =
    typeof window !== 'undefined' && !isDiscordEmbed
      ? `${window.location.origin}${window.location.pathname}`
      : 'https://albertorosati.github.io/yappik/';
  const separator = baseUrl.includes('?') ? '&' : '?';
  const companionUrl = `${baseUrl}${separator}room=${encodeURIComponent(
    roomCode
  )}&slot=${selectedSlot}`;

  const effectiveP2Connected = p2Connected ?? isConnected;
  const selectedSlotConnected =
    selectedSlot === 'p1' ? p1Connected : effectiveP2Connected;

  useEffect(() => {
    if (!isOpen) return;
    let active = true;

    QRCode.toString(companionUrl, {
      type: 'svg',
      margin: 1,
      width: 220,
      color: {
        dark: '#14121F',
        light: '#FFFDF5',
      },
    })
      .then((svg) => {
        if (active) setQrSvg(svg);
      })
      .catch((err) => {
        console.error('Failed to generate QR code', err);
      });

    return () => {
      active = false;
    };
  }, [isOpen, companionUrl]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  if (!isOpen) return null;

  const handleCopy = async () => {
    let didCopy = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(companionUrl);
        didCopy = true;
      }
    } catch {
      didCopy = false;
    }

    if (!didCopy && typeof document !== 'undefined') {
      try {
        const textarea = document.createElement('textarea');
        textarea.value = companionUrl;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        didCopy = document.execCommand('copy');
        document.body.removeChild(textarea);
      } catch {
        didCopy = false;
      }
    }

    if (didCopy) {
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    }
  };

  const isIt = language === 'it';

  return (
    <div
      className="fixed inset-0 z-50 bg-[#14121F]/80 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="card-paper max-w-md w-full max-h-[92dvh] overflow-y-auto p-5 sm:p-6 relative flex flex-col items-center text-center modal-slap-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close Button */}
        <button
          type="button"
          onClick={onClose}
          className="sticky top-0 self-end -mb-8 z-10 p-2 rounded-xl bg-paper hover:bg-yellow border-[3px] border-ink shadow-hard-sm transition-transform active:translate-y-0.5"
          aria-label={isIt ? 'Chiudi' : 'Close'}
        >
          <X className="w-5 h-5 text-ink" />
        </button>

        {/* Modal Header */}
        <div className="w-12 h-12 rounded-2xl bg-yellow border-[3px] border-ink shadow-hard-sm flex items-center justify-center mb-2.5">
          <Smartphone className="w-6 h-6 text-ink" />
        </div>

        <h3 className="font-display font-black text-2xl text-ink leading-tight mb-1">
          {isIt ? 'Microfono Smartphone' : 'Smartphone Voice Remote'}
        </h3>
        <span className="mb-2 px-3 py-0.5 rounded-full bg-paper border-2 border-ink font-display font-black text-[11px] text-ink shadow-hard-sm">
          {isIt ? `Stanza ${roomTag}` : `Room ${roomTag}`}
        </span>
        <p className="font-sans font-semibold text-xs sm:text-sm text-ink/75 max-w-xs mb-3">
          {isIt
            ? 'Scegli lo slot e inquadra il QR con il telefono per usare il microfono wireless!'
            : 'Choose player slot and scan the QR with your phone to use its wireless mic!'}
        </p>

        {/* Slot Selector P1 / P2 */}
        <div className="w-full grid grid-cols-2 gap-2 mb-3">
          <button
            type="button"
            onClick={() => {
              setSelectedSlot('p1');
              setCopied(false);
            }}
            className={`py-2 px-2.5 rounded-xl border-[2.5px] border-ink font-display font-black text-xs flex items-center justify-center gap-1.5 transition-all ${
              selectedSlot === 'p1'
                ? 'bg-blue text-paper shadow-hard-sm'
                : 'bg-paper text-ink/70 hover:text-ink'
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full border border-ink ${
                p1Connected ? 'bg-green' : 'bg-paper/40'
              }`}
            />
            <span className="truncate">{p1Name || (isIt ? 'Giocatore 1' : 'Player 1')}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setSelectedSlot('p2');
              setCopied(false);
            }}
            className={`py-2 px-2.5 rounded-xl border-[2.5px] border-ink font-display font-black text-xs flex items-center justify-center gap-1.5 transition-all ${
              selectedSlot === 'p2'
                ? 'bg-red text-paper shadow-hard-sm'
                : 'bg-paper text-ink/70 hover:text-ink'
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full border border-ink ${
                effectiveP2Connected ? 'bg-green' : 'bg-paper/40'
              }`}
            />
            <span className="truncate">{p2Name || (isIt ? 'Giocatore 2' : 'Player 2')}</span>
          </button>
        </div>

        {/* Live Status Pill */}
        <div
          className={`px-3.5 py-1.5 rounded-full border-[2px] border-ink text-xs font-display font-bold flex items-center gap-1.5 mb-3 shadow-hard-sm ${
            selectedSlotConnected ? 'bg-green text-ink' : 'bg-yellow text-ink'
          }`}
        >
          <Wifi className="w-3.5 h-3.5" />
          <span>
            {selectedSlotConnected
              ? isIt
                ? `${selectedSlot.toUpperCase()} Connesso • Voce attiva`
                : `${selectedSlot.toUpperCase()} Connected • Voice Active`
              : isIt
              ? `In attesa telefono ${selectedSlot.toUpperCase()}...`
              : `Waiting for ${selectedSlot.toUpperCase()} phone...`}
          </span>
        </div>

        {/* QR Code Container */}
        <div className="p-2.5 bg-paper border-[3px] border-ink rounded-2xl shadow-hard mb-3 flex items-center justify-center">
          {qrSvg ? (
            <div
              className="w-[180px] h-[180px] sm:w-[200px] sm:h-[200px] flex items-center justify-center select-none"
              dangerouslySetInnerHTML={{ __html: qrSvg }}
            />
          ) : (
            <div className="w-[180px] h-[180px] sm:w-[200px] sm:h-[200px] flex items-center justify-center text-xs font-bold text-ink/50">
              {isIt ? 'Generazione QR...' : 'Generating QR...'}
            </div>
          )}
        </div>

        {/* How it works steps */}
        <div className="w-full bg-[#1B1B3A]/5 rounded-xl p-3 border-[2px] border-ink/20 text-left mb-4">
          <ol className="text-xs font-sans font-medium text-ink/80 space-y-1 list-decimal list-inside">
            <li>
              {isIt
                ? 'Apri la fotocamera del telefono (Safari o Chrome).'
                : 'Open your phone camera (Safari or Chrome).'}
            </li>
            <li>
              {isIt
                ? 'Tocca il link e attiva il microfono sul telefono.'
                : 'Tap the link banner and turn on the phone mic.'}
            </li>
            <li>
              {isIt
                ? 'Quando è il tuo turno, parla al telefono per rispondere!'
                : 'On your turn, speak into your phone to answer!'}
            </li>
          </ol>
        </div>

        {/* Action Buttons: Copy link & Done */}
        <div className="w-full flex items-center gap-2">
          <button
            type="button"
            onClick={handleCopy}
            className="flex-1 btn-push py-2.5 px-3 rounded-xl bg-paper text-ink font-display font-bold text-xs flex items-center justify-center gap-1.5"
          >
            {copied ? (
              <>
                <Check className="w-4 h-4 text-green" />
                <span>{isIt ? 'Copiato!' : 'Copied!'}</span>
              </>
            ) : (
              <>
                <Copy className="w-4 h-4" />
                <span>{isIt ? 'Copia Link' : 'Copy Link'}</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={onClose}
            className="flex-1 btn-push py-2.5 px-3 rounded-xl bg-yellow text-ink font-display font-black text-xs"
          >
            {isIt ? 'Chiudi' : 'Done'}
          </button>
        </div>
      </div>
    </div>
  );
};
