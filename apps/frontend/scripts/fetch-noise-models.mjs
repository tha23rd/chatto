#!/usr/bin/env node
/**
 * Fetches the DeepFilterNet3 model assets for the fork's enhanced noise
 * suppression modes into the fixed `static/` path, verifying pinned SHA-256
 * checksums. Runs on every `pnpm build` (and manually for `vite dev` and the
 * benchmark harness), so the assets ship in every built frontend; the
 * feature itself is a per-client runtime setting in the call audio menu.
 *
 * The files are ~24 MB combined (~12 MB compressed transfer) and are
 * deliberately NOT committed to git. Already-valid files are skipped by
 * checksum, so CI caching of `static/models/` makes refetches rare.
 *
 * Assets are served from a SINGLE fixed same-origin path
 * (`/models/deepfilternet3`, a constant — never configuration). A free-form
 * URL invited protocol-relative (`//host`), backslash, and query/fragment
 * values that resolve cross-origin or to a different fetch target than the
 * browser requests. A fixed path removes all of that.
 *
 * Fail-closed rule: on checksum mismatch the build fails, so a changed
 * upstream artifact can never enter an image silently.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
