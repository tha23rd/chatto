import type { Session, WebFrameMain } from "electron";
import { NATIVE_RENDERER_ORIGIN } from "@chatto/native-bridge";
import { normalizeServerOrigin, normalizeServerOrigins } from "./validation.js";

const DEFAULT_PROBE_TTL_MS = 60_000;
const DEFAULT_OAUTH_TTL_MS = 20 * 60_000;
export const SERVER_DISCOVERY_PATH =
  "/api/connect/chatto.discovery.v1.ServerDiscoveryService/GetServer";
export const OAUTH_TOKEN_PATH = "/oauth/token";
const FALLBACK_ALLOWED_HEADERS = [
  "Authorization",
  "Content-Type",
  "Connect-Protocol-Version",
  "Connect-Timeout-Ms",
  "Grpc-Timeout",
  "X-Chatto-Asset-Proxy",
].join(", ");

type RequestHeaders = Record<string, string>;
type ResponseHeaders = Record<string, string[]>;

/** Exact-origin allowlist for the renderer's remote server traffic. */
export class RegisteredOriginPolicy {
  #registered = new Set<string>();
  #probes = new Map<string, number>();
  #oauthFlows = new Map<string, number>();

  setRegistered(value: unknown): boolean {
    const origins = normalizeServerOrigins(value);
    if (!origins) return false;
    this.#registered = new Set(origins);
    return true;
  }

  allowProbe(value: unknown, now = Date.now()): boolean {
    return this.#allowTemporarily(
      this.#probes,
      value,
      now + DEFAULT_PROBE_TTL_MS,
    );
  }

  allowOAuthFlow(value: unknown, now = Date.now()): boolean {
    const origin = normalizeServerOrigin(value);
    if (!origin || !this.#canStartOAuth(origin, now)) return false;
    this.#oauthFlows.set(origin, now + DEFAULT_OAUTH_TTL_MS);
    return true;
  }

  /** Whether a concrete request is inside its grant's deliberately narrow scope. */
  isAllowedRequest(
    urlValue: string,
    method: string,
    now = Date.now(),
  ): boolean {
    const origin = serverOriginForRequestUrl(urlValue);
    if (!origin) return false;
    if (this.#registered.has(origin)) return true;

    let url: URL;
    try {
      url = new URL(urlValue);
    } catch {
      return false;
    }
    if (url.protocol === "ws:" || url.protocol === "wss:") return false;
    const normalizedMethod = method.toUpperCase();
    if (
      this.#isTemporaryGrantActive(this.#probes, origin, now) &&
      url.pathname === SERVER_DISCOVERY_PATH &&
      (normalizedMethod === "GET" ||
        normalizedMethod === "POST" ||
        normalizedMethod === "OPTIONS")
    ) {
      return true;
    }
    return (
      this.#isTemporaryGrantActive(this.#oauthFlows, origin, now) &&
      url.pathname === OAUTH_TOKEN_PATH &&
      (normalizedMethod === "POST" || normalizedMethod === "OPTIONS")
    );
  }

  /** Authorization pages may open only after the matching OAuth grant exists. */
  isOAuthOrigin(value: unknown, now = Date.now()): boolean {
    const origin = normalizeServerOrigin(value);
    return origin
      ? this.#isTemporaryGrantActive(this.#oauthFlows, origin, now)
      : false;
  }

  get registeredOrigins(): ReadonlySet<string> {
    return this.#registered;
  }

  #canStartOAuth(origin: string, now: number): boolean {
    return (
      this.#registered.has(origin) ||
      this.#isTemporaryGrantActive(this.#probes, origin, now)
    );
  }

  #allowTemporarily(
    grants: Map<string, number>,
    value: unknown,
    expiresAt: number,
  ): boolean {
    const origin = normalizeServerOrigin(value);
    if (!origin) return false;
    grants.set(origin, expiresAt);
    return true;
  }

  #isTemporaryGrantActive(
    grants: Map<string, number>,
    origin: string,
    now: number,
  ): boolean {
    const expiresAt = grants.get(origin);
    if (expiresAt === undefined) return false;
    if (expiresAt > now) return true;
    grants.delete(origin);
    return false;
  }
}

/**
 * Make a registered server request appear same-origin to that server.
 *
 * This is required for WebSocket upgrades: their origin is checked before an
 * HTTP response exists, so response-only CORS rewriting cannot repair them.
 */
export function rewriteOutgoingOrigin(
  url: string,
  method: string,
  headers: RequestHeaders,
  policy: RegisteredOriginPolicy,
): RequestHeaders {
  const targetOrigin = serverOriginForRequestUrl(url);
  if (!targetOrigin) return headers;
  if (!policy.isAllowedRequest(url, method)) return headers;

  const originHeader = findHeaderName(headers, "origin");
  if (!originHeader) return headers;
  return { ...headers, [originHeader]: targetOrigin };
}

