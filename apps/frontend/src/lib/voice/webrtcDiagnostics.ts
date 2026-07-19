export type ScreenShareQualityLimitation = 'none' | 'cpu' | 'bandwidth' | 'other';

export interface RTCStatsRecordLike {
  readonly [key: string]: unknown;
}

export interface RTCStatsReportLike {
  forEach(callback: (value: RTCStatsRecordLike) => void): void;
}

export interface ScreenShareDiagnosticsSample {
  readonly sampledAtMs: number;
  readonly reportTimestampMs: number | null;
  readonly bytesSent: number | null;
  readonly bitrateBps: number | null;
  readonly codec: string | null;
  readonly frameWidth: number | null;
  readonly frameHeight: number | null;
  readonly framesPerSecond: number | null;
  readonly framesEncoded: number | null;
  readonly framesSent: number | null;
  readonly framesDropped: number | null;
  readonly totalEncodeTimeSeconds: number | null;
  readonly averageEncodeTimeMs: number | null;
  readonly qualityLimitationReason: ScreenShareQualityLimitation | null;
  readonly packetsSent: number | null;
  readonly retransmittedPacketsSent: number | null;
  readonly roundTripTimeMs: number | null;
}

export interface ScreenShareDiagnosticsSnapshot {
  readonly latest: ScreenShareDiagnosticsSample | null;
  readonly history: readonly ScreenShareDiagnosticsSample[];
}

export const EMPTY_SCREEN_SHARE_DIAGNOSTICS: ScreenShareDiagnosticsSnapshot = {
  latest: null,
  history: []
};

const EMPTY_STATS_REPORT: RTCStatsReportLike = {
  forEach() {}
};

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function statString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function qualityLimitation(value: unknown): ScreenShareQualityLimitation | null {
  return value === 'none' || value === 'cpu' || value === 'bandwidth' || value === 'other'
    ? value
    : null;
}

