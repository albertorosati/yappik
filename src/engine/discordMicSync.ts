import Peer, { DataConnection } from 'peerjs';
import { RemoteMicPacket } from '../types/game';
import { MqttRoomRelay } from './mqttRoomRelay';

const PEER_PREFIX = 'yapk-';

export type RemoteSlot = 'p1' | 'p2';

const ICE_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
  sdpSemantics: 'unified-plan',
} as RTCConfiguration;

const WEBRTC_HANDSHAKE_TIMEOUT_MS = 7500;
const RELAY_SLOT_TTL_MS = 28000;

interface RelayEnvelope {
  v: 1;
  from: 'host' | 'client';
  senderId: string;
  seq: number;
  targetSlot?: RemoteSlot;
  slot?: RemoteSlot;
  packet: RemoteMicPacket;
}

function makeSenderId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function generateRoomCode(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function formatRoomTag(roomCode: string): string {
  const cleaned = (roomCode || '').trim();
  if (!cleaned) return '#---';
  if (cleaned.length > 16) {
    return `#${cleaned.slice(0, 6).toUpperCase()}`;
  }
  return `#${cleaned.toUpperCase()}`;
}

export function parseRoomInput(
  rawInput: string
): { roomCode: string; slot?: RemoteSlot } | null {
  const trimmed = (rawInput || '').trim();
  if (!trimmed) return null;

  try {
    const hasQuery = trimmed.includes('?') || /^https?:\/\//i.test(trimmed);
    if (hasQuery) {
      const dummyBase = 'https://yappik.local/';
      const url = /^https?:\/\//i.test(trimmed)
        ? new URL(trimmed)
        : new URL(trimmed.startsWith('?') ? trimmed : `?${trimmed}`, dummyBase);
      const roomParam = url.searchParams.get('room')?.trim();
      const slotParam = url.searchParams.get('slot');
      if (roomParam) {
        return {
          roomCode: roomParam,
          slot: slotParam === 'p1' || slotParam === 'p2' ? slotParam : undefined,
        };
      }
    }
  } catch {
    // Fallback al codice diretto
  }

  const normalized = trimmed.replace(/^#/, '').trim();
  if (!normalized || /\s/.test(normalized)) return null;
  return { roomCode: normalized };
}

export class DiscordHostPeer {
  private peer: Peer | null = null;
  private peerOpen = false;
  private connections: Partial<Record<RemoteSlot, DataConnection>> = {};
  private relay: MqttRoomRelay | null = null;
  private relaySlots: Partial<Record<RemoteSlot, number>> = {};
  private relaySeq = 1;
  private readonly senderId = makeSenderId();
  public readonly roomCode: string;
  private onPacket: (packet: RemoteMicPacket) => void;
  private onConnectionChange: (
    connected: boolean,
    peerInfo?: string,
    slot?: RemoteSlot
  ) => void;
  private onError?: (errType: string, message: string) => void;
  private onReadyChange?: (ready: boolean) => void;
  private destroyed = false;
  private lastReadyState = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private windowListenersCleanup: (() => void) | null = null;

  constructor(
    roomCode: string,
    onPacket: (packet: RemoteMicPacket) => void,
    onConnectionChange: (
      connected: boolean,
      peerInfo?: string,
      slot?: RemoteSlot
    ) => void,
    onError?: (errType: string, message: string) => void,
    onReadyChange?: (ready: boolean) => void
  ) {
    this.roomCode = roomCode.trim().toLowerCase();
    this.onPacket = onPacket;
    this.onConnectionChange = onConnectionChange;
    this.onError = onError;
    this.onReadyChange = onReadyChange;
  }

  private updateReadyState(): void {
    const ready = Boolean(this.peerOpen || this.relay?.isReady());
    if (ready !== this.lastReadyState) {
      this.lastReadyState = ready;
      this.onReadyChange?.(ready);
    }
  }

  public isReady(): boolean {
    return this.lastReadyState;
  }

  public start(): void {
    this.destroy();
    this.destroyed = false;
    this.peerOpen = false;
    this.lastReadyState = false;

    const peerId = `${PEER_PREFIX}${this.roomCode}`;
    const peer = new Peer(peerId, { config: ICE_CONFIG });
    this.peer = peer;

    peer.on('open', () => {
      if (this.destroyed || this.peer !== peer) return;
      this.peerOpen = true;
      this.updateReadyState();
    });

    peer.on('connection', (conn) => {
      const metaSlot = conn.metadata?.slot;
      let activeSlot: RemoteSlot =
        metaSlot === 'p1' || metaSlot === 'p2' ? metaSlot : 'p2';

      const prev = this.connections[activeSlot];
      if (prev && prev !== conn) {
        try {
          prev.close();
        } catch {
          // Ignora
        }
      }
      this.connections[activeSlot] = conn;

      conn.on('open', () => {
        if (this.connections[activeSlot] !== conn) return;
        delete this.relaySlots[activeSlot];
        this.onConnectionChange(
          true,
          activeSlot === 'p1' ? 'Giocatore 1 Connesso' : 'Giocatore 2 Connesso',
          activeSlot
        );
      });

      conn.on('data', (data) => {
        if (data && typeof data === 'object' && 'type' in data) {
          const pkt = data as RemoteMicPacket;
          if (pkt.type === 'BYE') {
            const target = pkt.slot === 'p1' || pkt.slot === 'p2' ? pkt.slot : activeSlot;
            if (this.connections[target] === conn) {
              delete this.connections[target];
            }
            delete this.relaySlots[target];
            this.onConnectionChange(false, undefined, target);
            return;
          }
          if ((pkt.slot === 'p1' || pkt.slot === 'p2') && pkt.slot !== activeSlot) {
            if (this.connections[activeSlot] === conn) {
              delete this.connections[activeSlot];
              if (!this.relaySlots[activeSlot]) {
                this.onConnectionChange(false, undefined, activeSlot);
              }
            }
            activeSlot = pkt.slot;
            const existing = this.connections[activeSlot];
            if (existing && existing !== conn) {
              try {
                existing.close();
              } catch {
                // Ignora
              }
            }
            this.connections[activeSlot] = conn;
            this.onConnectionChange(
              true,
              activeSlot === 'p1' ? 'Giocatore 1 Connesso' : 'Giocatore 2 Connesso',
              activeSlot
            );
          }
          this.onPacket({ ...pkt, slot: pkt.slot ?? activeSlot });
        }
      });

      conn.on('close', () => {
        if (this.connections[activeSlot] === conn) {
          delete this.connections[activeSlot];
          if (!this.relaySlots[activeSlot]) {
            this.onConnectionChange(false, undefined, activeSlot);
          }
        }
      });

      conn.on('error', () => {
        if (this.connections[activeSlot] === conn) {
          delete this.connections[activeSlot];
          if (!this.relaySlots[activeSlot]) {
            this.onConnectionChange(false, undefined, activeSlot);
          }
        }
      });
    });

    peer.on('disconnected', () => {
      this.peerOpen = false;
      this.updateReadyState();
      if (this.destroyed || !this.peer || this.peer.destroyed) return;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        if (!this.destroyed && this.peer && !this.peer.destroyed && this.peer.disconnected) {
          try {
            this.peer.reconnect();
          } catch {
            // Ignora
          }
        }
      }, 1000);
    });

    peer.on('error', (err) => {
      console.warn('PeerJS Host warning:', err);
      if (err.type === 'unavailable-id') {
        this.peerOpen = false;
        this.updateReadyState();
      }
      this.onError?.(err.type || 'unknown', err.message || String(err));
    });

    // Dual-transport WebSocket relay fallback for mobile CGNAT / symmetric NAT
    if (typeof WebSocket === 'function') {
      const relay = new MqttRoomRelay(
        `yappik/v1/${this.roomCode}/to-host`,
        `yappik/v1/${this.roomCode}/to-client`,
        (raw) => this.handleRelayMessage(raw),
        () => this.updateReadyState()
      );
      this.relay = relay;
      relay.start();

      this.watchdogTimer = setInterval(() => {
        const now = Date.now();
        (['p1', 'p2'] as RemoteSlot[]).forEach((slot) => {
          const seenAt = this.relaySlots[slot];
          if (seenAt && now - seenAt > RELAY_SLOT_TTL_MS && !this.connections[slot]?.open) {
            delete this.relaySlots[slot];
            this.onConnectionChange(false, undefined, slot);
          }
        });
      }, 6000);
    }

    if (typeof window !== 'undefined') {
      const handleWake = () => {
        if (this.destroyed) return;
        this.relay?.reconnectNow();
        if (this.peer && !this.peer.destroyed && this.peer.disconnected) {
          try {
            this.peer.reconnect();
          } catch {
            // Ignora
          }
        }
      };
      const onVis = () => {
        if (document.visibilityState === 'visible') handleWake();
      };
      window.addEventListener('online', handleWake);
      document.addEventListener('visibilitychange', onVis);
      this.windowListenersCleanup = () => {
        window.removeEventListener('online', handleWake);
        document.removeEventListener('visibilitychange', onVis);
      };
    }
  }

  private handleRelayMessage(raw: unknown): void {
    if (this.destroyed || !raw || typeof raw !== 'object') return;
    const env = raw as Partial<RelayEnvelope>;
    if (env.v !== 1 || env.from !== 'client' || !env.packet || typeof env.packet !== 'object') {
      return;
    }
    const pkt = env.packet as RemoteMicPacket;
    if (!pkt.type) return;

    const slot: RemoteSlot =
      pkt.slot === 'p1' || pkt.slot === 'p2'
        ? pkt.slot
        : env.slot === 'p1' || env.slot === 'p2'
        ? env.slot
        : 'p2';

    if (pkt.type === 'BYE') {
      const hadRelay = Boolean(this.relaySlots[slot]);
      delete this.relaySlots[slot];
      if (hadRelay && !this.connections[slot]?.open) {
        this.onConnectionChange(false, undefined, slot);
      }
      return;
    }

    const wasConnected = this.isSlotConnected(slot);
    this.relaySlots[slot] = Date.now();
    if (!wasConnected) {
      this.onConnectionChange(
        true,
        slot === 'p1' ? 'Giocatore 1 Connesso' : 'Giocatore 2 Connesso',
        slot
      );
    }

    this.onPacket({ ...pkt, slot });
  }

  public isSlotConnected(slot: RemoteSlot): boolean {
    return Boolean(this.connections[slot]?.open || this.relaySlots[slot]);
  }

  private sendViaRelay(packet: RemoteMicPacket, targetSlot?: RemoteSlot): void {
    if (!this.relay?.isReady()) return;
    const envelope: RelayEnvelope = {
      v: 1,
      from: 'host',
      senderId: this.senderId,
      seq: this.relaySeq++,
      ...(targetSlot ? { targetSlot } : {}),
      packet,
    };
    this.relay.send(envelope);
  }

  public sendState(packet: RemoteMicPacket, targetSlot?: RemoteSlot): void {
    const enriched: RemoteMicPacket = {
      ...packet,
      p1Connected: this.isSlotConnected('p1'),
      p2Connected: this.isSlotConnected('p2'),
    };

    if (targetSlot) {
      const conn = this.connections[targetSlot];
      if (conn && conn.open) {
        try {
          conn.send(enriched);
          return;
        } catch {
          // Fallback al relay sotto
        }
      }
      this.sendViaRelay(enriched, targetSlot);
      return;
    }

    let sentRelayBroadcast = false;
    (['p1', 'p2'] as RemoteSlot[]).forEach((slot) => {
      const conn = this.connections[slot];
      if (conn && conn.open) {
        try {
          conn.send(enriched);
          return;
        } catch {
          // Fallback al relay
        }
      }
      if (this.relaySlots[slot] && !sentRelayBroadcast) {
        sentRelayBroadcast = true;
        this.sendViaRelay(enriched, slot);
      } else if (this.relaySlots[slot]) {
        this.sendViaRelay(enriched, slot);
      }
    });
  }

  public destroy(): void {
    this.destroyed = true;
    this.peerOpen = false;
    this.lastReadyState = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.windowListenersCleanup) {
      this.windowListenersCleanup();
      this.windowListenersCleanup = null;
    }
    this.relaySlots = {};
    if (this.relay) {
      this.relay.destroy();
      this.relay = null;
    }
    (['p1', 'p2'] as RemoteSlot[]).forEach((slot) => {
      const conn = this.connections[slot];
      if (conn) {
        try {
          conn.close();
        } catch {
          // Ignora
        }
        delete this.connections[slot];
      }
    });
    if (this.peer) {
      try {
        this.peer.destroy();
      } catch {
        // Ignora
      }
      this.peer = null;
    }
  }
}

