import { describe, expect, it, vi } from 'vitest';
import { createTauriNativeHost } from './tauriHost';
import type { DesktopUpdateSnapshot } from './types';

const idleUpdate: DesktopUpdateSnapshot = {
  supported: true,
  channel: 'stable',
  phase: 'idle',
  currentVersion: '0.1.0'
};

function displayCaptureStream(
  displaySurface: 'browser' | 'monitor' | 'window' | undefined,
  audioLabels: readonly string[]
) {
  const videoTrack = {
    getSettings: () => (displaySurface ? { displaySurface } : {})
  } as unknown as MediaStreamTrack;
  const audioTracks = audioLabels.map(
    (label) =>
      ({
        label,
        stop: vi.fn()
      }) as unknown as MediaStreamTrack
  );
  let attachedAudioTracks = [...audioTracks];
  const removeTrack = vi.fn((track: MediaStreamTrack) => {
    attachedAudioTracks = attachedAudioTracks.filter((candidate) => candidate !== track);
  });
  const stream = {
    getVideoTracks: () => [videoTrack],
    getAudioTracks: () => attachedAudioTracks,
    getTracks: () => [videoTrack, ...attachedAudioTracks],
    removeTrack
  } as unknown as MediaStream;

  return { audioTracks, removeTrack, stream };
}

function bindings() {
  return {
    fetch: vi.fn(async () => new Response(null, { status: 204 })),
    getDisplayMedia: vi.fn(async () => displayCaptureStream('monitor', []).stream),
    openUrl: vi.fn(async () => {}),
    createRealtimeSocket: vi.fn(),
    startServerOAuth: vi.fn(),
    registerPushToTalk: vi.fn(async () => () => {}),
    onTrayAction: vi.fn(async () => () => {}),
    setCallControls: vi.fn(async () => {}),
    setTaskbarAttention: vi.fn(async () => {}),
    quit: vi.fn(async () => {}),
    getDesktopUpdateState: vi.fn(async () => idleUpdate),
    setDesktopUpdateChannel: vi.fn(async () => idleUpdate),
    checkForDesktopUpdate: vi.fn(async () => idleUpdate),
    installDesktopUpdate: vi.fn(async () => {}),
    onDesktopUpdateState: vi.fn(async () => () => {})
  };
}

