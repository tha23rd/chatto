<!--
@component

Server-admin management UI for soundboard sounds. Lists the server's existing
sounds with a play-preview and a delete affordance, and lets an admin upload a
new one by providing a name, an audio file, an optional emoji icon, and a
default playback volume.

Sounds are admin-curated and immutable once uploaded (create + delete only).
Uploads are validated client-side: audio type, ≤20 MB, and ≤10 seconds decoded
duration, so obviously-invalid files are rejected before hitting the network.
The generous byte cap lets an admin drop in a full-quality source file and trim
it down to the few seconds they want before uploading.
-->
<script lang="ts">
  import { useConnection } from '$lib/state/server/connection.svelte';
  import { createAdminSoundboardAPI, type Sound } from '$lib/api-client/soundboard';
  import type { ConnectAPIConfig } from '$lib/api-client/connect';
  import { getActiveServer } from '$lib/state/activeServer.svelte';
  import { getSoundboard } from '$lib/state/soundboard.svelte';
  import * as m from '$lib/i18n/messages';

  import { Panel, DataTable } from '$lib/components/admin';
  import { TextInput, Button, RangeField, FormField } from '$lib/ui/form';
  import ContextMenu from '$lib/ui/ContextMenu.svelte';
  import EmojiPicker from '$lib/components/EmojiPicker.svelte';
  import { toast } from '$lib/ui/toast';
  import { dropZone } from '$lib/attachments/dropZone.svelte';
  import DropZoneOverlay from '$lib/attachments/DropZoneOverlay.svelte';
  import SoundboardTrimmer from '$lib/components/soundboard/SoundboardTrimmer.svelte';
  import { decodedClipFromAudioBuffer, trimClipToWav } from '$lib/audio/trimAudio';

  // Mirrors core.MaxSoundClipBytes on the server.
  const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
  // Longest clip that may be uploaded. Enforced client-side against the region
  // the admin keeps; the server bounds bytes, not duration.
  const MAX_DURATION_SECONDS = 10;
  const ACCEPTED_AUDIO_TYPES = ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm'];
  const ACCEPT_ATTR = ACCEPTED_AUDIO_TYPES.join(',');

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
  // here keeps the in-call soundboard panel in sync with uploads/deletes
  // without a client reload.
  const store = getSoundboard(getActiveServer());
  const sounds = $derived(store.sounds);

  // Upload form state
  let name = $state('');
  let emoji = $state('');
  let volumePercent = $state(100);
  let selectedFile = $state<File | null>(null);
  let uploading = $state(false);
  let fileInput = $state<HTMLInputElement>();
  let isDragging = $state(false);
  let emojiPickerAnchor = $state<{ top: number; bottom: number; left: number } | null>(null);

  function openEmojiPicker(event: MouseEvent) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    emojiPickerAnchor = { top: rect.top, bottom: rect.bottom, left: rect.left };
  }

  function handleEmojiSelect(chosen: string) {
    emoji = chosen;
    emojiPickerAnchor = null;
  }

  // Decoded clip + trim selection (seconds). The trimmer edits trimStart/trimEnd
  // in place; on upload we only re-encode when the selection actually differs
  // from the whole clip, so untrimmed uploads keep their original bytes/format.
  let decodedBuffer = $state<AudioBuffer | null>(null);
  let trimStart = $state(0);
  let trimEnd = $state(0);

  function resetSelection() {
    selectedFile = null;
    decodedBuffer = null;
    trimStart = 0;
    trimEnd = 0;
    if (fileInput) fileInput.value = '';
  }

  const canSubmit = $derived(name.trim().length > 0 && selectedFile !== null && !uploading);

  // A single shared preview player so starting one preview stops the previous.
  let previewAudio: HTMLAudioElement | null = null;

  async function loadSounds() {
    loading = true;
    error = null;
    // Force-refresh the shared store so this admin view shows the current
    // catalog and the in-call panel benefits from the refresh too.
    if (!(await store.load(apiConfig()))) {
      error = m['soundboard.load_failed']();
    }
    loading = false;
  }

  $effect(() => {
    loadSounds();
  });

  /**
   * Validate an audio file and, if valid, keep it as the pending selection.
   * Decodes the clip with the Web Audio API to measure its real duration
   * because file size alone does not bound length.
   */
  async function acceptFile(file: File): Promise<void> {
    if (!ACCEPTED_AUDIO_TYPES.includes(file.type)) {
      toast.error(m['soundboard.invalid_audio']());
      return;
    }
    if (file.size > MAX_AUDIO_BYTES) {
      toast.error(m['soundboard.audio_too_large']());
      return;
    }

    let decoded: AudioBuffer;
    try {
      const bytes = await file.arrayBuffer();
      // decodeAudioData detaches its input, so decode a copy.
      const ctx = new AudioContext();
      try {
        decoded = await ctx.decodeAudioData(bytes.slice(0));
      } finally {
        void ctx.close();
      }
    } catch {
      toast.error(m['soundboard.decode_failed']());
      return;
    }

    selectedFile = file;
    // Keep the decoded clip so the trimmer can render its waveform and so upload
    // can re-encode the selected region. The buffer stays valid after its decode
    // context is closed.
    //
    // A clip longer than the duration limit is NOT rejected here: the whole
    // point of the trimmer is to cut a longer clip down to size. We default the
    // selection to the first `MAX_DURATION_SECONDS` so it is already valid, and
    // the trimmer constrains the window to that length while the admin adjusts
    // where it sits.
    decodedBuffer = decoded;
    trimStart = 0;
    trimEnd = Math.min(decoded.duration, MAX_DURATION_SECONDS);
    if (!name.trim()) {
      // Seed the name from the file name for convenience.
      name = file.name.replace(/\.[^.]+$/, '').slice(0, 64);
    }
  }

  function handleFileSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void acceptFile(file);
  }

  const soundDropZone = dropZone({
    onDrop: (files) => {
      const file = files[0];
      if (file) void acceptFile(file);
    },
    onDragStateChange: (dragging) => (isDragging = dragging),
    acceptedTypes: ACCEPTED_AUDIO_TYPES
  });

  /**
   * Build the audio payload to upload. When the admin has trimmed the clip we
   * re-encode the selected region as a mono WAV; otherwise the original bytes
   * are uploaded untouched so no needless transcode is applied.
   */
  async function buildAudioUpload(
    file: File
  ): Promise<{ audio: Uint8Array<ArrayBuffer>; filename: string; contentType: string } | null> {
    const buffer = decodedBuffer;
    // The selected region must respect the duration limit. The trimmer already
    // constrains the window to this length, so this is a defensive backstop.
    if (buffer && trimEnd - trimStart > MAX_DURATION_SECONDS + 0.05) {
      toast.error(m['soundboard.audio_too_long']());
      return null;
    }
    const trimmed = buffer !== null && (trimStart > 0.001 || trimEnd < buffer.duration - 0.001);
    if (buffer && trimmed) {
      const wav = trimClipToWav(decodedClipFromAudioBuffer(buffer), trimStart, trimEnd);
      if (wav.byteLength > MAX_AUDIO_BYTES) {
        toast.error(m['soundboard.audio_too_large']());
        return null;
      }
      const base = file.name.replace(/\.[^.]+$/, '') || 'sound';
      return { audio: wav, filename: `${base}.wav`, contentType: 'audio/wav' };
    }
    return {
      audio: new Uint8Array(await file.arrayBuffer()),
      filename: file.name,
      contentType: file.type
    };
  }

  async function handleUpload(e: Event) {
    e.preventDefault();
    const file = selectedFile;
    if (!name.trim() || !file || uploading) return;

    const audioUpload = await buildAudioUpload(file);
    if (!audioUpload) return;

    uploading = true;
    try {
      const created = await createAdminSoundboardAPI(apiConfig()).create(
        name.trim(),
        audioUpload,
        { emoji: emoji.trim(), volume: volumePercent / 100 }
      );
      store.upsert(created);
      name = '';
      emoji = '';
      volumePercent = 100;
      resetSelection();
      toast.success(m['soundboard.uploaded']());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m['soundboard.upload_failed']());
    } finally {
      uploading = false;
    }
  }

  function handlePreview(sound: Sound) {
    previewAudio?.pause();
    const audio = new Audio(sound.url);
    audio.volume = Math.max(0, Math.min(1, sound.volume));
    previewAudio = audio;
    void audio.play().catch(() => toast.error(m['soundboard.play_failed']()));
  }

  async function handleDelete(sound: Sound) {
    try {
      await createAdminSoundboardAPI(apiConfig()).remove(sound.id);
      store.remove(sound.id);
      toast.success(m['soundboard.deleted']());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m['soundboard.delete_failed']());
    }
  }
