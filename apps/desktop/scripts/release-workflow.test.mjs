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

function assertBetaReleaseSecretsAreStepScoped(
  buildJob,
  publishJob,
  buildName,
  channelName,
) {
  const build = step(buildJob, buildName);
  const publishRelease = step(
    publishJob,
    /Stable/.test(buildName)
      ? "Create, reverify, and publish immutable Stable release"
      : "Create, reverify, and publish immutable Nightly prerelease",
  );
  const publishChannel = step(publishJob, channelName);
  const releaseJobs =
    buildJob === publishJob ? [buildJob] : [buildJob, publishJob];
  const releaseText = releaseJobs.join("\n");

  for (const releaseJob of releaseJobs) {
    assert.doesNotMatch(
      releaseJob.slice(0, releaseJob.indexOf("    steps:")),
      /secrets\.|GH_TOKEN|TAURI_SIGNING_PRIVATE_KEY/,
    );
  }
  assert.match(
    build,
    /TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/,
  );
  assert.match(
    build,
    /TAURI_SIGNING_PRIVATE_KEY_PASSWORD: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY_PASSWORD \}\}/,
  );
  assert.doesNotMatch(build, /GH_TOKEN/);
  assert.match(publishRelease, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(publishRelease, /TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(publishChannel, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(publishChannel, /TAURI_SIGNING_PRIVATE_KEY/);

  for (const secret of [
    "secrets.TAURI_SIGNING_PRIVATE_KEY ",
    "secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ",
  ]) {
    assert.equal(
      releaseText.split(secret).length - 1,
      1,
      `${secret.trim()} must occur in exactly one release step`,
    );
  }
  assert.equal(releaseText.split("GH_TOKEN:").length - 1, 2);
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
  const build = job(ci, "build-main-native-installer");
  assert.match(nightlyBuilder, /yyyyMMddHHmmss/);
  assert.match(nightlyBuilder, /-nightly\.\$\(\$timestamp/);
  assert.match(nightlyBuilder, /\$RunNumber/);
  assert.match(build, /git show -s --format=%cI \$env:GITHUB_SHA/);
  assert.doesNotMatch(build, /NIGHTLY_TIMESTAMP=.*Get-Date/);
  assert.match(build, /-TimestampUtc \$env:NIGHTLY_TIMESTAMP/);
  assert.match(build, /-RunNumber \$env:GITHUB_RUN_NUMBER/);
  assert.match(build, /git fetch --no-tags origin main-native/);
  assert.match(build, /\$branchSha -cne \$env:GITHUB_SHA/);
});

test("beta release builds fail closed around Tauri updater signatures", () => {
  assert.match(releaseBuilder, /TAURI_SIGNING_PRIVATE_KEY/);
  assert.doesNotMatch(
    releaseBuilder,
    /AZURE_ARTIFACT_SIGNING|CHATTO_WINDOWS_SIGNER_SUBJECT/,
  );
  assert.match(releaseBuilder, /updater-public-key\.txt/);
  assert.match(releaseBuilder, /createUpdaterArtifacts = \$true/);
  assert.match(releaseBuilder, /allowDowngrades = \$false/);
  assert.match(releaseBuilder, /verify-package\.ps1/);
  assert.match(releaseBuilder, /\.sig/);
  assert.match(releaseBuilder, /\.sha256/);
  assert.match(releaseBuilder, /update-manifest\.mjs build/);
});

test("desktop releases embed the exact native version in the frontend build", () => {
  const save = releaseBuilder.indexOf(
    "$previousBuildVersion = $env:CHATTO_BUILD_VERSION",
  );
  const assign = releaseBuilder.indexOf("$env:CHATTO_BUILD_VERSION = $Version");
  const build = releaseBuilder.indexOf("& pnpm --dir apps/desktop tauri build");
  const restore = releaseBuilder.indexOf(
    "$env:CHATTO_BUILD_VERSION = $previousBuildVersion",
  );

  assert.ok(save >= 0 && save < assign && assign < build && build < restore);
});

test("Nightly beta publication uses only GitHub contents and the updater key", () => {
  const build = job(ci, "build-main-native-installer");
  const publish = job(ci, "publish-main-native-installer");
  const release = `${build}\n${publish}`;
  assert.doesNotMatch(release, /environment: desktop-release/);
  assert.match(build, /permissions:\n\s+contents: read/);
  assert.match(publish, /permissions:\n\s+contents: write/);
  assert.doesNotMatch(
    release,
    /id-token|azure\/login|ArtifactSigning|AZURE_|AWS_|CHATTO_UPDATE_STORE/,
  );
  assert.match(build, /group: desktop-build-nightly/);
  assert.match(build, /cancel-in-progress: true/);
  assert.match(publish, /group: desktop-update-nightly/);
  assert.match(publish, /cancel-in-progress: false/);
  assertPrivilegedActionsArePinned(build);
  assertPrivilegedActionsArePinned(publish);
  assertBetaReleaseSecretsAreStepScoped(
    build,
    publish,
    "Build signed monotonic Nightly release",
    "Advance the Nightly update channel",
  );
  assert.ok(
    publish.indexOf("publish-prerelease.sh") <
      publish.indexOf("publish-update-channel.mjs nightly"),
  );
});

test("Nightly signed build runs in parallel and feeds the gated publisher", () => {
  const build = job(ci, "build-main-native-installer");
  const publish = job(ci, "publish-main-native-installer");
  const buildCache = step(build, "Cache Rust build artifacts");
  const publishCache = step(publish, "Cache Rust build artifacts");
  const upload = step(build, "Upload signed Nightly release artifact");
  const download = step(publish, "Download signed Nightly release artifact");
  const revalidate = publish.indexOf("Revalidate current main-native source");
  const publishRelease = publish.indexOf("publish-prerelease.sh");

  assert.doesNotMatch(build, /^    needs:/m);
  assert.match(
    publish,
    /needs:\n\s+- build-main-native-installer\n\s+- license-check/,
  );
  assert.doesNotMatch(
    publish,
    /pnpm\/action-setup|mise setup-frontend|mise build-api-types|build-prerelease\.ps1/,
  );
  assert.match(upload, /name: desktop-nightly-\$\{\{ github\.sha \}\}/);
  assert.match(upload, /retention-days: 1/);
  assert.match(upload, /compression-level: 0/);
  assert.match(download, /name: desktop-nightly-\$\{\{ github\.sha \}\}/);
  assert.match(download, /path: \.context\/release\/windows/);
  assert.match(buildCache, /shared-key: desktop-nightly-release/);
  assert.match(publishCache, /shared-key: desktop-nightly-release/);
  assert.match(publishCache, /save-if: false/);
  assert.match(
    publish,
    /VERSION: \$\{\{ needs\.build-main-native-installer\.outputs\.version \}\}/,
  );
  assert.ok(revalidate >= 0 && revalidate < publishRelease);
  assert.match(
    step(publish, "Revalidate current main-native source"),
    /\$branchSha -cne \$env:GITHUB_SHA/,
  );
});

test("Nightly builder generates API types before the signed release", () => {
  const build = job(ci, "build-main-native-installer");
  const apiTypes = build.indexOf("mise build-api-types");
  const signedBuild = build.indexOf("build-prerelease.ps1");

  assert.ok(apiTypes >= 0 && apiTypes < signedBuild);
});

test("GitHub assets remain draft until stored bytes and updater signature verify", () => {
  const draft = publisher.lastIndexOf("gh release create");
  const download = publisher.indexOf("gh release download");
  const compare = publisher.indexOf("cmp --silent");
  const updater = publisher.indexOf("-UpdaterSignaturePath");
  const verifyCall = publisher.lastIndexOf("verify_downloaded_assets");
  const publish = publisher.lastIndexOf("--draft=false");
  assert.ok(draft >= 0 && draft < verifyCall);
  assert.ok(download < compare && compare < updater);
  assert.ok(verifyCall < publish);
  assert.match(publisher, /exactly five release assets/);
  assert.match(publisher, /-SkipAuthenticode/);
});

test("draft release source verification does not resolve an unpublished tag", () => {
  assert.match(publisher, /targetCommitish/);
  assert.match(publisher, /\.targetCommitish == \$sha/);

  const publishedGuard = publisher.indexOf(
    'if [[ "$expected_draft" == false ]]',
  );
  const tagResolution = publisher.indexOf(
    'gh api "repos/${GITHUB_REPOSITORY}/commits/${RELEASE_TAG}"',
  );
  assert.ok(publishedGuard >= 0 && publishedGuard < tagResolution);
});

test("published release retries reuse the stored signed assets", () => {
  const publishedReleaseBranch = publisher.slice(
    publisher.indexOf("if jq -e '.isDraft == false'"),
    publisher.indexOf(
      "  fi\n",
      publisher.indexOf("if jq -e '.isDraft == false'"),
    ),
  );

  assert.match(publishedReleaseBranch, /verify_downloaded_assets false/);
  assert.match(publishedReleaseBranch, /adopt_downloaded_assets/);
  assert.match(
    publisher,
    /cp .*verification_directory.*asset.*asset_directory/,
  );
});

test("Stable tags are exact, version-aligned, and reachable from main-native", () => {
  assert.match(stable, /tags:\n\s+- desktop-v\*/);
  assert.match(stable, /\^desktop-v\(\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\)\$/);
  assert.match(stable, /apps\/desktop\/package\.json/);
  assert.match(stable, /apps\/desktop\/src-tauri\/Cargo\.toml/);
  assert.match(stable, /apps\/desktop\/src-tauri\/tauri\.conf\.json/);
  assert.match(stable, /git merge-base --is-ancestor .* origin\/main-native/);

  const release = job(stable, "publish-desktop-release");
  assert.doesNotMatch(release, /environment: desktop-release/);
  assert.match(release, /contents: write/);
  assert.doesNotMatch(
    release,
    /id-token|azure\/login|ArtifactSigning|AZURE_|AWS_|CHATTO_UPDATE_STORE/,
  );
  assert.match(release, /group: desktop-update-stable/);
  assert.match(release, /cancel-in-progress: false/);
  assertPrivilegedActionsArePinned(release);
  assertBetaReleaseSecretsAreStepScoped(
    release,
    release,
    "Build signed Stable release",
    "Advance the Stable update channel",
  );
  assert.ok(
    release.indexOf("publish-prerelease.sh") <
      release.indexOf("publish-update-channel.mjs stable"),
  );
});

test("channel publisher compares canonical bytes before rolling GitHub upload", () => {
  const channelPublisher = read(
    "apps/desktop/scripts/publish-update-channel.mjs",
  );
  const canonicalRead = channelPublisher.indexOf("existingCanonicalResponse");
  const versionComparison = channelPublisher.indexOf(
    "compareChannelVersions(",
    canonicalRead,
  );
  const channelUpload = channelPublisher.indexOf('"upload"');
  assert.ok(canonicalRead >= 0 && canonicalRead < versionComparison);
  assert.ok(versionComparison < channelUpload);
  assert.match(channelPublisher, /same .* version.*different bytes/i);
  assert.match(channelPublisher, /backwards/i);
});
