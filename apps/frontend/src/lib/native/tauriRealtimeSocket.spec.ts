import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@tauri-apps/plugin-websocket';
import { createTauriRealtimeSocket } from './tauriRealtimeSocket';

class FakeNativeSocket {
  readonly sent: Array<Message | string | number[]> = [];
  listener: ((message: unknown) => void) | null = null;

  addListener(listener: (message: unknown) => void): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  async send(message: Message | string | number[]): Promise<void> {
    this.sent.push(message);
  }

  async disconnect(): Promise<void> {}

  receive(message: unknown): void {
    this.listener?.(message);
  }
}

describe('Tauri realtime socket adapter', () => {
  it('validates the endpoint before connecting the native plugin', async () => {
    const connect = vi.fn(async () => new FakeNativeSocket());

    expect(() =>
      createTauriRealtimeSocket('ws://chatto.example/api/realtime', { connect })
    ).toThrow('Realtime URL is not allowed.');
    expect(connect).not.toHaveBeenCalled();
  });

  it('delivers open, binary message, send, and close semantics expected by the event bus', async () => {
    const native = new FakeNativeSocket();
    const connect = vi.fn(async () => native);
    const socket = createTauriRealtimeSocket('wss://chatto.example/api/realtime', {
      connect
    });
    const onopen = vi.fn();
    const onmessage = vi.fn();
    const onclose = vi.fn();
    socket.onopen = onopen;
    socket.onmessage = onmessage;
    socket.onclose = onclose;

    await vi.waitFor(() => expect(onopen).toHaveBeenCalledOnce());
    expect(onopen).toHaveBeenCalledOnce();
    expect(socket.readyState).toBe(1);

    native.receive({ type: 'Binary', data: [1, 2, 3] });
    expect(onmessage).toHaveBeenCalledWith({ data: new Uint8Array([1, 2, 3]) });

    socket.send(new Uint8Array([4, 5]));
    await Promise.resolve();
    expect(native.sent).toContainEqual([4, 5]);

    native.receive({ type: 'Close', data: { code: 1000, reason: 'done' } });
    expect(socket.readyState).toBe(3);
    expect(onclose).toHaveBeenCalledWith({ code: 1000, reason: 'done' });
  });

  it('sends the caller close code and reason to the native plugin', async () => {
    const native = new FakeNativeSocket();
    const socket = createTauriRealtimeSocket('ws://localhost:8080/api/realtime', {
      connect: async () => native
    });

    socket.close(1001, 'replaced');
    await vi.waitFor(() => expect(native.sent).toHaveLength(1));

    expect(socket.readyState).toBe(2);
    expect(native.sent).toContainEqual({
      type: 'Close',
      data: { code: 1001, reason: 'replaced' }
    });
  });

  it('turns plugin read errors into an abnormal close so callers reconnect', async () => {
    const native = new FakeNativeSocket();
    const socket = createTauriRealtimeSocket('wss://chatto.example/api/realtime', {
      connect: async () => native
    });
    const onerror = vi.fn();
    const onclose = vi.fn();
    socket.onerror = onerror;
    socket.onclose = onclose;
    await vi.waitFor(() => expect(socket.readyState).toBe(1));

    // tauri-plugin-websocket serializes tungstenite read errors as strings even
    // though its TypeScript declaration currently omits that channel payload.
    native.receive('Connection reset without closing handshake');

    expect(socket.readyState).toBe(3);
    expect(onerror).toHaveBeenCalledOnce();
    expect(onclose).toHaveBeenCalledWith({
      code: 1006,
      reason: 'Native WebSocket connection failed.'
    });
    expect(native.listener).toBeNull();
  });
});
