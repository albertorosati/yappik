import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  encodeRemainingLength,
  encodeConnectPacket,
  encodeSubscribePacket,
  encodePublishPacket,
  decodeMqttPackets,
  MqttRoomRelay,
} from './mqttRoomRelay';

describe('mqttRoomRelay framing & relay', () => {
  it('encodes multi-byte remaining length accurately', () => {
    expect(encodeRemainingLength(64)).toEqual([64]);
    expect(encodeRemainingLength(128)).toEqual([0x80, 0x01]);
    expect(encodeRemainingLength(16384)).toEqual([0x80, 0x80, 0x01]);
  });

  it('encodes and decodes PUBLISH + CONNACK + SUBACK coalesced packets', () => {
    const connack = new Uint8Array([0x20, 0x02, 0x00, 0x00]);
    const suback = new Uint8Array([0x90, 0x03, 0x00, 0x01, 0x00]);
    const payloadObj = { v: 1, packet: { type: 'PING', slot: 'p2' } };
    const pub = encodePublishPacket('yappik/v1/room1/to-host', JSON.stringify(payloadObj));

    const combined = new Uint8Array(connack.length + suback.length + pub.length);
    combined.set(connack, 0);
    combined.set(suback, connack.length);
    combined.set(pub, connack.length + suback.length);

    // Split in half first to ensure partial-buffer parsing works
    const splitAt = connack.length + suback.length + 5;
    const firstPass = decodeMqttPackets(combined.subarray(0, splitAt));
    expect(firstPass.packets).toHaveLength(2);
    expect(firstPass.packets[0]).toMatchObject({ type: 2, connackCode: 0 });
    expect(firstPass.packets[1]).toMatchObject({ type: 9 });

    const remainingBuf = new Uint8Array(firstPass.rest.length + (combined.length - splitAt));
    remainingBuf.set(firstPass.rest, 0);
    remainingBuf.set(combined.subarray(splitAt), firstPass.rest.length);

    const secondPass = decodeMqttPackets(remainingBuf);
    expect(secondPass.rest.length).toBe(0);
    expect(secondPass.packets).toHaveLength(1);
    expect(secondPass.packets[0].topic).toBe('yappik/v1/room1/to-host');
    expect(JSON.parse(secondPass.packets[0].payload!)).toEqual(payloadObj);
  });

  it('encodes valid MQTT 3.1.1 CONNECT and SUBSCRIBE headers', () => {
    const conn = encodeConnectPacket('yapk_123', 30);
    expect(conn[0]).toBe(0x10);
    const sub = encodeSubscribePacket(7, 'yappik/v1/abc/to-host');
    expect(sub[0]).toBe(0x82);
  });

  describe('MqttRoomRelay mock WebSocket roundtrip', () => {
    const origWs = globalThis.WebSocket;

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      globalThis.WebSocket = origWs;
    });

    it('completes CONNECT -> SUBSCRIBE -> PUBLISH lifecycle cleanly', () => {
      const sentFrames: Uint8Array[] = [];
      let socketInstance: any = null;

      class MockWebSocket {
        static OPEN = 1;
        readyState = 1;
        binaryType = 'arraybuffer';
        onopen: (() => void) | null = null;
        onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
        onerror: (() => void) | null = null;
        onclose: (() => void) | null = null;

        constructor() {
          socketInstance = this;
          setTimeout(() => this.onopen?.(), 10);
        }

        send(data: Uint8Array) {
          sentFrames.push(new Uint8Array(data));
          if (data[0] === 0x10) {
            // Reply with CONNACK
            this.onmessage?.({ data: new Uint8Array([0x20, 0x02, 0x00, 0x00]).buffer });
          } else if (data[0] === 0x82) {
            // Reply with SUBACK
            this.onmessage?.({ data: new Uint8Array([0x90, 0x03, 0x00, 0x01, 0x00]).buffer });
          }
        }

        close() {
          this.readyState = 3;
        }
      }

      (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;

      const onMsg = vi.fn();
      const onReady = vi.fn();
      const relay = new MqttRoomRelay(
        'yappik/v1/test/to-host',
        'yappik/v1/test/to-client',
        onMsg,
        onReady
      );

      // Queue packet before connection finishes
      relay.send({ type: 'PING', slot: 'p2' });
      relay.start();

      vi.advanceTimersByTime(20);
      expect(relay.isReady()).toBe(true);
      expect(onReady).toHaveBeenCalledWith(true);

      // Should have sent CONNECT, SUBSCRIBE, and flushed queued PUBLISH
      expect(sentFrames.some((f) => f[0] === 0x30)).toBe(true);

      // Simulate incoming PUBLISH from peer
      const inbound = encodePublishPacket(
        'yappik/v1/test/to-host',
        JSON.stringify({ type: 'STATE_UPDATE', p2Name: 'Marco' })
      );
      socketInstance.onmessage({ data: inbound.buffer });
      expect(onMsg).toHaveBeenCalledWith({ type: 'STATE_UPDATE', p2Name: 'Marco' });

      relay.destroy();
      expect(relay.isReady()).toBe(false);
    });
  });
});