export class DiscordClientPeer {
  private peer: Peer | null = null;
  private connection: DataConnection | null = null;
  private relay: MqttRoomRelay | null = null;
  private relayConnected = false;
  private webrtcConnected = false;
  private relaySeq = 1;
  private readonly senderId = makeSenderId();
  private roomCode: string;
  public readonly slot: RemoteSlot;
  private onStatePacket: (packet: RemoteMicPacket) => void;
  private onStatusChange: (
    status: 'connecting' | 'connected' | 'disconnected',
    msg?: string
  ) => void;
  private destroyed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private relayPingTimer: ReturnType<typeof setInterval> | null = null;
  private windowListenersCleanup: (() => void) | null = null;
  private retryCount = 0;
  private readonly maxAutoRetries = 10;

  constructor(
    roomCode: string,
    onStatePacket: (packet: RemoteMicPacket) => void,
    onStatusChange: (
      status: 'connecting' | 'connected' | 'disconnected',
      msg?: string
    ) => void,
    slot: RemoteSlot = 'p2'
  ) {
    this.roomCode = roomCode.trim().toLowerCase();
    this.onStatePacket = onStatePacket;
    this.onStatusChange = onStatusChange;
    this.slot = slot;
  }

  private getConnectedText(): string {
    const roomTag = formatRoomTag(this.roomCode);
    const slotLabel = this.slot === 'p1' ? 'Giocatore 1' : 'Giocatore 2';
    return `Sei nella stanza ${roomTag} (${slotLabel})`;
  }

