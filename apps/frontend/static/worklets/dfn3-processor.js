// SPDX-FileCopyrightText: 2026 ChattoCorp GmbH
// SPDX-FileCopyrightText: Mezon AI (deepfilternet3-noise-filter)
// SPDX-FileCopyrightText: DeepFilterNet contributors (https://github.com/Rikorose/DeepFilterNet)
// SPDX-License-Identifier: Apache-2.0

/*
 * Fork-owned DeepFilterNet3 AudioWorklet processor.
 *
 * Served same-origin (CSP `worker-src`/`script-src 'self'`) instead of the
 * vendor package's blob-URL worklet. The wasm-bindgen glue below is carried
 * over from `deepfilternet3-noise-filter` 1.3.0 (MIT OR Apache-2.0; Apache-2.0
 * selected) and must match the checksum-pinned `df_bg.wasm` — do not edit the
 * glue when bumping assets; regenerate it from the matching package version.
 *
 * The processor itself is rewritten for realtime robustness. The DFN3 model
 * consumes 480-sample frames while the render quantum is 128 samples, so
 * samples pass through input/output ring buffers. Differences from the vendor
 * processor, all aimed at the "clicks and static" failure mode:
 *
 * - Output priming: playback from the output ring starts only once one full
 *   frame plus one quantum (608 samples, ~12.7 ms) is buffered, giving every
 *   later quantum a jitter margin. The vendor version started at one frame
 *   with zero margin and underran on schedule in steady state.
 * - Underrun concealment: a missed deadline emits a short linear ramp from
 *   the last played sample to silence and re-primes, instead of a hard
 *   128-sample zero gap (an audible click).
 * - Transition hygiene: switching between bypass and the DFN3 path flushes
 *   the rings (stale buffered audio would replay ~13 ms late) and fades the
 *   new path in over one quantum.
 * - Telemetry: the processor reports ready/init-error, and posts periodic
 *   underrun counts so the main thread can fall back to browser processing
 *   under sustained overload.
 */

