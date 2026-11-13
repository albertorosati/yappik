/**
 * Lightweight zero-dependency MQTT 3.1.1 over WebSocket room relay.
 * Used alongside WebRTC (PeerJS) so PC + smartphone connections across
 * cellular CGNAT / symmetric NAT / strict Wi-Fi still pair immediately.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const DEFAULT_MQTT_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081',
] as const;

export function encodeRemainingLength(length: number): number[] {
  const bytes: number[] = [];
  let x = length;
  do {
    let encoded = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) encoded |= 0x80;
    bytes.push(encoded);
  } while (x > 0);
  return bytes;
}

export function encodeUtf8Field(str: string): Uint8Array {
  const utf8 = textEncoder.encode(str);
  const out = new Uint8Array(2 + utf8.length);
  out[0] = (utf8.length >> 8) & 0xff;
  out[1] = utf8.length & 0xff;
  out.set(utf8, 2);
  return out;
}

function buildMqttPacket(firstByte: number, bodyChunks: Uint8Array[]): Uint8Array {
  const remaining = bodyChunks.reduce((acc, c) => acc + c.length, 0);
  const remBytes = encodeRemainingLength(remaining);
  const packet = new Uint8Array(1 + remBytes.length + remaining);
  packet[0] = firstByte;
  packet.set(remBytes, 1);
  let offset = 1 + remBytes.length;
  for (const chunk of bodyChunks) {
    packet.set(chunk, offset);
    offset += chunk.length;
  }
  return packet;
}

export function encodeConnectPacket(clientId: string, keepAliveSec = 30): Uint8Array {
  const vh = new Uint8Array([
    0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, // "MQTT"
    0x04, // Protocol level 4 (3.1.1)
    0x02, // Clean session
    (keepAliveSec >> 8) & 0xff,
    keepAliveSec & 0xff,
  ]);
  const payload = encodeUtf8Field(clientId);
  return buildMqttPacket(0x10, [vh, payload]);
}

export function encodeSubscribePacket(packetId: number, topic: string): Uint8Array {
  const vh = new Uint8Array([(packetId >> 8) & 0xff, packetId & 0xff]);
  const topicField = encodeUtf8Field(topic);
  const qos = new Uint8Array([0x00]);
  return buildMqttPacket(0x82, [vh, topicField, qos]);
}

export function encodePublishPacket(topic: string, payloadText: string): Uint8Array {
  const topicField = encodeUtf8Field(topic);
  const payloadBytes = textEncoder.encode(payloadText);
  return buildMqttPacket(0x30, [topicField, payloadBytes]);
}

export interface DecodedMqttPacket {
  type: number;
  flags: number;
  topic?: string;
  payload?: string;
  connackCode?: number;
}

export function decodeMqttPackets(buffer: Uint8Array): {
  packets: DecodedMqttPacket[];
  rest: Uint8Array;
} {
  const packets: DecodedMqttPacket[] = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const header = buffer[offset];
    const type = (header >> 4) & 0x0f;
    const flags = header & 0x0f;

    let multiplier = 1;
    let remainingLength = 0;
    let lenBytes = 0;
    let incompleteHeader = false;

    for (let i = 0; i < 4; i++) {
      if (offset + 1 + i >= buffer.length) {
        incompleteHeader = true;
        break;
      }
      const byte = buffer[offset + 1 + i];
      lenBytes += 1;
      remainingLength += (byte & 0x7f) * multiplier;
      multiplier *= 128;
      if ((byte & 0x80) === 0) break;
    }

    if (incompleteHeader) break;

    const totalLen = 1 + lenBytes + remainingLength;
    if (offset + totalLen > buffer.length) break;

    const bodyStart = offset + 1 + lenBytes;
    const bodyEnd = bodyStart + remainingLength;

    if (type === 2 && remainingLength >= 2) {
      packets.push({
        type,
        flags,
        connackCode: buffer[bodyStart + 1],
      });
    } else if (type === 3 && remainingLength >= 2) {
      const topicLen = (buffer[bodyStart] << 8) | buffer[bodyStart + 1];
      let cursor = bodyStart + 2;
      if (cursor + topicLen <= bodyEnd) {
        const topic = textDecoder.decode(buffer.subarray(cursor, cursor + topicLen));
        cursor += topicLen;
        const qos = (flags >> 1) & 0x03;
        if (qos > 0) cursor += 2;
        const payload =
          cursor <= bodyEnd
            ? textDecoder.decode(buffer.subarray(cursor, bodyEnd))
            : '';
        packets.push({ type, flags, topic, payload });
      }
    } else {
      packets.push({ type, flags });
    }

    offset += totalLen;
  }

  return {
    packets,
    rest: offset < buffer.length ? buffer.slice(offset) : new Uint8Array(0),
  };
}

export class MqttRoomRelay {
  private readonly subscribeTopic: string;
  private readonly publishTopic: string;
  private readonly onMessage: (data: unknown) => void;
  private readonly onReadyChange?: (ready: boolean) => void;
  private ws: WebSocket | null = null;
  private rxBuffer: Uint8Array = new Uint8Array(0);
  private brokerIndex = 0;
  private destroyed = false;
  private ready = false;
  private connectTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private packetSeq = 1;
  private pendingMessages: string[] = [];

  constructor(
    subscribeTopic: string,
    publishTopic: string,
    onMessage: (data: unknown) => void,
    onReadyChange?: (ready: boolean) => void
  ) {
    this.subscribeTopic = subscribeTopic;
    this.publishTopic = publishTopic;
    this.onMessage = onMessage;
    this.onReadyChange = onReadyChange;
  }

  public isReady(): boolean {
    return this.ready;
  }

  public start(): void {
    if (this.destroyed) return;
    this.openSocket();
  }

  public send(data: unknown): boolean {
    if (this.destroyed) return false;
    const json = JSON.stringify(data);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.ready) {
      if (this.pendingMessages.length < 16) {
        this.pendingMessages.push(json);
      }
      return false;
    }
    try {
      this.ws.send(encodePublishPacket(this.publishTopic, json));
      return true;
    } catch {
      return false;
    }
  }

  public reconnectNow(): void {
    if (this.destroyed) return;
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) return;
    this.cleanupSocket();
    this.openSocket();
  }

  private setReady(next: boolean): void {
    if (this.ready === next) return;
    this.ready = next;
    this.onReadyChange?.(next);
  }

  private openSocket(): void {
    if (this.destroyed || typeof WebSocket !== 'function') return;
    this.cleanupSocket();
    const brokerUrl =
      DEFAULT_MQTT_BROKERS[this.brokerIndex % DEFAULT_MQTT_BROKERS.length];

    let ws: WebSocket;
    try {
      ws = new WebSocket(brokerUrl, ['mqtt']);
      ws.binaryType = 'arraybuffer';
    } catch {
      this.rotateAndRetry();
      return;
    }

    this.ws = ws;
    this.connectTimeout = setTimeout(() => {
      if (this.ws === ws && !this.ready && !this.destroyed) {
        this.rotateAndRetry();
      }
    }, 3500);

    ws.onopen = () => {
      if (this.ws !== ws || this.destroyed) return;
      const clientId = `yapk_${Math.random().toString(36).slice(2, 10)}`;
      try {
        ws.send(encodeConnectPacket(clientId, 30));
      } catch {
        this.rotateAndRetry();
      }
    };

    ws.onmessage = (ev) => {
      if (this.ws !== ws || this.destroyed) return;
      let chunk: Uint8Array;
      if (ev.data instanceof ArrayBuffer) {
        chunk = new Uint8Array(ev.data);
      } else if (ArrayBuffer.isView(ev.data)) {
        chunk = new Uint8Array(
          ev.data.buffer,
          ev.data.byteOffset,
          ev.data.byteLength
        );
      } else {
        return;
      }

      const combined = new Uint8Array(this.rxBuffer.length + chunk.length);
      combined.set(this.rxBuffer, 0);
      combined.set(chunk, this.rxBuffer.length);
      const { packets, rest } = decodeMqttPackets(combined);
      this.rxBuffer = rest;

      for (const pkt of packets) {
        if (pkt.type === 2 && pkt.connackCode === 0) {
          if (this.connectTimeout) {
            clearTimeout(this.connectTimeout);
            this.connectTimeout = null;
          }
          try {
            ws.send(encodeSubscribePacket(this.packetSeq++, this.subscribeTopic));
          } catch {
            this.rotateAndRetry();
            return;
          }
        } else if (pkt.type === 9) {
          // SUBACK: subscription active, ready to exchange packets reliably
          this.setReady(true);
          this.flushPending();
          this.startKeepalive(ws);
        } else if (pkt.type === 3 && pkt.payload) {
          try {
            const parsed = JSON.parse(pkt.payload);
            this.onMessage(parsed);
          } catch {
            // Ignore malformed JSON payloads
          }
        }
      }
    };

    ws.onerror = () => {
      if (this.ws !== ws || this.destroyed) return;
      this.rotateAndRetry();
    };

    ws.onclose = () => {
      if (this.ws !== ws || this.destroyed) return;
      this.rotateAndRetry();
    };
  }

  private flushPending(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.ready) return;
    while (this.pendingMessages.length > 0) {
      const json = this.pendingMessages.shift();
      if (!json) continue;
      try {
        this.ws.send(encodePublishPacket(this.publishTopic, json));
      } catch {
        break;
      }
    }
  }

  private startKeepalive(ws: WebSocket): void {
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.pingInterval = setInterval(() => {
      if (this.ws !== ws || this.destroyed || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      try {
        ws.send(new Uint8Array([0xc0, 0x00])); // PINGREQ
      } catch {
        this.rotateAndRetry();
      }
    }, 18000);
  }

  private rotateAndRetry(): void {
    if (this.destroyed) return;
    this.cleanupSocket();
    this.setReady(false);
    this.brokerIndex = (this.brokerIndex + 1) % DEFAULT_MQTT_BROKERS.length;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.destroyed) {
        this.openSocket();
      }
    }, 900);
  }

  private cleanupSocket(): void {
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    this.rxBuffer = new Uint8Array(0);
    if (this.ws) {
      const target = this.ws;
      this.ws = null;
      try {
        if (target.readyState === WebSocket.OPEN) {
          target.send(new Uint8Array([0xe0, 0x00])); // DISCONNECT
        }
        target.close();
      } catch {
        // Ignore close errors
      }
    }
  }

  public destroy(): void {
    this.destroyed = true;
    this.setReady(false);
    this.pendingMessages = [];
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cleanupSocket();
  }
}
