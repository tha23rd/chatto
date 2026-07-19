import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

function normalizeNewlines(contents) {
  return contents.replace(/\r\n?/g, "\n");
}

function workflowFile(name) {
  return normalizeNewlines(
    readFileSync(
      new URL(`.github/workflows/${name}`, `file://${repositoryRoot}`),
      "utf8",
    ),
  );
}

const ciWorkflow = workflowFile("ci.yml");
const serverReleaseWorkflow = workflowFile("release.yml");
const windowsBuilder = readFileSync(
  new URL(
    "apps/desktop/scripts/build-prerelease.ps1",
    `file://${repositoryRoot}`,
  ),
  "utf8",
);
const releasePublisher = readFileSync(
  new URL(
    "apps/desktop/scripts/publish-prerelease.sh",
    `file://${repositoryRoot}`,
  ),
  "utf8",
);

function job(workflow, name) {
  const marker = `  ${name}:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `workflow is missing the ${name} job`);

  const remainder = workflow.slice(start + marker.length);
  const nextJob = remainder.search(/^  [a-zA-Z][a-zA-Z0-9_-]*:\r?$/m);
  return nextJob === -1
    ? workflow.slice(start)
    : workflow.slice(start, start + marker.length + nextJob);
}

test("workflow parsing is independent of checkout line endings", () => {
  const windowsWorkflow = normalizeNewlines(
    ciWorkflow.replaceAll("\n", "\r\n"),
  );

  assert.match(job(windowsWorkflow, "test-desktop-windows"), /tauri build/);
  assert.match(
    job(windowsWorkflow, "publish-main-native-installer"),
    /contents: write/,
  );
});

test("CI treats main-native as an integration branch", () => {
  const triggers = ciWorkflow.slice(0, ciWorkflow.indexOf("jobs:\n"));
  const branchEntries = triggers.match(/^\s+- main-native$/gm) ?? [];

  assert.equal(
    branchEntries.length,
    2,
    "main-native must trigger both push and pull-request CI",
  );
  assert.match(triggers, /permissions:\n\s+contents: read/);
  assert.doesNotMatch(
    serverReleaseWorkflow,
    /main-native/,
    "main-native must not share the server v* release channel",
  );
});

test("Windows CI builds and transfers a commit-versioned NSIS installer", () => {
  const windowsJob = job(ciWorkflow, "test-desktop-windows");

  assert.match(windowsJob, /outputs:\n\s+version:/);
  assert.match(windowsJob, /tag:/);
  assert.match(windowsJob, /installer_name:/);
  assert.match(windowsJob, /refs\/heads\/main-native/);
  assert.match(windowsJob, /tauri build --no-bundle/);
  assert.match(windowsJob, /build-prerelease\.ps1/);
  assert.match(windowsJob, /uses: actions\/upload-artifact@v7/);
  assert.match(windowsJob, /name: windows-installer-\$\{\{ github\.sha \}\}/);
  assert.match(windowsJob, /retention-days: 1/);

  assert.match(windowsBuilder, /main-native\.sha-/);
  assert.match(windowsBuilder, /tauri build --config/);
  assert.match(windowsBuilder, /verify-package\.ps1/);
  assert.match(windowsBuilder, /\.sha256/);
  assert.match(
    windowsBuilder,
    /\[System\.IO\.File\]::WriteAllText\(\s*"\$stagedInstaller\.sha256",\s*"\$checksum  \$installerName`n",\s*\[System\.Text\.Encoding\]::ASCII\s*\)/s,
    "checksum assets must use LF so sha256sum can verify them cross-platform",
  );
});

test("the native publisher waits for CI and publishes an immutable prerelease", () => {
  const publisher = job(ciWorkflow, "publish-main-native-installer");

  assert.match(publisher, /refs\/heads\/main-native/);
  for (const requiredJob of [
    "license-check",
    "codegen-proto-drift",
    "test-frontend-unit",
    "test-desktop-windows",
    "test-cli",
    "test-e2e",
    "test-e2e-media",
  ]) {
    assert.match(
      publisher,
      new RegExp(`- ${requiredJob}`),
      `native publication must wait for ${requiredJob}`,
    );
  }

  assert.match(publisher, /permissions:\n\s+contents: write/);
  assert.match(publisher, /uses: actions\/download-artifact@v8/);
  assert.match(publisher, /name: windows-installer-\$\{\{ github\.sha \}\}/);
  assert.match(publisher, /publish-prerelease\.sh/);

  assert.match(releasePublisher, /sha256sum --check/);
  assert.match(releasePublisher, /GITHUB_REPOSITORY/);
  assert.match(releasePublisher, /gh release create/);
  assert.match(releasePublisher, /--target "\$GITHUB_SHA"/);
  assert.match(releasePublisher, /--prerelease/);
  assert.match(releasePublisher, /gh release create/);
  assert.match(releasePublisher, /--method DELETE/);
  assert.match(releasePublisher, /\.draft.*true/);
});
