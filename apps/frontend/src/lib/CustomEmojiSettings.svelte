<!--
@component

Server-admin management UI for custom emojis. Lists the server's existing
custom emojis with a delete affordance, and lets an admin upload a new one by
providing a shortcode name plus an image file.

Reactions reference custom emojis by their shortcode `name`, so names are the
stable identity shown here alongside the rendered image.
-->
<script lang="ts">
  import { useConnection } from '$lib/state/server/connection.svelte';
  import {
    createAdminCustomEmojiAPI,
    type CustomEmoji
  } from '$lib/api-client/customEmojis';
  import type { ConnectAPIConfig } from '$lib/api-client/connect';
  import { getActiveServer } from '$lib/state/activeServer.svelte';
  import { getCustomEmojis } from '$lib/state/customEmojis.svelte';
  import * as m from '$lib/i18n/messages';

  import { Panel, DataTable } from '$lib/components/admin';
  import { TextInput, Button } from '$lib/ui/form';
  import { toast } from '$lib/ui/toast';
  import { dropZone } from '$lib/attachments/dropZone.svelte';
  import DropZoneOverlay from '$lib/attachments/DropZoneOverlay.svelte';

  const connection = useConnection();

  function apiConfig(): ConnectAPIConfig {
    const conn = connection();
    return {
      serverId: conn.serverId,
      baseUrl: conn.connectBaseUrl,
      bearerToken: conn.bearerToken
    };
  }

  let loading = $state(true);
  let error = $state<string | null>(null);

  // The shared, per-server store is the single source of truth. Mutating it
  // here keeps the emoji picker, composer typeahead, and reactions in sync
  // with uploads/deletes without a client reload.
  const store = getCustomEmojis(getActiveServer());
  const emojis = $derived(store.emojis);

  // Upload form state
  let name = $state('');
  let selectedFile = $state<File | null>(null);
  let uploading = $state(false);
  let fileInput = $state<HTMLInputElement>();
  let isDragging = $state(false);

  const canSubmit = $derived(name.trim().length > 0 && selectedFile !== null && !uploading);

  // Object URL for the local preview; revoked when the selection changes or
  // the component unmounts so blobs are not leaked.
  const previewUrl = $derived(selectedFile ? URL.createObjectURL(selectedFile) : null);
  $effect(() => {
    const url = previewUrl;
    if (!url) return;
    return () => URL.revokeObjectURL(url);
  });

  async function loadEmojis() {
    loading = true;
    error = null;
    // Force-refresh the shared store so this admin view shows the current
    // catalog and every other surface benefits from the refresh too.
    if (!(await store.load(apiConfig()))) {
      error = m['server_settings.custom_emoji.load_failed']();
    }
    loading = false;
  }

  $effect(() => {
    loadEmojis();
  });

  function acceptFile(file: File): boolean {
    if (!file.type.startsWith('image/')) {
      toast.error(m['server_settings.custom_emoji.invalid_image']());
      return false;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error(m['server_settings.custom_emoji.image_too_large']());
      return false;
    }
    return true;
  }

  function handleFileSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file && acceptFile(file)) selectedFile = file;
  }

  const emojiDropZone = dropZone({
    onDrop: (files) => {
      const file = files[0];
      if (file && acceptFile(file)) selectedFile = file;
    },
    onDragStateChange: (dragging) => (isDragging = dragging),
    acceptedTypes: ['image/*']
  });

  async function handleUpload(e: Event) {
    e.preventDefault();
    const file = selectedFile;
    if (!name.trim() || !file || uploading) return;

    uploading = true;
    try {
      const created = await createAdminCustomEmojiAPI(apiConfig()).create(name.trim(), {
        image: new Uint8Array(await file.arrayBuffer()),
        filename: file.name,
        contentType: file.type
      });
      store.upsert(created);
      name = '';
      selectedFile = null;
      if (fileInput) fileInput.value = '';
      toast.success(m['server_settings.custom_emoji.uploaded']());
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : m['server_settings.custom_emoji.upload_failed']()
      );
    } finally {
      uploading = false;
    }
  }

  async function handleDelete(emoji: CustomEmoji) {
    try {
      await createAdminCustomEmojiAPI(apiConfig()).remove(emoji.id);
      store.remove(emoji.id);
      toast.success(m['server_settings.custom_emoji.deleted']());
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : m['server_settings.custom_emoji.delete_failed']()
      );
    }
  }
</script>

<div class="flex flex-col gap-6">
  <!-- Upload form -->
  <Panel title={m['server_settings.custom_emoji.upload']()} icon="iconify uil--smile">
    <form onsubmit={handleUpload} class="flex flex-col gap-4">
      <TextInput
        id="custom-emoji-name"
        label={m['server_settings.custom_emoji.name_label']()}
        bind:value={name}
        disabled={uploading}
        description={m['server_settings.custom_emoji.name_help']()}
      />

      <div
        class="relative flex items-center gap-4"
        data-testid="custom-emoji-drop-zone"
        {@attach emojiDropZone}
      >
        <DropZoneOverlay
          visible={isDragging}
          title={m['server_settings.custom_emoji.drop_image']()}
          subtitle={m['server_settings.custom_emoji.drop_subtitle']()}
        />
        <div
          class="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-emphasized text-muted"
        >
          {#if previewUrl}
            <img
              src={previewUrl}
              alt={m['server_settings.custom_emoji.preview_alt']()}
              class="h-full w-full object-contain"
            />
          {:else}
            <span class="iconify text-2xl uil--image"></span>
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
          <Button variant="secondary" onclick={() => fileInput?.click()} disabled={uploading}>
            <span class="inline-flex items-center gap-2">
              <span class="iconify uil--image-upload"></span>
              {selectedFile
                ? m['server_settings.custom_emoji.change_image']()
                : m['server_settings.custom_emoji.choose_image']()}
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
          loading={uploading}
          disabled={!canSubmit}
          loadingText={m['server_settings.custom_emoji.uploading']()}
        >
          <span class="iconify uil--plus"></span>
          {m['server_settings.custom_emoji.add_button']()}
        </Button>
      </div>
    </form>
  </Panel>

  <!-- Existing emojis -->
  <Panel
    title={m['server_settings.custom_emoji.list_title']()}
    icon="iconify uil--grids"
    count={emojis.length}
    noPadding
  >
    {#if loading}
      <div class="p-6 text-muted">{m['server_settings.custom_emoji.loading']()}</div>
    {:else if error}
      <div class="p-6 text-danger">{error}</div>
    {:else}
      <DataTable
        items={emojis}
        columns={3}
        getKey={(emoji) => emoji.id}
        emptyMessage={m['server_settings.custom_emoji.empty']()}
      >
        {#snippet header()}
          <th class="px-4 py-2">{m['server_settings.custom_emoji.column_preview']()}</th>
          <th class="px-4 py-2">{m['server_settings.custom_emoji.column_name']()}</th>
          <th class="px-4 py-2"></th>
        {/snippet}
        {#snippet row(emoji)}
          <td class="px-4 py-2">
            <img src={emoji.url} alt={emoji.name} class="h-8 w-8 object-contain" />
          </td>
          <td class="px-4 py-2 font-mono text-sm">{emoji.name}</td>
          <td class="px-4 py-2 text-right">
            <Button variant="ghost" onclick={() => handleDelete(emoji)}>
              <span class="inline-flex items-center gap-2 text-error">
                <span class="iconify uil--trash-alt"></span>
                {m['server_settings.custom_emoji.delete']()}
              </span>
            </Button>
          </td>
        {/snippet}
      </DataTable>
    {/if}
  </Panel>
</div>