function rounded(value: number | null, digits = 3): number | null {
  if (value === null) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function deltaRate(
  currentValue: number | null,
  previousValue: number | null,
  currentTimestampMs: number | null,
  previousTimestampMs: number | null,
  scale: number
): number | null {
  if (
    currentValue === null ||
    previousValue === null ||
    currentTimestampMs === null ||
    previousTimestampMs === null
  ) {
    return null;
  }
  const elapsedMs = currentTimestampMs - previousTimestampMs;
  const delta = currentValue - previousValue;
  if (elapsedMs <= 0 || delta < 0) return null;
  return (delta * scale) / elapsedMs;
}

function collectStats(report: RTCStatsReportLike): RTCStatsRecordLike[] {
  const stats: RTCStatsRecordLike[] = [];
  report.forEach((stat) => stats.push(stat));
  return stats;
}

/** Normalize a browser/WebView2 stats report without inventing unavailable values. */
export function normalizeScreenShareStats(
  report: RTCStatsReportLike,
  previous: ScreenShareDiagnosticsSample | null,
  sampledAtMs = Date.now()
): ScreenShareDiagnosticsSample {
  const stats = collectStats(report);
  const outboundCandidates = stats.filter(
    (stat) =>
      stat.type === 'outbound-rtp' &&
      (stat.kind === 'video' || stat.mediaType === 'video') &&
      stat.isRemote !== true
  );
  const outbound =
    outboundCandidates.sort(
      (left, right) =>
        (finiteNonNegative(right.bytesSent) ?? -1) - (finiteNonNegative(left.bytesSent) ?? -1)
    )[0] ?? null;

  const reportTimestampMs = finiteNonNegative(outbound?.timestamp);
  const bytesSent = finiteNonNegative(outbound?.bytesSent);
  const framesEncoded = finiteNonNegative(outbound?.framesEncoded);
  const totalEncodeTimeSeconds = finiteNonNegative(outbound?.totalEncodeTime);
  const codecId = statString(outbound?.codecId);
  const mediaSourceId = statString(outbound?.mediaSourceId);
  const outboundId = statString(outbound?.id);
  const remoteId = statString(outbound?.remoteId);
  const codecStat = codecId ? stats.find((stat) => stat.id === codecId) : undefined;
  const sourceStat = mediaSourceId ? stats.find((stat) => stat.id === mediaSourceId) : undefined;
  const remoteStat = remoteId
    ? stats.find((stat) => stat.id === remoteId)
    : stats.find(
        (stat) => stat.type === 'remote-inbound-rtp' && outboundId && stat.localId === outboundId
      );
  const roundTripTimeSeconds = finiteNonNegative(remoteStat?.roundTripTime);

  const bitrate = deltaRate(
    bytesSent,
    previous?.bytesSent ?? null,
    reportTimestampMs,
    previous?.reportTimestampMs ?? null,
    8_000
  );
  const encodedFrameDelta =
    framesEncoded !== null &&
    previous?.framesEncoded !== null &&
    previous?.framesEncoded !== undefined
      ? framesEncoded - previous.framesEncoded
      : null;
  const encodeTimeDelta =
    totalEncodeTimeSeconds !== null &&
    previous?.totalEncodeTimeSeconds !== null &&
    previous?.totalEncodeTimeSeconds !== undefined
      ? totalEncodeTimeSeconds - previous.totalEncodeTimeSeconds
      : null;
  const averageEncodeTimeMs =
    encodedFrameDelta !== null &&
    encodeTimeDelta !== null &&
    encodedFrameDelta > 0 &&
    encodeTimeDelta >= 0
      ? (encodeTimeDelta * 1_000) / encodedFrameDelta
      : null;

  return {
    sampledAtMs,
    reportTimestampMs,
    bytesSent,
    bitrateBps: rounded(bitrate, 0),
    codec: statString(codecStat?.mimeType),
    frameWidth: finiteNonNegative(sourceStat?.width ?? outbound?.frameWidth),
    frameHeight: finiteNonNegative(sourceStat?.height ?? outbound?.frameHeight),
    framesPerSecond: finiteNonNegative(sourceStat?.framesPerSecond ?? outbound?.framesPerSecond),
    framesEncoded,
    framesSent: finiteNonNegative(outbound?.framesSent),
    framesDropped: finiteNonNegative(outbound?.framesDropped ?? sourceStat?.framesDropped),
    totalEncodeTimeSeconds,
    averageEncodeTimeMs: rounded(averageEncodeTimeMs),
    qualityLimitationReason: qualityLimitation(outbound?.qualityLimitationReason),
    packetsSent: finiteNonNegative(outbound?.packetsSent),
    retransmittedPacketsSent: finiteNonNegative(outbound?.retransmittedPacketsSent),
    roundTripTimeMs: rounded(roundTripTimeSeconds === null ? null : roundTripTimeSeconds * 1_000, 3)
  };
}

export interface ScreenShareDiagnosticsCollectorOptions {
  readonly intervalMs?: number;
  readonly historyLimit?: number;
}

type StatsReader = () => Promise<RTCStatsReportLike | undefined>;

/** Low-frequency, bounded screen-share telemetry for local acceptance tuning. */
export class ScreenShareDiagnosticsCollector {
  readonly #onUpdate: (snapshot: ScreenShareDiagnosticsSnapshot) => void;
  readonly #intervalMs: number;
  readonly #historyLimit: number;
  #history: ScreenShareDiagnosticsSample[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #generation = 0;
  #readInFlight = false;
  #readReport: StatsReader | null = null;

  constructor(
    onUpdate: (snapshot: ScreenShareDiagnosticsSnapshot) => void,
    options: ScreenShareDiagnosticsCollectorOptions = {}
  ) {
    this.#onUpdate = onUpdate;
    this.#intervalMs = Math.max(1, options.intervalMs ?? 5_000);
    this.#historyLimit = Math.max(1, options.historyLimit ?? 12);
  }

  get snapshot(): ScreenShareDiagnosticsSnapshot {
    return {
      latest: this.#history.at(-1) ?? null,
      history: [...this.#history]
    };
  }

  start(readReport: StatsReader): void {
    this.stop();
    this.#history = [];
    this.#readReport = readReport;
    const generation = ++this.#generation;
    this.#onUpdate(this.snapshot);
    void this.#collect(generation);
    this.#timer = setInterval(() => {
      void this.#collect(generation);
    }, this.#intervalMs);
  }

  stop(): void {
    this.#generation += 1;
    this.#readReport = null;
    this.#readInFlight = false;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async #collect(generation: number): Promise<void> {
    if (generation !== this.#generation || this.#readInFlight || !this.#readReport) return;
    this.#readInFlight = true;
    const readReport = this.#readReport;
    try {
      const report = (await readReport()) ?? EMPTY_STATS_REPORT;
      if (generation !== this.#generation) return;
      const sample = normalizeScreenShareStats(report, this.#history.at(-1) ?? null);
      this.#history = [...this.#history, sample].slice(-this.#historyLimit);
      this.#onUpdate(this.snapshot);
    } catch {
      if (generation !== this.#generation) return;
      const sample = normalizeScreenShareStats(EMPTY_STATS_REPORT, this.#history.at(-1) ?? null);
      this.#history = [...this.#history, sample].slice(-this.#historyLimit);
      this.#onUpdate(this.snapshot);
    } finally {
      if (generation === this.#generation) this.#readInFlight = false;
    }
  }
}
