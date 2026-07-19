import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { protocol } from "electron";

const RENDERER_SCHEME = "chatto-app";

const MIME_TYPES = new Map<string, string>([
  [".avif", "image/avif"],
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".ogg", "audio/ogg"],
  [".onnx", "application/octet-stream"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
  [".webm", "video/webm"],
  [".webmanifest", "application/manifest+json"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

/** Register the renderer scheme before Electron reaches `ready`. */
export function registerPrivilegedRendererScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: RENDERER_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        codeCache: true,
      },
    },
  ]);
}

/** Serve the packaged static frontend from the stable renderer origin. */
export async function installRendererProtocol(
  rendererRoot: string,
): Promise<void> {
  const shellPath = path.join(rendererRoot, "200.html");
  const shell = await readFile(shellPath);
  const securityHeaders = rendererSecurityHeaders(shell.toString("utf8"));

  protocol.handle(RENDERER_SCHEME, async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }

    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response(null, { status: 400 });
    }
    if (url.host !== "app") return new Response(null, { status: 404 });

    const resolved = await resolveRendererAsset(rendererRoot, url.pathname);
    if (!resolved)
      return new Response(null, { status: 404, headers: securityHeaders });

    const contents =
      request.method === "HEAD" ? null : await readFile(resolved);
    return new Response(contents, {
      status: 200,
      headers: {
        ...securityHeaders,
        "Content-Type":
          MIME_TYPES.get(path.extname(resolved).toLowerCase()) ??
          "application/octet-stream",
        "Cache-Control": rendererCacheControl(rendererRoot, resolved),
      },
    });
  });
}

/** Cache content-addressed build assets long-term and revalidate stable names. */
export function rendererCacheControl(
  rendererRoot: string,
  resolvedAsset: string,
): string {
  const relative = path.relative(
    path.resolve(rendererRoot),
    path.resolve(resolvedAsset),
  );
  const immutablePrefix = path.join("_app", "immutable") + path.sep;
  return relative.startsWith(immutablePrefix)
    ? "public, max-age=31536000, immutable"
    : "no-cache";
}

/** Resolve an asset without permitting traversal outside the packaged root. */
export async function resolveRendererAsset(
  rendererRoot: string,
  pathname: string,
): Promise<string | null> {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decodedPath.includes("\0")) return null;

  const root = path.resolve(rendererRoot);
  const relative = decodedPath.replace(/^\/+/, "");
  const candidate = path.resolve(root, relative || "200.html");
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return null;
  if (await isFile(candidate)) return candidate;

  // Unknown extension-bearing URLs are failed assets, not SPA navigations.
  if (path.extname(relative)) return null;
  const fallback = path.join(root, "200.html");
  return (await isFile(fallback)) ? fallback : null;
}

/**
 * Build the renderer security headers.
 *
 * The CSP is served **report-only**, matching the web frontend
 * (`cli/internal/http_server/frontend.go`). Enforcement is deliberately not
 * viable for the multi-server client (ADR-025), and enforcing it here diverged
 * from the web and broke first-party UI: `require-trusted-types-for 'script'`
 * blocks the message composer (TipTap/ProseMirror assign to the `innerHTML`
 * Trusted Types sink with no allowed policy). Report-only surfaces the same
 * violations without blocking, so the native shell behaves like the web.
 *
 * The hashes still describe the generated shell's inline scripts so the
 * reported policy stays meaningful.
 */
export function rendererSecurityHeaders(
  shellHtml: string,
): Record<string, string> {
  const hashes = inlineScriptHashes(shellHtml);
  const scriptSources = [
    "'self'",
    ...hashes.map((hash) => `'sha256-${hash}'`),
  ].join(" ");
  const contentSecurityPolicy = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    `script-src ${scriptSources}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob: http: https:",
    "media-src 'self' blob: http: https:",
    "connect-src 'self' http: https: ws: wss:",
    "frame-src https://www.youtube-nocookie.com",
    "worker-src 'self' blob:",
    "require-trusted-types-for 'script'",
    "trusted-types chatto-markdown-html",
  ].join("; ");

  return {
    "Content-Security-Policy-Report-Only": contentSecurityPolicy,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy":
      "camera=(self), microphone=(self), display-capture=(self)",
    // Match the web frontend (frontend.go). `no-referrer` diverged and could
    // break Referer-origin hotlink protection on avatars/attachments.
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    // The CSP is report-only (see above), so its `frame-ancestors 'none'` no
    // longer enforces. Match the web frontend's enforced anti-framing header.
    "X-Frame-Options": "DENY",
  };
}

export function inlineScriptHashes(shellHtml: string): string[] {
  const hashes: string[] = [];
  const scriptPattern = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of shellHtml.matchAll(scriptPattern)) {
    hashes.push(
      createHash("sha256")
        .update(match[1] ?? "")
        .digest("base64"),
    );
  }
  return hashes;
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}
