/**
 * Client-side trimming of decoded soundboard clips.
 *
 * The soundboard upload flow lets an admin cut silence (or anything else) from
 * the start and end of a clip before uploading. Rather than transcode on the
 * server, we slice the already-decoded {@link AudioBuffer} in the browser and
 * re-encode the selected region as a 16-bit PCM mono WAV — a format the server
 * already accepts. Mono keeps the file comfortably under the upload size limit
 * for a clip of the soundboard's maximum length.
 *
 * The core helpers work on plain sample arrays so they can be unit-tested
 * without a real Web Audio `AudioContext`.
 */

/** A decoded clip reduced to the fields trimming needs. */
export interface DecodedClip {
  sampleRate: number;
  /** One Float32Array of samples per channel. */
  channels: Float32Array[];
}

/** Extract the trimming-relevant fields from a Web Audio buffer. */
export function decodedClipFromAudioBuffer(buffer: AudioBuffer): DecodedClip {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    // Copy so later playback/GC of the source buffer cannot mutate our data.
    channels.push(Float32Array.from(buffer.getChannelData(c)));
  }
  return { sampleRate: buffer.sampleRate, channels };
}

/**
 * Average the channels of `clip` between `startSeconds` and `endSeconds` into a
 * single mono sample array. The range is clamped to the clip's bounds and the
 * start is never allowed past the end, so callers cannot produce a negative or
 * out-of-range slice.
 */
export function sliceToMonoSamples(
  clip: DecodedClip,
  startSeconds: number,
  endSeconds: number
): Float32Array {
  const totalFrames = clip.channels[0]?.length ?? 0;
  if (totalFrames === 0) return new Float32Array(0);

  const clampFrame = (seconds: number): number => {
    const frame = Math.round(seconds * clip.sampleRate);
    if (frame < 0) return 0;
    if (frame > totalFrames) return totalFrames;
    return frame;
  };

  const startFrame = clampFrame(startSeconds);
  const endFrame = Math.max(startFrame, clampFrame(endSeconds));
  const length = endFrame - startFrame;
  const out = new Float32Array(length);

  const channelCount = clip.channels.length;
  for (let ch = 0; ch < channelCount; ch++) {
    const data = clip.channels[ch];
    for (let i = 0; i < length; i++) {
      out[i] += data[startFrame + i] / channelCount;
    }
  }
  return out;
}

/**
 * Encode mono float samples (nominally in [-1, 1]) as a 16-bit PCM WAV file.
 * Samples outside the range are hard-clipped rather than allowed to wrap.
 */
export function encodeWavMono(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format: PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

/**
 * Slice `clip` to `[startSeconds, endSeconds)` and encode it as a mono WAV.
 * Convenience wrapper around {@link sliceToMonoSamples} and
 * {@link encodeWavMono}.
 */
export function trimClipToWav(
  clip: DecodedClip,
  startSeconds: number,
  endSeconds: number
): Uint8Array<ArrayBuffer> {
  return encodeWavMono(sliceToMonoSamples(clip, startSeconds, endSeconds), clip.sampleRate);
}
