import {
  type CallKeybindingAction,
  callKeybindingAcceleratorFromEvent,
  callKeybindingActionForAccelerator,
  isCallKeybindingCaptureActive,
  isEditableShortcutTarget,
  onCallKeybindingsChanged
} from '$lib/callKeybindings';
import { userPreferences } from '$lib/state/userPreferences.svelte';
import type {
  NativeCallControls,
  NativeHost,
  NativeShortcutState,
  Unsubscribe
} from './types';

export interface NativeCallControlTarget {
  snapshot(): NativeCallControls;
  setPushToTalkPressed(pressed: boolean): Promise<void>;
  setPushToMutePressed(pressed: boolean): Promise<void>;
  toggleMute(): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  toggleDeafen(): Promise<void>;
  setDeafened(deafened: boolean): Promise<void>;
  toggleCamera(): Promise<void>;
  setCameraEnabled(enabled: boolean): Promise<void>;
  toggleScreenShare(): Promise<void>;
  setScreenShareEnabled(enabled: boolean): Promise<void>;
  leave(): Promise<void>;
}

type CallOwner = {
  readonly id: symbol;
  readonly target: NativeCallControlTarget;
};

const coordinators = new WeakMap<NativeHost, NativeCallControlsCoordinator>();

function reportNativeControlFailure(operation: string, error: unknown): void {
  console.error(`[native-call-controls] ${operation} failed`, error);
}

async function unsubscribeWithRetry(unsubscribe: Unsubscribe): Promise<void> {
  try {
    await unsubscribe();
  } catch {
    await unsubscribe();
  }
}

function keybindingSignature(): string {
  return JSON.stringify(userPreferences.callKeybindings);
}

function isMomentaryAction(action: CallKeybindingAction): boolean {
  return action === 'push-to-talk' || action === 'push-to-mute';
}

/**
 * Owns process-wide call keybindings and the native tray subscription.
 *
 * Chatto may keep calls connected on more than one server. The most recently
 * started call owns shortcut actions; when it stops, ownership falls back to
 * the previous connected call. Native registration and cleanup share one
 * promise chain so a late unregister cannot remove newly installed bindings.
 */
class NativeCallControlsCoordinator {
  readonly #host: NativeHost;
  readonly #owners = new Map<symbol, CallOwner>();
  readonly #shortcutUnsubscribes = new Map<string, Unsubscribe>();
  readonly #pressedAccelerators = new Map<string, CallKeybindingAction>();
  readonly #browserFallbackAccelerators = new Set<string>();
  #trayUnsubscribe: Unsubscribe | null = null;
  #keybindingChangeUnsubscribe: Unsubscribe | null = null;
  #browserListenersInstalled = false;
  #registeredKeybindingSignature: string | null = null;
  #transition: Promise<void> = Promise.resolve();

  constructor(host: NativeHost) {
    this.#host = host;
  }