(function () {
  'use strict';

  // --- AudioWorklet polyfill -------------------------------------------------
  // AudioWorkletGlobalScope has no TextDecoder/TextEncoder. wasm-bindgen
  // constructs `new TextDecoder()` at module top level (unguarded), which
  // would throw inside a worklet and prevent registerProcessor() from
  // running. Provide minimal UTF-8 shims when absent. (Only used for
  // error/diagnostic strings; the audio path passes bytes/floats.)
  if (typeof TextDecoder === 'undefined') {
    globalThis.TextDecoder = class {
      decode(bytes) {
        if (!bytes) return '';
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer || bytes);
        let out = '';
        for (let i = 0; i < u8.length; ) {
          const c = u8[i++];
          if (c < 0x80) out += String.fromCharCode(c);
          else if (c < 0xe0) out += String.fromCharCode(((c & 0x1f) << 6) | (u8[i++] & 0x3f));
          else if (c < 0xf0)
            out += String.fromCharCode(
              ((c & 0x0f) << 12) | ((u8[i++] & 0x3f) << 6) | (u8[i++] & 0x3f)
            );
          else {
            const cp =
              (((c & 0x07) << 18) |
                ((u8[i++] & 0x3f) << 12) |
                ((u8[i++] & 0x3f) << 6) |
                (u8[i++] & 0x3f)) -
              0x10000;
            out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
          }
        }
        return out;
      }
    };
  }
  if (typeof TextEncoder === 'undefined') {
    globalThis.TextEncoder = class {
      encode(str) {
        const out = [];
        for (let i = 0; i < str.length; i++) {
          let c = str.charCodeAt(i);
          if (c < 0x80) out.push(c);
          else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
          else if (c >= 0xd800 && c < 0xdc00) {
            const c2 = str.charCodeAt(++i);
            c = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
            out.push(
              0xf0 | (c >> 18),
              0x80 | ((c >> 12) & 0x3f),
              0x80 | ((c >> 6) & 0x3f),
              0x80 | (c & 0x3f)
            );
          } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        }
        return new Uint8Array(out);
      }
      encodeInto(str, dst) {
        const enc = this.encode(str);
        dst.set(enc);
        return { read: str.length, written: enc.length };
      }
    };
  }

  // --- wasm-bindgen glue (deepfilternet3-noise-filter 1.3.0) -----------------

  let wasm;
  let WASM_VECTOR_LEN = 0;

  function df_create(model_bytes, atten_lim) {
    const ptr0 = passArray8ToWasm0(model_bytes, wasm.__wbindgen_malloc_command_export);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.df_create(ptr0, len0, atten_lim);
    return ret >>> 0;
  }

  function df_get_frame_length(st) {
    const ret = wasm.df_get_frame_length(st);
    return ret >>> 0;
  }

  function df_process_frame(st, input) {
    const ptr0 = passArrayF32ToWasm0(input, wasm.__wbindgen_malloc_command_export);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.df_process_frame(st, ptr0, len0);
    return ret;
  }

  function df_set_atten_lim(st, lim_db) {
    wasm.df_set_atten_lim(st, lim_db);
  }

  function __wbg_get_imports() {
    const import0 = {
      __proto__: null,
      __wbg___wbindgen_throw_344f42d3211c4765: function (arg0, arg1) {
        throw new Error(getStringFromWasm0(arg0, arg1));
      },
      __wbg_getRandomValues_cc7f052a444bb2ce: function () {
        return handleError(function (arg0, arg1) {
          globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
        }, arguments);
      },
      __wbg_new_from_slice_ddf8b82c4d6af38e: function (arg0, arg1) {
        const ret = new Float32Array(getArrayF32FromWasm0(arg0, arg1));
        return ret;
      },
      __wbindgen_init_externref_table: function () {
        const table = wasm.__wbindgen_externrefs;
        const offset = table.grow(4);
        table.set(0, undefined);
        table.set(offset + 0, undefined);
        table.set(offset + 1, null);
        table.set(offset + 2, true);
        table.set(offset + 3, false);
      }
    };
    return {
      __proto__: null,
      './df_bg.js': import0
    };
  }

  function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc_command_export();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
  }

  function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
  }

  function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
  }

  let cachedFloat32ArrayMemory0 = null;
  function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
      cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
  }

  function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
  }

  let cachedUint8ArrayMemory0 = null;
  function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
      cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
  }

  function handleError(f, args) {
    try {
      return f.apply(this, args);
    } catch (e) {
      const idx = addToExternrefTable0(e);
      wasm.__wbindgen_exn_store_command_export(idx);
    }
  }

  function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
  }

  function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
  }

  let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
  cachedTextDecoder.decode();
  const MAX_SAFARI_DECODE_BYTES = 2146435072;
  let numBytesDecoded = 0;
  function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
      cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
      cachedTextDecoder.decode();
      numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
  }

  function __wbg_finalize_init(instance) {
    wasm = instance.exports;
    cachedFloat32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
  }

  function initSync(module) {
    if (wasm !== undefined) return wasm;
    if (module !== undefined && Object.getPrototypeOf(module) === Object.prototype) {
      ({ module } = module);
    }
    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
      module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance);
  }

  // --- processor -------------------------------------------------------------

  const QUANTUM = 128;
  /** Post stats roughly every 2 s at 48 kHz (750 quanta × 128 samples). */
  const STATS_INTERVAL_QUANTA = 750;

  const MessageTypes = {
    SET_SUPPRESSION_LEVEL: 'SET_SUPPRESSION_LEVEL',
    SET_BYPASS: 'SET_BYPASS'
  };

  class ChattoDfn3Processor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      this.dfModel = null;
      this.ok = false;
      this.bypass = false;
      this.usingDfn = false;
      this.transitionPending = false;
      this.inputGap = false;

      this.inputBuffer = null;
      this.outputBuffer = null;
      this.bufferSize = 0;
      this.inWrite = 0;
      this.inRead = 0;
      this.outWrite = 0;
      this.outRead = 0;

      this.primed = false;
      this.primeTarget = 0;
      /** Samples of fade-in left to apply to the currently emitted path. */
      this.fadeRemaining = 0;
      this.lastSample = 0;

      this.underruns = 0;
      this.quantaSinceStats = 0;
      this.tempFrame = null;

      try {
        initSync(options.processorOptions.wasmModule);
        const modelBytes = new Uint8Array(options.processorOptions.modelBytes);
        const level = clampLevel(options.processorOptions.suppressionLevel ?? 50);
        const handle = df_create(modelBytes, level);
        const frameLength = df_get_frame_length(handle);
        this.dfModel = { handle, frameLength };
        this.bufferSize = frameLength * 8;
        this.inputBuffer = new Float32Array(this.bufferSize);
        this.outputBuffer = new Float32Array(this.bufferSize);
        this.tempFrame = new Float32Array(frameLength);
        this.primeTarget = frameLength + QUANTUM;
        this.resetRings();
        this.ok = true;
        this.port.postMessage({ type: 'ready' });
      } catch (error) {
        this.ok = false;
        this.port.postMessage({ type: 'init-error', message: String(error) });
      }
      this.port.onmessage = (event) => this.handleMessage(event.data);
    }

    handleMessage(data) {
      switch (data.type) {
        case MessageTypes.SET_SUPPRESSION_LEVEL:
          if (this.dfModel && typeof data.value === 'number') {
            df_set_atten_lim(this.dfModel.handle, clampLevel(data.value));
          }
          break;
        case MessageTypes.SET_BYPASS: {
          const next = Boolean(data.value);
          if (next !== this.bypass) {
            this.bypass = next;
            // The graph may have this node disconnected while bypassed (the
            // gate is routed straight to the output), so process() might not
            // observe the flip; force the transition bookkeeping on the next
            // callback regardless.
            this.transitionPending = true;
          }
          break;
        }
      }
    }

    inAvailable() {
      return (this.inWrite - this.inRead + this.bufferSize) % this.bufferSize;
    }

    outAvailable() {
      return (this.outWrite - this.outRead + this.bufferSize) % this.bufferSize;
    }

    resetRings() {
      this.inWrite = this.inRead = 0;
      this.outRead = 0;
      // Pre-seed one quantum of silence so playback starts once a single
      // frame is buffered while still holding a full quantum of jitter
      // margin. The seed is start-of-stream silence, not an audible gap;
      // without it the prime target would wait for a second frame and cost
      // an extra ~8 ms of latency.
      this.outputBuffer.fill(0);
      this.outWrite = QUANTUM;
      this.primed = false;
    }

    /**
     * Copy `source` (or the output ring when `source` is null) into every
     * output channel, applying the pending fade-in ramp. Tracks the last
     * emitted sample for underrun concealment.
     */
    emit(outChans, source) {
      for (let i = 0; i < QUANTUM; i++) {
        let s;
        if (source) {
          s = source[i] ?? 0;
        } else {
          s = this.outputBuffer[this.outRead];
          this.outRead = (this.outRead + 1) % this.bufferSize;
        }
        if (this.fadeRemaining > 0) {
          s *= 1 - this.fadeRemaining / QUANTUM;
          this.fadeRemaining--;
        }
        for (let c = 0; c < outChans.length; c++) outChans[c][i] = s;
        this.lastSample = s;
      }
    }

    /** Ramp from the last played sample to silence — a click-free gap. */
    conceal(outChans) {
      const from = this.lastSample;
      for (let i = 0; i < QUANTUM; i++) {
        const s = from * (1 - (i + 1) / QUANTUM);
        for (let c = 0; c < outChans.length; c++) outChans[c][i] = s;
      }
      this.lastSample = 0;
    }

    process(inputList, outputList) {
      const input = inputList[0]?.[0];
      const outChans = outputList[0] ?? [];
      if (outChans.length === 0) return true;

      const wantDfn = this.ok && !this.bypass;
      if (wantDfn !== this.usingDfn || this.transitionPending) {
        // Stale ring contents would replay ~a frame of old audio after a
        // bypass round-trip; flush and fade the new path in.
        if (wantDfn) this.resetRings();
        this.fadeRemaining = QUANTUM;
        this.usingDfn = wantDfn;
        this.transitionPending = false;
      }

      // Absent input (capture-track swap on a device switch, LiveKit track
      // restart): conceal the cut with a ramp on the first gap quantum, then
      // emit the engine's zero-filled silence. When input resumes, flush the
      // rings — pre-gap audio must not replay against the new capture, and a
      // stale old-device tail must not be spliced into one DFN3 frame with
      // new-device samples — and fade the resumed path in.
      if (!input) {
        if (!this.inputGap) {
          this.inputGap = true;
          this.conceal(outChans);
        } else {
          this.lastSample = 0;
        }
        return true;
      }
      if (this.inputGap) {
        this.inputGap = false;
        if (wantDfn) this.resetRings();
        this.fadeRemaining = QUANTUM;
      }

      if (!wantDfn) {
        this.emit(outChans, input);
        return true;
      }

      // Feed the input ring. No overflow guard is needed: the engine clocks
      // exactly one 128-sample quantum per callback and the drain loop below
      // runs in the same callback, so occupancy is bounded at well under one
      // frame plus one quantum — a wrap here would be a logic error, not a
      // load condition.
      for (let i = 0; i < input.length; i++) {
        this.inputBuffer[this.inWrite] = input[i];
        this.inWrite = (this.inWrite + 1) % this.bufferSize;
      }

      const frameLength = this.dfModel.frameLength;
      while (this.inAvailable() >= frameLength) {
        for (let i = 0; i < frameLength; i++) {
          this.tempFrame[i] = this.inputBuffer[this.inRead];
          this.inRead = (this.inRead + 1) % this.bufferSize;
        }
        const processed = df_process_frame(this.dfModel.handle, this.tempFrame);
        for (let i = 0; i < processed.length; i++) {
          this.outputBuffer[this.outWrite] = processed[i];
          this.outWrite = (this.outWrite + 1) % this.bufferSize;
        }
      }

      if (!this.primed) {
        // Initial fill (or refill after an underrun): stay silent until the
        // ring holds a frame plus one quantum of jitter margin. This is
        // start-of-stream latency, not a mid-stream gap — not an underrun.
        if (this.outAvailable() >= this.primeTarget) {
          this.primed = true;
          this.fadeRemaining = QUANTUM;
        } else {
          this.lastSample = 0;
          this.bumpStats();
          return true;
        }
      }

      if (this.outAvailable() >= QUANTUM) {
        this.emit(outChans, null);
      } else {
        // Deadline miss (slow inference or scheduling jitter): conceal the
        // gap with a ramp to silence and re-prime for fresh margin.
        this.underruns++;
        this.conceal(outChans);
        this.primed = false;
      }
      this.bumpStats();
      return true;
    }

    bumpStats() {
      this.quantaSinceStats++;
      if (this.quantaSinceStats >= STATS_INTERVAL_QUANTA) {
        this.port.postMessage({
          type: 'stats',
          underruns: this.underruns,
          quanta: this.quantaSinceStats
        });
        this.underruns = 0;
        this.quantaSinceStats = 0;
      }
    }
  }

  function clampLevel(value) {
    return Math.max(0, Math.min(100, Math.floor(value)));
  }

  registerProcessor('chatto-dfn3-processor', ChattoDfn3Processor);
})();
