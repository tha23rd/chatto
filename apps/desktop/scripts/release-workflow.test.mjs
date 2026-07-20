import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path) =>
  readFileSync(new URL(path, `file://${repositoryRoot}`), "utf8").replaceAll(
    "\r\n",
    "\n",
  );
const ci = read(".github/workflows/ci.yml");
const stable = read(".github/workflows/desktop-release.yml");
const nightlyBuilder = read("apps/desktop/scripts/build-prerelease.ps1");
const releaseBuilder = read("apps/desktop/scripts/build-release.ps1");
const signer = read("apps/desktop/scripts/sign-artifact.ps1");
const publisher = read("apps/desktop/scripts/publish-prerelease.sh");
const capabilities = read("apps/desktop/src-tauri/capabilities/default.json");

function job(workflow, name) {
  const marker = `  ${name}:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `workflow is missing ${name}`);
  const remainder = workflow.slice(start + marker.length);
  const next = remainder.search(/^  [a-zA-Z][a-zA-Z0-9_-]*:\n/m);
  return next === -1
    ? workflow.slice(start)
    : workflow.slice(start, start + marker.length + next);
}

function step(jobText, name) {
  const marker = `      - name: ${name}\n`;
  const start = jobText.indexOf(marker);
  assert.notEqual(start, -1, `job is missing step: ${name}`);
  const remainder = jobText.slice(start + marker.length);
  const next = remainder.search(/^      - name: /m);
  return next === -1
    ? jobText.slice(start)
    : jobText.slice(start, start + marker.length + next);
}

function assertPrivilegedActionsArePinned(jobText) {
  const actions = [...jobText.matchAll(/^\s+uses: ([^\s#]+)(?:\s+#.*)?$/gm)];
  assert.ok(actions.length > 0, "privileged job must declare its actions");
  for (const [, action] of actions) {
    if (action.startsWith("./")) continue;
    assert.match(
      action,
      /^[^@]+@[0-9a-f]{40}$/,
      `${action} must use a full immutable commit SHA`,
    );
  }
}

function assertReleaseSecretsAreStepScoped(release, buildName, channelName) {
  const build = step(release, buildName);
  const publishRelease = step(
    release,
    /Stable/.test(buildName)
      ? "Create, reverify, and publish immutable Stable release"
      : "Create, reverify, and publish immutable Nightly prerelease",
  );
  const publishChannel = step(release, channelName);

  assert.doesNotMatch(
    release.slice(0, release.indexOf("    steps:")),
    /secrets\.|GH_TOKEN|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|TAURI_SIGNING_PRIVATE_KEY/,
  );
  assert.match(
    build,
    /TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/,
  );
  assert.match(
    build,
    /TAURI_SIGNING_PRIVATE_KEY_PASSWORD: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY_PASSWORD \}\}/,
  );
  assert.doesNotMatch(
    build,
    /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|GH_TOKEN/,
  );
  assert.match(publishRelease, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(
    publishRelease,
    /TAURI_SIGNING_PRIVATE_KEY|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/,
  );
  assert.match(
    publishChannel,
    /AWS_ACCESS_KEY_ID: \$\{\{ secrets\.CHATTO_UPDATE_STORE_ACCESS_KEY_ID \}\}/,
  );
  assert.match(
    publishChannel,
    /AWS_SECRET_ACCESS_KEY: \$\{\{ secrets\.CHATTO_UPDATE_STORE_SECRET_ACCESS_KEY \}\}/,
  );
  assert.doesNotMatch(publishChannel, /TAURI_SIGNING_PRIVATE_KEY|GH_TOKEN/);

  for (const secret of [
    "secrets.TAURI_SIGNING_PRIVATE_KEY ",
    "secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ",
    "secrets.CHATTO_UPDATE_STORE_ACCESS_KEY_ID ",
    "secrets.CHATTO_UPDATE_STORE_SECRET_ACCESS_KEY ",
    "GH_TOKEN:",
  ]) {
    assert.equal(
      release.split(secret).length - 1,
      1,
      `${secret.trim()} must occur in exactly one release step`,
    );
  }

  const azureLogin = release.indexOf("Login to Azure with GitHub OIDC");
  const afterAzureLogin = release.slice(azureLogin);
  const usesAfterLogin = [
    ...afterAzureLogin.matchAll(/^\s+uses: ([^\s#]+)(?:\s+#.*)?$/gm),
  ].map((match) => match[1]);
  assert.deepEqual(usesAfterLogin, [
    "azure/login@532459ea530d8321f2fb9bb10d1e0bcf23869a43",
  ]);
}

test("PR desktop CI is secret-free and never bundles an installer", () => {
  const tests = job(ci, "test-desktop-windows");
  assert.match(tests, /tauri build --no-bundle/);
  assert.doesNotMatch(
    tests,
    /desktop-release|TAURI_SIGNING|AZURE_|AWS_|secrets\./,
  );
  assert.doesNotMatch(capabilities, /"(?:updater|process):/);
});

test("Nightly versions are monotonic SemVer derived from UTC and run number", () => {
  assert.match(nightlyBuilder, /yyyyMMddHHmmss/);
  assert.match(nightlyBuilder, /-nightly\.\$\(\$timestamp/);
  assert.match(nightlyBuilder, /\$RunNumber/);
  assert.match(ci, /git show -s --format=%cI \$env:GITHUB_SHA/);
  assert.doesNotMatch(
    job(ci, "publish-main-native-installer"),
    /NIGHTLY_TIMESTAMP=.*Get-Date/,
  );
  assert.match(ci, /-TimestampUtc \$env:NIGHTLY_TIMESTAMP/);
  assert.match(ci, /-RunNumber \$env:GITHUB_RUN_NUMBER/);
  assert.match(ci, /git fetch --no-tags origin main-native/);
  assert.match(ci, /\$branchSha -cne \$env:GITHUB_SHA/);
});

test("release builds fail closed and sign before Tauri updater artifacts", () => {
  for (const required of [
    "CHATTO_DESKTOP_UPDATER_PUBLIC_KEY",
    "TAURI_SIGNING_PRIVATE_KEY",
    "AZURE_ARTIFACT_SIGNING_ENDPOINT",
    "AZURE_ARTIFACT_SIGNING_ACCOUNT",
    "AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE",
    "CHATTO_WINDOWS_SIGNER_SUBJECT",
  ]) {
    assert.match(releaseBuilder, new RegExp(required));
  }
  assert.match(releaseBuilder, /createUpdaterArtifacts = \$true/);
  assert.match(releaseBuilder, /allowDowngrades = \$false/);
  assert.match(releaseBuilder, /signCommand/);
  assert.match(releaseBuilder, /verify-package\.ps1/);
  assert.match(releaseBuilder, /\.sig/);
  assert.match(releaseBuilder, /\.sha256/);
  assert.match(releaseBuilder, /update-manifest\.mjs build/);
  assert.match(signer, /Invoke-ArtifactSigning/);
  assert.match(signer, /ExcludeAzureCliCredential \$false/);
  assert.match(signer, /SignatureStatus\]::Valid/);
  assert.match(signer, /SignerCertificate\.Subject -cne/);
});

test("Nightly publication is protected, least-privilege, and OIDC-only", () => {
  const release = job(ci, "publish-main-native-installer");
  assert.match(release, /environment: desktop-release/);
  assert.match(release, /permissions:\n\s+contents: write\n\s+id-token: write/);
  assert.match(
    release,
    /azure\/login@532459ea530d8321f2fb9bb10d1e0bcf23869a43/,
  );
  assert.doesNotMatch(release, /client-secret:/);
  assert.match(release, /ArtifactSigning -RequiredVersion 0\.1\.8/);
  assert.match(release, /group: desktop-update-nightly/);
  assert.match(release, /cancel-in-progress: false/);
  assertPrivilegedActionsArePinned(release);
  assertReleaseSecretsAreStepScoped(
    release,
    "Build signed monotonic Nightly release",
    "Advance the Nightly update channel",
  );
  assert.ok(
    release.indexOf("publish-prerelease.sh") <
      release.indexOf("publish-update-channel.mjs nightly"),
  );
});

test("GitHub assets remain draft until stored bytes and both signatures verify", () => {
  const draft = publisher.lastIndexOf("gh release create");
  const download = publisher.indexOf("gh release download");
  const compare = publisher.indexOf("cmp --silent");
  const authenticode = publisher.indexOf("-ExpectedSignerSubject");
  const updater = publisher.indexOf("-UpdaterSignaturePath");
  const verifyCall = publisher.lastIndexOf("verify_downloaded_assets");
  const publish = publisher.lastIndexOf("--draft=false");
  assert.ok(draft >= 0 && draft < verifyCall);
  assert.ok(
    download < compare && compare < authenticode && authenticode < updater,
  );
  assert.ok(verifyCall < publish);
  assert.match(publisher, /exactly five release assets/);
});

test("Stable tags are exact, version-aligned, and reachable from main-native", () => {
  assert.match(stable, /tags:\n\s+- desktop-v\*/);
  assert.match(stable, /\^desktop-v\(\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\)\$/);
  assert.match(stable, /apps\/desktop\/package\.json/);
  assert.match(stable, /apps\/desktop\/src-tauri\/Cargo\.toml/);
  assert.match(stable, /apps\/desktop\/src-tauri\/tauri\.conf\.json/);
  assert.match(stable, /git merge-base --is-ancestor .* origin\/main-native/);

  const release = job(stable, "publish-desktop-release");
  assert.match(release, /environment: desktop-release/);
  assert.match(release, /contents: write\n\s+id-token: write/);
  assert.doesNotMatch(release, /client-secret:/);
  assert.match(release, /group: desktop-update-stable/);
  assert.match(release, /cancel-in-progress: false/);
  assertPrivilegedActionsArePinned(release);
  assertReleaseSecretsAreStepScoped(
    release,
    "Build signed Stable release",
    "Advance the Stable update channel",
  );
  assert.ok(
    release.indexOf("publish-prerelease.sh") <
      release.indexOf("publish-update-channel.mjs stable"),
  );
});

test("channel publisher compares canonical bytes before immutable publication or copy", () => {
  const channelPublisher = read(
    "apps/desktop/scripts/publish-update-channel.mjs",
  );
  const canonicalRead = channelPublisher.indexOf("existingCanonicalResponse");
  const versionComparison = channelPublisher.indexOf(
    "compareChannelVersions(",
    canonicalRead,
  );
  const immutablePut = channelPublisher.indexOf('"put-object"');
  const canonicalCopy = channelPublisher.indexOf('"copy-object"');
  assert.ok(canonicalRead >= 0 && canonicalRead < versionComparison);
  assert.ok(versionComparison < immutablePut && immutablePut < canonicalCopy);
  assert.match(channelPublisher, /same .* version.*different bytes/i);
  assert.match(channelPublisher, /backwards/i);
});