  start(owner: CallOwner): void {
    if (this.#owners.has(owner.id)) return;
    this.#owners.set(owner.id, owner);
    this.#keybindingChangeUnsubscribe ??= onCallKeybindingsChanged(() => {
      this.#scheduleReconcile();
    });
    this.#scheduleReconcile();
  }

  sync(owner: CallOwner): void {
    if (this.#activeOwner()?.id !== owner.id) return;
    this.#scheduleReconcile();
  }

  stop(owner: CallOwner): void {
    const wasActive = this.#activeOwner()?.id === owner.id;
    if (!this.#owners.delete(owner.id)) return;
    if (wasActive) this.#releasePressedActions(owner.target);
    this.#scheduleReconcile();
  }

  #activeOwner(): CallOwner | null {
    return [...this.#owners.values()].at(-1) ?? null;
  }

  #scheduleReconcile(): void {
    this.#transition = this.#transition
      .then(() => this.#reconcile())
      .catch((error) => reportNativeControlFailure('registration transition', error));
  }

  async #reconcile(): Promise<void> {
    const active = this.#activeOwner();
    if (!active) {
      await this.#cleanupRegistrations(true);
      this.#keybindingChangeUnsubscribe?.();
      this.#keybindingChangeUnsubscribe = null;
      return;
    }

    await this.#ensureRegistered(active.target);
    if (this.#host.capabilities.tray) {
      await this.#host.setCallControls(active.target.snapshot());
    }
  }

  async #ensureRegistered(target: NativeCallControlTarget): Promise<void> {
    const signature = keybindingSignature();
    if (this.#registeredKeybindingSignature !== signature) {
      this.#releasePressedActions(target);
      await this.#cleanupShortcuts();
      this.#registeredKeybindingSignature = signature;

      if (this.#host.capabilities.globalCallKeybindings) {
        for (const [action, accelerator] of Object.entries(userPreferences.callKeybindings)) {
          if (!accelerator) continue;
          try {
            const unsubscribe = await this.#host.registerGlobalShortcut(
              accelerator,
              (state) => this.#handleShortcut(action as CallKeybindingAction, accelerator, state)
            );
            this.#shortcutUnsubscribes.set(accelerator, unsubscribe);
          } catch (error) {
            // A system shortcut can already belong to another app. Keep every
            // other binding active and retry this one after the user changes
            // preferences or reconnects the final call.
            // Chords the plugin cannot register at all (bare modifier keys,
            // international-layout codes) dispatch from focused-window key
            // events while the window has focus.
            this.#browserFallbackAccelerators.add(accelerator);
            reportNativeControlFailure(`register ${accelerator}`, error);
          }
        }
        if (this.#browserFallbackAccelerators.size > 0) this.#installBrowserListeners();
      } else {
        this.#installBrowserListeners();
      }
    }

    if (this.#host.capabilities.tray && !this.#trayUnsubscribe) {
      this.#trayUnsubscribe = await this.#host.onTrayAction((action) => {
        const active = this.#activeOwner();
        if (!active) return;
        const operation =
          action === 'toggle-mute'
            ? active.target.toggleMute()
            : action === 'toggle-deafen'
              ? active.target.toggleDeafen()
              : null;
        void operation?.catch((error) => reportNativeControlFailure('tray action', error));
      });
    }
  }

  #installBrowserListeners(): void {
    if (this.#browserListenersInstalled || typeof window === 'undefined') return;
    window.addEventListener('keydown', this.#handleBrowserKeyDown);
    window.addEventListener('keyup', this.#handleBrowserKeyUp);
    window.addEventListener('blur', this.#handleBrowserBlur);
    this.#browserListenersInstalled = true;
  }

  readonly #handleBrowserKeyDown = (event: KeyboardEvent): void => {
    if (isCallKeybindingCaptureActive() || isEditableShortcutTarget(event.target)) return;
    const accelerator = callKeybindingAcceleratorFromEvent(event);
    if (!accelerator) return;
    // Desktop hosts also receive the same key events the global shortcut
    // hooks already dispatch; only act on chords the system could not
    // register, or every chord would fire twice.
    if (
      this.#host.capabilities.globalCallKeybindings &&
      !this.#browserFallbackAccelerators.has(accelerator)
    ) {
      return;
    }
    const action = callKeybindingActionForAccelerator(
      userPreferences.callKeybindings,
      accelerator
    );
    if (!action) return;

    event.preventDefault();
    this.#handleShortcut(action, accelerator, 'pressed');
  };

  readonly #handleBrowserKeyUp = (event: KeyboardEvent): void => {
    const accelerator = callKeybindingAcceleratorFromEvent(event);
    const pressed = accelerator ? this.#pressedAccelerators.get(accelerator) : undefined;
    const matches = pressed
      ? [[accelerator as string, pressed] as const]
      : [...this.#pressedAccelerators].filter(
          ([pressedAccelerator]) =>
            pressedAccelerator === event.code || pressedAccelerator.endsWith(`+${event.code}`)
        );
    if (matches.length === 0) return;
    event.preventDefault();
    // Modifier key-up events can arrive before the main key is released, so
    // `ctrlKey`/`altKey` may no longer reproduce the pressed accelerator.
    // Physical-code fallback guarantees held microphone actions still release.
    for (const [pressedAccelerator, action] of matches) {
      this.#handleShortcut(action, pressedAccelerator, 'released');
    }
  };

  readonly #handleBrowserBlur = (): void => {
    const target = this.#activeOwner()?.target;
    if (target) this.#releasePressedActions(target);
  };

  #handleShortcut(
    action: CallKeybindingAction,
    accelerator: string,
    state: NativeShortcutState
  ): void {
    const target = this.#activeOwner()?.target;
    if (!target) return;

    if (state === 'pressed') {
      if (isCallKeybindingCaptureActive() || this.#pressedAccelerators.has(accelerator)) return;
      if (isMomentaryAction(action)) this.#releaseMomentaryActions(target);
      this.#pressedAccelerators.set(accelerator, action);
    } else {
      if (!this.#pressedAccelerators.delete(accelerator)) return;
      if (!isMomentaryAction(action)) return;
    }

    void this.#dispatchShortcut(target, action, state).catch((error) =>
      reportNativeControlFailure(`${action} action`, error)
    );
  }

  async #dispatchShortcut(
    target: NativeCallControlTarget,
    action: CallKeybindingAction,
    state: NativeShortcutState
  ): Promise<void> {
    const pressed = state === 'pressed';
    switch (action) {
      case 'push-to-talk':
        await target.setPushToTalkPressed(pressed);
        break;
      case 'push-to-mute':
        await target.setPushToMutePressed(pressed);
        break;
      case 'toggle-mute':
        if (pressed) await target.toggleMute();
        break;
      case 'mute':
        if (pressed) await target.setMuted(true);
        break;
      case 'unmute':
        if (pressed) await target.setMuted(false);
        break;
      case 'toggle-deafen':
        if (pressed) await target.toggleDeafen();
        break;
      case 'deafen':
        if (pressed) await target.setDeafened(true);
        break;
      case 'undeafen':
        if (pressed) await target.setDeafened(false);
        break;
      case 'toggle-camera':
        if (pressed) await target.toggleCamera();
        break;
      case 'camera-on':
        if (pressed) await target.setCameraEnabled(true);
        break;
      case 'camera-off':
        if (pressed) await target.setCameraEnabled(false);
        break;
      case 'toggle-screen-share':
        if (pressed) await target.toggleScreenShare();
        break;
      case 'start-screen-share':
        if (pressed) await target.setScreenShareEnabled(true);
        break;
      case 'stop-screen-share':
        if (pressed) await target.setScreenShareEnabled(false);
        break;
      case 'leave-call':
        if (pressed) await target.leave();
        break;
    }
  }

  #releaseMomentaryActions(target: NativeCallControlTarget): void {
    for (const [accelerator, action] of this.#pressedAccelerators) {
      if (!isMomentaryAction(action)) continue;
      this.#pressedAccelerators.delete(accelerator);
      void this.#dispatchShortcut(target, action, 'released').catch((error) =>
        reportNativeControlFailure(`${action} release`, error)
      );
    }
  }

  #releasePressedActions(target: NativeCallControlTarget): void {
    this.#releaseMomentaryActions(target);
    this.#pressedAccelerators.clear();
  }

  async #cleanupShortcuts(): Promise<void> {
    const failures: unknown[] = [];
    const target = this.#activeOwner()?.target;
    if (target) this.#releasePressedActions(target);

    for (const [accelerator, unsubscribe] of this.#shortcutUnsubscribes) {
      try {
        await unsubscribeWithRetry(unsubscribe);
        if (this.#shortcutUnsubscribes.get(accelerator) === unsubscribe) {
          this.#shortcutUnsubscribes.delete(accelerator);
        }
      } catch (error) {
        failures.push(error);
      }
    }

    if (this.#browserListenersInstalled && typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.#handleBrowserKeyDown);
      window.removeEventListener('keyup', this.#handleBrowserKeyUp);
      window.removeEventListener('blur', this.#handleBrowserBlur);
      this.#browserListenersInstalled = false;
    }
    this.#browserFallbackAccelerators.clear();
    this.#registeredKeybindingSignature = null;

    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more call keybinding cleanups failed.');
    }
  }

  async #cleanupRegistrations(disableTray: boolean): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.#cleanupShortcuts();
    } catch (error) {
      failures.push(error);
    }

    const trayUnsubscribe = this.#trayUnsubscribe;
    if (trayUnsubscribe) {
      try {
        await unsubscribeWithRetry(trayUnsubscribe);
        if (this.#trayUnsubscribe === trayUnsubscribe) this.#trayUnsubscribe = null;
      } catch (error) {
        failures.push(error);
      }
    }
    if (disableTray && this.#host.capabilities.tray) {
      try {
        await this.#host.setCallControls({ connected: false, muted: false, deafened: false });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more native call-control cleanups failed.');
    }
  }
}

function coordinatorFor(host: NativeHost): NativeCallControlsCoordinator {
  let coordinator = coordinators.get(host);
  if (!coordinator) {
    coordinator = new NativeCallControlsCoordinator(host);
    coordinators.set(host, coordinator);
  }
  return coordinator;
}

/** A per-call handle into the process-wide call-control coordinator. */
export class NativeCallControlsController {
  readonly #coordinator: NativeCallControlsCoordinator;
  readonly #owner: CallOwner;
  #active = false;

  constructor(host: NativeHost, target: NativeCallControlTarget) {
    this.#coordinator = coordinatorFor(host);
    this.#owner = { id: Symbol('native-call-owner'), target };
  }

  start(): void {
    if (this.#active) return;
    this.#active = true;
    this.#coordinator.start(this.#owner);
  }

  sync(): void {
    if (!this.#active) return;
    this.#coordinator.sync(this.#owner);
  }

  stop(): void {
    if (!this.#active) return;
    this.#active = false;
    this.#coordinator.stop(this.#owner);
  }
}
