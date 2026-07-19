import type {
  NativePushToTalkBinding,
  NativePushToTalkEvent,
  NativePushToTalkRegistration,
} from "@chatto/native-bridge";

type KeyboardHookEvent = { keycode: number };
type KeyboardHookListener = (event: KeyboardHookEvent) => void;

export interface KeyboardHook {
  on(event: "keydown" | "keyup", listener: KeyboardHookListener): void;
  off?(event: "keydown" | "keyup", listener: KeyboardHookListener): void;
  removeListener?(
    event: "keydown" | "keyup",
    listener: KeyboardHookListener,
  ): void;
  start(): void;
  stop(): void;
}

type KeyboardHookModule = {
  uIOhook: KeyboardHook;
  UiohookKey: Record<string, number>;
};

type KeyboardHookLoader = () => Promise<KeyboardHookModule>;

const defaultLoader: KeyboardHookLoader = async () =>
  (await import("uiohook-napi")) as unknown as KeyboardHookModule;

/** Press/release global push-to-talk backed by a low-level keyboard hook. */
export class PushToTalkController {
  #emit: (event: NativePushToTalkEvent) => void;
  #hasPermission: () => boolean;
  #load: KeyboardHookLoader;
  #hook: KeyboardHook | null = null;
  #keycode: number | null = null;
  #pressed = false;

  #onKeyDown = (event: KeyboardHookEvent): void => {
    if (event.keycode !== this.#keycode || this.#pressed) return;
    this.#pressed = true;
    this.#emit("pressed");
  };

  #onKeyUp = (event: KeyboardHookEvent): void => {
    if (event.keycode !== this.#keycode || !this.#pressed) return;
    this.#pressed = false;
    this.#emit("released");
  };

  constructor(
    emit: (event: NativePushToTalkEvent) => void,
    options: { hasPermission?: () => boolean; load?: KeyboardHookLoader } = {},
  ) {
    this.#emit = emit;
    this.#hasPermission = options.hasPermission ?? (() => true);
    this.#load = options.load ?? defaultLoader;
  }

  async register(
    binding: NativePushToTalkBinding,
  ): Promise<NativePushToTalkRegistration> {
    if (!this.#hasPermission())
      return { registered: false, reason: "permission-denied" };

    try {
      const module = await this.#load();
      const keycode = resolveHookKey(module.UiohookKey, binding.key);
      if (keycode === null)
        return { registered: false, reason: "unsupported-key" };

      if (!this.#hook) {
        this.#hook = module.uIOhook;
        this.#hook.on("keydown", this.#onKeyDown);
        this.#hook.on("keyup", this.#onKeyUp);
        this.#hook.start();
      }
      if (this.#pressed) this.#emit("released");
      this.#pressed = false;
      this.#keycode = keycode;
      return { registered: true };
    } catch {
      this.dispose();
      return { registered: false, reason: "hook-failed" };
    }
  }

  dispose(): void {
    const hook = this.#hook;
    this.#hook = null;
    this.#keycode = null;
    if (!hook) return;
    if (this.#pressed) this.#emit("released");
    this.#pressed = false;
    try {
      removeHookListener(hook, "keydown", this.#onKeyDown);
      removeHookListener(hook, "keyup", this.#onKeyUp);
    } catch {
      // The client is already detached; hook cleanup is best-effort.
    }
    try {
      hook.stop();
    } catch {
      // Native hook shutdown must not block application exit or recovery.
    }
  }
}

export function resolveHookKey(
  keys: Record<string, number>,
  value: string,
): number | null {
  const normalized = value.trim();
  if (!normalized || normalized.length > 64) return null;
  const aliases: Record<string, string> = {
    Control: "Ctrl",
    ControlLeft: "Ctrl",
    ControlRight: "CtrlRight",
    ShiftLeft: "Shift",
    ShiftRight: "ShiftRight",
    AltLeft: "Alt",
    AltRight: "AltRight",
    MetaLeft: "Meta",
    MetaRight: "MetaRight",
  };
  let candidate = aliases[normalized] ?? normalized;
  if (/^Key[A-Z]$/.test(candidate)) candidate = candidate.slice(3);
  if (/^Digit[0-9]$/.test(candidate)) candidate = candidate.slice(5);

  const exact = keys[candidate];
  if (Number.isInteger(exact)) return exact;
  const matchingEntry = Object.entries(keys).find(
    ([name, keycode]) =>
      name.toLowerCase() === candidate.toLowerCase() &&
      Number.isInteger(keycode),
  );
  return matchingEntry?.[1] ?? null;
}

function removeHookListener(
  hook: KeyboardHook,
  event: "keydown" | "keyup",
  listener: KeyboardHookListener,
): void {
  if (hook.off) hook.off(event, listener);
  else hook.removeListener?.(event, listener);
}
