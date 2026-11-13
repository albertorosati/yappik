import Peer, { DataConnection } from 'peerjs';
import { RemoteMicPacket } from '../types/game';

const PEER_PREFIX = 'yapk-';

export type RemoteSlot = 'p1' | 'p2';

const ICE_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
};

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
  private connections: Partial<Record<RemoteSlot, DataConnection>> = {};
  public readonly roomCode: string;
  private onPacket: (packet: RemoteMicPacket) => void;
  private onConnectionChange: (
    connected: boolean,
    peerInfo?: string,
    slot?: RemoteSlot
  ) => void;
  private onError?: (errType: string, message: string) => void;
  private destroyed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    roomCode: string,
    onPacket: (packet: RemoteMicPacket) => void,
    onConnectionChange: (
      connected: boolean,
      peerInfo?: string,
      slot?: RemoteSlot
    ) => void,
    onError?: (errType: string, message: string) => void
  ) {
    this.roomCode = roomCode.trim().toLowerCase();
    this.onPacket = onPacket;
    this.onConnectionChange = onConnectionChange;
    this.onError = onError;
  }

  public start(): void {
    this.destroy();
    this.destroyed = false;
    const peerId = `${PEER_PREFIX}${this.roomCode}`;
    const peer = new Peer(peerId, { config: ICE_CONFIG });
    this.peer = peer;

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
        this.onConnectionChange(
          true,
          activeSlot === 'p1' ? 'Giocatore 1 Connesso' : 'Giocatore 2 Connesso',
          activeSlot
        );
      });

      conn.on('data', (data) => {
        if (data && typeof data === 'object' && 'type' in data) {
          const pkt = data as RemoteMicPacket;
          if ((pkt.slot === 'p1' || pkt.slot === 'p2') && pkt.slot !== activeSlot) {
            if (this.connections[activeSlot] === conn) {
              delete this.connections[activeSlot];
              this.onConnectionChange(false, undefined, activeSlot);
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
          this.onConnectionChange(false, undefined, activeSlot);
        }
      });

      conn.on('error', () => {
        if (this.connections[activeSlot] === conn) {
          delete this.connections[activeSlot];
          this.onConnectionChange(false, undefined, activeSlot);
        }
      });
    });

    peer.on('disconnected', () => {
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
      this.onError?.(err.type || 'unknown', err.message || String(err));
    });
  }

  public isSlotConnected(slot: RemoteSlot): boolean {
    return Boolean(this.connections[slot]?.open);
  }

  public sendState(packet: RemoteMicPacket, targetSlot?: RemoteSlot): void {
    const enriched: RemoteMicPacket = {
      ...packet,
      p1Connected: Boolean(this.connections.p1?.open),
      p2Connected: Boolean(this.connections.p2?.open),
    };

    if (targetSlot) {
      const conn = this.connections[targetSlot];
      if (conn && conn.open) {
        try {
          conn.send(enriched);
        } catch {
          // Ignora
        }
      }
      return;
    }

    (['p1', 'p2'] as RemoteSlot[]).forEach((slot) => {
      const conn = this.connections[slot];
      if (conn && conn.open) {
        try {
          conn.send(enriched);
        } catch {
          // Ignora
        }
      }
    });
  }

  public destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
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
  private roomCode: string;
  public readonly slot: RemoteSlot;
  private onStatePacket: (packet: RemoteMicPacket) => void;
  private onStatusChange: (
    status: 'connecting' | 'connected' | 'disconnected',
    msg?: string
  ) => void;
  private destroyed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;
  private readonly maxAutoRetries = 5;

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

  public connect(): void {
    this.retryCount = 0;
    this.openConnectionSession();
  }

  private scheduleRetry(reason: string): void {
    if (this.destroyed) return;
    if (this.retryCount >= this.maxAutoRetries) {
      this.onStatusChange('disconnected', `${reason} (tocca Riconnetti per riprovare)`);
      return;
    }
    this.retryCount += 1;
    const delayMs = Math.min(8000, 1000 * Math.pow(2, this.retryCount - 1));
    this.onStatusChange(
      'connecting',
      `${reason} Nuovo tentativo tra ${Math.round(delayMs / 1000)}s (${this.retryCount}/${this.maxAutoRetries})...`
    );
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.destroyed) {
        this.openConnectionSession();
      }
    }, delayMs);
  }

  private openConnectionSession(): void {
    this.cleanupSession();
    this.destroyed = false;
    const roomTag = formatRoomTag(this.roomCode);
    this.onStatusChange(
      'connecting',
      `Connessione alla stanza ${roomTag} (${this.slot.toUpperCase()})...`
    );

    const peer = new Peer({ config: ICE_CONFIG });
    this.peer = peer;

    peer.on('open', () => {
      if (this.destroyed || this.peer !== peer) return;
      const targetId = `${PEER_PREFIX}${this.roomCode}`;
      const conn = peer.connect(targetId, {
        reliable: true,
        metadata: { slot: this.slot },
      });
      this.connection = conn;

      conn.on('open', () => {
        if (this.connection !== conn) return;
        this.retryCount = 0;
        this.sendPacket({ type: 'PING', slot: this.slot });
        const slotLabel = this.slot === 'p1' ? 'Giocatore 1' : 'Giocatore 2';
        this.onStatusChange(
          'connected',
          `Sei nella stanza ${roomTag} (${slotLabel})`
        );
      });

      conn.on('data', (data) => {
        if (data && typeof data === 'object' && 'type' in data) {
          this.onStatePacket(data as RemoteMicPacket);
        }
      });

      conn.on('close', () => {
        if (this.connection === conn) {
          this.connection = null;
          if (!this.destroyed) {
            this.scheduleRetry("Connessione chiusa dall'host.");
          }
        }
      });

      conn.on('error', () => {
        if (this.connection === conn) {
          this.connection = null;
          if (!this.destroyed) {
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
        this.scheduleRetry('Segnale P2P perso.');
      }
    });

    peer.on('error', (err) => {
      if (this.destroyed || this.peer !== peer) return;
      const recoverable =
        err.type === 'peer-unavailable' ||
        err.type === 'network' ||
        err.type === 'server-error' ||
        err.type === 'socket-error' ||
        err.type === 'socket-closed';
      if (recoverable) {
        this.scheduleRetry(`Stanza non ancora pronta (${err.type}).`);
      } else {
        this.onStatusChange(
          'disconnected',
          `Errore P2P (${err.type}).`
        );
      }
    });
  }

  public sendPacket(packet: RemoteMicPacket): void {
    if (this.connection && this.connection.open) {
      try {
        this.connection.send({
          ...packet,
          slot: packet.slot ?? this.slot,
        });
      } catch {
        // Ignora
      }
    }
  }

  private cleanupSession(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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
    this.cleanupSession();
  }
}
