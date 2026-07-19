import { describe, expect, it } from "vitest";
import {
  isAllowedRendererPermission,
  isRendererUrl,
  isSafeExternalUrl,
  normalizeServerOrigin,
  normalizeServerOrigins,
} from "./validation.js";

describe("renderer permission policy", () => {
  it("allows capture and selected speaker output but rejects unrelated privileges", () => {
    expect(isAllowedRendererPermission("media")).toBe(true);
    expect(isAllowedRendererPermission("display-capture")).toBe(true);
    expect(isAllowedRendererPermission("speaker-selection")).toBe(true);
    expect(isAllowedRendererPermission("openExternal")).toBe(false);
    expect(isAllowedRendererPermission("notifications")).toBe(false);
  });
});

describe("server origin validation", () => {
  it("normalizes HTTP(S) URLs to exact origins", () => {
    expect(normalizeServerOrigin("https://chat.example.com/path?q=1")).toBe(
      "https://chat.example.com",
    );
    expect(normalizeServerOrigin("http://localhost:4173/")).toBe(
      "http://localhost:4173",
    );
  });

  it("rejects credentials and non-network schemes", () => {
    expect(normalizeServerOrigin("https://user:secret@example.com")).toBeNull();
    expect(normalizeServerOrigin("file:///tmp/app")).toBeNull();
    expect(normalizeServerOrigin("javascript:alert(1)")).toBeNull();
  });

  it("deduplicates and bounds origin arrays", () => {
    expect(
      normalizeServerOrigins(["https://a.example", "https://a.example/path"]),
    ).toEqual(["https://a.example"]);
    expect(
      normalizeServerOrigins(new Array(65).fill("https://a.example")),
    ).toBeNull();
  });
});

describe("renderer and external URL validation", () => {
  it("recognizes only the bundled renderer origin", () => {
    expect(isRendererUrl("chatto-app://app/chat/example")).toBe(true);
    expect(isRendererUrl("chatto-app://other/chat/example")).toBe(false);
    expect(isRendererUrl("https://app/chat/example")).toBe(false);
  });

  it("allows only credential-free HTTP(S) external URLs", () => {
    expect(isSafeExternalUrl("https://example.com/path")).toBe(true);
    expect(isSafeExternalUrl("https://user:secret@example.com")).toBe(false);
    expect(isSafeExternalUrl("chatto://join")).toBe(false);
  });
});
