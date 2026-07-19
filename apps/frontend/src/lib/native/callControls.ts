import type { NativeCallControls, NativeHost, Unsubscribe } from './types';

export const PUSH_TO_TALK_ACCELERATOR = 'Control+Shift+Space';

export interface NativeCallControlTarget {
  snapshot(): NativeCallControls;
  setPushToTalkPressed(pressed: boolean): Promise<void>;
  toggleMute(): Promise<void>;
  toggleDeafen(): Promise<void>;
}

type CallOwner = {
  readonly id: symbol;
  readonly target: NativeCallControlTarget;
};

const coordinators = new WeakMap<NativeHost, NativeCallControlsCoordinator>();

function reportNativeControlFailure(operation: string, error: unknown): void {
  console.error(`[native-call-controls] ${operation} failed`, error);
}

/**
 * Owns the one process-wide shortcut and tray subscription.
 *
 * Chatto may keep calls connected on more than one server. The most recently
 * started call owns native actions; when it stops, ownership falls back to the
 * previous connected call. Registration and cleanup share one promise chain so
 * a late unregister can never remove a newly installed shortcut.
 */
class NativeCallControlsCoordinator {
  readonly #host: NativeHost;
  readonly #owners = new Map<symbol, CallOwner>();
  #pushToTalkUnsubscribe: Unsubscribe | null = null;
  #trayUnsubscribe: Unsubscribe | null = null;
  #transition: Promise<void> = Promise.resolve();

  constructor(host: NativeHost) {
    this.#host = host;
  }

  start(owner: CallOwner): void {
    if (this.#owners.has(owner.id)) return;
    this.#owners.set(owner.id, owner);
    this.#scheduleReconcile();
  }

  sync(owner: CallOwner): void {
    if (this.#activeOwner()?.id !== owner.id) return;
    this.#scheduleReconcile();
  }

  stop(owner: CallOwner): void {
    if (!this.#owners.delete(owner.id)) return;
    void owner.target
      .setPushToTalkPressed(false)
      .catch((error) => reportNativeControlFailure('push-to-talk release', error));
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
      const pushToTalkUnsubscribe = this.#pushToTalkUnsubscribe;
      const trayUnsubscribe = this.#trayUnsubscribe;
      this.#pushToTalkUnsubscribe = null;
      this.#trayUnsubscribe = null;
      if (pushToTalkUnsubscribe) await pushToTalkUnsubscribe();
      if (trayUnsubscribe) await trayUnsubscribe();
      if (this.#host.capabilities.tray) {
        await this.#host.setCallControls({ connected: false, muted: false, deafened: false });
      }
      return;
    }

    await this.#ensureRegistered();
    if (this.#host.capabilities.tray) {
      await this.#host.setCallControls(active.target.snapshot());
    }
  }

  async #ensureRegistered(): Promise<void> {
    if (this.#pushToTalkUnsubscribe || this.#trayUnsubscribe) return;
    let pushToTalkUnsubscribe: Unsubscribe | null = null;
    let trayUnsubscribe: Unsubscribe | null = null;
    try {
      if (this.#host.capabilities.globalPushToTalk) {
        pushToTalkUnsubscribe = await this.#host.registerPushToTalk(
          PUSH_TO_TALK_ACCELERATOR,
          (state) => {
            const active = this.#activeOwner();
            if (!active) return;
            void active.target
              .setPushToTalkPressed(state === 'pressed')
              .catch((error) => reportNativeControlFailure('push-to-talk action', error));
          }
        );
      }
      if (this.#host.capabilities.tray) {
        trayUnsubscribe = await this.#host.onTrayAction((action) => {
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
    } catch (error) {
      if (pushToTalkUnsubscribe) await pushToTalkUnsubscribe();
      if (trayUnsubscribe) await trayUnsubscribe();
      throw error;
    }
    this.#pushToTalkUnsubscribe = pushToTalkUnsubscribe;
    this.#trayUnsubscribe = trayUnsubscribe;
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

/** A per-call handle into the process-wide native call-control coordinator. */
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
