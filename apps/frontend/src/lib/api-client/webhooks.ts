import { AdminWebhookService } from "@chatto/api-types/admin/v1/webhooks_connect";
import type { Webhook } from "@chatto/api-types/admin/v1/webhooks_pb";
import {
  authHeaders,
  createChattoClient,
  handleAuthError,
  type ConnectAPIConfig,
} from "./connect.js";

/**
 * Lightweight render shape for a channel webhook (FDR-902). Carries what the
 * admin UI needs to list and manage a webhook; the one-time secret token/URL
 * are returned separately by create/regenerate and are never part of this
 * shape, since the backend only ever returns them once.
 */
export type WebhookView = {
  id: string;
  roomId: string;
  name: string;
  avatarUrl: string | null;
  createdBy: string;
  createdAtMs: number;
  disabled: boolean;
  userId: string;
};

/** Image bytes payload accepted by the create/update RPCs. */
export type WebhookImageUpload = {
  image: Uint8Array<ArrayBuffer>;
  filename: string;
  contentType: string;
};

/** Result of creating a webhook or regenerating its token: includes the one-time secret. */
export type CreatedWebhook = {
  webhook: WebhookView;
  /** Raw secret token. Shown once; only its hash is stored server-side. */
  token: string;
  /** Full post URL (base URL + webhook id + token). Shown once. */
  url: string;
};

/**
 * Administrative client for managing channel webhooks (`chatto.admin.v1`).
 * Requires `server.manage`; used by the server-admin UI.
 */
export function createAdminWebhookAPI(config: ConnectAPIConfig) {
  const client = createChattoClient(AdminWebhookService, config);
  const headers = () => authHeaders(config);
  return {
    async list(roomId?: string): Promise<WebhookView[]> {
      try {
        const response = await client.listWebhooks(
          roomId ? { roomId } : {},
          { headers: headers() },
        );
        return response.webhooks.map(mapWebhook);
      } catch (err) {
        return handleAuthError(config, err);
      }
    },

    async create(input: {
      roomId: string;
      name: string;
      avatar?: WebhookImageUpload;
    }): Promise<CreatedWebhook> {
      try {
        const response = await client.createWebhook(input, {
          headers: headers(),
        });
        if (!response.webhook) {
          throw new Error("createWebhook returned no webhook");
        }
        return {
          webhook: mapWebhook(response.webhook),
          token: response.token,
          url: response.url,
        };
      } catch (err) {
        return handleAuthError(config, err);
      }
    },

    async update(input: {
      id: string;
      name?: string;
      avatar?: WebhookImageUpload;
      clearAvatar?: boolean;
      disabled?: boolean;
    }): Promise<WebhookView> {
      try {
        const response = await client.updateWebhook(input, {
          headers: headers(),
        });
        if (!response.webhook) {
          throw new Error("updateWebhook returned no webhook");
        }
        return mapWebhook(response.webhook);
      } catch (err) {
        return handleAuthError(config, err);
      }
    },

    async remove(id: string): Promise<void> {
      try {
        await client.deleteWebhook({ id }, { headers: headers() });
      } catch (err) {
        return handleAuthError(config, err);
      }
    },

    async regenerateToken(id: string): Promise<CreatedWebhook> {
      try {
        const response = await client.regenerateWebhookToken(
          { id },
          { headers: headers() },
        );
        if (!response.webhook) {
          throw new Error("regenerateWebhookToken returned no webhook");
        }
        return {
          webhook: mapWebhook(response.webhook),
          token: response.token,
          url: response.url,
        };
      } catch (err) {
        return handleAuthError(config, err);
      }
    },
  };
}

function mapWebhook(webhook: Webhook): WebhookView {
  return {
    id: webhook.id,
    roomId: webhook.roomId,
    name: webhook.name,
    avatarUrl: webhook.avatarUrl ?? null,
    createdBy: webhook.createdBy,
    createdAtMs: Number(webhook.createdAtMs),
    disabled: webhook.disabled,
    userId: webhook.userId,
  };
}
