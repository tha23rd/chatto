<!--
@component

Server-admin management UI for channel webhooks (FDR-902). Lists the
server's existing webhooks with their target room and status, and lets an
admin create a new webhook by picking a room, a name, and an optional avatar.

The backend only ever returns a webhook's secret post URL once: at creation
time and again on token regeneration. This component surfaces that one-time
URL in a dismissable dialog with a copy-to-clipboard control and a clear
warning, since it cannot be retrieved again afterwards.
-->
<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query';
  import { useServerScope } from '$lib/state/server/scope.svelte';
  import {
    createAdminWebhookAPI,
    type WebhookImageUpload,
    type WebhookView
  } from '$lib/api-client/webhooks';
  import type { ConnectAPIConfig } from '$lib/api-client/connect';
  import { adminQueryKeys } from '$lib/query/admin';
  import { queryClient } from '$lib/query/client';
  import { RoomKind } from '$lib/api-client/roomDirectory';
  import { timeFormatSettingsFor } from '$lib/utils/formatTime';
  import { getLocale } from '$lib/i18n/runtime';
  import { formatDate } from '$lib/utils/formatTime';
  import { m } from '$lib/i18n/messages';

  import { Panel, DataTable, CopyId } from '$lib/components/admin';
  import { TextInput, Select, Button } from '$lib/ui/form';
  import Dialog from '$lib/ui/Dialog.svelte';
  import ConfirmDialog from '$lib/ui/ConfirmDialog.svelte';
  import { toast } from '$lib/ui/toast';
  import { dropZone } from '$lib/attachments/dropZone.svelte';
  import DropZoneOverlay from '$lib/attachments/DropZoneOverlay.svelte';

  const serverScope = useServerScope();
  const connection = () => serverScope.connection;
  const userSettings = $derived(timeFormatSettingsFor(serverScope.store.currentUser.user?.settings));
  const activeLocale = $derived(getLocale());

  function apiConfig(): ConnectAPIConfig {
    const conn = connection();
    return {
      serverId: conn.serverId,
      baseUrl: conn.connectBaseUrl,
      bearerToken: conn.bearerToken
    };
  }

  // Keyed by server and session scope, so the list survives remounts, refetches
  // when stale, and is purged with the rest of the session cache when projected
  // authorization is lost.
  const webhooksQuery = createQuery(
    () => {
      const serverId = serverScope.serverId;
      const connection = serverScope.connection;
      return {
        queryKey: adminQueryKeys.webhooks(serverId, connection),
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          connection.getAPI(createAdminWebhookAPI).list(undefined, { signal })
      };
    },
    () => queryClient
  );

  const webhooks = $derived(webhooksQuery.data ?? []);
  const loading = $derived(webhooksQuery.isPending);
  const error = $derived(
    webhooksQuery.isError ? m('server_settings.webhooks.load_failed') : null
  );

  const webhooksKey = $derived(
    adminQueryKeys.webhooks(serverScope.serverId, serverScope.connection)
  );

  /**
   * Write a created/updated webhook straight into the cache, newest-first, so
   * the admin list reflects the change without a refetch. Mirrors the previous
   * store's `upsert`.
   */
  function upsertWebhook(webhook: WebhookView): void {
    queryClient.setQueryData<WebhookView[]>(webhooksKey, (current) => [
      webhook,
      ...(current ?? []).filter((existing) => existing.id !== webhook.id)
    ]);
  }

  function removeWebhook(id: string): void {
    queryClient.setQueryData<WebhookView[]>(webhooksKey, (current) =>
      (current ?? []).filter((existing) => existing.id !== id)
    );
  }

  // Rooms this server has, for the "target room" picker and for resolving a
  // webhook's room id to a display name in the list. Webhooks only post into
  // channel rooms, so DMs are excluded.
  const roomsStore = $derived(serverScope.store.navigation);
  const roomOptions = $derived(
    roomsStore.rooms
      .filter((room) => room.type === RoomKind.CHANNEL)
      .map((room) => ({ value: room.id, label: room.name }))
  );

  function roomName(roomId: string): string {
    return roomsStore.rooms.find((room) => room.id === roomId)?.name ?? roomId;
  }

  function formatCreated(createdAtMs: number): string {
    return formatDate(new Date(createdAtMs), userSettings, activeLocale);
  }

  // Create form state
  let roomId = $state('');
  let name = $state('');
  let selectedFile = $state<File | null>(null);
  let creating = $state(false);
  let fileInput = $state<HTMLInputElement>();
  let isDragging = $state(false);

  const canSubmit = $derived(name.trim().length > 0 && roomId.length > 0 && !creating);

  const previewUrl = $derived(selectedFile ? URL.createObjectURL(selectedFile) : null);
  $effect(() => {
    const url = previewUrl;
    if (!url) return;
    return () => URL.revokeObjectURL(url);
  });

  // One-time secret reveal (create or regenerate). Cleared when dismissed;
  // the backend never returns the token/URL again after this.
  let revealed = $state<{ title: string; url: string } | null>(null);

  // Per-row action state
  let togglingId = $state<string | null>(null);
  let regeneratingId = $state<string | null>(null);
  let confirmRegenerate = $state<WebhookView | null>(null);
  let confirmDelete = $state<WebhookView | null>(null);
  let deletingId = $state<string | null>(null);

  function acceptFile(file: File): boolean {
    if (!file.type.startsWith('image/')) {
      toast.error(m('server_settings.webhooks.invalid_image'));
      return false;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error(m('server_settings.webhooks.image_too_large'));
      return false;
    }
    return true;
  }

  function handleFileSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file && acceptFile(file)) selectedFile = file;
  }

  const avatarDropZone = dropZone({
    onDrop: (files) => {
      const file = files[0];
      if (file && acceptFile(file)) selectedFile = file;
    },
    onDragStateChange: (dragging) => (isDragging = dragging),
    acceptedTypes: ['image/*']
  });

  async function handleCreate(e: Event) {
    e.preventDefault();
    if (!name.trim() || !roomId || creating) return;

    creating = true;
    try {
      let avatar: WebhookImageUpload | undefined;
      if (selectedFile) {
        avatar = {
          image: new Uint8Array(await selectedFile.arrayBuffer()),
          filename: selectedFile.name,
          contentType: selectedFile.type
        };
      }
      const created = await createAdminWebhookAPI(apiConfig()).create({
        roomId,
        name: name.trim(),
        avatar
      });
      upsertWebhook(created.webhook);
      name = '';
      roomId = '';
      selectedFile = null;
      if (fileInput) fileInput.value = '';
      toast.success(m('server_settings.webhooks.created'));
      revealed = { title: m('server_settings.webhooks.url_dialog_title'), url: created.url };
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : m('server_settings.webhooks.create_failed')
      );
    } finally {
      creating = false;
    }
  }

  async function handleToggleDisabled(webhook: WebhookView) {
    if (togglingId) return;
    togglingId = webhook.id;
    try {
      const updated = await createAdminWebhookAPI(apiConfig()).update({
        id: webhook.id,
        disabled: !webhook.disabled
      });
      upsertWebhook(updated);
      toast.success(m('server_settings.webhooks.updated'));
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : m('server_settings.webhooks.update_failed')
      );
    } finally {
      togglingId = null;
    }
  }

  async function handleRegenerate(webhook: WebhookView) {
    if (regeneratingId) return;
    regeneratingId = webhook.id;
    try {
      const result = await createAdminWebhookAPI(apiConfig()).regenerateToken(webhook.id);
      upsertWebhook(result.webhook);
      confirmRegenerate = null;
      toast.success(m('server_settings.webhooks.regenerated'));
      revealed = {
        title: m('server_settings.webhooks.regenerate_url_dialog_title'),
        url: result.url
      };
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : m('server_settings.webhooks.regenerate_failed')
      );
    } finally {
      regeneratingId = null;
    }
  }

  async function handleDelete(webhook: WebhookView) {
    if (deletingId) return;
    deletingId = webhook.id;
    try {
      await createAdminWebhookAPI(apiConfig()).remove(webhook.id);
      removeWebhook(webhook.id);
      confirmDelete = null;
      toast.success(m('server_settings.webhooks.deleted'));
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : m('server_settings.webhooks.delete_failed')
      );
    } finally {
      deletingId = null;
    }
  }
