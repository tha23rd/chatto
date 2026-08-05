import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const REPOSITORY = "tha23rd/chatto";
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const NIGHTLY_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-nightly\.\d{14}\.(0|[1-9]\d*)$/;
const SIGNATURE = /^[A-Za-z0-9+/]+={0,2}$/;

function assertVersion(version) {
  if (
    typeof version !== "string" ||
    (!STABLE_VERSION.test(version) && !NIGHTLY_VERSION.test(version))
  ) {
    throw new Error("invalid desktop release version");
  }
  return version;
}

function expectedInstallerName(version) {
  return `Chatto_${assertVersion(version)}_x64-setup.exe`;
}

export function immutableAssetUrl(version, installerName) {
  const validatedVersion = assertVersion(version);
  if (installerName !== expectedInstallerName(validatedVersion)) {
    throw new Error(
      "installer name does not match the desktop release version",
    );
  }
  return `https://github.com/${REPOSITORY}/releases/download/desktop-v${validatedVersion}/${installerName}`;
}

function normalizePublishedAt(value) {
  const date = new Date(value);
  if (typeof value !== "string" || Number.isNaN(date.valueOf())) {
    throw new Error("publishedAt must be an RFC 3339 timestamp");
  }
  return date.toISOString();
}

function assertLiteralSignature(value) {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.includes("://") ||
    !SIGNATURE.test(value)
  ) {
    throw new Error("manifest must contain the literal updater signature");
  }
  return value;
}

export function buildUpdateManifest({
  version,
  publishedAt,
  notes,
  installerName,
  signature,
}) {
  const validatedVersion = assertVersion(version);
  if (typeof notes !== "string" || notes.trim().length === 0) {
    throw new Error("release notes must not be empty");
  }
  return {
    version: validatedVersion,
    notes: notes.trim(),
    pub_date: normalizePublishedAt(publishedAt),
    platforms: {
      "windows-x86_64": {
        url: immutableAssetUrl(validatedVersion, installerName),
        signature: assertLiteralSignature(signature.trim()),
      },
    },
  };
}

export function validateUpdateManifest(manifest) {
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest)
  ) {
    throw new Error("update manifest must be an object");
  }
  const allowedFields = new Set(["version", "notes", "pub_date", "platforms"]);
  for (const field of Object.keys(manifest)) {
    if (!allowedFields.has(field)) {
      throw new Error(`unexpected manifest field: ${field}`);
    }
  }
  const version = assertVersion(manifest.version);
  normalizePublishedAt(manifest.pub_date);
  if (
    typeof manifest.notes !== "string" ||
    manifest.notes.trim().length === 0
  ) {
    throw new Error("release notes must not be empty");
  }
  const platformNames = Object.keys(manifest.platforms ?? {});
  if (platformNames.length !== 1 || platformNames[0] !== "windows-x86_64") {
    throw new Error("manifest must contain only windows-x86_64");
  }
  const platform = manifest.platforms["windows-x86_64"];
  const allowedPlatformFields = new Set(["url", "signature"]);
  if (
    platform === null ||
    typeof platform !== "object" ||
    Object.keys(platform).some((field) => !allowedPlatformFields.has(field))
  ) {
    throw new Error("invalid windows-x86_64 platform metadata");
  }
  const installerName = expectedInstallerName(version);
  if (platform.url !== immutableAssetUrl(version, installerName)) {
    throw new Error("update URL must be the immutable GitHub asset");
  }
  assertLiteralSignature(platform.signature);
  return manifest;
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      version: { type: "string" },
      "published-at": { type: "string" },
      notes: { type: "string" },
      "installer-name": { type: "string" },
      "signature-file": { type: "string" },
      output: { type: "string" },
      manifest: { type: "string" },
    },
  });
  const command = positionals[0];
  if (command === "build") {
    for (const required of [
      "version",
      "published-at",
      "notes",
      "installer-name",
      "signature-file",
      "output",
    ]) {
      if (!values[required]) throw new Error(`--${required} is required`);
    }
    const signature = (await readFile(values["signature-file"], "utf8")).trim();
    const manifest = buildUpdateManifest({
      version: values.version,
      publishedAt: values["published-at"],
      notes: values.notes,
      installerName: values["installer-name"],
      signature,
    });
    await writeFile(values.output, `${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }
  if (command === "verify") {
    if (!values.manifest) throw new Error("--manifest is required");
    validateUpdateManifest(JSON.parse(await readFile(values.manifest, "utf8")));
    return;
  }
  throw new Error("expected build or verify command");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
