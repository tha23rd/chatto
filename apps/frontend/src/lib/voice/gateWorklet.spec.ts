/**
 * Behavioural tests for the audio-thread input gate
 * (`static/worklets/gate-processor.js`): the gate must open on peaks at or
 * above the threshold, hold through brief dips, close with a slow release,
 * and pass audio untouched when disabled — all driven from the audio thread
 * so hidden tabs cannot freeze it shut (tha23rd/chatto#82).
 *
 * The worklet is plain JS in an IIFE; these tests load it in a Node VM with
 * the two globals it needs and drive `process()` like the render thread does.
 */
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const QUANTUM = 128;
const WORKLET_PATH = new URL('../../../static/worklets/gate-processor.js', import.meta.url);
const WORKLET_SOURCE = await readFile(WORKLET_PATH, 'utf8');

class FakePort {
  messages: { type: string; value?: number }[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  postMessage(data: { type: string; value?: number }) {
    this.messages.push(data);
  }
}

class AudioWorkletProcessor {
  port = new FakePort();
}

type GateInstance = {
  process(inputList: Float32Array[][], outputList: Float32Array[][]): boolean;
  port: FakePort;
};

function makeGate(threshold: number): GateInstance {
  const registry: Record<string, unknown> = {};
  const sandbox: Record<string, unknown> = {
    AudioWorkletProcessor,
    registerProcessor: (name: string, ctor: unknown) => {
      registry[name] = ctor;
    },
    Math,
    Number,
    Object,
    Array,
    Error,
    globalThis: undefined
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(WORKLET_SOURCE, sandbox, { filename: WORKLET_PATH.href });
  const Ctor = registry['chatto-gate-processor'] as new (options: {
    processorOptions: { threshold: number };
  }) => GateInstance;
  return new Ctor({ processorOptions: { threshold } });
}

/** RMS of a buffer slice. */
function rms(buf: Float32Array): number {
  let e = 0;
  for (let i = 0; i < buf.length; i++) e += buf[i] * buf[i];
  return Math.sqrt(e / buf.length);
}

function drive(gate: GateInstance, signals: Float32Array[]): Float32Array[] {
  return signals.map((input) => {
    const out = new Float32Array(QUANTUM);
    gate.process([[input]], [[out]]);
    return out;
  });
}

function constantSignal(amplitude: number, quanta: number): Float32Array[] {
  return Array.from({ length: quanta }, () => new Float32Array(QUANTUM).fill(amplitude));
}

describe('chatto-gate-processor', () => {
  it('passes audio through untouched while the gate is disabled', () => {
    const gate = makeGate(0);
    const input = new Float32Array(QUANTUM).fill(0.25);
    const out = new Float32Array(QUANTUM);
    gate.process([[input]], [[out]]);
    for (let i = 0; i < QUANTUM; i++) expect(out[i]).toBeCloseTo(input[i], 6);
  });

  it('closes on sustained quiet input and reopens on a peak at the threshold', () => {
    const gate = makeGate(0.3);
    // Quiet input below the threshold: the gate releases over ~120 ms.
    const closed = drive(gate, constantSignal(0.05, 400)); // ~1.07 s
    expect(rms(closed.at(-1)!)).toBeLessThan(0.002); // fully closed

    // Loud input at/above the threshold: opens within the 10 ms attack.
    const opened = drive(gate, constantSignal(0.3, 30)); // ~80 ms
    expect(rms(opened.at(-1)!)).toBeGreaterThan(0.29);
  });

  it('holds the gate open through brief dips below the threshold', () => {
    const gate = makeGate(0.3);
    const output = drive(gate, [...constantSignal(0.9, 4), ...constantSignal(0.05, 94)]);
    // 250 ms hold: the last quantum of the quiet stretch is still open...
    expect(rms(output.at(-1)!)).toBeGreaterThan(0.03);
    // ...and a longer quiet stretch releases it.
    const longer = drive(gate, constantSignal(0.05, 200));
    expect(rms(longer.at(-1)!)).toBeLessThan(0.002);
  });

  it('opens live when the threshold is lowered via SET_THRESHOLD', () => {
    const gate = makeGate(0.9);
    const quiet = constantSignal(0.1, 400);
    expect(rms(drive(gate, quiet).at(-1)!)).toBeLessThan(0.005);
    gate.port.onmessage?.({ data: { type: 'SET_THRESHOLD', value: 0.05 } });
    const reopened = drive(gate, quiet.slice(0, 30));
    expect(rms(reopened.at(-1)!)).toBeGreaterThan(0.09);
  });

  it('handles a missing input channel without throwing', () => {
    const gate = makeGate(0.3);
    const out = new Float32Array(QUANTUM);
    expect(() => gate.process([[]], [[out]])).not.toThrow();
    expect(rms(out)).toBe(0);
  });
});
