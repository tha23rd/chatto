import type { NativeCallControls, NativeHost, Unsubscribe } from './types';

export const PUSH_TO_TALK_ACCELERATOR = 'Control+Shift+Space';

export interface NativeCallControlTarget {
  snapshot(): NativeCallControls;
  setPushToTalkPressed(pressed: boolean): Promise<void>;
  toggleMute(): Promise<void>;
  toggleDeafen(): Promise<void>;
}

/**
 * Owns the native registrations for one connected call.
 *
 * Registration is generation-checked because Tauri installs listeners
 * asynchronously. A call that ends while registration is pending immediately
 * disposes the late listener instead of leaking it into the next call.
 */
export class NativeCallControlsController {
  readonly #host: NativeHost;
  readonly #target: NativeCallControlTarget;
  #active = false;
  #generation = 0;
  #pushToTalkUnsubscribe: Unsubscribe | null = null;
  #trayUnsubscribe: Unsubscribe | null = null;

  constructor(host: NativeHost, target: NativeCallControlTarget) {
    this.#host = host;
    this.#target = target;
  }

  start(): void {
    if (this.#active) return;
    this.#active = true;
    const generation = ++this.#generation;
    this.sync();

    if (this.#host.capabilities.globalPushToTalk) {
      void this.#host
        .registerPushToTalk(PUSH_TO_TALK_ACCELERATOR, (state) => {
          if (!this.#active) return;
          void this.#target.setPushToTalkPressed(state === 'pressed').catch(() => {});
        })
        .then((unsubscribe) => {
          if (!this.#active || this.#generation !== generation) {
            unsubscribe();
            return;
          }
          this.#pushToTalkUnsubscribe = unsubscribe;
        })
        .catch(() => {});
    }

    if (this.#host.capabilities.tray) {
      void this.#host
        .onTrayAction((action) => {
          if (!this.#active) return;
          if (action === 'toggle-mute') {
            void this.#target.toggleMute().catch(() => {});
          } else if (action === 'toggle-deafen') {
            void this.#target.toggleDeafen().catch(() => {});
          }
        })
        .then((unsubscribe) => {
          if (!this.#active || this.#generation !== generation) {
            unsubscribe();
            return;
          }
          this.#trayUnsubscribe = unsubscribe;
        })
        .catch(() => {});
    }
  }

  sync(): void {
    if (!this.#host.capabilities.tray) return;
    void this.#host.setCallControls(this.#target.snapshot()).catch(() => {});
  }

  stop(): void {
    this.#active = false;
    this.#generation += 1;
    void this.#target.setPushToTalkPressed(false).catch(() => {});
    this.#pushToTalkUnsubscribe?.();
    this.#pushToTalkUnsubscribe = null;
    this.#trayUnsubscribe?.();
    this.#trayUnsubscribe = null;
    this.sync();
  }
}
