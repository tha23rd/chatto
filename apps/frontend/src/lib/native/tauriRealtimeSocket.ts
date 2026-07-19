import TauriWebSocket, { type ConnectionConfig, type Message } from '@tauri-apps/plugin-websocket';
import type { RealtimeMessageData, RealtimeSocketLike } from './types';
import { assertAllowedRealtimeUrl } from './urlPolicy';

interface NativeWebSocket {
  addListener(listener: (message: unknown) => void): () => void;
  send(message: Message | string | number[]): Promise<void>;
  disconnect(): Promise<void>;
}

export interface TauriRealtimeBindings {
  connect(url: string, config?: ConnectionConfig): Promise<NativeWebSocket>;
}

const connectionConfig: ConnectionConfig = {
  readBufferSize: 64 * 1024,
  writeBufferSize: 64 * 1024,
  maxWriteBufferSize: 1024 * 1024,
  maxMessageSize: 16 * 1024 * 1024,
  maxFrameSize: 4 * 1024 * 1024
};

class TauriRealtimeSocketAdapter implements RealtimeSocketLike {
  binaryType: BinaryType = 'arraybuffer';
  readyState = 0;
  onopen: RealtimeSocketLike['onopen'] = null;
  onmessage: RealtimeSocketLike['onmessage'] = null;
  onerror: RealtimeSocketLike['onerror'] = null;
  onclose: RealtimeSocketLike['onclose'] = null;

  #socket: NativeWebSocket | null = null;
  #removeListener: (() => void) | null = null;
  #pendingClose: { code: number; reason: string } | null = null;

  constructor(connection: Promise<NativeWebSocket>) {
    void this.#finishConnecting(connection);
  }

  send(data: Uint8Array): void {
    if (this.readyState !== 1 || !this.#socket) {
      throw new Error('Realtime socket is not open.');
    }
    void this.#socket.send(Array.from(data)).catch(() => {
      this.#fail('Native WebSocket send failed.');
    });
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.#pendingClose = { code, reason };
    if (this.#socket) this.#sendClose(this.#socket, this.#pendingClose);
  }

  async #finishConnecting(connection: Promise<NativeWebSocket>): Promise<void> {
    try {
      const socket = await connection;
      this.#socket = socket;
      this.#removeListener = socket.addListener((message) => this.#handleMessage(message));

      if (this.#pendingClose) {
        this.#sendClose(socket, this.#pendingClose);
        return;
      }

      this.readyState = 1;
      this.onopen?.();
    } catch {
      this.#emitError();
      this.#finishClose({ code: 1006, reason: 'Native WebSocket connection failed.' });
    }
  }

  #sendClose(socket: NativeWebSocket, close: { code: number; reason: string }): void {
    void socket.send({ type: 'Close', data: close }).catch(() => {
      this.#emitError();
      this.#finishClose({ code: 1006, reason: 'Native WebSocket close failed.' });
    });
  }

  #handleMessage(message: unknown): void {
    if (!message || typeof message !== 'object' || !('type' in message)) {
      this.#fail('Native WebSocket connection failed.');
      return;
    }

    const nativeMessage = message as Message;
    switch (nativeMessage.type) {
      case 'Binary':
        this.onmessage?.({ data: this.#binaryMessageData(nativeMessage.data) });
        return;
      case 'Text':
        this.onmessage?.({ data: new TextEncoder().encode(nativeMessage.data) });
        return;
      case 'Close':
        this.#finishClose(nativeMessage.data ?? { code: 1000, reason: '' });
        return;
      case 'Ping':
      case 'Pong':
        return;
    }
  }

  #fail(reason: string): void {
    if (this.readyState === 3) return;
    this.#emitError();
    void this.#socket?.disconnect().catch(() => {});
    this.#finishClose({ code: 1006, reason });
  }

  #binaryMessageData(data: number[]): RealtimeMessageData {
    const bytes = new Uint8Array(data);
    return this.binaryType === 'blob' ? new Blob([bytes]) : bytes;
  }

  #emitError(): void {
    this.onerror?.(new Event('error'));
  }

  #finishClose(event: { code?: number; reason?: string }): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.#removeListener?.();
    this.#removeListener = null;
    this.#socket = null;
    this.onclose?.(event);
  }
}

/** Start the Rust WebSocket plugin behind the synchronous browser socket shape. */
export function createTauriRealtimeSocket(
  url: string,
  bindings: TauriRealtimeBindings = {
    connect: (endpoint, config) => TauriWebSocket.connect(endpoint, config)
  }
): RealtimeSocketLike {
  const endpoint = assertAllowedRealtimeUrl(url);
  return new TauriRealtimeSocketAdapter(bindings.connect(endpoint, connectionConfig));
}
