import { describe, expect, it, vi } from "vitest";
import {
  callbackResponseHtml,
  OAuthLoopbackReceiver,
  oauthCallbackFromUrl,
} from "./oauthCallback.js";

describe("OAuth loopback callback parsing", () => {
  it("accepts success and error callbacks with state", () => {
    expect(
      oauthCallbackFromUrl(new URL("http://127.0.0.1/cb?code=abc&state=xyz")),
    ).toEqual({
      code: "abc",
      state: "xyz",
      error: null,
      errorDescription: null,
    });
    expect(
      oauthCallbackFromUrl(
        new URL(
          "http://127.0.0.1/cb?error=access_denied&error_description=no&state=xyz",
        ),
      ),
    ).toEqual({
      code: null,
      state: "xyz",
      error: "access_denied",
      errorDescription: "no",
    });
  });

  it("rejects callbacks without CSRF state or an outcome", () => {
    expect(
      oauthCallbackFromUrl(new URL("http://127.0.0.1/cb?code=abc")),
    ).toBeNull();
    expect(
      oauthCallbackFromUrl(new URL("http://127.0.0.1/cb?state=xyz")),
    ).toBeNull();
  });

  it("escapes localized completion copy", () => {
    const html = callbackResponseHtml({ title: "<done>", message: "A & B" });
    expect(html).toContain("&lt;done&gt;");
    expect(html).toContain("A &amp; B");
    expect(html).not.toContain("<done>");
  });
});

describe("OAuthLoopbackReceiver", () => {
  it("receives a one-shot callback on a random loopback path", async () => {
    const callback = vi.fn();
    const receiver = new OAuthLoopbackReceiver(callback);
    const redirectUri = await receiver.prepare({
      title: "Complete",
      message: "Return to Chatto.",
    });
    expect(redirectUri).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback\/[A-Za-z0-9_-]+$/,
    );

    const responses = await Promise.all([
      fetch(`${redirectUri}?code=abc&state=xyz`),
      fetch(`${redirectUri}?code=abc&state=xyz`),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 410,
    ]);
    expect(
      responses
        .find((response) => response.status === 200)
        ?.headers.get("content-security-policy"),
    ).not.toContain("unsafe-inline");
    expect(callback).toHaveBeenCalledWith({
      code: "abc",
      state: "xyz",
      error: null,
      errorDescription: null,
    });
    expect(callback).toHaveBeenCalledOnce();
    await receiver.close();
  });
});
