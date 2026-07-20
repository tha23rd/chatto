import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { validateUpdateManifest } from "./update-manifest.mjs";

const execFileAsync = promisify(execFile);
const PUBLIC_BASE_URL = "https://updates.chatto.run";
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-nightly\.\d{14}\.(0|[1-9]\d*))?$/;

export function channelObjectKeys(channel, version) {
  if (channel !== "stable" && channel !== "nightly") {
    throw new Error("channel must be stable or nightly");
  }
  if (typeof version !== "string" || !VERSION.test(version)) {
    throw new Error("invalid desktop release version");
  }
  return {
    immutable: `desktop/${channel}/versions/${version}/windows-x86_64.json`,
    canonical: `desktop/${channel}/windows-x86_64.json`,
  };
}

function validateOptions(options) {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket ?? "")) {
    throw new Error("invalid update bucket");
  }
  let endpoint;
  try {
    endpoint = new URL(options.endpoint);
  } catch {
    throw new Error("update store endpoint must be a valid HTTPS URL");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new Error(
      "update store endpoint must be a credential-free HTTPS URL",
    );
  }
  if (!/^[A-Za-z0-9-]{1,64}$/.test(options.region ?? "")) {
    throw new Error("invalid update store region");
  }
  if (options.publicBaseUrl !== PUBLIC_BASE_URL) {
    throw new Error(`public base must be ${PUBLIC_BASE_URL}`);
  }
}

function awsArguments(options, operation, operationArguments) {
  return [
    "--endpoint-url",
    options.endpoint,
    "--region",
    options.region,
    "s3api",
    operation,
    "--bucket",
    options.bucket,
    ...operationArguments,
  ];
}

async function defaultRunner(command, args) {
  await execFileAsync(command, args, { maxBuffer: 1024 * 1024 });
}

function equalBytes(left, right, description) {
  if (!left.equals(right))
    throw new Error(`${description} did not match local manifest`);
}

export async function publishUpdateChannel(
  options,
  { runner = defaultRunner, fetchImpl = fetch } = {},
) {
  validateOptions(options);
  const localBytes = await readFile(options.manifestPath);
  const manifest = validateUpdateManifest(
    JSON.parse(localBytes.toString("utf8")),
  );
  const keys = channelObjectKeys(options.channel, manifest.version);
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

  const workingDirectory =
    options.temporaryDirectory ??
    (await mkdtemp(join(tmpdir(), "chatto-update-channel-")));
  const immutableReadback = join(workingDirectory, "immutable-readback.json");
  const canonicalReadback = join(workingDirectory, "canonical-readback.json");

  try {
    await runner(
      "aws",
      awsArguments(options, "put-object", [
        "--key",
        keys.immutable,
        "--body",
        options.manifestPath,
        "--content-type",
        "application/json",
        "--cache-control",
        "public, max-age=31536000, immutable",
        "--if-none-match",
        "*",
      ]),
    );
  } catch (error) {
    // A rerun may encounter the same immutable object. It is safe only when
    // its stored bytes are exactly the release manifest we intended to publish.
    await runner(
      "aws",
      awsArguments(options, "get-object", [
        "--key",
        keys.immutable,
        immutableReadback,
      ]),
    );
    equalBytes(
      localBytes,
      await readFile(immutableReadback),
      "existing immutable object",
    );
  }

  await runner(
    "aws",
    awsArguments(options, "get-object", [
      "--key",
      keys.immutable,
      immutableReadback,
    ]),
  );
  equalBytes(localBytes, await readFile(immutableReadback), "immutable object");

  await runner(
    "aws",
    awsArguments(options, "copy-object", [
      "--key",
      keys.canonical,
      "--copy-source",
      encodeURIComponent(`${options.bucket}/${keys.immutable}`),
      "--metadata-directive",
      "REPLACE",
      "--content-type",
      "application/json",
      "--cache-control",
      "no-cache",
    ]),
  );
  await runner(
    "aws",
    awsArguments(options, "get-object", [
      "--key",
      keys.canonical,
      canonicalReadback,
    ]),
  );
  equalBytes(localBytes, await readFile(canonicalReadback), "canonical object");

  const publicResponse = await fetchImpl(
    `${PUBLIC_BASE_URL}/${keys.canonical}`,
    {
      cache: "no-store",
    },
  );
  if (!publicResponse.ok) {
    throw new Error(
      `public update channel is unavailable (${publicResponse.status})`,
    );
  }
  equalBytes(
    localBytes,
    Buffer.from(await publicResponse.arrayBuffer()),
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
  for (const name of [
    "CHATTO_UPDATE_STORE_BUCKET",
    "CHATTO_UPDATE_STORE_ENDPOINT",
    "CHATTO_UPDATE_STORE_REGION",
    "CHATTO_UPDATE_STORE_PUBLIC_BASE_URL",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
  ]) {
    if (!process.env[name]) throw new Error(`${name} is required`);
  }
  await publishUpdateChannel({
    channel,
    manifestPath,
    bucket: process.env.CHATTO_UPDATE_STORE_BUCKET,
    endpoint: process.env.CHATTO_UPDATE_STORE_ENDPOINT,
    region: process.env.CHATTO_UPDATE_STORE_REGION,
    publicBaseUrl: process.env.CHATTO_UPDATE_STORE_PUBLIC_BASE_URL,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