</script>

<div class="flex flex-col gap-6">
  <!-- Upload form -->
  <Panel title={m['soundboard.upload']()} icon="iconify uil--music">
    <form onsubmit={handleUpload} class="flex flex-col gap-4">
      <TextInput
        id="soundboard-name"
        label={m['soundboard.name_label']()}
        bind:value={name}
        disabled={uploading}
        maxlength={64}
        description={m['soundboard.name_help']()}
      />

      <FormField label={m['soundboard.emoji_label']()}>
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="grid h-10 w-10 shrink-0 cursor-pointer place-items-center rounded-md border border-border bg-background text-lg transition-[background-color,scale] hover:bg-surface active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-60"
            title={m['soundboard.emoji_choose']()}
            aria-label={m['soundboard.emoji_choose']()}
            disabled={uploading}
            onclick={openEmojiPicker}
            data-testid="soundboard-emoji-picker"
          >
            {#if emoji}
              <span aria-hidden="true">{emoji}</span>
            {:else}
              <span class="iconify text-muted uil--smile" aria-hidden="true"></span>
            {/if}
          </button>
          {#if emoji}
            <Button variant="ghost" onclick={() => (emoji = '')} disabled={uploading}>
              {m['soundboard.emoji_clear']()}
            </Button>
          {:else}
            <span class="text-sm text-muted">{m['soundboard.emoji_none']()}</span>
          {/if}
        </div>
      </FormField>

      <RangeField
        id="soundboard-volume"
        label={m['soundboard.volume_label']()}
        bind:value={volumePercent}
        displayValue={`${volumePercent}%`}
        icon="iconify uil--volume"
        min={0}
        max={100}
        step={5}
        disabled={uploading}
      />

      <div
        class="relative flex items-center gap-4"
        data-testid="soundboard-drop-zone"
        {@attach soundDropZone}
      >
        <DropZoneOverlay
          visible={isDragging}
          title={m['soundboard.drop_audio']()}
          subtitle={m['soundboard.drop_subtitle']()}
        />
        <div
          class="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-emphasized text-muted"
        >
          <span class="iconify text-2xl uil--music"></span>
        </div>
        <div class="flex flex-col gap-2">
          <input
            type="file"
            accept={ACCEPT_ATTR}
            class="hidden"
            bind:this={fileInput}
            onchange={handleFileSelect}
          />
          <Button variant="secondary" onclick={() => fileInput?.click()} disabled={uploading}>
            <span class="inline-flex items-center gap-2">
              <span class="iconify uil--upload"></span>
              {selectedFile ? m['soundboard.change_file']() : m['soundboard.choose_file']()}
            </span>
          </Button>
          <span class="text-sm text-muted">
            {selectedFile ? selectedFile.name : m['soundboard.no_file']()}
          </span>
        </div>
      </div>

      {#if decodedBuffer}
        <SoundboardTrimmer
          buffer={decodedBuffer}
          bind:start={trimStart}
          bind:end={trimEnd}
          maxSelectionSeconds={MAX_DURATION_SECONDS}
          volume={volumePercent / 100}
          disabled={uploading}
        />
      {/if}

      <div>
        <Button
          type="submit"
          loading={uploading}
          disabled={!canSubmit}
          loadingText={m['soundboard.uploading']()}
        >
          <span class="iconify uil--plus"></span>
          {m['soundboard.add_button']()}
        </Button>
      </div>
    </form>
  </Panel>

  <!-- Existing sounds -->
  <Panel
    title={m['soundboard.list_title']()}
    icon="iconify uil--music-note"
    count={sounds.length}
    noPadding
  >
    {#if loading}
      <div class="p-6 text-muted">{m['soundboard.loading']()}</div>
    {:else if error}
      <div class="p-6 text-danger">{error}</div>
    {:else}
      <DataTable
        items={sounds}
        columns={3}
        getKey={(sound) => sound.id}
        emptyMessage={m['soundboard.empty']()}
      >
        {#snippet header()}
          <th class="px-4 py-2">{m['soundboard.column_preview']()}</th>
          <th class="px-4 py-2">{m['soundboard.column_name']()}</th>
          <th class="px-4 py-2"></th>
        {/snippet}
        {#snippet row(sound)}
          <td class="px-4 py-2">
            <Button variant="ghost" onclick={() => handlePreview(sound)}>
              <span class="inline-flex items-center gap-2">
                {#if sound.emoji}
                  <span class="text-lg">{sound.emoji}</span>
                {:else}
                  <span class="iconify text-lg uil--play"></span>
                {/if}
                <span class="sr-only">{m['soundboard.play']()}</span>
              </span>
            </Button>
          </td>
          <td class="px-4 py-2 text-sm font-medium">{sound.name}</td>
          <td class="px-4 py-2 text-right">
            <Button variant="ghost" onclick={() => handleDelete(sound)}>
              <span class="inline-flex items-center gap-2 text-error">
                <span class="iconify uil--trash-alt"></span>
                {m['soundboard.delete']()}
              </span>
            </Button>
          </td>
        {/snippet}
      </DataTable>
    {/if}
  </Panel>
</div>

{#if emojiPickerAnchor}
  <ContextMenu anchor={emojiPickerAnchor} onclose={() => (emojiPickerAnchor = null)}>
    <EmojiPicker
      serverId={getActiveServer()}
      includeCustom={false}
      onSelect={handleEmojiSelect}
      onClose={() => (emojiPickerAnchor = null)}
    />
  </ContextMenu>
{/if}