describe('Tauri NativeHost', () => {
  it('advertises only the native capabilities implemented by the adapter', () => {
    const host = createTauriNativeHost(bindings());

    expect(host.kind).toBe('tauri');
    expect(host.capabilities).toEqual({
      nativeOAuth: true,
      nativeHttp: true,
      nativeRealtime: true,
      globalPushToTalk: true,
      tray: true,
      appBadge: true,
      desktopUpdates: true,
      managedVideoPopOut: true,
      windowApplicationAudio: true
    });
  });

  it('maps badge counts and flags to a Windows taskbar attention indicator', async () => {
    const native = bindings();
    const host = createTauriNativeHost(native);

    await host.setAppBadge({ kind: 'count', count: 3 });
    await host.setAppBadge({ kind: 'flag' });
    await host.setAppBadge({ kind: 'clear' });

    expect(native.setTaskbarAttention.mock.calls).toEqual([[true], [true], [false]]);
  });

  it('requests application audio when an audio-enabled desktop capture selects a window', async () => {
    const native = bindings();
    const host = createTauriNativeHost(native);
    const audio = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    };
    const video = {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: 60
    };

    await host.captureDisplayMedia({
      audio,
      video,
      systemAudio: 'include'
    });

    expect(native.getDisplayMedia).toHaveBeenCalledWith({
      audio,
      video,
      systemAudio: 'include',
      windowAudio: 'window'
    });
  });

  it('retains positively identified application audio for a window capture', async () => {
    const native = bindings();
    const capture = displayCaptureStream('window', ['Application Audio']);
    native.getDisplayMedia.mockResolvedValue(capture.stream);
    const host = createTauriNativeHost(native);

    const stream = await host.captureDisplayMedia({ audio: true, video: true });

    expect(stream.getAudioTracks()).toEqual(capture.audioTracks);
    expect(capture.audioTracks[0].stop).not.toHaveBeenCalled();
    expect(capture.removeTrack).not.toHaveBeenCalled();
  });

  it('stops and removes system audio from a window capture', async () => {
    const native = bindings();
    const capture = displayCaptureStream('window', ['System Audio']);
    native.getDisplayMedia.mockResolvedValue(capture.stream);
    const host = createTauriNativeHost(native);

    const stream = await host.captureDisplayMedia({ audio: true, video: true });

    expect(capture.audioTracks[0].stop).toHaveBeenCalledOnce();
    expect(capture.removeTrack).toHaveBeenCalledWith(capture.audioTracks[0]);
    expect(stream.getAudioTracks()).toEqual([]);
  });

  it('retains system audio for a monitor capture', async () => {
    const native = bindings();
    const capture = displayCaptureStream('monitor', ['System Audio']);
    native.getDisplayMedia.mockResolvedValue(capture.stream);
    const host = createTauriNativeHost(native);

    const stream = await host.captureDisplayMedia({ audio: true, video: true });

    expect(stream.getAudioTracks()).toEqual(capture.audioTracks);
    expect(capture.audioTracks[0].stop).not.toHaveBeenCalled();
    expect(capture.removeTrack).not.toHaveBeenCalled();
  });

  it('retains tab audio for a browser-surface capture', async () => {
    const native = bindings();
    const capture = displayCaptureStream('browser', ['Tab audio']);
    native.getDisplayMedia.mockResolvedValue(capture.stream);
    const host = createTauriNativeHost(native);

    const stream = await host.captureDisplayMedia({ audio: true, video: true });

    expect(stream.getAudioTracks()).toEqual(capture.audioTracks);
    expect(capture.audioTracks[0].stop).not.toHaveBeenCalled();
    expect(capture.removeTrack).not.toHaveBeenCalled();
  });

  it('removes non-application audio when display-surface metadata is unavailable', async () => {
    const native = bindings();
    const capture = displayCaptureStream(undefined, ['System Audio']);
    native.getDisplayMedia.mockResolvedValue(capture.stream);
    const host = createTauriNativeHost(native);

    const stream = await host.captureDisplayMedia({ audio: true, video: true });

    expect(capture.audioTracks[0].stop).toHaveBeenCalledOnce();
    expect(capture.removeTrack).toHaveBeenCalledWith(capture.audioTracks[0]);
    expect(stream.getAudioTracks()).toEqual([]);
  });

  it('excludes window audio when capture audio is false or omitted', async () => {
    const native = bindings();
    const host = createTauriNativeHost(native);

    await host.captureDisplayMedia({ audio: false, video: true });
    await host.captureDisplayMedia({ video: true });

    expect(native.getDisplayMedia).toHaveBeenNthCalledWith(1, {
      audio: false,
      video: true,
      windowAudio: 'exclude'
    });
    expect(native.getDisplayMedia).toHaveBeenNthCalledWith(2, {
      video: true,
      windowAudio: 'exclude'
    });
  });

  it('routes desktop updates through typed native bindings', async () => {
    const native = bindings();
    const host = createTauriNativeHost(native);
    const listener = vi.fn();

    await expect(host.getDesktopUpdateState()).resolves.toBe(idleUpdate);
    await expect(host.setDesktopUpdateChannel('nightly')).resolves.toBe(idleUpdate);
    await expect(host.checkForDesktopUpdate()).resolves.toBe(idleUpdate);
    await host.installDesktopUpdate();
    await host.onDesktopUpdateState(listener);

    expect(native.getDesktopUpdateState).toHaveBeenCalledOnce();
    expect(native.setDesktopUpdateChannel).toHaveBeenCalledWith('nightly');
    expect(native.checkForDesktopUpdate).toHaveBeenCalledOnce();
    expect(native.installDesktopUpdate).toHaveBeenCalledOnce();
    expect(native.onDesktopUpdateState).toHaveBeenCalledWith(listener);
  });

  it('routes global push-to-talk through the native shortcut binding', async () => {
    const native = bindings();
    const host = createTauriNativeHost(native);
    const listener = vi.fn();

    await host.registerPushToTalk('Control+Shift+Space', listener);

    expect(native.registerPushToTalk).toHaveBeenCalledWith('Control+Shift+Space', listener);
  });

  it('routes tray actions and lifecycle controls through typed native bindings', async () => {
    const native = bindings();
    const host = createTauriNativeHost(native);
    const listener = vi.fn();
    const controls = { connected: true, muted: false, deafened: true };

    await host.onTrayAction(listener);
    await host.setCallControls(controls);
    await host.quit();

    expect(native.onTrayAction).toHaveBeenCalledWith(listener);
    expect(native.setCallControls).toHaveBeenCalledWith(controls);
    expect(native.quit).toHaveBeenCalledOnce();
  });

  it('routes only registered HTTPS and loopback origins without following redirects', async () => {
    const native = bindings();
    const host = createTauriNativeHost(native);
    const releaseHttps = host.registerServerOrigin('https://chatto.example');
    host.registerServerOrigin('http://127.0.0.1:8080');

    await host.fetch('https://chatto.example/api/connect');
    await host.fetch('http://127.0.0.1:8080/api/connect');

    expect(native.fetch).toHaveBeenNthCalledWith(1, 'https://chatto.example/api/connect', {
      maxRedirections: 0
    });
    expect(native.fetch).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:8080/api/connect', {
      maxRedirections: 0
    });

    releaseHttps();
    await expect(host.fetch('https://chatto.example/api/connect')).rejects.toThrow(
      'Server origin is not registered.'
    );
  });

  it('rejects unregistered HTTPS, WSS, and OAuth destinations', async () => {
    const native = bindings();
    const host = createTauriNativeHost(native);

    await expect(host.fetch('https://chatto.example/api/connect')).rejects.toThrow(
      'Server origin is not registered.'
    );
    expect(() => host.createRealtimeSocket('wss://chatto.example/api/realtime')).toThrow(
      'Server origin is not registered.'
    );
    await expect(
      host.startServerOAuth({
        serverUrl: 'https://chatto.example',
        authorizePath: '/oauth/authorize',
        codeChallenge: 'challenge',
        codeVerifier: 'verifier',
        state: 'state'
      })
    ).rejects.toThrow('Server origin is not registered.');
    expect(native.fetch).not.toHaveBeenCalled();
    expect(native.createRealtimeSocket).not.toHaveBeenCalled();
    expect(native.startServerOAuth).not.toHaveBeenCalled();
  });

  it('maps a registered HTTP origin to its realtime WebSocket origin', () => {
    const native = bindings();
    const host = createTauriNativeHost(native);
    host.registerServerOrigin('https://chatto.example:8443');

    host.createRealtimeSocket('wss://chatto.example:8443/api/realtime');

    expect(native.createRealtimeSocket).toHaveBeenCalledWith(
      'wss://chatto.example:8443/api/realtime'
    );
    expect(() => host.createRealtimeSocket('wss://other.example/api/realtime')).toThrow(
      'Server origin is not registered.'
    );
  });

  it('rejects unsafe HTTP destinations before invoking native code', async () => {
    const native = bindings();
    const host = createTauriNativeHost(native);

    await expect(host.fetch('http://chatto.example/private?token=secret')).rejects.toThrow(
      'HTTP endpoint is not allowed.'
    );
    expect(native.fetch).not.toHaveBeenCalled();
  });

  it('opens only allowed external URLs with the operating system', async () => {
    const native = bindings();
    const host = createTauriNativeHost(native);

    await host.openExternal('https://chatto.example/docs');
    expect(native.openUrl).toHaveBeenCalledWith('https://chatto.example/docs');

    await expect(host.openExternal('file:///C:/Windows/System32')).rejects.toThrow(
      'External URL is not allowed.'
    );
  });
});
