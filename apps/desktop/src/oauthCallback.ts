import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type {
  NativeOAuthCallback,
  NativeOAuthCallbackLabels,
} from "@chatto/native-bridge";

const MAX_QUERY_VALUE_LENGTH = 4096;
const CALLBACK_TIMEOUT_MS = 10 * 60_000;

/** Owns the one-shot loopback receiver used by native OAuth authorization. */
export class OAuthLoopbackReceiver {
  #server: Server | null = null;
  #timeout: NodeJS.Timeout | null = null;
  #onCallback: (callback: NativeOAuthCallback) => void;

  constructor(onCallback: (callback: NativeOAuthCallback) => void) {
    this.#onCallback = onCallback;
  }

  async prepare(labels: NativeOAuthCallbackLabels): Promise<string> {
    await this.close();
    const pathToken = randomBytes(24).toString("base64url");
    const callbackPath = `/oauth/callback/${pathToken}`;
    let consumed = false;

    const server = createServer((request, response) => {
      if (request.method !== "GET" || !request.url) {
        response.writeHead(405, { Allow: "GET" }).end();
        return;
      }

      let requestUrl: URL;
      try {
        requestUrl = new URL(request.url, "http://127.0.0.1");
      } catch {
        response.writeHead(400).end();
        return;
      }
      if (requestUrl.pathname !== callbackPath) {
        response.writeHead(404).end();
        return;
      }
      if (consumed) {
        response
          .writeHead(410, securityHeaders("text/plain; charset=utf-8"))
          .end("Callback already used");
        return;
      }

      const callback = oauthCallbackFromUrl(requestUrl);
      if (!callback) {
        response
          .writeHead(400, securityHeaders("text/plain; charset=utf-8"))
          .end("Invalid callback");
        return;
      }

      consumed = true;
      response
        .writeHead(200, securityHeaders("text/html; charset=utf-8"))
        .end(callbackResponseHtml(labels));
      this.#onCallback(callback);
      setImmediate(() => void this.close());
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 10_000;
    server.maxHeadersCount = 32;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.#server = server;
    server.on("error", () => {
      if (this.#server === server) void this.close();
    });
    this.#timeout = setTimeout(() => void this.close(), CALLBACK_TIMEOUT_MS);
    this.#timeout.unref();

    const address = server.address();
    if (!address || typeof address === "string") {
      await this.close();
      throw new Error("OAuth loopback receiver did not bind a TCP port");
    }
    return `http://127.0.0.1:${address.port}${callbackPath}`;
  }

  async close(): Promise<void> {
    if (this.#timeout) clearTimeout(this.#timeout);
    this.#timeout = null;
    const server = this.#server;
    this.#server = null;
    if (!server?.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export function oauthCallbackFromUrl(url: URL): NativeOAuthCallback | null {
  const code = boundedQueryValue(url.searchParams.get("code"));
  const state = boundedQueryValue(url.searchParams.get("state"));
  const error = boundedQueryValue(url.searchParams.get("error"));
  const errorDescription = boundedQueryValue(
    url.searchParams.get("error_description"),
  );
  if (!state || (!code && !error)) return null;
  return { code, state, error, errorDescription };
}

/**
 * Styles for the loopback success page. Kept as a hashed constant so the page
 * can look polished without weakening the response CSP to `'unsafe-inline'`:
 * {@link callbackStyleHash} pins exactly this block via `style-src 'sha256-…'`.
 */
const CALLBACK_STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; padding: 24px;
    display: grid; place-items: center;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #f4f4f6; color: #1c1d21;
  }
  .card {
    width: 100%; max-width: 400px; text-align: center;
    padding: 40px 32px; border-radius: 16px;
    background: #ffffff; border: 1px solid #e4e4ea;
    box-shadow: 0 12px 40px rgba(20, 20, 40, 0.08);
  }
  .badge {
    width: 64px; height: 64px; margin: 0 auto 20px;
    display: grid; place-items: center; border-radius: 50%;
    background: rgba(34, 197, 94, 0.14);
  }
  .badge svg { width: 32px; height: 32px; stroke: #16a34a; }
  h1 { margin: 0 0 8px; font-size: 20px; font-weight: 600; }
  p { margin: 0; font-size: 14px; line-height: 1.5; opacity: 0.72; }
  @media (prefers-color-scheme: dark) {
    body { background: #1e1f22; color: #e7e7ea; }
    .card { background: #2b2d31; border-color: #3a3c42; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35); }
    .badge svg { stroke: #4ade80; }
  }
`;

/** Base64 SHA-256 of {@link CALLBACK_STYLE}, for the response CSP `style-src`. */
const callbackStyleHash = createHash("sha256")
  .update(CALLBACK_STYLE)
  .digest("base64");

export function callbackResponseHtml(
  labels: NativeOAuthCallbackLabels,
): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(labels.title)}</title>
<style>${CALLBACK_STYLE}</style></head>
<body><main class="card">
  <div class="badge" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
  </div>
  <h1>${escapeHtml(labels.title)}</h1>
  <p>${escapeHtml(labels.message)}</p>
</main></body></html>`;
}

function boundedQueryValue(value: string | null): string | null {
  return value !== null &&
    value.length > 0 &&
    value.length <= MAX_QUERY_VALUE_LENGTH
    ? value
    : null;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function securityHeaders(contentType: string): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; style-src 'sha256-${callbackStyleHash}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
    "Content-Type": contentType,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}
