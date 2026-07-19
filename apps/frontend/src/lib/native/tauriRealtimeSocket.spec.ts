import { describe, expect, it, vi } from 'vitest';
import {
  createTauriRealtimeSocket,
  type NativeRealtimeMessage
} from './tauriRealtimeSocket';

class FakeNativeSocket {
  readonly sent: number[][] = [];
  readonly disconnects: Array<{ code: number; reason: string }> = [];
  listener: ((message: NativeRealtimeMessage) => void) | null = null;

  addListener(listener: (message: NativeRealtimeMessage) => void): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  async send(message: number[]): Promise<void> {
    this.sent.push(message);
  }

  async disconnect(close: { code: number; reason: string }): Promise<void> {
    this.disconnects.push(close);
  }

  receive(message: NativeRealtimeMessage): void {
    this.listener?.(message);
  }
}

describe('Tauri realtime socket adapter', () => {
  it('validates the endpoint before connecting the native bridge', async () => {
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

  it('opens before delivering native events buffered during the IPC handshake', async () => {
    const native = new FakeNativeSocket();
    native.addListener = (listener) => {
      native.listener = listener;
      listener({ type: 'Binary', data: [1] });
      return () => {
        native.listener = null;
      };
    };
    const order: string[] = [];
    const socket = createTauriRealtimeSocket('wss://chatto.example/api/realtime', {
      connect: async () => native
    });
    socket.onopen = () => order.push('open');
    socket.onmessage = () => order.push('message');

    await vi.waitFor(() => expect(order).toHaveLength(2));

    expect(order).toEqual(['open', 'message']);
  });

  it('keeps the browser socket open across native IPC idle heartbeats', async () => {
    const native = new FakeNativeSocket();
    const socket = createTauriRealtimeSocket('wss://chatto.example/api/realtime', {
      connect: async () => native
    });
    const onmessage = vi.fn();
    const onclose = vi.fn();
    socket.onmessage = onmessage;
    socket.onclose = onclose;
    await vi.waitFor(() => expect(socket.readyState).toBe(1));

    native.receive({ type: 'Idle' });

    expect(socket.readyState).toBe(1);
    expect(onmessage).not.toHaveBeenCalled();
    expect(onclose).not.toHaveBeenCalled();
  });

  it('sends the caller close code and reason to the native bridge', async () => {
    const native = new FakeNativeSocket();
    const socket = createTauriRealtimeSocket('ws://localhost:8080/api/realtime', {
      connect: async () => native
    });

    socket.close(1001, 'replaced');
    await vi.waitFor(() => expect(native.disconnects).toHaveLength(1));

    expect(socket.readyState).toBe(3);
    expect(native.disconnects).toContainEqual({ code: 1001, reason: 'replaced' });
  });

  it('turns native read errors into an abnormal close so callers reconnect', async () => {
    const native = new FakeNativeSocket();
    const socket = createTauriRealtimeSocket('wss://chatto.example/api/realtime', {
      connect: async () => native
    });
    const onerror = vi.fn();
    const onclose = vi.fn();
    socket.onerror = onerror;
    socket.onclose = onclose;
    await vi.waitFor(() => expect(socket.readyState).toBe(1));

    native.receive({ type: 'Error' });

    expect(socket.readyState).toBe(3);
    expect(onerror).toHaveBeenCalledOnce();
    expect(onclose).toHaveBeenCalledWith({
      code: 1006,
      reason: 'Native WebSocket connection failed.'
    });
    expect(native.listener).toBeNull();
    expect(native.disconnects).toContainEqual({ code: 1001, reason: 'connection failed' });
  });
});
