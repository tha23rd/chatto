import type { NativeDeepLink } from "@chatto/native-bridge";
import { normalizeServerOrigin } from "./validation.js";

const IDENTIFIER = /^[A-Za-z0-9_-]{1,256}$/;

/** Parse the deliberately small `chatto://` operating-system link grammar. */
export function parseDeepLink(value: string): NativeDeepLink | null {
  if (value.length > 8192) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "chatto:" || url.username || url.password) return null;

  const action = url.host || url.pathname.replace(/^\/+/, "");
  const serverUrl = normalizeServerOrigin(url.searchParams.get("server"));
  if (!serverUrl) return null;

  if (action === "join") {
    return { kind: "join", serverUrl };
  }

  if (action === "message") {
    const roomId = url.searchParams.get("room");
    const eventId = url.searchParams.get("event");
    const threadId = url.searchParams.get("thread");
    if (!roomId || !IDENTIFIER.test(roomId)) return null;
    if (eventId !== null && !IDENTIFIER.test(eventId)) return null;
    if (threadId !== null && !IDENTIFIER.test(threadId)) return null;
    return { kind: "message", serverUrl, roomId, eventId, threadId };
  }

  return null;
}

/** Return the first valid deep link in a process argument list. */
export function deepLinkFromArgv(argv: string[]): NativeDeepLink | null {
  for (const arg of argv) {
    if (!arg.startsWith("chatto:")) continue;
    const parsed = parseDeepLink(arg);
    if (parsed) return parsed;
  }
  return null;
}
