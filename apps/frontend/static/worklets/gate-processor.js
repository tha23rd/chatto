// SPDX-FileCopyrightText: 2026 ChattoCorp GmbH
// SPDX-License-Identifier: Apache-2.0

/*
 * Fork-owned input-gate AudioWorklet processor.
 *
 * Implements the "input sensitivity" noise gate on the audio thread. The
 * previous implementation measured the input level on the main thread with a
 * `requestAnimationFrame` loop and drove a GainNode with setTargetAtTime;
 * browsers stop rAF for hidden tabs, so the gate froze in whatever state it
 * was in — a closed gate left the microphone permanently muted while the tab
 * was in the background (see tha23rd/chatto#82). Running the gate here keeps
 * it sample-accurate and immune to page visibility.
 *
 * Behaviour mirrors the old main-thread gate: key off the peak level of the
 * gained signal, open instantly while the level is at or above the threshold,
 * hold open briefly so short dips between words do not chatter, then close
 * with a slow release. A threshold of 0 disables the gate (pure pass-through
 * with a fast fade-up so re-enabling never clicks).
 *
 * The fork-owned main-thread side (`MicProcessor`) keeps its AnalyserNode
 * purely for the level meter the preferences UI draws; it is display-only.
 */

(function () {
  'use strict';

  const QUANTUM = 128;
  /** Hold the gate open this many sample frames after the last open peak. */
  const HOLD_FRAMES = Math.round(0.25 * 48000); // 250 ms at 48 kHz

  // One-pole smoothing constants per sample (48 kHz), matching the former
  // setTargetAtTime attack/release time constants.
  const ATTACK_COEF = 1 - Math.exp(-1 / (0.01 * 48000)); // 10 ms
  const RELEASE_COEF = 1 - Math.exp(-1 / (0.12 * 48000)); // 120 ms

  const clamp01 = (value) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

  class ChattoGateProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      this.threshold = clamp01(options.processorOptions?.threshold ?? 0);
      this.gain = 1;
      this.holdUntil = 0;
      this.samplePos = 0;
      this.port.onmessage = (event) => {
        const data = event.data;
        if (data?.type === 'SET_THRESHOLD' && typeof data.value === 'number') {
          this.threshold = clamp01(data.value);
        }
      };
    }

    process(inputList, outputList) {
      const input = inputList[0];
      const outChans = outputList[0] ?? [];
      if (outChans.length === 0) return true;
      const from = this.samplePos;
      this.samplePos += QUANTUM;

      // Gate disabled or no input: pass through, fading up on a fast ramp so
      // re-enabling after a closed gate never clicks.
      if (this.threshold <= 0 || !input || input.length === 0) {
        for (let c = 0; c < outChans.length; c++) {
          const src = input?.[Math.min(c, input.length - 1)];
          const dst = outChans[c];
          for (let i = 0; i < QUANTUM; i++) {
            this.gain += (1 - this.gain) * ATTACK_COEF;
            dst[i] = (src ? src[i] : 0) * this.gain;
          }
        }
        return true;
      }

      let peak = 0;
      for (let c = 0; c < input.length; c++) {
        const ch = input[c];
        for (let i = 0; i < ch.length; i++) {
          const a = ch[i] < 0 ? -ch[i] : ch[i];
          if (a > peak) peak = a;
        }
      }
      if (peak >= this.threshold) this.holdUntil = from + HOLD_FRAMES;
      const open = from < this.holdUntil;
      const coef = open ? ATTACK_COEF : RELEASE_COEF;
      const target = open ? 1 : 0;

      for (let c = 0; c < outChans.length; c++) {
        const src = input[Math.min(c, input.length - 1)];
        const dst = outChans[c];
        for (let i = 0; i < QUANTUM; i++) {
          this.gain += (target - this.gain) * coef;
          dst[i] = (src ? src[i] : 0) * this.gain;
        }
      }
      return true;
    }
  }

  registerProcessor('chatto-gate-processor', ChattoGateProcessor);
})();
