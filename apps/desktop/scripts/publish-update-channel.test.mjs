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

async function fixture({
  releaseVersion = version,
  notes = "Nightly desktop update.",
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "chatto-channel-test-"));
  const manifest = buildUpdateManifest({
    version: releaseVersion,
    publishedAt: "2026-07-19T18:30:45Z",
    notes,
    installerName: `Chatto_${releaseVersion}_x64-setup.exe`,
    signature: "dGF1cmktbWluaXNpZ24tc2lnbmF0dXJl",
  });
  const manifestPath = join(directory, "update.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { directory, manifestPath, manifest };
}

function response(bytes, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

function options(directory, manifestPath, channel = "nightly") {
  return {
    channel,
    manifestPath,
    bucket: "chatto-desktop-updates",
    endpoint: "https://objects.example.test",
    region: "auto",
    publicBaseUrl: "https://updates.chatto.run",
    temporaryDirectory: directory,
  };
}

test("allowlists channel object keys", () => {
  assert.deepEqual(channelObjectKeys("nightly", version), {
    immutable: `desktop/nightly/versions/${version}/windows-x86_64.json`,
    canonical: "desktop/nightly/windows-x86_64.json",
  });
  assert.throws(() => channelObjectKeys("../../stable", version), /channel/);
  assert.throws(() => channelObjectKeys("nightly", "../latest"), /version/);
  assert.throws(() => channelObjectKeys("stable", version), /stable/);
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
    canonicalReads += 1;
    if (canonicalReads === 1) return response(Buffer.alloc(0), 404);
    return response(await readFile(manifestPath));
  };

  let canonicalReads = 0;

  await publishUpdateChannel(options(directory, manifestPath), {
    runner,
    fetchImpl,
  });

  assert.deepEqual(
    calls.map((args) => args[args.indexOf("s3api") + 1]),
    ["put-object", "get-object", "copy-object", "get-object"],
  );
  assert.ok(calls[0].includes("--if-none-match"));
  assert.ok(calls[2].includes("no-cache"));
  assert.equal(manifest.version, version);
});

test("rejects a Stable rollback before writing any object", async () => {
  const local = await fixture({
    releaseVersion: "0.1.9",
    notes: "Older Stable update.",
  });
  const current = await fixture({
    releaseVersion: "0.2.0",
    notes: "Current Stable update.",
  });
  const currentBytes = await readFile(current.manifestPath);
  let ran = false;

  await assert.rejects(
    publishUpdateChannel(
      options(local.directory, local.manifestPath, "stable"),
      {
        runner: async () => {
          ran = true;
        },
        fetchImpl: async (_url, request = {}) =>
          request.method === "HEAD"
            ? { ok: true, status: 200 }
            : response(currentBytes),
      },
    ),
    /move stable.*backwards/i,
  );
  assert.equal(ran, false);
});

test("rejects an equal Stable version with different manifest bytes", async () => {
  const local = await fixture({
    releaseVersion: "0.2.0",
    notes: "Replacement Stable update.",
  });
  const current = await fixture({
    releaseVersion: "0.2.0",
    notes: "Original Stable update.",
  });
  const currentBytes = await readFile(current.manifestPath);
  let ran = false;

  await assert.rejects(
    publishUpdateChannel(
      options(local.directory, local.manifestPath, "stable"),
      {
        runner: async () => {
          ran = true;
        },
        fetchImpl: async (_url, request = {}) =>
          request.method === "HEAD"
            ? { ok: true, status: 200 }
            : response(currentBytes),
      },
    ),
    /same stable version.*different bytes/i,
  );
  assert.equal(ran, false);
});

test("treats an equal Stable version with identical bytes as an idempotent no-op", async () => {
  const local = await fixture({ releaseVersion: "0.2.0" });
  const localBytes = await readFile(local.manifestPath);
  let ran = false;

  await publishUpdateChannel(
    options(local.directory, local.manifestPath, "stable"),
    {
      runner: async () => {
        ran = true;
      },
      fetchImpl: async (_url, request = {}) =>
        request.method === "HEAD"
          ? { ok: true, status: 200 }
          : response(localBytes),
    },
  );
  assert.equal(ran, false);
});

test("orders Nightly versions by base, immutable UTC timestamp, then run number", async () => {
  const current = await fixture({
    releaseVersion: "0.1.0-nightly.20260719183045.812",
  });
  const currentBytes = await readFile(current.manifestPath);

  for (const olderVersion of [
    "0.0.9-nightly.20260720183045.900",
    "0.1.0-nightly.20260719183044.999",
    "0.1.0-nightly.20260719183045.811",
  ]) {
    const older = await fixture({ releaseVersion: olderVersion });
    await assert.rejects(
      publishUpdateChannel(options(older.directory, older.manifestPath), {
        runner: async () => assert.fail("rollback must not call AWS"),
        fetchImpl: async (_url, request = {}) =>
          request.method === "HEAD"
            ? { ok: true, status: 200 }
            : response(currentBytes),
      }),
      /move nightly.*backwards/i,
    );
  }
});

test("advances Nightly only when the candidate is strictly newer", async () => {
  const current = await fixture({
    releaseVersion: "0.1.0-nightly.20260719183045.812",
  });
  const candidate = await fixture({
    releaseVersion: "0.1.0-nightly.20260719183045.813",
  });
  const currentBytes = await readFile(current.manifestPath);
  const candidateBytes = await readFile(candidate.manifestPath);
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
  let canonicalReads = 0;
  const fetchImpl = async (_url, request = {}) => {
    if (request.method === "HEAD") return { ok: true, status: 200 };
    canonicalReads += 1;
    return response(canonicalReads === 1 ? currentBytes : candidateBytes);
  };

  await publishUpdateChannel(
    options(candidate.directory, candidate.manifestPath),
    { runner, fetchImpl },
  );

  assert.deepEqual(
    calls.map((args) => args[args.indexOf("s3api") + 1]),
    ["put-object", "get-object", "copy-object", "get-object"],
  );
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
  const common = options(directory, manifestPath);

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
