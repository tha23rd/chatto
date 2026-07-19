import { describe, expect, it, vi } from "vitest";
import {
  PushToTalkController,
  resolveHookKey,
  type KeyboardHook,
} from "./pushToTalk.js";

class FakeHook implements KeyboardHook {
  listeners = {
    keydown: new Set<(event: { keycode: number }) => void>(),
    keyup: new Set<(event: { keycode: number }) => void>(),
  };
  start = vi.fn();
  stop = vi.fn();

  on(
    event: "keydown" | "keyup",
    listener: (event: { keycode: number }) => void,
  ): void {
    this.listeners[event].add(listener);
  }

  off(
    event: "keydown" | "keyup",
    listener: (event: { keycode: number }) => void,
  ): void {
    this.listeners[event].delete(listener);
  }

  emit(event: "keydown" | "keyup", keycode: number): void {
    for (const listener of this.listeners[event]) listener({ keycode });
  }
}

describe("resolveHookKey", () => {
  it("supports DOM code aliases and case-insensitive enum names", () => {
    const keys = { A: 1, F8: 2, Ctrl: 3 };
    expect(resolveHookKey(keys, "KeyA")).toBe(1);
    expect(resolveHookKey(keys, "f8")).toBe(2);
    expect(resolveHookKey(keys, "ControlLeft")).toBe(3);
    expect(resolveHookKey(keys, "NoSuchKey")).toBeNull();
  });
});

describe("PushToTalkController", () => {
  it("emits one pressed/released pair and ignores repeat keydown events", async () => {
    const hook = new FakeHook();
    const emit = vi.fn();
    const controller = new PushToTalkController(emit, {
      load: async () => ({ uIOhook: hook, UiohookKey: { F8: 88 } }),
    });

    await expect(controller.register({ key: "F8" })).resolves.toEqual({
      registered: true,
    });
    hook.emit("keydown", 88);
    hook.emit("keydown", 88);
    hook.emit("keyup", 88);
    expect(emit.mock.calls).toEqual([["pressed"], ["released"]]);
    controller.dispose();
    expect(hook.stop).toHaveBeenCalledOnce();
  });

  it("fails closed when accessibility permission is unavailable", async () => {
    const controller = new PushToTalkController(vi.fn(), {
      hasPermission: () => false,
    });
    await expect(controller.register({ key: "F8" })).resolves.toEqual({
      registered: false,
      reason: "permission-denied",
    });
  });
});
