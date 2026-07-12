import { CustomEmojiService } from "@chatto/api-types/api/v1/custom_emojis_connect";
import { AdminCustomEmojiService } from "@chatto/api-types/admin/v1/custom_emojis_connect";
import {
  authHeaders,
  createChattoClient,
  handleAuthError,
  type ConnectAPIConfig,
} from "./connect.js";

/**
 * Lightweight render shape for a custom emoji. Carries only what the UI needs
 * to display and reference an emoji: its stable id, its shortcode `name`
 * (used as the reaction key), and the signed image `url`.
 */
export type CustomEmoji = {
  id: string;
  name: string;
  url: string;
};

/** Image bytes payload accepted by the admin create RPC. */
export type CustomEmojiImageUpload = {
  image: Uint8Array<ArrayBuffer>;
  filename: string;
  contentType: string;
};

/**
 * Read-only client for the public custom emoji API (`chatto.api.v1`).
 * Any authenticated member can list the server's custom emojis.
 */
export function createCustomEmojiAPI(config: ConnectAPIConfig) {
  const client = createChattoClient(CustomEmojiService, config);
  const headers = () => authHeaders(config);
  return {
    async list(): Promise<CustomEmoji[]> {
      try {
        const response = await client.listCustomEmojis(
          {},
          { headers: headers() },
        );
        return response.emojis.map(mapCustomEmoji);
      } catch (err) {
        return handleAuthError(config, err);
      }
    },
  };
}

/**
 * Administrative client for managing custom emojis (`chatto.admin.v1`).
 * Requires server-management permission; used by the server-admin UI.
 */
export function createAdminCustomEmojiAPI(config: ConnectAPIConfig) {
  const client = createChattoClient(AdminCustomEmojiService, config);
  const headers = () => authHeaders(config);
  return {
    async list(): Promise<CustomEmoji[]> {
      try {
        const response = await client.listCustomEmojis(
          {},
          { headers: headers() },
        );
        return response.emojis.map(mapCustomEmoji);
      } catch (err) {
        return handleAuthError(config, err);
      }
    },

    async create(
      name: string,
      image: CustomEmojiImageUpload,
    ): Promise<CustomEmoji> {
      try {
        const response = await client.createCustomEmoji(
          { name, image },
          { headers: headers() },
        );
        if (!response.emoji) {
          throw new Error("createCustomEmoji returned no emoji");
        }
        return mapCustomEmoji(response.emoji);
      } catch (err) {
        return handleAuthError(config, err);
      }
    },

    async remove(id: string): Promise<void> {
      try {
        await client.deleteCustomEmoji({ id }, { headers: headers() });
      } catch (err) {
        return handleAuthError(config, err);
      }
    },
  };
}

function mapCustomEmoji(emoji: {
  id: string;
  name: string;
  url: string;
}): CustomEmoji {
  return { id: emoji.id, name: emoji.name, url: emoji.url };
}
