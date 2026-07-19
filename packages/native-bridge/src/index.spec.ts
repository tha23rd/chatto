import { describe, expect, it } from "vitest";
import {
  NATIVE_DEEP_LINK_SCHEME,
  NATIVE_RENDERER_ORIGIN,
  NativeIpc,
} from "./index.js";

describe("native bridge constants", () => {
  it("keeps renderer and operating-system schemes separate", () => {
    expect(new URL(NATIVE_RENDERER_ORIGIN).protocol).toBe("chatto-app:");
    expect(NATIVE_DEEP_LINK_SCHEME).toBe("chatto");
  });

  it("uses unique private IPC channels", () => {
    const channels = Object.values(NativeIpc);
    expect(new Set(channels).size).toBe(channels.length);
    expect(
      channels.every((channel) => channel.startsWith("chatto-native:")),
    ).toBe(true);
  });
});
