<!--
@component

Waveform trim editor for a decoded soundboard clip. Renders the clip's waveform
and two draggable handles so an admin can cut silence (or anything else) from
the start and end before uploading. The selection band between the handles is
draggable too, so an established window can be slid over the clip as a unit
instead of re-dragging each edge. A preview button plays only the selected
region with a moving playhead, at the clip's pending default volume.

`start`/`end` are bound in seconds; the parent slices and re-encodes the
selected region on upload (see `trimAudio.ts`). The handles and the selection
band are exposed as ARIA sliders so they work with the keyboard as well as the
pointer.
-->
<script lang="ts">
  import * as m from '$lib/i18n/messages';
  import { Button } from '$lib/ui/form';

  interface Props {
    /** The decoded clip being trimmed. */
    buffer: AudioBuffer;
    /** Selection start, in seconds. */
    start: number;
    /** Selection end, in seconds. */
    end: number;
    /**
     * Largest allowed selection span, in seconds. The handles are constrained
     * so `end - start` never exceeds this, which lets an admin slide a
     * fixed-length window over a clip that is longer than the upload limit.
     * Defaults to unlimited.
     */
    maxSelectionSeconds?: number;
    /**
     * Playback gain for the preview, 0–1. Tracks the pending default volume so
     * an admin can hear the level they are about to save. Changes apply to an
     * in-flight preview.
     */
    volume?: number;
    disabled?: boolean;
  }

  let {
    buffer,
    start = $bindable(),
    end = $bindable(),
    maxSelectionSeconds = Infinity,
    volume = 1,
    disabled = false
  }: Props = $props();

  // Smallest selectable region, so the two handles can never cross or collapse.
  const MIN_GAP_SECONDS = 0.1;
  // Arrow-key nudge distance for the keyboard slider affordance.
  const KEY_STEP_SECONDS = 0.05;

  const duration = $derived(buffer.duration);
  const selectedSeconds = $derived(Math.max(0, end - start));

  let trackEl = $state<HTMLDivElement>();
  let canvasEl = $state<HTMLCanvasElement>();
  let resizeTick = $state(0);

  let dragging = $state<'start' | 'end' | 'range' | null>(null);
  // Distance in seconds between the pointer and the selection start when a
  // whole-selection drag begins, so the window follows the grab point.
  let rangeGrabSeconds = 0;

  // Preview playback state. The AudioContext is created lazily on first play
  // and closed on unmount.
  let audioCtx: AudioContext | null = null;
  let source: AudioBufferSourceNode | null = null;
  let gain: GainNode | null = null;
  let playing = $state(false);
  let playheadSeconds = $state(0);
  let rafId = 0;

  const clamp = (value: number, min: number, max: number): number =>
    Math.max(min, Math.min(max, value));

  const asPercent = (seconds: number): string =>
    `${duration > 0 ? (seconds / duration) * 100 : 0}%`;

  function formatSeconds(seconds: number): string {
    return `${seconds.toFixed(2)}s`;
  }

  function setHandle(which: 'start' | 'end', seconds: number): void {
    if (which === 'start') {
      // Lower bound keeps the window within maxSelectionSeconds of the end.
      start = clamp(seconds, Math.max(0, end - maxSelectionSeconds), end - MIN_GAP_SECONDS);
    } else {
      end = clamp(seconds, start + MIN_GAP_SECONDS, Math.min(duration, start + maxSelectionSeconds));
    }
  }

  /**
   * Slide the selection so it starts at `nextStart`, preserving its span. The
   * window is clamped to the clip, so pushing past either edge parks it flush
   * against that edge rather than shrinking it.
   */
  function moveSelection(nextStart: number): void {
    const span = Math.max(MIN_GAP_SECONDS, end - start);
    const clamped = clamp(nextStart, 0, Math.max(0, duration - span));
    start = clamped;
    end = clamped + span;
  }

  function secondsFromClientX(clientX: number): number {
    if (!trackEl) return 0;
    const rect = trackEl.getBoundingClientRect();
    const fraction = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    return clamp(fraction, 0, 1) * duration;
  }

  function onHandlePointerDown(which: 'start' | 'end', event: PointerEvent): void {
    if (disabled) return;
    event.preventDefault();
    stopPreview();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    dragging = which;
  }

  function onHandlePointerMove(which: 'start' | 'end', event: PointerEvent): void {
    if (dragging !== which) return;
    setHandle(which, secondsFromClientX(event.clientX));
  }

  function onHandlePointerUp(event: PointerEvent): void {
    if (!dragging) return;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    dragging = null;
  }

  function onRangePointerDown(event: PointerEvent): void {
    if (disabled) return;
    event.preventDefault();
    stopPreview();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    rangeGrabSeconds = secondsFromClientX(event.clientX) - start;
    dragging = 'range';
  }

  function onRangePointerMove(event: PointerEvent): void {
    if (dragging !== 'range') return;
    moveSelection(secondsFromClientX(event.clientX) - rangeGrabSeconds);
  }

  function onRangeKeyDown(event: KeyboardEvent): void {
    if (disabled) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      moveSelection(start - KEY_STEP_SECONDS);
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      moveSelection(start + KEY_STEP_SECONDS);
    } else if (event.key === 'Home') {
      moveSelection(0);
    } else if (event.key === 'End') {
      moveSelection(duration);
    } else {
      return;
    }
    event.preventDefault();
  }

  function onHandleKeyDown(which: 'start' | 'end', event: KeyboardEvent): void {
    if (disabled) return;
    const current = which === 'start' ? start : end;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      setHandle(which, current - KEY_STEP_SECONDS);
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      setHandle(which, current + KEY_STEP_SECONDS);
    } else if (event.key === 'Home') {
      setHandle(which, which === 'start' ? 0 : start + MIN_GAP_SECONDS);
    } else if (event.key === 'End') {
      setHandle(which, which === 'start' ? end - MIN_GAP_SECONDS : duration);
    } else {
      return;
    }
    event.preventDefault();
  }

  function reset(): void {
    stopPreview();
    start = 0;
    // Reset to the largest valid default window rather than the whole clip,
    // which may exceed the allowed selection length.
    end = Math.min(duration, maxSelectionSeconds);
  }

  const isTrimmed = $derived(start > 0.001 || end < duration - 0.001);

  function ensureContext(): AudioContext | null {
    const globals = globalThis as typeof globalThis & {
      webkitAudioContext?: typeof AudioContext;
    };
    const Ctor = globals.AudioContext ?? globals.webkitAudioContext;
    if (!Ctor) return null;
    try {
      if (!audioCtx || audioCtx.state === 'closed') audioCtx = new Ctor();
      if (audioCtx.state === 'suspended') void audioCtx.resume();
      return audioCtx;
    } catch {
      return null;
    }
  }

  function togglePreview(): void {
    if (playing) stopPreview();
    else startPreview();
  }

  function startPreview(): void {
    const ctx = ensureContext();
    if (!ctx) return;
    stopPreview();

    const node = ctx.createBufferSource();
    node.buffer = buffer;
    // Route through a gain node so the preview is audible at the pending
    // default volume, and so slider moves can be applied mid-playback.
    const gainNode = ctx.createGain();
    gainNode.gain.value = clamp(volume, 0, 1);
    node.connect(gainNode);
    gainNode.connect(ctx.destination);
    gain = gainNode;
    const offset = start;
    const span = Math.max(0, end - start);
    const startedAt = ctx.currentTime;
    node.onended = () => {
      if (source === node) stopPreview();
    };
    node.start(0, offset, span);
    source = node;
    playing = true;
    playheadSeconds = offset;

    const tick = (): void => {
      if (!playing) return;
      playheadSeconds = Math.min(end, offset + (ctx.currentTime - startedAt));
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  function stopPreview(): void {
    playing = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (source) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
      source = null;
    }
    if (gain) {
      gain.disconnect();
      gain = null;
    }
  }

  function drawWaveform(): void {
    const canvas = canvasEl;
    if (!canvas) return;
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    if (cssWidth === 0 || cssHeight === 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(cssWidth * dpr);
    canvas.height = Math.floor(cssHeight * dpr);
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;
    ctx2d.scale(dpr, dpr);
    ctx2d.clearRect(0, 0, cssWidth, cssHeight);
    ctx2d.fillStyle = getComputedStyle(canvas).color || '#888';

    const data = buffer.getChannelData(0);
    const bars = Math.max(1, Math.floor(cssWidth / 3));
    const step = Math.max(1, Math.floor(data.length / bars));
    const mid = cssHeight / 2;
    const barWidth = cssWidth / bars;

    for (let b = 0; b < bars; b++) {
      let peak = 0;
      const base = b * step;
      for (let i = 0; i < step && base + i < data.length; i++) {
        const value = Math.abs(data[base + i]);
        if (value > peak) peak = value;
      }
      const barHeight = Math.max(1, peak * cssHeight * 0.9);
      ctx2d.fillRect(b * barWidth, mid - barHeight / 2, Math.max(1, barWidth - 1), barHeight);
    }
  }

  // Redraw the waveform whenever the clip or the element size changes. Canvas
  // is external state, so an effect is the right tool here.
  $effect(() => {
    // Track dependencies explicitly.
    void buffer;
    void resizeTick;
    drawWaveform();
  });

  // Follow the volume prop into the live Web Audio graph so an in-flight
  // preview reflects slider moves immediately.
  $effect(() => {
    const level = clamp(volume, 0, 1);
    if (gain) gain.gain.value = level;
  });

  // Observe size changes so the waveform stays crisp across layout/DPR shifts.
  $effect(() => {
    if (!canvasEl || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => (resizeTick += 1));
    observer.observe(canvasEl);
    return () => observer.disconnect();
  });

  // Tear down audio on unmount.
  $effect(() => {
    return () => {
      stopPreview();
      if (audioCtx && audioCtx.state !== 'closed') void audioCtx.close();
      audioCtx = null;
    };
  });
</script>

<div class="flex flex-col gap-2">
  <div class="flex items-center justify-between text-sm text-muted">
    <span>{m['soundboard.trim_help']()}</span>
    <span class="tabular-nums">{formatSeconds(selectedSeconds)}</span>
  </div>

  <div
    bind:this={trackEl}
    class="relative h-24 w-full overflow-hidden rounded-lg bg-surface-emphasized select-none"
    class:opacity-60={disabled}
  >
    <canvas bind:this={canvasEl} class="absolute inset-0 h-full w-full text-muted"></canvas>

    <!-- Dim the regions outside the selection. -->
    <div
      class="absolute inset-y-0 left-0 bg-surface/70"
      style:width={asPercent(start)}
    ></div>
    <div
      class="absolute inset-y-0 right-0 bg-surface/70"
      style:width={asPercent(duration - end)}
    ></div>

    <!-- Selection band. Draggable so the window can be moved as a unit. -->
    <div
      class={[
        'absolute inset-y-0 border-x-2 border-action/80 bg-action/10',
        disabled ? 'cursor-not-allowed' : dragging === 'range' ? 'cursor-grabbing' : 'cursor-grab'
      ]}
      style:left={asPercent(start)}
      style:right={asPercent(duration - end)}
      role="slider"
      tabindex={disabled ? -1 : 0}
      aria-label={m['soundboard.trim_range_handle']()}
      aria-valuemin={0}
      aria-valuemax={Math.max(0, duration - selectedSeconds)}
      aria-valuenow={start}
      aria-valuetext={`${formatSeconds(start)} – ${formatSeconds(end)}`}
      onpointerdown={onRangePointerDown}
      onpointermove={onRangePointerMove}
      onpointerup={onHandlePointerUp}
      onkeydown={onRangeKeyDown}
    ></div>

    <!-- Playhead. -->
    {#if playing}
      <div
        class="pointer-events-none absolute inset-y-0 w-px bg-action"
        style:left={asPercent(playheadSeconds)}
      ></div>
    {/if}

    <!-- Start handle. -->
    <div
      class="absolute inset-y-0 -ml-1.5 flex w-3 cursor-ew-resize items-center justify-center"
      style:left={asPercent(start)}
      role="slider"
      tabindex={disabled ? -1 : 0}
      aria-label={m['soundboard.trim_start_handle']()}
      aria-valuemin={0}
      aria-valuemax={duration}
      aria-valuenow={start}
      aria-valuetext={formatSeconds(start)}
      onpointerdown={(e) => onHandlePointerDown('start', e)}
      onpointermove={(e) => onHandlePointerMove('start', e)}
      onpointerup={onHandlePointerUp}
      onkeydown={(e) => onHandleKeyDown('start', e)}
    >
      <span class="h-full w-1 rounded-full bg-action"></span>
    </div>

    <!-- End handle. -->
    <div
      class="absolute inset-y-0 -ml-1.5 flex w-3 cursor-ew-resize items-center justify-center"
      style:left={asPercent(end)}
      role="slider"
      tabindex={disabled ? -1 : 0}
      aria-label={m['soundboard.trim_end_handle']()}
      aria-valuemin={0}
      aria-valuemax={duration}
      aria-valuenow={end}
      aria-valuetext={formatSeconds(end)}
      onpointerdown={(e) => onHandlePointerDown('end', e)}
      onpointermove={(e) => onHandlePointerMove('end', e)}
      onpointerup={onHandlePointerUp}
      onkeydown={(e) => onHandleKeyDown('end', e)}
    >
      <span class="h-full w-1 rounded-full bg-action"></span>
    </div>
  </div>

  <div class="flex items-center justify-between text-xs text-muted">
    <span class="tabular-nums">{formatSeconds(start)}</span>
    <div class="flex items-center gap-2">
      <Button variant="secondary" onclick={togglePreview} {disabled}>
        <span class="inline-flex items-center gap-2">
          <span class="iconify {playing ? 'uil--square' : 'uil--play'}"></span>
          {playing ? m['soundboard.trim_stop']() : m['soundboard.trim_preview']()}
        </span>
      </Button>
      <Button variant="ghost" onclick={reset} disabled={disabled || !isTrimmed}>
        {m['soundboard.trim_reset']()}
      </Button>
    </div>
    <span class="tabular-nums">{formatSeconds(end)}</span>
  </div>
</div>