  private isAnyTransportConnected(): boolean {
    return this.webrtcConnected || this.relayConnected;
  }

  public connect(): void {
    this.destroyed = false;
    this.retryCount = 0;
    this.relayConnected = false;
    this.webrtcConnected = false;
    this.startRelay();
    this.openWebRtcSession();
    this.attachWindowListeners();
  }

  private attachWindowListeners(): void {
    if (this.windowListenersCleanup || typeof window === 'undefined') return;
    const wake = () => {
      if (this.destroyed) return;
      this.relay?.reconnectNow();
      if (!this.webrtcConnected && !this.connection?.open) {
        this.retryCount = 0;
        this.openWebRtcSession();
      }
      if (this.relay?.isReady()) {
        this.sendViaRelay({ type: 'PING', slot: this.slot });
      }
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') wake();
    };
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', onVis);
    this.windowListenersCleanup = () => {
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', onVis);
    };
  }

  private startRelay(): void {
    if (this.relay || typeof WebSocket !== 'function') return;
    const relay = new MqttRoomRelay(
      `yappik/v1/${this.roomCode}/to-client`,
      `yappik/v1/${this.roomCode}/to-host`,
      (raw) => this.handleRelayMessage(raw),
      (ready) => {
        if (ready && !this.destroyed) {
          this.sendViaRelay({ type: 'PING', slot: this.slot });
        }
      }
    );
    this.relay = relay;
    relay.start();

    if (this.relayPingTimer) clearInterval(this.relayPingTimer);
    this.relayPingTimer = setInterval(() => {
      if (this.destroyed) return;
      if (!this.isAnyTransportConnected() && this.relay?.isReady()) {
        this.sendViaRelay({ type: 'PING', slot: this.slot });
      }
    }, 1500);
  }

