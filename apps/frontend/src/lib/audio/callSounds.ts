/**
 * Fixed voice-call participant and stream transition cues using Web Audio.
 *
 * These are intentionally separate from configurable notification sounds:
 * call cues do not read notification sound IDs, filters, or envelopes.
 */

export type CallSoundKind = 'join' | 'leave' | 'stream-start' | 'stream-stop';

const CUE_DURATION_MS = 480;
const NOTE_DURATION_SECONDS = 0.18;
const NOTE_SPACING_SECONDS = 0.11;
const OUTPUT_GAIN = 0.11;
const CUE_FREQUENCIES: Record<CallSoundKind, readonly number[]> = {
  join: [523.25, 659.25],
  leave: [659.25, 523.25],
  'stream-start': [392, 523.25, 783.99],
  'stream-stop': [783.99, 523.25, 392]
};

let audioCtx: AudioContext | null = null;

export function playCallSound(kind: CallSoundKind): Promise<void> {
  const ctx = getContext();
  if (!ctx) return Promise.resolve();

  const frequencies = CUE_FREQUENCIES[kind];
  const output = ctx.createGain();
  output.gain.value = OUTPUT_GAIN;
  output.connect(ctx.destination);

  frequencies.forEach((frequency, index) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const start = ctx.currentTime + index * NOTE_SPACING_SECONDS;
    const stop = start + NOTE_DURATION_SECONDS;

    osc.type = 'sine';
    osc.frequency.value = frequency;

    gain.gain.setValueAtTime(0.001, start);
    gain.gain.exponentialRampToValueAtTime(1, start + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.001, stop);

    osc.connect(gain);
    gain.connect(output);
    osc.start(start);
    osc.stop(stop);
  });

  setTimeout(() => {
    try {
      output.disconnect();
    } catch {
      // Some browsers throw if the node is already disconnected.
    }
  }, CUE_DURATION_MS);

  return delay(CUE_DURATION_MS);
}

function getContext(): AudioContext | null {
  const globals = globalThis as typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };
  const AudioContextCtor = globals.AudioContext ?? globals.webkitAudioContext;
  if (!AudioContextCtor) return null;

  try {
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new AudioContextCtor();
    }
    if (audioCtx.state === 'suspended') {
      void audioCtx.resume();
    }
    return audioCtx;
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
