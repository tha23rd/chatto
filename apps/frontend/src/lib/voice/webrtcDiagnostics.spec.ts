import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ScreenShareDiagnosticsCollector,
  normalizeScreenShareStats,
  type RTCStatsReportLike
} from './webrtcDiagnostics';

function report(...stats: Array<Record<string, unknown>>): RTCStatsReportLike {
  const values = new Map(stats.map((stat, index) => [String(stat.id ?? index), stat]));
  return {
    forEach(callback) {
      values.forEach((value) => callback(value));
    }
  };
}

function videoReport(overrides: Record<string, unknown> = {}): RTCStatsReportLike {
  return report(
    {
      id: 'outbound-video',
      type: 'outbound-rtp',
      kind: 'video',
      timestamp: 1_000,
      bytesSent: 1_000,
      codecId: 'codec',
      mediaSourceId: 'source',
      remoteId: 'remote',
      framesEncoded: 30,
      framesSent: 28,
      framesDropped: 2,
      totalEncodeTime: 0.3,
      qualityLimitationReason: 'cpu',
      packetsSent: 100,
      retransmittedPacketsSent: 5,
      ...overrides
    },
    {
      id: 'codec',
      type: 'codec',
      mimeType: 'video/VP9'
    },
    {
      id: 'source',
      type: 'media-source',
      kind: 'video',
      width: 1920,
      height: 1080,
      framesPerSecond: 60
    },
    {
      id: 'remote',
      type: 'remote-inbound-rtp',
      localId: 'outbound-video',
      roundTripTime: 0.04
    }
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('normalizeScreenShareStats', () => {
  it('normalizes safe outbound metrics and computes rate deltas', () => {
    const first = normalizeScreenShareStats(videoReport(), null, 10_000);
    const second = normalizeScreenShareStats(
      videoReport({
        timestamp: 3_000,
        bytesSent: 501_000,
        framesEncoded: 90,
        framesSent: 86,
        framesDropped: 4,
        totalEncodeTime: 0.9,
        packetsSent: 300,
        retransmittedPacketsSent: 8,
        qualityLimitationReason: 'bandwidth'
      }),
      first,
      12_000
    );

    expect(first).toMatchObject({
      sampledAtMs: 10_000,
      reportTimestampMs: 1_000,
      bitrateBps: null,
      codec: 'video/VP9',
      frameWidth: 1920,
      frameHeight: 1080,
      framesPerSecond: 60,
      framesEncoded: 30,
      framesSent: 28,
      framesDropped: 2,
      averageEncodeTimeMs: null,
      qualityLimitationReason: 'cpu',
      packetsSent: 100,
      retransmittedPacketsSent: 5,
      roundTripTimeMs: 40
    });
    expect(second).toMatchObject({
      sampledAtMs: 12_000,
      bitrateBps: 2_000_000,
      averageEncodeTimeMs: 10,
      qualityLimitationReason: 'bandwidth',
      packetsSent: 300,
      retransmittedPacketsSent: 8
    });
  });

  it('preserves unavailable and unknown values as null instead of zero', () => {
    const empty = normalizeScreenShareStats(report(), null, 20_000);
    const malformed = normalizeScreenShareStats(
      videoReport({
        bytesSent: Number.POSITIVE_INFINITY,
        framesEncoded: -1,
        framesDropped: 0,
        qualityLimitationReason: 'mystery'
      }),
      null,
      21_000
    );

    expect(empty).toEqual({
      sampledAtMs: 20_000,
      reportTimestampMs: null,
      bytesSent: null,
      bitrateBps: null,
      codec: null,
      frameWidth: null,
      frameHeight: null,
      framesPerSecond: null,
      framesEncoded: null,
      framesSent: null,
      framesDropped: null,
      totalEncodeTimeSeconds: null,
      averageEncodeTimeMs: null,
      qualityLimitationReason: null,
      packetsSent: null,
      retransmittedPacketsSent: null,
      roundTripTimeMs: null
    });
    expect(malformed.bytesSent).toBeNull();
    expect(malformed.framesEncoded).toBeNull();
    expect(malformed.framesDropped).toBe(0);
    expect(malformed.qualityLimitationReason).toBeNull();
  });
});

describe('ScreenShareDiagnosticsCollector', () => {
  it('samples immediately, bounds history, and stops without retaining a timer', async () => {
    vi.useFakeTimers();
    let sequence = 0;
    const readReport = vi.fn(async () =>
      videoReport({ timestamp: ++sequence * 1_000, bytesSent: sequence * 10_000 })
    );
    const onUpdate = vi.fn();
    const collector = new ScreenShareDiagnosticsCollector(onUpdate, {
      intervalMs: 100,
      historyLimit: 2
    });

    collector.start(readReport);
    await vi.advanceTimersByTimeAsync(250);

    expect(readReport).toHaveBeenCalledTimes(3);
    expect(collector.snapshot.history).toHaveLength(2);
    expect(collector.snapshot.latest).toBe(collector.snapshot.history[1]);

    collector.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(readReport).toHaveBeenCalledTimes(3);
  });

  it('ignores a stats read that resolves after collection stops', async () => {
    let resolve!: (value: RTCStatsReportLike) => void;
    const pending = new Promise<RTCStatsReportLike>((res) => {
      resolve = res;
    });
    const collector = new ScreenShareDiagnosticsCollector(vi.fn(), {
      intervalMs: 60_000,
      historyLimit: 2
    });

    collector.start(() => pending);
    collector.stop();
    resolve(videoReport());
    await pending;
    await Promise.resolve();

    expect(collector.snapshot.latest).toBeNull();
    expect(collector.snapshot.history).toEqual([]);
  });
});
