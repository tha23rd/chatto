import { describe, expect, it } from 'vitest';

import {
  encodeWavMono,
  sliceToMonoSamples,
  trimClipToWav,
  type DecodedClip
} from './trimAudio';

function ramp(length: number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = i;
  return out;
}

const readString = (view: DataView, offset: number, length: number): string => {
  let text = '';
  for (let i = 0; i < length; i++) text += String.fromCharCode(view.getUint8(offset + i));
  return text;
};

describe('sliceToMonoSamples', () => {
  const clip: DecodedClip = { sampleRate: 100, channels: [ramp(100)] };

  it('extracts the requested second range as frames', () => {
    // 0.1s..0.3s at 100Hz -> frames 10..30 -> 20 samples starting at value 10.
    const out = sliceToMonoSamples(clip, 0.1, 0.3);
    expect(out.length).toBe(20);
    expect(out[0]).toBe(10);
    expect(out[19]).toBe(29);
  });

  it('averages multiple channels into mono', () => {
    const stereo: DecodedClip = {
      sampleRate: 10,
      channels: [Float32Array.from([1, 1, 1]), Float32Array.from([-1, -1, -1])]
    };
    const out = sliceToMonoSamples(stereo, 0, 1);
    expect(Array.from(out)).toEqual([0, 0, 0]);
  });

  it('clamps out-of-range and inverted bounds instead of producing bad slices', () => {
    expect(sliceToMonoSamples(clip, -5, 0.05).length).toBe(5); // negative start -> 0
    expect(sliceToMonoSamples(clip, 0.5, 99).length).toBe(50); // end past duration -> clamped
    expect(sliceToMonoSamples(clip, 0.8, 0.2).length).toBe(0); // end before start -> empty
  });
});

describe('encodeWavMono', () => {
  it('writes a valid 44-byte PCM header with mono/bit-depth fields', () => {
    const bytes = encodeWavMono(Float32Array.from([0, 0.5, -0.5]), 44100);
    const view = new DataView(bytes.buffer);
    expect(readString(view, 0, 4)).toBe('RIFF');
    expect(readString(view, 8, 4)).toBe('WAVE');
    expect(readString(view, 36, 4)).toBe('data');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(44100); // sample rate
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(view.getUint32(40, true)).toBe(3 * 2); // data size = samples * 2 bytes
    expect(bytes.length).toBe(44 + 3 * 2);
  });

  it('clips samples outside [-1, 1] to the 16-bit range', () => {
    const bytes = encodeWavMono(Float32Array.from([2, -2]), 8000);
    const view = new DataView(bytes.buffer);
    expect(view.getInt16(44, true)).toBe(0x7fff);
    expect(view.getInt16(46, true)).toBe(-0x8000);
  });
});

describe('trimClipToWav', () => {
  it('produces a WAV whose data length matches the trimmed frame count', () => {
    const clip: DecodedClip = { sampleRate: 1000, channels: [ramp(1000)] };
    const bytes = trimClipToWav(clip, 0.2, 0.7); // 500 frames
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(40, true)).toBe(500 * 2);
  });
});
