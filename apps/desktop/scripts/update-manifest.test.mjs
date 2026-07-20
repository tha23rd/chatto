import assert from "node:assert/strict";
import test from "node:test";

import {
  buildUpdateManifest,
  immutableAssetUrl,
  validateUpdateManifest,
} from "./update-manifest.mjs";

const version = "0.1.0-nightly.20260719183045.812";
const installerName = `Chatto_${version}_x64-setup.exe`;
const signature = "dGF1cmktbWluaXNpZ24tc2lnbmF0dXJl";

test("builds the exact Tauri static Windows manifest", () => {
  const manifest = buildUpdateManifest({
    version,
    publishedAt: "2026-07-19T18:30:45Z",
    notes: "Nightly desktop update.",
    installerName,
    signature,
  });

  assert.deepEqual(manifest, {
    version,
    notes: "Nightly desktop update.",
    pub_date: "2026-07-19T18:30:45.000Z",
    platforms: {
      "windows-x86_64": {
        url: `https://github.com/chattocorp/chatto/releases/download/desktop-v${version}/${installerName}`,
        signature,
      },
    },
  });
  assert.equal(validateUpdateManifest(manifest).version, version);
});

test("only permits immutable chattocorp/chatto desktop release assets", () => {
  assert.equal(
    immutableAssetUrl(version, installerName),
    `https://github.com/chattocorp/chatto/releases/download/desktop-v${version}/${installerName}`,
  );

  const valid = buildUpdateManifest({
    version,
    publishedAt: "2026-07-19T18:30:45Z",
    notes: "Nightly desktop update.",
    installerName,
    signature,
  });
  valid.platforms["windows-x86_64"].url = "https://attacker.invalid/update.exe";
  assert.throws(() => validateUpdateManifest(valid), /immutable GitHub asset/);
});

test("rejects downgrade metadata, unknown platforms, and non-literal signatures", () => {
  const valid = buildUpdateManifest({
    version: "0.1.0",
    publishedAt: "2026-07-19T18:30:45Z",
    notes: "Stable desktop update.",
    installerName: "Chatto_0.1.0_x64-setup.exe",
    signature,
  });

  assert.throws(
    () => validateUpdateManifest({ ...valid, allowDowngrades: true }),
    /unexpected manifest field/,
  );
  assert.throws(
    () =>
      validateUpdateManifest({
        ...valid,
        platforms: {
          ...valid.platforms,
          linux: valid.platforms["windows-x86_64"],
        },
      }),
    /windows-x86_64/,
  );
  assert.throws(
    () =>
      validateUpdateManifest({
        ...valid,
        platforms: {
          "windows-x86_64": {
            ...valid.platforms["windows-x86_64"],
            signature: "https://example.invalid/update.sig",
          },
        },
      }),
    /literal updater signature/,
  );
});
