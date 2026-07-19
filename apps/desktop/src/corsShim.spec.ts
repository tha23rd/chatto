import { describe, expect, it } from "vitest";
import {
  OAUTH_TOKEN_PATH,
  RegisteredOriginPolicy,
  SERVER_DISCOVERY_PATH,
  rewriteCorsResponseHeaders,
  rewriteOutgoingOrigin,
} from "./corsShim.js";

describe("RegisteredOriginPolicy", () => {
  it("allows every path only for registered origins", () => {
    const policy = new RegisteredOriginPolicy();
    expect(policy.setRegistered(["https://one.example/path"])).toBe(true);
    expect(
      policy.isAllowedRequest("https://one.example/api/private", "POST"),
    ).toBe(true);
    expect(policy.isAllowedRequest("wss://one.example/realtime", "GET")).toBe(
      true,
    );
    expect(policy.isAllowedRequest("https://two.example/api", "GET")).toBe(
      false,
    );
  });

  it("limits a temporary probe to the public discovery RPC", () => {
    const policy = new RegisteredOriginPolicy();
    expect(policy.allowProbe("https://two.example", 1_000)).toBe(true);
    expect(
      policy.isAllowedRequest(
        `https://two.example${SERVER_DISCOVERY_PATH}`,
        "POST",
        1_001,
      ),
    ).toBe(true);
    expect(
      policy.isAllowedRequest("https://two.example/api/private", "GET", 1_001),
    ).toBe(false);
    expect(
      policy.isAllowedRequest(
        `wss://two.example${SERVER_DISCOVERY_PATH}`,
        "GET",
        1_001,
      ),
    ).toBe(false);
    expect(
      policy.isAllowedRequest(
        `https://two.example${SERVER_DISCOVERY_PATH}`,
        "POST",
        61_001,
      ),
    ).toBe(false);
  });

  it("requires a probe or registration and limits OAuth to token exchange", () => {
    const policy = new RegisteredOriginPolicy();
    expect(policy.allowOAuthFlow("https://two.example", 1_000)).toBe(false);
    expect(policy.allowProbe("https://two.example", 1_000)).toBe(true);
    expect(policy.allowOAuthFlow("https://two.example", 1_001)).toBe(true);
    expect(policy.isOAuthOrigin("https://two.example", 1_002)).toBe(true);
    expect(
      policy.isAllowedRequest(
        `https://two.example${OAUTH_TOKEN_PATH}`,
        "OPTIONS",
        1_002,
      ),
    ).toBe(true);
    expect(
      policy.isAllowedRequest("https://two.example/account", "GET", 1_002),
    ).toBe(false);
  });

  it("leaves the previous allowlist intact after invalid input", () => {
    const policy = new RegisteredOriginPolicy();
    policy.setRegistered(["https://one.example"]);
    expect(policy.setRegistered(["file:///tmp/nope"])).toBe(false);
    expect(policy.isAllowedRequest("https://one.example/api", "GET")).toBe(
      true,
    );
  });
});

describe("CORS and WebSocket rewriting", () => {
  it("rewrites an outgoing Origin only for an allowed target", () => {
    const policy = new RegisteredOriginPolicy();
    policy.setRegistered(["https://chat.example"]);

    expect(
      rewriteOutgoingOrigin(
        "wss://chat.example/realtime",
        "GET",
        { Origin: "chatto-app://app", Upgrade: "websocket" },
        policy,
      ),
    ).toEqual({ Origin: "https://chat.example", Upgrade: "websocket" });
    const unregistered = { Origin: "chatto-app://app" };
    expect(
      rewriteOutgoingOrigin(
        "https://other.example/api",
        "POST",
        unregistered,
        policy,
      ),
    ).toBe(unregistered);
  });

  it("reflects the renderer origin for credentialed and non-credentialed responses", () => {
    const original = {
      "access-control-allow-origin": ["https://chat.example"],
      Vary: ["Accept-Encoding"],
    };
    const rewritten = rewriteCorsResponseHeaders(
      original,
      "Authorization, Content-Type",
    );

    expect(rewritten["Access-Control-Allow-Origin"]).toEqual([
      "chatto-app://app",
    ]);
    expect(rewritten["Access-Control-Allow-Credentials"]).toEqual(["true"]);
    expect(rewritten["Access-Control-Allow-Headers"]).toEqual([
      "Authorization, Content-Type",
    ]);
    expect(rewritten.Vary).toEqual(["Accept-Encoding, Origin"]);
    expect(original["access-control-allow-origin"]).toEqual([
      "https://chat.example",
    ]);
  });

  it("falls back to a bounded header allowlist for malformed preflights", () => {
    const rewritten = rewriteCorsResponseHeaders({}, "Bad Header");
    expect(rewritten["Access-Control-Allow-Headers"][0]).toContain(
      "Connect-Protocol-Version",
    );
    expect(rewritten["Access-Control-Allow-Headers"][0]).not.toContain(
      "Bad Header",
    );
  });
});
