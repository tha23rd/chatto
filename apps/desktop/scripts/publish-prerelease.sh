#!/usr/bin/env bash

set -euo pipefail

: "${VERSION:?VERSION is required}"
: "${RELEASE_TAG:?RELEASE_TAG is required}"
: "${INSTALLER_NAME:?INSTALLER_NAME is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+-main-native\.sha-[0-9a-f]{12}$ ]]; then
  echo "::error::Invalid main-native prerelease version."
  exit 1
fi
if [[ ! "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::GitHub did not provide a full commit SHA."
  exit 1
fi
if [[ ! "$GITHUB_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "::error::Invalid GitHub repository identifier."
  exit 1
fi

expected_tag="desktop-v${VERSION}"
expected_installer="Chatto_${VERSION}_x64-setup.exe"
if [[ "$RELEASE_TAG" != "$expected_tag" || "$INSTALLER_NAME" != "$expected_installer" ]]; then
  echo "::error::Windows release metadata is internally inconsistent."
  exit 1
fi
if [[ "$VERSION" != *"${GITHUB_SHA:0:12}" ]]; then
  echo "::error::Windows release version does not identify the source commit."
  exit 1
fi

asset_directory="${ASSET_DIRECTORY:-.context/release/windows}"
installer="${asset_directory}/${INSTALLER_NAME}"
checksum="${installer}.sha256"
for asset in "$installer" "$checksum"; do
  if [[ ! -f "$asset" ]]; then
    echo "::error::Missing Windows release asset: $(basename "$asset")"
    exit 1
  fi
done

mapfile -t staged_assets < <(find "$asset_directory" -maxdepth 1 -type f -printf '%f\n' | sort)
if (( ${#staged_assets[@]} != 2 )); then
  echo "::error::Expected exactly two Windows release assets, found ${#staged_assets[@]}."
  printf 'Staged asset: %s\n' "${staged_assets[@]}"
  exit 1
fi

(
  cd "$asset_directory"
  sha256sum --check "${INSTALLER_NAME}.sha256"
)

release_title="Chatto Windows POC ${VERSION}"
notes_file="${RUNNER_TEMP:-/tmp}/main-native-release-notes.md"
release_json="${RUNNER_TEMP:-/tmp}/main-native-release.json"
release_error="${RUNNER_TEMP:-/tmp}/main-native-release-error.txt"
release_page="${RUNNER_TEMP:-/tmp}/main-native-release-page.json"
tag_json="${RUNNER_TEMP:-/tmp}/main-native-tag.json"

{
  echo "Automated Windows POC build from \`main-native\`."
  echo
  echo "- Source commit: \`${GITHUB_SHA}\`"
  echo "- Installer: \`${INSTALLER_NAME}\`"
  echo "- Checksum: \`${INSTALLER_NAME}.sha256\`"
  echo
  echo "**Unsigned POC:** Windows SmartScreen may warn about or block this installer."
} > "$notes_file"

verify_release_assets() {
  local metadata_file="$1"
  for expected_asset in "$INSTALLER_NAME" "${INSTALLER_NAME}.sha256"; do
    if ! jq -e --arg name "$expected_asset" 'any(.assets[]; .name == $name)' "$metadata_file" > /dev/null; then
      echo "::error::GitHub Release is missing ${expected_asset}."
      return 1
    fi
  done
}

verify_tag_ref() {
  if ! gh api "repos/${GITHUB_REPOSITORY}/git/ref/tags/${RELEASE_TAG}" > "$tag_json"; then
    echo "::error::Native release tag is missing."
    return 1
  fi
  if [[ "$(jq -r '.object.type' "$tag_json")" != "commit" || "$(jq -r '.object.sha' "$tag_json")" != "$GITHUB_SHA" ]]; then
    echo "::error::Native release tag does not identify the source commit."
    return 1
  fi
}

if gh api "repos/${GITHUB_REPOSITORY}/releases/tags/${RELEASE_TAG}" > "$release_json" 2> "$release_error"; then
  verify_tag_ref
  if [[ "$(jq -r '.draft' "$release_json")" != "false" || "$(jq -r '.prerelease' "$release_json")" != "true" ]]; then
    echo "::error::Existing native release is not a published prerelease."
    exit 1
  fi
  verify_release_assets "$release_json"
  echo "Immutable prerelease ${RELEASE_TAG} is already published."
  exit 0
elif ! grep -q 'HTTP 404' "$release_error"; then
  sed 's/^/::error::/' "$release_error" >&2
  exit 1
fi

incomplete_release_found=false
release_page_number=1
while true; do
  gh api "repos/${GITHUB_REPOSITORY}/releases?per_page=100&page=${release_page_number}" > "$release_page"
  if jq -e --arg tag "$RELEASE_TAG" '.[] | select(.tag_name == $tag)' "$release_page" > "$release_json"; then
    incomplete_release_found=true
    break
  fi

  if (( $(jq 'length' "$release_page") < 100 )); then
    break
  fi
  ((release_page_number += 1))
done

if [[ "$incomplete_release_found" == "true" ]]; then
  if [[ "$(jq -r '.draft' "$release_json")" != "true" ]]; then
    echo "::error::Refusing to replace a native release that is already public."
    exit 1
  fi
  verify_tag_ref

  incomplete_release_id="$(jq -r '.id' "$release_json")"
  if [[ ! "$incomplete_release_id" =~ ^[0-9]+$ ]]; then
    echo "::error::Incomplete native release has an invalid identifier."
    exit 1
  fi
  gh api --method DELETE "repos/${GITHUB_REPOSITORY}/releases/${incomplete_release_id}"
fi

tag_arguments=(--target "$GITHUB_SHA")
if gh api "repos/${GITHUB_REPOSITORY}/git/ref/tags/${RELEASE_TAG}" > "$tag_json" 2> "$release_error"; then
  verify_tag_ref
  tag_arguments=(--verify-tag)
elif ! grep -q 'HTTP 404' "$release_error"; then
  sed 's/^/::error::/' "$release_error" >&2
  exit 1
fi

gh release create "$RELEASE_TAG" \
  "$installer" \
  "$checksum" \
  --repo "$GITHUB_REPOSITORY" \
  "${tag_arguments[@]}" \
  --title "$release_title" \
  --notes-file "$notes_file" \
  --prerelease

gh api "repos/${GITHUB_REPOSITORY}/releases/tags/${RELEASE_TAG}" > "$release_json"
if [[ "$(jq -r '.draft' "$release_json")" != "false" || "$(jq -r '.prerelease' "$release_json")" != "true" ]]; then
  echo "::error::GitHub Release was not published as a prerelease."
  exit 1
fi
verify_tag_ref
verify_release_assets "$release_json"

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### Main-native GitHub prerelease"
    echo
    echo "- Tag: \`${RELEASE_TAG}\`"
    echo "- Installer: \`${INSTALLER_NAME}\`"
    echo "- Source: \`${GITHUB_SHA}\`"
  } >> "$GITHUB_STEP_SUMMARY"
fi
