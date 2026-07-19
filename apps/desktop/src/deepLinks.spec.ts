import { describe, expect, it } from "vitest";
import { deepLinkFromArgv, parseDeepLink } from "./deepLinks.js";

describe("parseDeepLink", () => {
  it("parses join links and normalizes the server origin", () => {
    expect(
      parseDeepLink(
        "chatto://join?server=https%3A%2F%2Fchat.example.com%2Fignored",
      ),
    ).toEqual({
      kind: "join",
      serverUrl: "https://chat.example.com",
    });
  });

  it("parses message links", () => {
    expect(
      parseDeepLink(
        "chatto://message?server=https%3A%2F%2Fchat.example.com&room=R_1&event=E-2&thread=T3",
      ),
    ).toEqual({
      kind: "message",
      serverUrl: "https://chat.example.com",
      roomId: "R_1",
      eventId: "E-2",
      threadId: "T3",
    });
  });

  it("rejects unknown actions, unsafe origins, and unbounded identifiers", () => {
    expect(
      parseDeepLink("chatto://run?server=https%3A%2F%2Fchat.example.com"),
    ).toBeNull();
    expect(
      parseDeepLink("chatto://join?server=file%3A%2F%2F%2Ftmp"),
    ).toBeNull();
    expect(
      parseDeepLink(
        `chatto://message?server=https%3A%2F%2Fchat.example.com&room=${"a".repeat(257)}`,
      ),
    ).toBeNull();
    expect(
      parseDeepLink(
        `chatto://join?server=https%3A%2F%2Fchat.example.com&ignored=${"a".repeat(8192)}`,
      ),
    ).toBeNull();
  });

  it("finds a valid link among process arguments", () => {
    expect(
      deepLinkFromArgv([
        "/opt/Chatto/chatto",
        "--flag",
        "chatto://join?server=https%3A%2F%2Fchat.example.com",
      ]),
    ).toEqual({
      kind: "join",
      serverUrl: "https://chat.example.com",
    });
  });
});