  private handleRelayMessage(raw: unknown): void {
    if (this.destroyed || !raw || typeof raw !== 'object') return;
    const env = raw as Partial<RelayEnvelope>;
    if (env.v !== 1 || env.from !== 'host' || !env.packet || typeof env.packet !== 'object') {
      return;
    }
    if (env.targetSlot && env.targetSlot !== this.slot) {
      return;
    }

    const pkt = env.packet as RemoteMicPacket;
    if (!pkt.type) return;

    const firstConfirm = !this.relayConnected;
    this.relayConnected = true;
    this.retryCount = 0;

    if (firstConfirm) {
      if (this.handshakeTimer) {
        clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
      }
      this.onStatusChange('connected', this.getConnectedText());
    }

    // Evita doppia elaborazione se WebRTC diretto è già aperto
    if (!this.webrtcConnected) {
      this.onStatePacket(pkt);
    }
  }

  private sendViaRelay(packet: RemoteMicPacket): boolean {
    if (!this.relay?.isReady()) return false;
    const envelope: RelayEnvelope = {
      v: 1,
      from: 'client',
      senderId: this.senderId,
      seq: this.relaySeq++,
      slot: this.slot,
      packet: {
        ...packet,
        slot: packet.slot ?? this.slot,
      },
    };
    return this.relay.send(envelope);
  }

