import { invoke } from '@tauri-apps/api/core';
import type { RealtimeMessageData, RealtimeSocketLike } from './types';
import { assertAllowedRealtimeUrl } from './urlPolicy';

type NativeClose = { code: number; reason: string };

export type NativeRealtimeMessage =
  | { type: 'Text'; data: string }
  | { type: 'Binary'; data: number[] }
  | { type: 'Ping'; data: number[] }
  | { type: 'Pong'; data: number[] }
  | { type: 'Close'; data?: NativeClose | null }
  | { type: 'Error' }
  | { type: 'Idle' };

interface NativeWebSocket {
  addListener(listener: (message: NativeRealtimeMessage) => void): () => void;
  send(message: number[]): Promise<void>;
  disconnect(close: NativeClose): Promise<void>;
}

export interface TauriRealtimeBindings {
  connect(url: string): Promise<NativeWebSocket>;
}

const MAX_PENDING_EVENTS = 32;

async function connectNativeRealtimeSocket(url: string): Promise<NativeWebSocket> {
  let listener: ((message: NativeRealtimeMessage) => void) | null = null;
  let disconnected = false;
  const pending: NativeRealtimeMessage[] = [];
  const id = await invoke<number>('realtime_connect', { url });

  const deliver = (message: NativeRealtimeMessage): boolean => {
    if (listener) {
      listener(message);
      return true;
    }
    if (pending.length < MAX_PENDING_EVENTS) {
      pending.push(message);
      return true;
    }
    pending.length = 0;
    pending.push({ type: 'Error' });
    return false;
  };

  const receive = async (): Promise<void> => {
    while (!disconnected) {
      let message: NativeRealtimeMessage;
      try {
        message = await invoke<NativeRealtimeMessage>('realtime_receive', { id });
      } catch {
        if (!disconnected) deliver({ type: 'Error' });
        return;
      }
      if (disconnected) return;
      if (!deliver(message)) {
        disconnected = true;
        void invoke('realtime_disconnect', {
          id,
          close: { code: 1001, reason: 'renderer backpressure' }
        }).catch(() => {});
        return;
      }
      if (message.type === 'Close' || message.type === 'Error') return;
    }
  };
  void receive();

  return {
    addListener(nextListener) {
      listener = nextListener;
      for (const message of pending.splice(0)) nextListener(message);
      return () => {
        if (listener === nextListener) listener = null;
      };
    },
    async send(message) {
      if (disconnected) throw new Error('Native realtime connection is not open.');
      await invoke('realtime_send', { id, data: message });
    },
    async disconnect(close) {
      if (disconnected) return;
      disconnected = true;
      try {
        await invoke('realtime_disconnect', { id, close });
      } catch (error) {
        disconnected = false;
        throw error;
      }
    }
  };
}

class TauriRealtimeSocketAdapter implements RealtimeSocketLike {
  binaryType: BinaryType = 'arraybuffer';
  readyState = 0;
  onopen: RealtimeSocketLike['onopen'] = null;
  onmessage: RealtimeSocketLike['onmessage'] = null;
  onerror: RealtimeSocketLike['onerror'] = null;
  onclose: RealtimeSocketLike['onclose'] = null;

  #socket: NativeWebSocket | null = null;
  #removeListener: (() => void) | null = null;
  #pendingClose: NativeClose | null = null;
  #bufferNativeEvents = false;
  #pendingNativeEvents: NativeRealtimeMessage[] = [];

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
      this.#bufferNativeEvents = true;
      this.#removeListener = socket.addListener((message) => this.#receiveNativeMessage(message));

      if (this.#pendingClose) {
        this.#bufferNativeEvents = false;
        this.#sendClose(socket, this.#pendingClose);
        this.#drainNativeEvents();
        return;
      }

      this.readyState = 1;
      this.onopen?.();
      this.#bufferNativeEvents = false;
      this.#drainNativeEvents();
    } catch {
      this.#emitError();
      this.#finishClose({ code: 1006, reason: 'Native WebSocket connection failed.' });
    }
  }

  #sendClose(socket: NativeWebSocket, close: NativeClose): void {
    void socket
      .disconnect(close)
      .then(() => this.#finishClose(close))
      .catch(() => {
        this.#emitError();
        this.#finishClose({ code: 1006, reason: 'Native WebSocket close failed.' });
      });
  }

  #receiveNativeMessage(message: NativeRealtimeMessage): void {
    if (!this.#bufferNativeEvents) {
      this.#handleMessage(message);
      return;
    }
    if (this.#pendingNativeEvents.length < MAX_PENDING_EVENTS) {
      this.#pendingNativeEvents.push(message);
      return;
    }
    this.#pendingNativeEvents = [{ type: 'Error' }];
  }

  #drainNativeEvents(): void {
    for (const message of this.#pendingNativeEvents.splice(0)) this.#handleMessage(message);
  }

  #handleMessage(message: NativeRealtimeMessage): void {
    if (this.readyState === 3) return;
    switch (message.type) {
      case 'Binary':
        this.onmessage?.({ data: this.#binaryMessageData(message.data) });
        return;
      case 'Text':
        this.onmessage?.({ data: new TextEncoder().encode(message.data) });
        return;
      case 'Close':
        this.#finishClose(message.data ?? { code: 1000, reason: '' });
        return;
      case 'Error':
        this.#fail('Native WebSocket connection failed.');
        return;
      case 'Ping':
      case 'Pong':
      case 'Idle':
        return;
    }
  }

  #fail(reason: string): void {
    if (this.readyState === 3) return;
    this.#emitError();
    void this.#socket?.disconnect({ code: 1001, reason: 'connection failed' }).catch(() => {});
    this.#finishClose({ code: 1006, reason });
  }

  #binaryMessageData(data: number[]): RealtimeMessageData {
    const bytes = new Uint8Array(data);
    return this.binaryType === 'blob' ? new Blob([bytes]) : bytes;
  }

  #emitError(): void {
    this.onerror?.(new Event('error'));
  }

  #finishClose(event: NativeClose): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.#removeListener?.();
    this.#removeListener = null;
    this.#pendingNativeEvents.length = 0;
    this.#socket = null;
    this.onclose?.(event);
  }
}

/** Start the app-owned Rust WebSocket bridge behind the browser socket shape. */
export function createTauriRealtimeSocket(
  url: string,
  bindings: TauriRealtimeBindings = { connect: connectNativeRealtimeSocket }
): RealtimeSocketLike {
  const endpoint = assertAllowedRealtimeUrl(url);
  return new TauriRealtimeSocketAdapter(bindings.connect(endpoint));
}