/** Reflect the bundled renderer origin on responses from an allowed server. */
export function rewriteCorsResponseHeaders(
  headers: ResponseHeaders,
  requestedHeaders?: string,
): ResponseHeaders {
  const result = { ...headers };
  setResponseHeader(result, "Access-Control-Allow-Origin", [
    NATIVE_RENDERER_ORIGIN,
  ]);
  setResponseHeader(result, "Access-Control-Allow-Credentials", ["true"]);
  setResponseHeader(result, "Access-Control-Allow-Methods", [
    "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
  ]);
  setResponseHeader(result, "Access-Control-Allow-Headers", [
    normalizeRequestedHeaders(requestedHeaders) ?? FALLBACK_ALLOWED_HEADERS,
  ]);

  const existingVary = responseHeader(result, "vary")?.join(", ") ?? "";
  const varyTokens = new Set(
    existingVary
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean),
  );
  varyTokens.add("Origin");
  setResponseHeader(result, "Vary", [[...varyTokens].join(", ")]);
  return result;
}

/** Install exact-origin request/response hooks on the renderer session. */
export function installCorsShim(
  session: Session,
  policy: RegisteredOriginPolicy,
  rendererTarget: () => {
    webContentsId: number;
    mainFrame: WebFrameMain;
  } | null,
): void {
  const preflightHeaders = new Map<number, string>();
  const filter = {
    urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"],
  };

  session.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    if (!isRendererMainFrameRequest(details, rendererTarget())) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }

    const origin = serverOriginForRequestUrl(details.url);
    if (!origin) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    if (!policy.isAllowedRequest(details.url, details.method)) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }

    if (details.method === "OPTIONS") {
      const requested = requestHeader(
        details.requestHeaders,
        "access-control-request-headers",
      );
      if (requested) preflightHeaders.set(details.id, requested);
    }

    callback({
      requestHeaders: rewriteOutgoingOrigin(
        details.url,
        details.method,
        details.requestHeaders,
        policy,
      ),
    });
  });

  session.webRequest.onHeadersReceived(filter, (details, callback) => {
    if (!isRendererMainFrameRequest(details, rendererTarget())) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }

    const origin = serverOriginForRequestUrl(details.url);
    if (!origin) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    if (!policy.isAllowedRequest(details.url, details.method)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }

    const requested = preflightHeaders.get(details.id);
    preflightHeaders.delete(details.id);
    callback({
      responseHeaders: rewriteCorsResponseHeaders(
        details.responseHeaders ?? {},
        requested,
      ),
    });
  });

  session.webRequest.onErrorOccurred(filter, (details) => {
    preflightHeaders.delete(details.id);
  });
}

function isRendererMainFrameRequest(
  details: { webContentsId?: number; frame?: WebFrameMain | null },
  target: { webContentsId: number; mainFrame: WebFrameMain } | null,
): boolean {
  return (
    target !== null &&
    details.webContentsId === target.webContentsId &&
    details.frame === target.mainFrame
  );
}

/** Map WebSocket URLs back to the owning HTTP(S) server origin. */
export function serverOriginForRequestUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol === "ws:") url.protocol = "http:";
    else if (url.protocol === "wss:") url.protocol = "https:";
    return normalizeServerOrigin(url.origin);
  } catch {
    return null;
  }
}

function requestHeader(
  headers: RequestHeaders,
  name: string,
): string | undefined {
  const key = findHeaderName(headers, name);
  return key ? headers[key] : undefined;
}

function findHeaderName(
  headers: Record<string, unknown>,
  name: string,
): string | undefined {
  const lowerName = name.toLowerCase();
  return Object.keys(headers).find((key) => key.toLowerCase() === lowerName);
}

function responseHeader(
  headers: ResponseHeaders,
  name: string,
): string[] | undefined {
  const key = findHeaderName(headers, name);
  return key ? headers[key] : undefined;
}

function setResponseHeader(
  headers: ResponseHeaders,
  name: string,
  value: string[],
): void {
  const existingName = findHeaderName(headers, name);
  if (existingName && existingName !== name) delete headers[existingName];
  headers[name] = value;
}

function normalizeRequestedHeaders(value: string | undefined): string | null {
  if (!value || value.length > 2048) return null;
  const tokens = value
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  if (
    tokens.length === 0 ||
    tokens.some((token) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(token))
  ) {
    return null;
  }
  return tokens.join(", ");
}
