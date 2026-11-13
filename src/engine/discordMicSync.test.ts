import { describe, it, expect, vi } from 'vitest';

const { mockPeerInstances } = vi.hoisted(() => ({
  mockPeerInstances: [] as Array<{
    id: string;
    handlers: Record<string, (...args: unknown[]) => void>;
    lastConn?: {
      open: boolean;
      peer: string;
      metadata?: unknown;
      handlers: Record<string, (...args: unknown[]) => void>;
      sent: unknown[];
      on: (ev: string, fn: (...args: unknown[]) => void) => void;
      send: (d: unknown) => void;
      close: () => void;
    };
  }>,
}));

vi.mock('peerjs', () => {
  class MockPeer {
    public id: string;
    public destroyed = false;
    public disconnected = false;
    private handlers: Record<string, (...args: unknown[]) => void> = {};
    public lastConn?: (typeof mockPeerInstances)[number]['lastConn'];

    constructor(id?: string | Record<string, unknown>) {
      this.id = typeof id === 'string' ? id : 'client-mock-id';
      mockPeerInstances.push({
        id: this.id,
        handlers: this.handlers,
      });
    }

    on(event: string, cb: (...args: unknown[]) => void) {
      this.handlers[event] = cb;
    }

    connect(target: string, opts?: { metadata?: unknown }) {
      const connHandlers: Record<string, (...args: unknown[]) => void> = {};
      const sent: unknown[] = [];
      const conn = {
        open: true,
        peer: target,
        metadata: opts?.metadata,
        handlers: connHandlers,
        sent,
        on(ev: string, fn: (...args: unknown[]) => void) {
          connHandlers[ev] = fn;
        },
        send(d: unknown) {
          sent.push(d);
        },
        close() {
          this.open = false;
        },
      };
      this.lastConn = conn;
      const entry = mockPeerInstances.find((p) => p.id === this.id);
      if (entry) entry.lastConn = conn;
      return conn;
    }

    reconnect() {}
    destroy() {
      this.destroyed = true;
    }
  }

  return {
    default: MockPeer,
    Peer: MockPeer,
  };
});

import {
  generateRoomCode,
  formatRoomTag,
  parseRoomInput,
  DiscordHostPeer,
  DiscordClientPeer,
} from './discordMicSync';

describe('discordMicSync - generateRoomCode', () => {
  it('generates a valid UUID v4 / GUID string', () => {
    const code = generateRoomCode();
    expect(code).toBeDefined();
    // UUID format: 8-4-4-4-12 hex chars
    expect(code).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('guarantees unique session IDs across 50 iterations with 0 collisions', () => {
    const set = new Set<string>();
    const iterations = 50;
    for (let i = 0; i < iterations; i++) {
      const code = generateRoomCode();
      expect(set.has(code)).toBe(false);
      set.add(code);
    }
    expect(set.size).toBe(iterations);
  });
});

describe('discordMicSync - Dual-slot Host/Client routing', () => {
  it('tracks P1 and P2 connections independently and ignores stale connection closes', () => {
    mockPeerInstances.length = 0;
    const onPacket = vi.fn();
    const onConnChange = vi.fn();

    const host = new DiscordHostPeer('ROOM1', onPacket, onConnChange);
    host.start();
    const peerRecord = mockPeerInstances[0];
    expect(peerRecord).toBeDefined();

    const makeMockConn = (peerId: string, slot: 'p1' | 'p2') => {
      const handlers: Record<string, (...args: unknown[]) => void> = {};
      return {
        open: true,
        peer: peerId,
        metadata: { slot },
        sent: [] as unknown[],
        on(ev: string, fn: (...args: unknown[]) => void) {
          handlers[ev] = fn;
        },
        send(d: unknown) {
          this.sent.push(d);
        },
        close() {
          this.open = false;
        },
        emit(ev: string, ...args: unknown[]) {
          handlers[ev]?.(...args);
        },
      };
    };

    const p1Old = makeMockConn('phone-p1-old', 'p1');
    const p1New = makeMockConn('phone-p1-new', 'p1');
    const p2 = makeMockConn('phone-p2', 'p2');

    peerRecord.handlers['connection'](p1Old);
    p1Old.emit('open');
    expect(onConnChange).toHaveBeenLastCalledWith(true, expect.any(String), 'p1');

    // Reconnect P1 with newer connection, then close old P1 -> must NOT mark P1 disconnected
    peerRecord.handlers['connection'](p1New);
    p1New.emit('open');
    p1Old.emit('close');
    expect(onConnChange).not.toHaveBeenCalledWith(false, undefined, 'p1');

    // Connect P2 in parallel
    peerRecord.handlers['connection'](p2);
    p2.emit('open');
    expect(onConnChange).toHaveBeenLastCalledWith(true, expect.any(String), 'p2');

    // Route packet from P1 preserves slot: 'p1'
    p1New.emit('data', { type: 'TRANSCRIPT', transcript: 'roma' });
    expect(onPacket).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'TRANSCRIPT', transcript: 'roma', slot: 'p1' })
    );

    host.destroy();
  });

  it('sends initial PING stamped with client slot upon opening connection', () => {
    mockPeerInstances.length = 0;
    const onState = vi.fn();
    const onStatus = vi.fn();

    const client = new DiscordClientPeer('ROOM2', onState, onStatus, 'p1');
    client.connect();
    const clientRecord = mockPeerInstances[0];
    clientRecord.handlers['open']();
    clientRecord.lastConn?.handlers['open']();

    expect(onStatus).toHaveBeenCalledWith(
      'connected',
      expect.stringContaining('#ROOM2')
    );
    expect(clientRecord.lastConn?.sent[0]).toEqual({ type: 'PING', slot: 'p1' });

    client.destroy();
  });

  it('formats room tags and parses room codes or full invite URLs cleanly', () => {
    expect(formatRoomTag('abcd1234-5678-90ab-cdef-111122223333')).toBe('#ABCD12');
    expect(formatRoomTag('discroom99')).toBe('#DISCROOM99');
    expect(formatRoomTag('test42')).toBe('#TEST42');
    expect(parseRoomInput('https://albertorosati.github.io/yappik/?room=ROOM99&slot=p1')).toEqual({
      roomCode: 'ROOM99',
      slot: 'p1',
    });
    expect(parseRoomInput('?room=abc-123&slot=p2')).toEqual({
      roomCode: 'abc-123',
      slot: 'p2',
    });
    expect(parseRoomInput('#TestRoom')).toEqual({ roomCode: 'TestRoom' });
    expect(parseRoomInput('   ')).toBeNull();
  });
});
