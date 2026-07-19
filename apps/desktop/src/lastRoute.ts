import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { isRendererUrl } from "./validation.js";

/**
 * Whether a renderer URL is worth restoring on the next launch.
 *
 * Only in-app `/chat` locations qualify. Transient routes — `/login`, the OAuth
 * callback, the root redirect — must never be restored (restoring the callback
 * would replay a stale code), and skipping them means a brief visit to one does
 * not clobber the saved in-app location.
 */
export function isRestorableRoute(value: string): boolean {
  if (!isRendererUrl(value)) return false;
  try {
    return new URL(value).pathname.startsWith("/chat");
  } catch {
    return false;
  }
}

/**
 * Persists the last in-app renderer route so a cold launch restores where the
 * user left off.
 *
 * The desktop renderer is served from the app bundle, not a Chatto server, so a
 * bare `/` has no origin session and dead-ends at the login/welcome screen. A
 * browser avoids this by keeping its URL across reloads; this store gives the
 * shell the same behaviour without any change to the shared web routing.
 */
export class LastRouteStore {
  readonly #file: string;
  #lastSaved: string | null = null;

  constructor(file: string) {
    this.#file = file;
  }

  /**
   * The saved route, or `null` when there is none or it is no longer
   * restorable. Synchronous because it is read exactly once, at launch.
   */
  read(): string | null {
    try {
      const parsed = JSON.parse(readFileSync(this.#file, "utf8")) as {
        url?: unknown;
      };
      return typeof parsed.url === "string" && isRestorableRoute(parsed.url)
        ? parsed.url
        : null;
    } catch {
      return null;
    }
  }

  /** Record the current route if it is a restorable in-app location. */
  save(url: string): void {
    if (!isRestorableRoute(url) || url === this.#lastSaved) return;
    this.#lastSaved = url;
    // Best-effort: a failed write only costs one restored launch, never data.
    void writeFile(this.#file, JSON.stringify({ url })).catch(() => {});
  }
}
