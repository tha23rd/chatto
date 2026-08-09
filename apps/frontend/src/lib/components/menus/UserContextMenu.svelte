<!--
@component

Shows a user's profile card. On desktop, renders as a floating popover anchored to the trigger
element. On mobile (touch devices), renders as a bottom sheet. This dual behavior comes from
ContextMenu, which handles both modes automatically.

**Props:**
- `user` - The user to display (must include id, login, displayName, presenceStatus)
- `roles` - Explicit role names (excluding `everyone`) to show as Discord-style coloured pills
- `anchorRect` - Bounding rect of the trigger element (used for desktop positioning)
- `canSendMessage` - Whether to show the "Send Message" button
- `onSendMessage` - Callback when "Send Message" is clicked
- `canBanFromRoom` - Whether to show the room-ban action
- `banningFromRoom` - Whether the room-ban action is currently running
- `onBanFromRoom` - Callback when "Ban from room" is clicked
- `onClose` - Callback to close the popover/sheet
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { PresenceStatus } from '@chatto/api-types/api/v1/presence_pb';

  import UserAvatar from '$lib/components/UserAvatar.svelte';
  import UserCustomStatusBadge from '$lib/components/UserCustomStatusBadge.svelte';
  import ContextMenu from '$lib/ui/ContextMenu.svelte';
  import {
    getLiveCustomStatus,
    getLiveDisplayName,
    getLiveLogin,
    type CustomUserStatus
  } from '$lib/state/userProfiles.svelte';
  import { useServerScope } from '$lib/state/server/scope.svelte';
  import type { MentionRole } from '$lib/state/room';
  import * as m from '$lib/i18n/messages';
  import { roleColorToCSS } from '$lib/roleColors';

  let {
    user,
    anchorRect,
    roles = [],
    canSendMessage = false,
    canBanFromRoom = false,
    banningFromRoom = false,
    onSendMessage,
    onBanFromRoom,
    onClose
  }: {
    user: {
      id: string;
      login: string;
      displayName: string;
      roleColor?: number | null;
      avatarUrl?: string | null;
      presenceStatus: PresenceStatus;
      customStatus?: CustomUserStatus | null;
    };
    /** Explicit role names (excluding `everyone`); rendered Discord-style as coloured pills. */
    roles?: string[];
    anchorRect?: { top: number; bottom: number; left: number } | null;
    canSendMessage?: boolean;
    canBanFromRoom?: boolean;
    banningFromRoom?: boolean;
    onSendMessage?: () => void;
    onBanFromRoom?: () => void;
    onClose?: () => void;
  } = $props();

  const displayName = $derived(getLiveDisplayName(user.id, user.displayName || user.login));
  const customStatus = $derived(getLiveCustomStatus(user.id, user.customStatus));

  // Public role catalogue, shared per server and lazily loaded; the popover is
  // one more consumer of the same coalesced fetch the composer uses.
  const roleCatalog = $derived(useServerScope()?.store.mentionRoles ?? null);

  /** Role pills in hierarchy order (highest position first); unknown names are skipped. */
  const rolePills = $derived.by(() => {
    if (roles.length === 0 || !roleCatalog) return [];
    return roles
      .map((roleName) => roleCatalog.roles.find((role) => role.name === roleName))
      .filter((role): role is MentionRole => role !== undefined)
      .sort((a, b) => b.position - a.position);
  });

  onMount(() => {
    void roleCatalog?.load();
  });

  function handleSendMessage() {
    onSendMessage?.();
    onClose?.();
  }

  function handleBanFromRoom() {
    onBanFromRoom?.();
  }
</script>

<ContextMenu
  anchor={anchorRect}
  role="dialog"
  ariaLabel={m['chat.user_menu.profile']()}
  class="w-64"
  onclose={() => onClose?.()}
>
  <div class="rounded-md bg-background">
    <div class="flex items-center gap-3 p-3">
      <UserAvatar {user} size="md" />
      <div class="min-w-0 flex-1">
        <div class="truncate font-semibold" style:color={roleColorToCSS(user.roleColor)}>
          {displayName}
        </div>
        <div class="truncate text-xs text-muted">@{getLiveLogin(user.id, user.login)}</div>
        <UserCustomStatusBadge status={customStatus} showText class="mt-1 max-w-full" />
      </div>
    </div>

    {#if canSendMessage || canBanFromRoom}
      <div class="border-t border-border p-1">
        {#if canSendMessage}
          <button type="button" class="sidebar-item" onclick={handleSendMessage}>
            {m['chat.user_menu.send_message']()}
          </button>
        {/if}
        {#if canBanFromRoom}
          <button
            type="button"
            class="sidebar-item text-danger disabled:cursor-not-allowed disabled:opacity-50"
            onclick={handleBanFromRoom}
            disabled={banningFromRoom}
          >
            {banningFromRoom ? m['admin.moderation.banning']() : m['admin.moderation.ban_action']()}
          </button>
        {/if}
      </div>
    {/if}

    {#if rolePills.length > 0}
      <div class="border-t border-border p-3">
        <div class="role-pills flex flex-wrap gap-1">
          {#each rolePills as role (role.name)}
            <span
              class="inline-flex items-center gap-1.5 rounded bg-surface-emphasized px-2 py-0.5 text-xs font-medium text-muted"
              title={role.displayName}
            >
              <span
                class="size-2 rounded-full"
                style:background={roleColorToCSS(role.color) ?? 'currentColor'}
              ></span>
              <span style:color={roleColorToCSS(role.color)}>{role.displayName}</span>
            </span>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</ContextMenu>
