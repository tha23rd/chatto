[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Version,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F]{40}$')]
    [string]$CommitSha,

    [Parameter(Mandatory = $true)]
    [ValidateSet('stable', 'nightly')]
    [string]$Channel,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$PublishedAt,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$OutputDirectory,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$VerificationDirectory,

    [string]$GitHubOutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$desktopRoot = Split-Path -Parent $PSScriptRoot
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $desktopRoot '..\..'))
$stablePattern = '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$'
$nightlyPattern = '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-nightly\.\d{14}\.(0|[1-9]\d*)$'
if (($Channel -eq 'stable' -and $Version -notmatch $stablePattern) -or
    ($Channel -eq 'nightly' -and $Version -notmatch $nightlyPattern)) {
    throw "Version does not match the $Channel release channel."
}

$publicationTime = [DateTimeOffset]::Parse(
    $PublishedAt,
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::AssumeUniversal
).ToUniversalTime().ToString('o')

foreach ($name in @('TAURI_SIGNING_PRIVATE_KEY')) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
        throw "$name is required for a desktop release build."
    }
}

function Resolve-RepositoryPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    if ([System.IO.Path]::IsPathRooted($Path)) {
        return [System.IO.Path]::GetFullPath($Path)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot $Path))
}

$resolvedVerificationDirectory = Resolve-RepositoryPath -Path $VerificationDirectory
$resolvedOutputDirectory = Resolve-RepositoryPath -Path $OutputDirectory
[void](New-Item -ItemType Directory -Path $resolvedVerificationDirectory -Force)
[void](New-Item -ItemType Directory -Path $resolvedOutputDirectory -Force)
if (@(Get-ChildItem -LiteralPath $resolvedOutputDirectory -Force).Count -ne 0) {
    throw 'Desktop release output directory must be empty before staging assets.'
}

$updaterPublicKeyPath = Join-Path $desktopRoot 'updater-public-key.txt'
$updaterPublicKey = (Get-Content -LiteralPath $updaterPublicKeyPath -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($updaterPublicKey)) {
    throw 'The checked-in updater public key is empty.'
}
$overlayPath = Join-Path $resolvedVerificationDirectory 'tauri.release.conf.json'
$overlay = [ordered]@{
    version = $Version
    bundle = [ordered]@{
        createUpdaterArtifacts = $true
        windows = [ordered]@{
            allowDowngrades = $false
        }
    }
    plugins = [ordered]@{
        updater = [ordered]@{
            pubkey = $updaterPublicKey
        }
    }
}
$overlay | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $overlayPath -Encoding utf8

$previousBuildVersion = $env:CHATTO_BUILD_VERSION
$env:CHATTO_BUILD_VERSION = $Version
try {
    Push-Location $repositoryRoot
    try {
        & pnpm --dir apps/desktop tauri build --config $overlayPath
        if ($LASTEXITCODE -ne 0) {
            throw "Tauri release build failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}
finally {
    $env:CHATTO_BUILD_VERSION = $previousBuildVersion
}

if ([string]::IsNullOrWhiteSpace($env:CARGO_TARGET_DIR)) {
    $cargoTargetDirectory = Join-Path $desktopRoot 'src-tauri\target'
}
else {
    $cargoTargetDirectory = [System.IO.Path]::GetFullPath($env:CARGO_TARGET_DIR)
}
$installerName = "Chatto_${Version}_x64-setup.exe"
$installer = Join-Path $cargoTargetDirectory "release\bundle\nsis\$installerName"
$signature = "$installer.sig"
foreach ($path in @($installer, $signature)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Expected Tauri release artifact was not created: $([IO.Path]::GetFileName($path))."
    }
}

& (Join-Path $PSScriptRoot 'verify-package.ps1') `
    -PackagePath $installer `
    -OutputDirectory $resolvedVerificationDirectory `
    -SkipAuthenticode `
    -UpdaterSignaturePath $signature `
    -UpdaterPublicKey $updaterPublicKey

$stagedInstaller = Join-Path $resolvedOutputDirectory $installerName
$stagedSignature = "$stagedInstaller.sig"
Copy-Item -LiteralPath $installer -Destination $stagedInstaller
Copy-Item -LiteralPath $signature -Destination $stagedSignature
$checksum = (Get-FileHash -LiteralPath $stagedInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText(
    "$stagedInstaller.sha256",
    "$checksum  $installerName`n",
    [Text.Encoding]::ASCII
)

$manifestName = "Chatto_${Version}_windows-x86_64.update.json"
$manifestPath = Join-Path $resolvedOutputDirectory $manifestName
$notes = if ($Channel -eq 'stable') { 'Stable Chatto desktop update.' } else { 'Nightly Chatto desktop update.' }
Push-Location $repositoryRoot
try {
    & node apps/desktop/scripts/update-manifest.mjs build `
        --version $Version `
        --published-at $publicationTime `
        --notes $notes `
        --installer-name $installerName `
        --signature-file $stagedSignature `
        --output $manifestPath
    if ($LASTEXITCODE -ne 0) { throw 'Failed to generate the Tauri update manifest.' }
    & node apps/desktop/scripts/update-manifest.mjs verify --manifest $manifestPath
    if ($LASTEXITCODE -ne 0) { throw 'Generated Tauri update manifest is invalid.' }
}
finally {
    Pop-Location
}

$metadataName = "Chatto_${Version}_windows-x86_64.metadata.json"
$metadataPath = Join-Path $resolvedOutputDirectory $metadataName
[ordered]@{
    schemaVersion = 1
    version = $Version
    channel = $Channel
    tag = "desktop-v$Version"
    sourceSha = $CommitSha.ToLowerInvariant()
    authenticode = $false
    publisher = $null
    publishedAt = $publicationTime
    installer = $installerName
    sha256 = $checksum
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $metadataPath -Encoding utf8

if (-not [string]::IsNullOrWhiteSpace($GitHubOutputPath)) {
    "version=$Version" | Out-File -FilePath $GitHubOutputPath -Encoding utf8 -Append
    "tag=desktop-v$Version" | Out-File -FilePath $GitHubOutputPath -Encoding utf8 -Append
    "installer_name=$installerName" | Out-File -FilePath $GitHubOutputPath -Encoding utf8 -Append
    "manifest_name=$manifestName" | Out-File -FilePath $GitHubOutputPath -Encoding utf8 -Append
    "metadata_name=$metadataName" | Out-File -FilePath $GitHubOutputPath -Encoding utf8 -Append
}

[PSCustomObject]@{
    Version = $Version
    Tag = "desktop-v$Version"
    InstallerName = $installerName
    ManifestName = $manifestName
    MetadataName = $metadataName
    Sha256 = $checksum
}
