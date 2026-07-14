#!/usr/bin/env node
/**
 * Fetches the DeepFilterNet3 model assets used by the fork's experimental
 * noise suppression feature (VITE_ENABLE_NOISE_SUPPRESSION) into the
 * `static/` path matching VITE_NOISE_SUPPRESSION_ASSETS_URL, verifying
 * pinned SHA-256 checksums.
 *
 * The files are ~24 MB combined and are deliberately NOT committed to git.
 * `pnpm build` runs this with `--if-enabled`; a plain manual invocation
 * always fetches (useful for `vite dev` and the benchmark harness).
 *
 * Env handling matches Vite: values are read from process.env first, then
 * from the same `.env` files Vite loads, so a `.env`-enabled build cannot
 * compile the feature as enabled while this script thinks it is disabled.
 *
 * Assets are served from a SINGLE fixed same-origin path
 * (`/models/deepfilternet3`); `VITE_NOISE_SUPPRESSION_ASSETS_URL` must equal
 * it exactly. A free-form URL invited protocol-relative (`//host`),
 * backslash, and query/fragment values that resolve cross-origin or to a
 * different fetch target than the browser requests, and left cleanup unable
 * to find prior custom paths. A fixed path removes all of that.
 *
 * Fail-closed rules under `--if-enabled`:
 * - flag off: remove the fixed assets directory so a disabled build cannot
 *   ship it, then exit successfully.
 * - flag on without the exact assets path: fail the build.
 * - checksum mismatch: fail the build so a changed upstream artifact can
 *   never enter an image silently.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';

const FRONTEND_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC_DIR = path.join(FRONTEND_DIR, 'static');
// The one accepted path. Must match NOISE_SUPPRESSION_ASSETS_PATH in
// src/lib/voice/noiseSuppression.svelte.ts.
const ASSETS_PATH = '/models/deepfilternet3';
const TARGET_DIR = path.join(STATIC_DIR, ...ASSETS_PATH.replace(/^\//, '').split('/'));

const BASE_URL = 'https://cdn.mezon.ai/AI/models/datas/noise_suppression/deepfilternet3';

/** Pinned artifacts for deepfilternet3-noise-filter 1.3.0 (2026-07-12). */
const ASSETS = [
  {
    relativePath: 'v3/pkg/df_bg.wasm',
    sha256: '440b5d12b6ea7d95008736f844221d7874ee15de5cb10d3015002470fdba0432'
  },
  {
    relativePath: 'v3/models/DeepFilterNet3_onnx.tar.gz',
    sha256: 'c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616'
  }
];

// Vite-equivalent env resolution: .env files as the base, real environment
// variables taking precedence (matching Vite, where process.env wins).
const fileEnv = loadEnv('production', FRONTEND_DIR, 'VITE_');
function env(name) {
  return process.env[name] ?? fileEnv[name];
}

const flagEnabled = env('VITE_ENABLE_NOISE_SUPPRESSION') === 'true';
const assetsUrl = env('VITE_NOISE_SUPPRESSION_ASSETS_URL');

if (process.argv.includes('--if-enabled')) {
  if (!flagEnabled) {
    // A disabled build must not ship previously fetched assets: Vite copies
    // everything under static/ into the build output.
    if (existsSync(TARGET_DIR)) {
      await rm(TARGET_DIR, { recursive: true, force: true });
      console.log(`noise suppression disabled; removed assets at ${TARGET_DIR}`);
    } else {
      console.log('noise suppression disabled; skipping model fetch');
    }
    process.exit(0);
  }
  if (assetsUrl !== ASSETS_PATH) {
    console.error(
      `VITE_ENABLE_NOISE_SUPPRESSION=true requires ` +
        `VITE_NOISE_SUPPRESSION_ASSETS_URL=${ASSETS_PATH} exactly ` +
        `(got: ${assetsUrl ?? '<unset>'}), so built clients load models only ` +
        `from that fixed same-origin path.`
    );
    process.exit(1);
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function fetchAsset({ relativePath, sha256: expected }) {
  const target = path.join(TARGET_DIR, relativePath);

  if (existsSync(target)) {
    const current = sha256(await readFile(target));
    if (current === expected) {
      console.log(`ok       ${relativePath} (cached)`);
      return;
    }
    console.log(`stale    ${relativePath} (checksum changed, refetching)`);
  }

  const url = `${BASE_URL}/${relativePath}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  const body = Buffer.from(await response.arrayBuffer());

  const actual = sha256(body);
  if (actual !== expected) {
    throw new Error(
      `Checksum mismatch for ${relativePath}\n  expected ${expected}\n  actual   ${actual}\n` +
        'Refusing to write. If upstream published a new artifact on purpose, ' +
        're-verify it and update the pinned checksum in this script.'
    );
  }

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, body);
  console.log(`fetched  ${relativePath} (${(body.length / 1024 / 1024).toFixed(1)} MB)`);
}

for (const asset of ASSETS) {
  await fetchAsset(asset);
}
console.log(`Noise suppression model assets ready in ${TARGET_DIR}`);
