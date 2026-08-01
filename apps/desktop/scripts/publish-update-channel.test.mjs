import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildUpdateManifest } from "./update-manifest.mjs";
import * as channelPublisher from "./publish-update-channel.mjs";

const { compareChannelVersions, publishUpdateChannel } = channelPublisher;
const repository = "tha23rd/chatto";
const sourceSha = "28d085ced6b97af1d774b5bbaf1bd637eda80abf";
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
    repository,
    sourceSha,
    temporaryDirectory: directory,
  };
}

test("derives allowlisted rolling GitHub channel releases", () => {
  assert.equal(typeof channelPublisher.channelRelease, "function");
  assert.deepEqual(channelPublisher.channelRelease("nightly", repository), {
    tag: "desktop-nightly",
    assetName: "windows-x86_64.json",
    publicUrl:
      "https://github.com/tha23rd/chatto/releases/download/desktop-nightly/windows-x86_64.json",
  });
  assert.throws(
    () => channelPublisher.channelRelease("../../stable", repository),
    /channel/,
  );
  assert.throws(
    () => channelPublisher.channelRelease("nightly", "../evil"),
    /repository/,
  );
});

test("creates a rolling prerelease, uploads the canonical manifest, and verifies public bytes", async () => {
  const { directory, manifestPath, manifest } = await fixture();
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "release" && args[1] === "view") {
      const error = new Error("release not found");
      error.stderr = "release not found";
      throw error;
    }
  };
  let canonicalReads = 0;
  const fetchImpl = async (url, request = {}) => {
    if (request.method === "HEAD") return { ok: true, status: 200 };
    assert.equal(
      url,
      "https://github.com/tha23rd/chatto/releases/download/desktop-nightly/windows-x86_64.json",
    );
    canonicalReads += 1;
    if (canonicalReads === 1) return response(Buffer.alloc(0), 404);
    return response(await readFile(manifestPath));
  };

  await publishUpdateChannel(options(directory, manifestPath), {
    runner,
    fetchImpl,
  });

  assert.deepEqual(
    calls.map((call) => call.slice(1, 3)),
    [
      ["release", "view"],
      ["release", "create"],
      ["release", "upload"],
    ],
  );
  assert.ok(calls[1].includes("--prerelease"));
  assert.ok(calls[1].includes(sourceSha));
  assert.ok(calls[2].includes("--clobber"));
  assert.ok(calls[2].some((value) => value.endsWith("windows-x86_64.json")));
  assert.equal(manifest.version, version);
});

test("reuses an existing rolling release", async () => {
  const candidate = await fixture();
  const candidateBytes = await readFile(candidate.manifestPath);
  const calls = [];
  let canonicalReads = 0;

  await publishUpdateChannel(
    options(candidate.directory, candidate.manifestPath),
    {
      runner: async (command, args) => calls.push([command, ...args]),
      fetchImpl: async (_url, request = {}) => {
        if (request.method === "HEAD") return { ok: true, status: 200 };
        canonicalReads += 1;
        return canonicalReads === 1
          ? response(Buffer.alloc(0), 404)
          : response(candidateBytes);
      },
    },
  );

  assert.deepEqual(
    calls.map((call) => call.slice(1, 3)),
    [
      ["release", "view"],
      ["release", "upload"],
    ],
  );
});

test("rejects a Stable rollback before mutating GitHub", async () => {
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
        runner: async () => assert.fail("rollback must not call GitHub"),
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
  let canonicalReads = 0;

  await publishUpdateChannel(
    options(candidate.directory, candidate.manifestPath),
    {
      runner: async (command, args) => calls.push([command, ...args]),
      fetchImpl: async (_url, request = {}) => {
        if (request.method === "HEAD") return { ok: true, status: 200 };
        canonicalReads += 1;
        return response(canonicalReads === 1 ? currentBytes : candidateBytes);
      },
    },
  );

  assert.deepEqual(
    calls.map((call) => call.slice(1, 3)),
    [
      ["release", "view"],
      ["release", "upload"],
    ],
  );
});

test("waits for the public channel CDN to serve the uploaded manifest", async () => {
  const current = await fixture({
    releaseVersion: "0.1.0-nightly.20260719183045.812",
  });
  const candidate = await fixture({
    releaseVersion: "0.1.0-nightly.20260719183045.813",
  });
  const currentBytes = await readFile(current.manifestPath);
  const candidateBytes = await readFile(candidate.manifestPath);
  const sleeps = [];
  let canonicalReads = 0;

  await publishUpdateChannel(
    options(candidate.directory, candidate.manifestPath),
    {
      runner: async () => {},
      fetchImpl: async (_url, request = {}) => {
        if (request.method === "HEAD") return { ok: true, status: 200 };
        canonicalReads += 1;
        return response(canonicalReads < 4 ? currentBytes : candidateBytes);
      },
      sleep: async (delayMs) => sleeps.push(delayMs),
      publicationVerificationDelaysMs: [0, 5, 10],
    },
  );

  assert.equal(canonicalReads, 4);
  assert.deepEqual(sleeps, [5, 10]);
});

test("fails after bounded retries when the public channel does not converge", async () => {
  const current = await fixture({
    releaseVersion: "0.1.0-nightly.20260719183045.812",
  });
  const candidate = await fixture({
    releaseVersion: "0.1.0-nightly.20260719183045.813",
  });
  const currentBytes = await readFile(current.manifestPath);
  const sleeps = [];

  await assert.rejects(
    publishUpdateChannel(options(candidate.directory, candidate.manifestPath), {
      runner: async () => {},
      fetchImpl: async (_url, request = {}) =>
        request.method === "HEAD"
          ? { ok: true, status: 200 }
          : response(currentBytes),
      sleep: async (delayMs) => sleeps.push(delayMs),
      publicationVerificationDelaysMs: [0, 5, 10],
    }),
    /public update channel did not converge after 3 attempts.*did not match/i,
  );

  assert.deepEqual(sleeps, [5, 10]);
});

test("rejects arbitrary repositories and source SHAs before invoking GitHub", async () => {
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
    publishUpdateChannel({ ...common, repository: "../evil" }, deps),
    /repository/,
  );
  await assert.rejects(
    publishUpdateChannel({ ...common, sourceSha: "main-native" }, deps),
    /source SHA/,
  );
  assert.equal(ran, false);
});

test("propagates unexpected rolling release lookup failures", async () => {
  const candidate = await fixture();
  const calls = [];
  const failure = new Error("GitHub API unavailable");
  failure.stderr = "HTTP 503";

  await assert.rejects(
    publishUpdateChannel(options(candidate.directory, candidate.manifestPath), {
      runner: async (command, args) => {
        calls.push([command, ...args]);
        throw failure;
      },
      fetchImpl: async (_url, request = {}) =>
        request.method === "HEAD"
          ? { ok: true, status: 200 }
          : response(Buffer.alloc(0), 404),
    }),
    /GitHub API unavailable/,
  );
  assert.equal(calls.length, 1);
});

test("compares channel versions without lexical timestamp mistakes", () => {
  assert.equal(
    compareChannelVersions(
      "nightly",
      "0.1.0-nightly.20260719183045.9",
      "0.1.0-nightly.20260719183045.10",
    ),
    -1,
  );
  assert.equal(compareChannelVersions("stable", "0.10.0", "0.9.9"), 1);
});
