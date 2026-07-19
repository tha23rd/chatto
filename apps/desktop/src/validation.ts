import { NATIVE_RENDERER_ORIGIN } from "@chatto/native-bridge";

export const MAX_REGISTERED_ORIGINS = 64;

const ALLOWED_RENDERER_PERMISSIONS = new Set([
  "clipboard-sanitized-write",
  "display-capture",
  "fullscreen",
  "media",
  "speaker-selection",
]);

/** Permissions the fixed, first-party renderer may request from Chromium. */
export function isAllowedRendererPermission(value: string): boolean {
  return ALLOWED_RENDERER_PERMISSIONS.has(value);
}

export function normalizeServerOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function normalizeServerOrigins(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_REGISTERED_ORIGINS)
    return null;
  const origins = new Set<string>();
  for (const candidate of value) {
    const origin = normalizeServerOrigin(candidate);
    if (!origin) return null;
    origins.add(origin);
  }
  return [...origins];
}

export function isRendererUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}` === NATIVE_RENDERER_ORIGIN;
  } catch {
    return false;
  }
}

export function boundedString(
  value: unknown,
  maxLength: number,
): string | null {
  return typeof value === "string" && value.length <= maxLength ? value : null;
}

export function boundedNonEmptyString(
  value: unknown,
  maxLength: number,
): string | null {
  const string = boundedString(value, maxLength)?.trim();
  return string ? string : null;
}

export function finiteInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value >= minimum && value <= maximum ? value : null;
}

export function isSafeExternalUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
