import compare from 'semver/functions/compare.js';
import valid from 'semver/functions/valid.js';

export const MINIMUM_SUPPORTED_SERVER_VERSION = '0.5.0-0';

const serverFeatureMinimumVersions = {
  adminApi: '0.5.0-0',
  messageSearch: '0.5.0-0',
  realtimeProjection: '0.5.0-0',
  roomManagement: '0.5.0-0'
} as const;

export type ServerFeature = keyof typeof serverFeatureMinimumVersions;

export type ServerCompatibilityStatus =
  'supported' | 'unsupported' | 'unknown' | 'unreachable';

export type ServerCompatibilityReason =
  | 'version-confirmed'
  | 'server-too-old'
  | 'server-version-unknown'
  | 'unreachable';

export type ServerCompatibilityResult = {
  status: ServerCompatibilityStatus;
  reason: ServerCompatibilityReason;
};

export type ServerCompatibilityInput = {
  serverVersion: string;
  unreachable?: boolean;
};

export function compareReleaseVersions(left: string, right: string): number | null {
  const parsedLeft = valid(left.trim());
  const parsedRight = valid(right.trim());
  if (!parsedLeft || !parsedRight) return null;
  return compare(parsedLeft, parsedRight);
}

export function evaluateServerCompatibility(
  input: ServerCompatibilityInput
): ServerCompatibilityResult {
  if (input.unreachable) {
    return { status: 'unreachable', reason: 'unreachable' };
  }

  const comparison = compareReleaseVersions(input.serverVersion, MINIMUM_SUPPORTED_SERVER_VERSION);
  if (comparison === null) {
    return { status: 'unknown', reason: 'server-version-unknown' };
  }
  if (comparison === -1) {
    return { status: 'unsupported', reason: 'server-too-old' };
  }

  return { status: 'supported', reason: 'version-confirmed' };
}

/**
 * Whether a server positively declared a protocol capability.
 *
 * Release-version gating (`supportsServerFeature`) covers features that exist
 * in upstream Chatto releases. Capabilities cover protocol features specific to
 * this distribution, which a release version cannot distinguish from an
 * upstream release carrying the same version.
 *
 * Returns `null` when the server advertised no capability list at all, so
 * callers can tell "not supported" apart from "not yet discovered".
 */
export function hasProtocolCapability(
  capabilities: string[] | null,
  capability: string
): boolean | null {
  if (capabilities === null) return null;
  return capabilities.includes(capability);
}

export function supportsServerFeature(serverVersion: string, feature: ServerFeature): boolean {
  const comparison = compareReleaseVersions(
    serverVersion,
    serverFeatureMinimumVersions[feature]
  );
  return comparison !== null && comparison >= 0;
}
