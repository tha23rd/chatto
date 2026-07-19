import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  inlineScriptHashes,
  rendererCacheControl,
  rendererSecurityHeaders,
  resolveRendererAsset,
} from "./appProtocol.js";

describe("renderer cache policy", () => {
  it("caches hashed build assets but revalidates stable app metadata", () => {
    const root = path.join(os.tmpdir(), "chatto-renderer-cache");
    expect(
      rendererCacheControl(
        root,
        path.join(root, "_app", "immutable", "chunks", "app.abc123.js"),
      ),
    ).toBe("public, max-age=31536000, immutable");
    expect(
      rendererCacheControl(root, path.join(root, "_app", "version.json")),
    ).toBe("no-cache");
    expect(rendererCacheControl(root, path.join(root, "200.html"))).toBe(
      "no-cache",
    );
  });
});

describe("renderer protocol policy", () => {
  it("hashes inline scripts into a report-only policy matching the web", () => {
    const html =
      '<script>window.answer = 42;</script><script src="/app.js"></script>';
    const hashes = inlineScriptHashes(html);
    expect(hashes).toHaveLength(1);
    const headers = rendererSecurityHeaders(html);
    // Report-only, matching the web frontend (frontend.go). Enforcing the CSP
    // here blocked the composer via Trusted Types; report-only surfaces the
    // same violations without breaking first-party UI.
    expect(headers["Content-Security-Policy"]).toBeUndefined();
    expect(headers["Content-Security-Policy-Report-Only"]).toContain(
      `'sha256-${hashes[0]}'`,
    );
    expect(headers["Content-Security-Policy-Report-Only"]).not.toContain(
      "script-src 'self' 'unsafe-inline'",
    );
    expect(headers["Content-Security-Policy-Report-Only"]).toContain(
      "object-src 'none'",
    );
  });

  it("serves real assets, falls back for routes, and rejects traversal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "chatto-renderer-test-"));
    await writeFile(path.join(root, "200.html"), "<!doctype html>");
    await writeFile(path.join(root, "app.js"), "export {};");

    expect(await resolveRendererAsset(root, "/app.js")).toBe(
      path.join(root, "app.js"),
    );
    expect(await resolveRendererAsset(root, "/chat/example/room")).toBe(
      path.join(root, "200.html"),
    );
    expect(await resolveRendererAsset(root, "/missing.js")).toBeNull();
    expect(await resolveRendererAsset(root, "/%2e%2e/secret.txt")).toBeNull();
  });
});
