import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { validateUpdateManifest } from "./update-manifest.mjs";

const execFileAsync = promisify(execFile);
const CHANNEL_ASSET_NAME = "windows-x86_64.json";
const REPOSITORY =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/;
const SOURCE_SHA = /^[0-9a-f]{40}$/;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const NIGHTLY_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-nightly\.(\d{14})\.(0|[1-9]\d*)$/;

function versionIdentifiers(channel, version) {
  const pattern = channel === "stable" ? STABLE_VERSION : NIGHTLY_VERSION;
  if (channel !== "stable" && channel !== "nightly") {
    throw new Error("channel must be stable or nightly");
  }
  const match = pattern.exec(version);
  if (!match) {
    throw new Error(`version does not match the ${channel} update channel`);
  }
  return match.slice(1).map((identifier) => BigInt(identifier));
}

export function compareChannelVersions(channel, left, right) {
  const leftIdentifiers = versionIdentifiers(channel, left);
  const rightIdentifiers = versionIdentifiers(channel, right);
  for (let index = 0; index < leftIdentifiers.length; index += 1) {
    if (leftIdentifiers[index] < rightIdentifiers[index]) return -1;
    if (leftIdentifiers[index] > rightIdentifiers[index]) return 1;
  }
  return 0;
}

export function channelRelease(channel, repository) {
  if (channel !== "stable" && channel !== "nightly") {
    throw new Error("channel must be stable or nightly");
  }
  if (!REPOSITORY.test(repository ?? "")) {
    throw new Error("invalid GitHub repository");
  }
  const tag = `desktop-${channel}`;
  return {
    tag,
    assetName: CHANNEL_ASSET_NAME,
    publicUrl: `https://github.com/${repository}/releases/download/${tag}/${CHANNEL_ASSET_NAME}`,
  };
}

function validateOptions(options) {
  const release = channelRelease(options.channel, options.repository);
  if (!SOURCE_SHA.test(options.sourceSha ?? "")) {
    throw new Error("invalid source SHA");
  }
  return release;
}

async function defaultRunner(command, args) {
  return execFileAsync(command, args, { maxBuffer: 1024 * 1024 });
}

function missingRelease(error) {
  return /release not found/i.test(
    `${error?.stderr ?? ""}\n${error?.message ?? ""}`,
  );
}

function equalBytes(left, right, description) {
  if (!left.equals(right)) {
    throw new Error(`${description} did not match local manifest`);
  }
}

async function responseBytes(response) {
  return Buffer.from(await response.arrayBuffer());
}

async function ensureRollingRelease(options, release, runner) {
  try {
    await runner("gh", [
      "release",
      "view",
      release.tag,
      "--repo",
      options.repository,
      "--json",
      "tagName",
    ]);
    return;
  } catch (error) {
    if (!missingRelease(error)) throw error;
  }

  const displayChannel =
    options.channel === "stable" ? "Stable" : "Nightly";
  await runner("gh", [
    "release",
    "create",
    release.tag,
    "--repo",
    options.repository,
    "--target",
    options.sourceSha,
    "--title",
    `Chatto Windows ${displayChannel} channel`,
    "--notes",
    `Rolling manifest for the Chatto Windows ${displayChannel} beta channel.`,
    "--prerelease",
  ]);
}

export async function publishUpdateChannel(
  options,
  { runner = defaultRunner, fetchImpl = fetch } = {},
) {
  const release = validateOptions(options);
  const localBytes = await readFile(options.manifestPath);
  const manifest = validateUpdateManifest(
    JSON.parse(localBytes.toString("utf8")),
  );
  versionIdentifiers(options.channel, manifest.version);

  const assetUrl = manifest.platforms["windows-x86_64"].url;
  const assetResponse = await fetchImpl(assetUrl, {
    method: "HEAD",
    redirect: "follow",
  });
  if (!assetResponse.ok) {
    throw new Error(
      `immutable GitHub asset is unavailable (${assetResponse.status})`,
    );
  }

  // Check the client-visible channel before mutating GitHub. This makes stale
  // and replayed publishers fail closed instead of moving a channel backwards.
  const existingCanonicalResponse = await fetchImpl(release.publicUrl, {
    cache: "no-store",
    redirect: "follow",
  });
  if (existingCanonicalResponse.ok) {
    const existingBytes = await responseBytes(existingCanonicalResponse);
    let existingManifest;
    try {
      existingManifest = validateUpdateManifest(
        JSON.parse(existingBytes.toString("utf8")),
      );
    } catch (error) {
      throw new Error(
        `existing canonical manifest is invalid: ${error.message}`,
      );
    }
    const comparison = compareChannelVersions(
      options.channel,
      manifest.version,
      existingManifest.version,
    );
    if (comparison < 0) {
      throw new Error(
        `refusing to move ${options.channel} update channel backwards from ${existingManifest.version} to ${manifest.version}`,
      );
    }
    if (comparison === 0) {
      if (!localBytes.equals(existingBytes)) {
        throw new Error(
          `same ${options.channel} version has different bytes in the canonical manifest`,
        );
      }
      return;
    }
  } else if (existingCanonicalResponse.status !== 404) {
    throw new Error(
      `existing public update channel is unavailable (${existingCanonicalResponse.status})`,
    );
  }

  const workingDirectory =
    options.temporaryDirectory ??
    (await mkdtemp(join(tmpdir(), "chatto-update-channel-")));
  const canonicalManifestPath = join(workingDirectory, release.assetName);
  await copyFile(options.manifestPath, canonicalManifestPath);

  await ensureRollingRelease(options, release, runner);
  await runner("gh", [
    "release",
    "upload",
    release.tag,
    canonicalManifestPath,
    "--repo",
    options.repository,
    "--clobber",
  ]);

  const publicResponse = await fetchImpl(release.publicUrl, {
    cache: "no-store",
    redirect: "follow",
  });
  if (!publicResponse.ok) {
    throw new Error(
      `public update channel is unavailable (${publicResponse.status})`,
    );
  }
  equalBytes(
    localBytes,
    await responseBytes(publicResponse),
    "public update channel",
  );
}

async function main() {
  const [, , channel, manifestPath] = process.argv;
  if (!channel || !manifestPath || process.argv.length !== 4) {
    throw new Error(
      "usage: publish-update-channel.mjs <stable|nightly> <manifest>",
    );
  }
  for (const name of ["GH_TOKEN", "GITHUB_REPOSITORY", "GITHUB_SHA"]) {
    if (!process.env[name]) throw new Error(`${name} is required`);
  }
  await publishUpdateChannel({
    channel,
    manifestPath,
    repository: process.env.GITHUB_REPOSITORY,
    sourceSha: process.env.GITHUB_SHA,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
