#!/usr/bin/env bash

set -euo pipefail

for name in VERSION RELEASE_TAG INSTALLER_NAME MANIFEST_NAME METADATA_NAME RELEASE_KIND \
  GITHUB_REPOSITORY GITHUB_SHA GH_TOKEN; do
  if [[ -z "${!name:-}" ]]; then
    echo "::error::${name} is required"
    exit 1
  fi
done

stable_pattern='^[0-9]+\.[0-9]+\.[0-9]+$'
nightly_pattern='^[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]{14}\.[0-9]+$'
if [[ "$RELEASE_KIND" == "stable" ]]; then
  [[ "$VERSION" =~ $stable_pattern ]] || { echo '::error::Invalid stable version.'; exit 1; }
  prerelease=false
elif [[ "$RELEASE_KIND" == "nightly" ]]; then
  [[ "$VERSION" =~ $nightly_pattern ]] || { echo '::error::Invalid nightly version.'; exit 1; }
  prerelease=true
else
  echo '::error::RELEASE_KIND must be stable or nightly.'
  exit 1
fi
[[ "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo '::error::Invalid source SHA.'; exit 1; }
[[ "$GITHUB_REPOSITORY" == 'tha23rd/chatto' ]] || { echo '::error::Unexpected release repository.'; exit 1; }

updater_public_key="$(tr -d '\r\n' <apps/desktop-tauri/updater-public-key.txt)"
[[ -n "$updater_public_key" ]] || { echo '::error::Checked-in updater public key is empty.'; exit 1; }

expected_tag="desktop-v${VERSION}"
expected_installer="Chatto_${VERSION}_x64-setup.exe"
expected_manifest="Chatto_${VERSION}_windows-x86_64.update.json"
expected_metadata="Chatto_${VERSION}_windows-x86_64.metadata.json"
if [[ "$RELEASE_TAG" != "$expected_tag" || "$INSTALLER_NAME" != "$expected_installer" || \
      "$MANIFEST_NAME" != "$expected_manifest" || "$METADATA_NAME" != "$expected_metadata" ]]; then
  echo '::error::Desktop release metadata is internally inconsistent.'
  exit 1
fi
asset_directory="${ASSET_DIRECTORY:-.context/release/windows}"
assets=(
  "${asset_directory}/${INSTALLER_NAME}"
  "${asset_directory}/${INSTALLER_NAME}.sig"
  "${asset_directory}/${INSTALLER_NAME}.sha256"
  "${asset_directory}/${MANIFEST_NAME}"
  "${asset_directory}/${METADATA_NAME}"
)
for asset in "${assets[@]}"; do
  [[ -f "$asset" ]] || { echo "::error::Missing release asset: $(basename "$asset")"; exit 1; }
done
mapfile -t staged_assets < <(find "$asset_directory" -maxdepth 1 -type f -printf '%f\n' | sort)
[[ ${#staged_assets[@]} -eq 5 ]] || { echo '::error::Expected exactly five release assets.'; exit 1; }

(
  cd "$asset_directory"
  sha256sum --check "${INSTALLER_NAME}.sha256"
)
node apps/desktop-tauri/scripts/update-manifest.mjs verify --manifest "${asset_directory}/${MANIFEST_NAME}"
jq -e --arg version "$VERSION" --arg sha "$GITHUB_SHA" \
  '.version == $version and .sourceSha == $sha and .authenticode == false and .publisher == null' \
  "${asset_directory}/${METADATA_NAME}" >/dev/null

release_json="${RUNNER_TEMP:-/tmp}/desktop-release.json"
release_notes="${RUNNER_TEMP:-/tmp}/desktop-release-notes.md"
verification_directory="${RUNNER_TEMP:-/tmp}/desktop-release-verification"
{
  echo "Automated Chatto Windows ${RELEASE_KIND} release."
  echo
  echo "- Version: \`${VERSION}\`"
  echo "- Source commit: \`${GITHUB_SHA}\`"
  echo '- Authenticode: not enabled for this beta release'
} >"$release_notes"

load_release() {
  gh release view "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" \
    --json tagName,targetCommitish,isDraft,isPrerelease,assets >"$release_json" 2>/dev/null
}

verify_release_metadata() {
  local expected_draft="$1"
  jq -e --arg tag "$RELEASE_TAG" --arg sha "$GITHUB_SHA" --argjson draft "$expected_draft" --argjson prerelease "$prerelease" \
    '.tagName == $tag and .targetCommitish == $sha and .isDraft == $draft and .isPrerelease == $prerelease and
     (.assets | length) == 5' "$release_json" >/dev/null
  for expected_asset in "$INSTALLER_NAME" "${INSTALLER_NAME}.sig" "${INSTALLER_NAME}.sha256" "$MANIFEST_NAME" "$METADATA_NAME"; do
    jq -e --arg name "$expected_asset" 'any(.assets[]; .name == $name)' "$release_json" >/dev/null
  done
  if [[ "$expected_draft" == false ]]; then
    actual_sha="$(gh api "repos/${GITHUB_REPOSITORY}/commits/${RELEASE_TAG}" --jq .sha)"
    [[ "$actual_sha" == "$GITHUB_SHA" ]] || { echo '::error::Release tag does not identify source commit.'; return 1; }
  fi
}

verify_downloaded_assets() {
  local compare_to_staged="${1:-true}"
  rm -rf "$verification_directory"
  mkdir -p "$verification_directory"
  gh release download "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --dir "$verification_directory"
  if [[ "$compare_to_staged" == true ]]; then
    for asset in "${assets[@]}"; do
      cmp --silent "$asset" "${verification_directory}/$(basename "$asset")" || {
        echo "::error::Stored release asset differs: $(basename "$asset")"
        return 1
      }
    done
  fi
  (
    cd "$verification_directory"
    sha256sum --check "${INSTALLER_NAME}.sha256"
  )
  node apps/desktop-tauri/scripts/update-manifest.mjs verify --manifest "${verification_directory}/${MANIFEST_NAME}"
  jq -e --arg version "$VERSION" --arg sha "$GITHUB_SHA" \
    '.version == $version and .sourceSha == $sha and .authenticode == false and .publisher == null' \
    "${verification_directory}/${METADATA_NAME}" >/dev/null
  pwsh -NoProfile -NonInteractive -File apps/desktop-tauri/scripts/verify-package.ps1 \
    -PackagePath "${verification_directory}/${INSTALLER_NAME}" \
    -OutputDirectory "${verification_directory}/verification-report" \
    -SkipAuthenticode \
    -UpdaterSignaturePath "${verification_directory}/${INSTALLER_NAME}.sig" \
    -UpdaterPublicKey "$updater_public_key"
}

adopt_downloaded_assets() {
  for asset in "${assets[@]}"; do
    cp "${verification_directory}/$(basename "$asset")" "${asset_directory}/$(basename "$asset")"
  done
}

if load_release; then
  if jq -e '.isDraft == false' "$release_json" >/dev/null; then
    verify_release_metadata false
    verify_downloaded_assets false
    adopt_downloaded_assets
    echo "Immutable desktop release ${RELEASE_TAG} already verified and staged for channel publication."
    exit 0
  fi
  verify_release_metadata true || {
    echo '::error::Existing draft does not match this release.'
    exit 1
  }
  gh release upload "$RELEASE_TAG" "${assets[@]}" --repo "$GITHUB_REPOSITORY" --clobber
else
  create_arguments=(--repo "$GITHUB_REPOSITORY" --target "$GITHUB_SHA" --title "Chatto Windows ${VERSION}" --notes-file "$release_notes" --draft)
  [[ "$prerelease" == true ]] && create_arguments+=(--prerelease)
  gh release create "$RELEASE_TAG" "${assets[@]}" "${create_arguments[@]}"
fi

load_release
verify_release_metadata true
verify_downloaded_assets true

# Only expose the release after every stored byte and updater signature have
# been reverified from GitHub.
gh release edit "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --draft=false --prerelease="$prerelease"
load_release
verify_release_metadata false

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### Windows desktop ${RELEASE_KIND}"
    echo
    echo "- Tag: \`${RELEASE_TAG}\`"
    echo "- Installer: \`${INSTALLER_NAME}\`"
    echo "- Source: \`${GITHUB_SHA}\`"
  } >>"$GITHUB_STEP_SUMMARY"
fi