  private scheduleRetry(reason: string): void {
    if (this.destroyed) return;
    if (this.isAnyTransportConnected()) return;

    if (this.retryCount >= this.maxAutoRetries) {
      this.onStatusChange('disconnected', `${reason} (tocca Riconnetti per riprovare)`);
      return;
    }
    this.retryCount += 1;
    const delayMs = Math.min(5000, 900 * Math.pow(1.6, this.retryCount - 1));
    this.onStatusChange(
      'connecting',
      `${reason} Ricerca stanza (${this.retryCount}/${this.maxAutoRetries})...`
    );
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.destroyed && !this.isAnyTransportConnected()) {
        this.openWebRtcSession();
      }
    }, delayMs);
  }

  private openWebRtcSession(): void {
    this.cleanupWebRtc();
    const roomTag = formatRoomTag(this.roomCode);
    if (!this.isAnyTransportConnected()) {
      this.onStatusChange(
        'connecting',
        `Connessione alla stanza ${roomTag} (${this.slot.toUpperCase()})...`
      );
    }

    const peer = new Peer({ config: ICE_CONFIG });
    this.peer = peer;

    this.handshakeTimer = setTimeout(() => {
      if (this.destroyed || this.peer !== peer || this.webrtcConnected) return;
      // If WebRTC ICE stalls (e.g. mobile CGNAT), keep relay running or retry cleanly
      this.cleanupWebRtc();
      if (!this.isAnyTransportConnected()) {
        this.scheduleRetry(`Timeout P2P su stanza ${roomTag}.`);
      }
    }, WEBRTC_HANDSHAKE_TIMEOUT_MS);

    peer.on('open', () => {
      if (this.destroyed || this.peer !== peer) return;
      const targetId = `${PEER_PREFIX}${this.roomCode}`;
      const conn = peer.connect(targetId, {
        reliable: true,
        serialization: 'json',
        metadata: { slot: this.slot },
      });
      this.connection = conn;

      // Fast detection when WebRTC ICE enters failed state
      const pc = (conn as unknown as { peerConnection?: RTCPeerConnection }).peerConnection;
      if (pc && typeof pc.addEventListener === 'function') {
        pc.addEventListener('iceconnectionstatechange', () => {
          if (
            pc.iceConnectionState === 'failed' &&
            this.connection === conn &&
            !this.webrtcConnected &&
            !this.destroyed
          ) {
            this.cleanupWebRtc();
            if (!this.isAnyTransportConnected()) {
              this.scheduleRetry(`Rete P2P bloccata (${roomTag}).`);
            }
          }
        });
      }

      conn.on('open', () => {
        if (this.connection !== conn || this.destroyed) return;
        if (this.handshakeTimer) {
          clearTimeout(this.handshakeTimer);
          this.handshakeTimer = null;
        }
        this.retryCount = 0;
        this.webrtcConnected = true;
        this.sendPacket({ type: 'PING', slot: this.slot });
        this.onStatusChange('connected', this.getConnectedText());
      });

      conn.on('data', (data) => {
        if (data && typeof data === 'object' && 'type' in data) {
          this.onStatePacket(data as RemoteMicPacket);
        }
      });

      conn.on('close', () => {
        if (this.connection === conn) {
          this.connection = null;
          this.webrtcConnected = false;
          if (!this.destroyed && !this.isAnyTransportConnected()) {
            this.scheduleRetry("Connessione chiusa dall'host.");
          }
        }
      });

      conn.on('error', () => {
        if (this.connection === conn) {
          this.connection = null;
          this.webrtcConnected = false;
          if (!this.destroyed && !this.isAnyTransportConnected()) {
            this.scheduleRetry('Errore di comunicazione P2P.');
          }
        }
      });
    });

    peer.on('disconnected', () => {
      if (this.destroyed || this.peer !== peer || peer.destroyed) return;
      try {
        peer.reconnect();
      } catch {
        if (!this.isAnyTransportConnected()) {
          this.scheduleRetry('Segnale P2P perso.');
        }
      }
    });

    peer.on('error', (err) => {
      if (this.destroyed || this.peer !== peer) return;
      if (this.handshakeTimer) {
        clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
      }
      if (this.isAnyTransportConnected()) return;

      const recoverable =
        err.type === 'peer-unavailable' ||
        err.type === 'network' ||
        err.type === 'server-error' ||
        err.type === 'socket-error' ||
        err.type === 'socket-closed' ||
        err.type === 'webrtc';
      if (recoverable) {
        this.scheduleRetry(`Stanza non ancora pronta (${err.type}).`);
      } else {
        this.onStatusChange('disconnected', `Errore P2P (${err.type}).`);
      }
    });
  }

  public sendPacket(packet: RemoteMicPacket): void {
    const payload: RemoteMicPacket = {
      ...packet,
      slot: packet.slot ?? this.slot,
    };
    if (this.connection && this.connection.open) {
      try {
        this.connection.send(payload);
        return;
      } catch {
        // Fallback al relay sotto
      }
    }
    this.sendViaRelay(payload);
  }

  private cleanupWebRtc(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    this.webrtcConnected = false;
    if (this.connection) {
      try {
        this.connection.close();
      } catch {
        // Ignora
      }
      this.connection = null;
    }
    if (this.peer) {
      try {
        this.peer.destroy();
      } catch {
        // Ignora
      }
      this.peer = null;
    }
  }

  public destroy(): void {
    this.destroyed = true;
    try {
      this.sendPacket({ type: 'BYE', slot: this.slot });
    } catch {
      // Ignora
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.relayPingTimer) {
      clearInterval(this.relayPingTimer);
      this.relayPingTimer = null;
    }
    if (this.windowListenersCleanup) {
      this.windowListenersCleanup();
      this.windowListenersCleanup = null;
    }
    this.relayConnected = false;
    if (this.relay) {
      this.relay.destroy();
      this.relay = null;
    }
    this.cleanupWebRtc();
  }
}
