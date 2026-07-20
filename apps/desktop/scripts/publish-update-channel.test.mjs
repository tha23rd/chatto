import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildUpdateManifest } from "./update-manifest.mjs";
import {
  channelObjectKeys,
  publishUpdateChannel,
} from "./publish-update-channel.mjs";

const version = "0.1.0-nightly.20260719183045.812";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "chatto-channel-test-"));
  const manifest = buildUpdateManifest({
    version,
    publishedAt: "2026-07-19T18:30:45Z",
    notes: "Nightly desktop update.",
    installerName: `Chatto_${version}_x64-setup.exe`,
    signature: "dGF1cmktbWluaXNpZ24tc2lnbmF0dXJl",
  });
  const manifestPath = join(directory, "update.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { directory, manifestPath, manifest };
}

test("allowlists channel object keys", () => {
  assert.deepEqual(channelObjectKeys("nightly", version), {
    immutable: `desktop/nightly/versions/${version}/windows-x86_64.json`,
    canonical: "desktop/nightly/windows-x86_64.json",
  });
  assert.throws(() => channelObjectKeys("../../stable", version), /channel/);
  assert.throws(() => channelObjectKeys("nightly", "../latest"), /version/);
});

test("publishes immutable then canonical and verifies every stored/public byte", async () => {
  const { directory, manifestPath, manifest } = await fixture();
  const calls = [];
  const stored = new Map();
  const runner = async (_command, args) => {
    calls.push([...args]);
    const operation = args[args.indexOf("s3api") + 1];
    const value = (flag) => args[args.indexOf(flag) + 1];
    if (operation === "put-object") {
      stored.set(value("--key"), await readFile(value("--body")));
    } else if (operation === "get-object") {
      await writeFile(args.at(-1), stored.get(value("--key")));
    } else if (operation === "copy-object") {
      const source = decodeURIComponent(value("--copy-source"));
      stored.set(
        value("--key"),
        stored.get(source.slice(source.indexOf("/") + 1)),
      );
    }
  };
  const fetchImpl = async (url, options = {}) => {
    if (options.method === "HEAD") return { ok: true, status: 200 };
    assert.equal(
      url,
      "https://updates.chatto.run/desktop/nightly/windows-x86_64.json",
    );
    const bytes = await readFile(manifestPath);
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
    };
  };

  await publishUpdateChannel(
    {
      channel: "nightly",
      manifestPath,
      bucket: "chatto-desktop-updates",
      endpoint: "https://objects.example.test",
      region: "auto",
      publicBaseUrl: "https://updates.chatto.run",
      temporaryDirectory: directory,
    },
    { runner, fetchImpl },
  );

  assert.deepEqual(
    calls.map((args) => args[args.indexOf("s3api") + 1]),
    ["put-object", "get-object", "copy-object", "get-object"],
  );
  assert.ok(calls[0].includes("--if-none-match"));
  assert.ok(calls[2].includes("no-cache"));
  assert.equal(manifest.version, version);
});

test("rejects arbitrary endpoints, buckets, and public bases before running AWS", async () => {
  const { directory, manifestPath } = await fixture();
  let ran = false;
  const deps = {
    runner: async () => {
      ran = true;
    },
    fetchImpl: async () => ({ ok: true, status: 200 }),
  };
  const common = {
    channel: "nightly",
    manifestPath,
    bucket: "chatto-desktop-updates",
    endpoint: "https://objects.example.test",
    region: "auto",
    publicBaseUrl: "https://updates.chatto.run",
    temporaryDirectory: directory,
  };

  await assert.rejects(
    publishUpdateChannel({ ...common, bucket: "../bucket" }, deps),
    /bucket/,
  );
  await assert.rejects(
    publishUpdateChannel(
      { ...common, endpoint: "http://localhost:9000" },
      deps,
    ),
    /HTTPS/,
  );
  await assert.rejects(
    publishUpdateChannel(
      { ...common, publicBaseUrl: "https://evil.test" },
      deps,
    ),
    /public base/,
  );
  assert.equal(ran, false);
});
