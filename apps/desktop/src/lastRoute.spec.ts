import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isRestorableRoute, LastRouteStore } from "./lastRoute.js";

const ORIGIN = "chatto-app://app";

describe("isRestorableRoute", () => {
  it("accepts in-app /chat routes on the renderer origin", () => {
    expect(isRestorableRoute(`${ORIGIN}/chat`)).toBe(true);
    expect(isRestorableRoute(`${ORIGIN}/chat/acme.example/room-1`)).toBe(true);
  });

  it("rejects transient routes, other origins, and junk", () => {
    expect(isRestorableRoute(`${ORIGIN}/login`)).toBe(false);
    expect(isRestorableRoute(`${ORIGIN}/servers/callback?code=abc`)).toBe(false);
    expect(isRestorableRoute(`${ORIGIN}/`)).toBe(false);
    expect(isRestorableRoute("https://evil.example/chat")).toBe(false);
    expect(isRestorableRoute("not a url")).toBe(false);
  });
});

describe("LastRouteStore", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "chatto-lastroute-"));
    file = path.join(dir, "last-route.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null when nothing has been saved", () => {
    expect(new LastRouteStore(file).read()).toBeNull();
  });

  it("round-trips a saved /chat route", async () => {
    const store = new LastRouteStore(file);
    store.save(`${ORIGIN}/chat/acme.example/room-1`);
    // save() writes asynchronously; wait for the file to land.
    await expect
      .poll(async () => {
        try {
          return JSON.parse(await readFile(file, "utf8")).url;
        } catch {
          return null;
        }
      })
      .toBe(`${ORIGIN}/chat/acme.example/room-1`);
    expect(new LastRouteStore(file).read()).toBe(
      `${ORIGIN}/chat/acme.example/room-1`,
    );
  });

  it("does not persist transient or foreign routes", async () => {
    const store = new LastRouteStore(file);
    store.save(`${ORIGIN}/login`);
    store.save("https://evil.example/chat");
    // Give any (unexpected) async write a chance to happen.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(new LastRouteStore(file).read()).toBeNull();
  });

  it("ignores a saved route that is no longer restorable", async () => {
    await writeFile(file, JSON.stringify({ url: `${ORIGIN}/login` }));
    expect(new LastRouteStore(file).read()).toBeNull();
  });
});
