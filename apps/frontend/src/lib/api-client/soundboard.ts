import { SoundboardService } from "@chatto/api-types/api/v1/soundboard_connect";
import { AdminSoundboardService } from "@chatto/api-types/admin/v1/soundboard_connect";
import {
  authHeaders,
  createChattoClient,
  handleAuthError,
  type ConnectAPIConfig,
} from "./connect.js";

/**
 * Lightweight render shape for a soundboard sound. Carries only what the UI
 * needs to display, preview, and play a sound: its stable id, display `name`,
 * the public audio `url`, an optional `emoji` icon, the default playback
 * `volume` (0..1), and the clip `durationMs`.
 */
export type Sound = {
  id: string;
  name: string;
  url: string;
  emoji: string;
  volume: number;
  durationMs: number;
};

/** Audio bytes payload accepted by the admin create RPC. */
export type SoundAudioUpload = {
  audio: Uint8Array<ArrayBuffer>;
  filename: string;
  contentType: string;
};

/**
 * Read-only client for the public soundboard API (`chatto.api.v1`).
 * Any authenticated member can list the server's sounds.
 */
export function createSoundboardAPI(config: ConnectAPIConfig) {
  const client = createChattoClient(SoundboardService, config);
  const headers = () => authHeaders(config);
  return {
    async list(): Promise<Sound[]> {
      try {
        const response = await client.listSounds({}, { headers: headers() });
        return response.sounds.map(mapSound);
      } catch (err) {
        return handleAuthError(config, err);
      }
    },
  };
}

/**
 * Administrative client for managing soundboard sounds (`chatto.admin.v1`).
 * Requires `soundboard.manage` (or the broader `server.manage`); used by the
 * server management UI.
 */
export function createAdminSoundboardAPI(config: ConnectAPIConfig) {
  const client = createChattoClient(AdminSoundboardService, config);
  const headers = () => authHeaders(config);
  return {
    async list(): Promise<Sound[]> {
      try {
        const response = await client.listSounds({}, { headers: headers() });
        return response.sounds.map(mapSound);
      } catch (err) {
        return handleAuthError(config, err);
      }
    },

    async create(
      name: string,
      audio: SoundAudioUpload,
      options: { emoji?: string; volume?: number } = {},
    ): Promise<Sound> {
      try {
        const response = await client.createSound(
          {
            name,
            audio,
            emoji: options.emoji ?? "",
            volume: options.volume ?? 1,
          },
          { headers: headers() },
        );
        if (!response.sound) {
          throw new Error("createSound returned no sound");
        }
        return mapSound(response.sound);
      } catch (err) {
        return handleAuthError(config, err);
      }
    },

    async remove(id: string): Promise<void> {
      try {
        await client.deleteSound({ id }, { headers: headers() });
      } catch (err) {
        return handleAuthError(config, err);
      }
    },
  };
}

/**
 * Map a protobuf `chatto.api.v1.Sound` to the UI render shape. Exported so the
 * realtime projection, which carries the same catalog inside authenticated
 * server state, produces identical objects to the ConnectRPC list calls.
 */
export function mapSound(sound: {
  id: string;
  name: string;
  url: string;
  emoji: string;
  volume: number;
  durationMs: bigint;
}): Sound {
  return {
    id: sound.id,
    name: sound.name,
    url: sound.url,
    emoji: sound.emoji,
    volume: sound.volume,
    durationMs: Number(sound.durationMs),
  };
}
