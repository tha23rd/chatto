import { resolve } from '$app/paths';
import {
  generateServerId,
  serverRegistry,
  type RegisteredServer
} from '$lib/state/server/registry.svelte';
import type { NativeOAuthResult, NativeOAuthUser } from '$lib/native/types';

export interface ServerOAuthFlowMetadata {
  readonly remoteUrl: string;
  readonly serverName?: string | null;
  readonly serverIconUrl?: string | null;
}

export interface ServerOAuthRegistry {
  readonly servers: RegisteredServer[];
  addServer(server: RegisteredServer): void;
  updateServer(id: string, data: Partial<Omit<RegisteredServer, 'id'>>): boolean;
  replaceServerAuthentication(
    id: string,
    data: Pick<
      RegisteredServer,
      'token' | 'userId' | 'userLogin' | 'userDisplayName' | 'userAvatarUrl' | 'reauthRequiredAt'
    >
  ): boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseUser(value: unknown): NativeOAuthUser | null {
  const user = asRecord(value);
  if (!user || typeof user.id !== 'string' || typeof user.login !== 'string') return null;
  return {
    id: user.id,
    login: user.login,
    displayName: optionalString(user.displayName),
    avatarUrl: optionalString(user.avatarUrl)
  };
}

/** Validate and normalize the public `/oauth/token` JSON response. */
export function parseServerOAuthTokenResponse(value: unknown): NativeOAuthResult {
  const response = asRecord(value);
  const accessToken = response?.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('OAuth token response did not include an access token.');
  }
  return {
    accessToken,
    user: parseUser(response?.user)
  };
}

function chatRoute(server: RegisteredServer): string {
  let segment = server.id;
  try {
    const url = new URL(server.url);
    segment =
      typeof window !== 'undefined' && url.origin === window.location.origin ? '-' : url.hostname;
  } catch {
    // The registry already accepted this server ID; retain it as a safe fallback.
  }
  return resolve('/chat/[serverId]', { serverId: segment });
}

/** Apply a successful browser or native OAuth result to the shared registry. */
export function completeServerOAuth(
  flow: ServerOAuthFlowMetadata,
  result: NativeOAuthResult,
  registry: ServerOAuthRegistry = serverRegistry
): string {
  if (!result.accessToken) {
    throw new Error('OAuth token response did not include an access token.');
  }

  const existing = registry.servers.find(
    (server) => server.url.toLowerCase() === flow.remoteUrl.toLowerCase()
  );
  let registered: RegisteredServer;

  if (existing) {
    registry.updateServer(existing.id, {
      name: flow.serverName ?? existing.name,
      iconUrl: flow.serverIconUrl ?? existing.iconUrl
    });
    registry.replaceServerAuthentication(existing.id, {
      token: result.accessToken,
      userId: result.user?.id ?? null,
      userLogin: result.user?.login ?? null,
      userDisplayName: result.user?.displayName ?? null,
      userAvatarUrl: result.user?.avatarUrl ?? null,
      reauthRequiredAt: null
    });
    registered = existing;
  } else {
    const id = generateServerId(
      flow.remoteUrl,
      registry.servers.map((server) => server.id)
    );
    registered = {
      id,
      url: flow.remoteUrl,
      name: flow.serverName ?? 'Chatto',
      iconUrl: flow.serverIconUrl ?? null,
      token: result.accessToken,
      userId: result.user?.id ?? null,
      userLogin: result.user?.login ?? null,
      userDisplayName: result.user?.displayName ?? null,
      userAvatarUrl: result.user?.avatarUrl ?? null,
      reauthRequiredAt: null,
      addedAt: Date.now()
    };
    registry.addServer(registered);
  }

  return chatRoute(registered);
}