</script>

<div class="flex flex-col gap-6">
  <!-- Create form -->
  <Panel title={m('server_settings.webhooks.create')} icon="icon-[uil--link-add]">
    <form onsubmit={handleCreate} class="flex flex-col gap-4">
      <Select
        id="webhook-room"
        label={m('server_settings.webhooks.room_label')}
        bind:value={roomId}
        options={roomOptions}
        placeholder={m('server_settings.webhooks.room_placeholder')}
        disabled={creating}
      />

      <TextInput
        id="webhook-name"
        label={m('server_settings.webhooks.name_label')}
        bind:value={name}
        disabled={creating}
        description={m('server_settings.webhooks.name_help')}
      />

      <div
        class="relative flex items-center gap-4"
        data-testid="webhook-avatar-drop-zone"
        {@attach avatarDropZone}
      >
        <DropZoneOverlay
          visible={isDragging}
          title={m('server_settings.webhooks.drop_image')}
          subtitle={m('server_settings.webhooks.drop_subtitle')}
        />
        <div
          class="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-emphasized text-muted"
        >
          {#if previewUrl}
            <img
              src={previewUrl}
              alt={m('server_settings.webhooks.preview_alt')}
              class="h-full w-full object-cover"
            />
          {:else}
            <span class="text-2xl icon-[uil--robot]"></span>
          {/if}
        </div>
        <div class="flex flex-col gap-2">
          <input
            type="file"
            accept="image/*"
            class="hidden"
            bind:this={fileInput}
            onchange={handleFileSelect}
          />
          <Button variant="secondary" onclick={() => fileInput?.click()} disabled={creating}>
            <span class="inline-flex items-center gap-2">
              <span class="icon-[uil--image-upload]"></span>
              {selectedFile
                ? m('server_settings.webhooks.change_image')
                : m('server_settings.webhooks.choose_image')}
            </span>
          </Button>
          {#if selectedFile}
            <span class="text-sm text-muted">{selectedFile.name}</span>
          {/if}
        </div>
      </div>

      <div>
        <Button
          type="submit"
          loading={creating}
          disabled={!canSubmit}
          loadingText={m('server_settings.webhooks.creating')}
        >
          <span class="icon-[uil--plus]"></span>
          {m('server_settings.webhooks.create_button')}
        </Button>
      </div>
    </form>
  </Panel>

  <!-- Existing webhooks -->
  <Panel
    title={m('server_settings.webhooks.list_title')}
    icon="icon-[uil--link-add]"
    count={webhooks.length}
    noPadding
  >
    {#if loading}
      <div class="p-6 text-muted">{m('server_settings.webhooks.loading')}</div>
    {:else if error}
      <div class="p-6 text-danger">{error}</div>
    {:else}
      <DataTable
        items={webhooks}
        columns={5}
        getKey={(webhook) => webhook.id}
        emptyMessage={m('server_settings.webhooks.empty')}
      >
        {#snippet header()}
          <th class="px-4 py-2">{m('server_settings.webhooks.column_name')}</th>
          <th class="px-4 py-2">{m('server_settings.webhooks.column_room')}</th>
          <th class="px-4 py-2">{m('server_settings.webhooks.column_created')}</th>
          <th class="px-4 py-2">{m('server_settings.webhooks.column_status')}</th>
          <th class="px-4 py-2"></th>
        {/snippet}
        {#snippet row(webhook)}
          <td class="px-4 py-2">
            <span class="inline-flex items-center gap-2">
              <span
                class="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-emphasized text-muted"
              >
                {#if webhook.avatarUrl}
                  <img
                    src={webhook.avatarUrl}
                    alt={webhook.name}
                    class="h-full w-full object-cover"
                  />
                {:else}
                  <span class="text-sm icon-[uil--robot]"></span>
                {/if}
              </span>
              {webhook.name}
            </span>
          </td>
          <td class="px-4 py-2 text-muted">{roomName(webhook.roomId)}</td>
          <td class="px-4 py-2 text-muted">{formatCreated(webhook.createdAtMs)}</td>
          <td class="px-4 py-2">
            {#if webhook.disabled}
              <span class="text-muted">{m('server_settings.webhooks.disabled')}</span>
            {:else}
              <span class="text-success">{m('server_settings.webhooks.enabled')}</span>
            {/if}
          </td>
          <td class="px-4 py-2 text-right whitespace-nowrap">
            <Button
              variant="ghost"
              onclick={() => (confirmRegenerate = webhook)}
              disabled={regeneratingId === webhook.id}
            >
              <span class="icon-[uil--refresh]"></span>
              {m('server_settings.webhooks.regenerate_token')}
            </Button>
            <Button
              variant="ghost"
              onclick={() => handleToggleDisabled(webhook)}
              disabled={togglingId === webhook.id}
            >
              {#if webhook.disabled}
                <span class="icon-[uil--play]"></span>
                {m('server_settings.webhooks.enable')}
              {:else}
                <span class="icon-[uil--pause]"></span>
                {m('server_settings.webhooks.disable')}
              {/if}
            </Button>
            <Button variant="ghost" onclick={() => (confirmDelete = webhook)}>
              <span class="inline-flex items-center gap-2 text-error">
                <span class="icon-[uil--trash-alt]"></span>
                {m('server_settings.webhooks.delete')}
              </span>
            </Button>
          </td>
        {/snippet}
      </DataTable>
    {/if}
  </Panel>
</div>

<!-- One-time secret URL reveal -->
{#if revealed}
  {@const revealedUrl = revealed.url}
  <Dialog visible title={revealed.title} onclose={() => (revealed = null)}>
    <div class="flex flex-col gap-4">
      <p class="flex items-start gap-2 text-warning">
        <span class="mt-0.5 shrink-0 text-lg icon-[uil--exclamation-triangle]"></span>
        <span>{m('server_settings.webhooks.url_warning')}</span>
      </p>
      <div class="rounded-md border border-border bg-surface-emphasized/40 p-3">
        <CopyId value={revealedUrl} />
      </div>
      <div class="flex justify-end">
        <Button onclick={() => (revealed = null)}>{m('server_settings.webhooks.done')}</Button>
      </div>
    </div>
  </Dialog>
{/if}

<!-- Regenerate token confirmation -->
{#if confirmRegenerate}
  {@const webhook = confirmRegenerate}
  <ConfirmDialog
    title={m('server_settings.webhooks.regenerate_confirm_title')}
    tone="warning"
    actionLabel={m('server_settings.webhooks.regenerate_confirm_action')}
    loading={regeneratingId === webhook.id}
    onconfirm={() => handleRegenerate(webhook)}
    onclose={() => (confirmRegenerate = null)}
  >
    {m('server_settings.webhooks.regenerate_confirm_body')}
  </ConfirmDialog>
{/if}

<!-- Delete confirmation -->
{#if confirmDelete}
  {@const webhook = confirmDelete}
  <ConfirmDialog
    title={m('server_settings.webhooks.delete_confirm_title')}
    tone="danger"
    actionLabel={m('server_settings.webhooks.delete_confirm_action')}
    loading={deletingId === webhook.id}
    onconfirm={() => handleDelete(webhook)}
    onclose={() => (confirmDelete = null)}
  >
    {m('server_settings.webhooks.delete_confirm_body')}
  </ConfirmDialog>
{/if}
