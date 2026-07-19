[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F]{40}$')]
    [string]$CommitSha,

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

function Get-RepositoryPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if ([System.IO.Path]::IsPathRooted($Path)) {
        return [System.IO.Path]::GetFullPath($Path)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot $Path))
}

$manifestPath = Join-Path $desktopRoot 'package.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$baseVersion = [string]$manifest.version
if ($baseVersion -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') {
    throw 'Desktop base version must be a stable three-component semantic version.'
}

$normalizedCommit = $CommitSha.ToLowerInvariant()
$shortCommit = $normalizedCommit.Substring(0, 12)
$version = "$baseVersion-main-native.sha-$shortCommit"
$tag = "desktop-v$version"
$installerName = "Chatto_${version}_x64-setup.exe"

$resolvedVerificationDirectory = Get-RepositoryPath -Path $VerificationDirectory
[void](New-Item -ItemType Directory -Path $resolvedVerificationDirectory -Force)
$configPath = Join-Path $resolvedVerificationDirectory 'tauri.main-native.conf.json'
@{ version = $version } |
    ConvertTo-Json -Compress |
    Set-Content -LiteralPath $configPath -Encoding utf8

Push-Location $repositoryRoot
try {
    & pnpm --dir apps/desktop tauri build --config $configPath
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri build failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

if ([string]::IsNullOrWhiteSpace($env:CARGO_TARGET_DIR)) {
    $cargoTargetDirectory = Join-Path $desktopRoot 'src-tauri\target'
}
else {
    $cargoTargetDirectory = [System.IO.Path]::GetFullPath($env:CARGO_TARGET_DIR)
}
$bundleDirectory = Join-Path $cargoTargetDirectory 'release\bundle\nsis'
$installers = @(Get-ChildItem -LiteralPath $bundleDirectory -Filter $installerName -File -ErrorAction SilentlyContinue)
if ($installers.Count -ne 1) {
    throw "Expected exactly one release-version NSIS installer, found $($installers.Count)."
}
if ($installers[0].Name -cne $installerName) {
    throw 'NSIS installer name does not match the commit-derived version.'
}

& (Join-Path $PSScriptRoot 'verify-package.ps1') `
    -PackagePath $installers[0].FullName `
    -OutputDirectory $resolvedVerificationDirectory

$resolvedOutputDirectory = Get-RepositoryPath -Path $OutputDirectory
[void](New-Item -ItemType Directory -Path $resolvedOutputDirectory -Force)
$existingOutputs = @(Get-ChildItem -LiteralPath $resolvedOutputDirectory -Force)
if ($existingOutputs.Count -ne 0) {
    throw 'Prerelease output directory must be empty before staging assets.'
}

$stagedInstaller = Join-Path $resolvedOutputDirectory $installerName
Copy-Item -LiteralPath $installers[0].FullName -Destination $stagedInstaller
$checksum = (Get-FileHash -LiteralPath $stagedInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
"$checksum  $installerName" |
    Set-Content -LiteralPath "$stagedInstaller.sha256" -Encoding ascii

if (-not [string]::IsNullOrWhiteSpace($GitHubOutputPath)) {
    "version=$version" | Out-File -FilePath $GitHubOutputPath -Encoding utf8 -Append
    "tag=$tag" | Out-File -FilePath $GitHubOutputPath -Encoding utf8 -Append
    "installer_name=$installerName" | Out-File -FilePath $GitHubOutputPath -Encoding utf8 -Append
}

if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_STEP_SUMMARY)) {
    "### Main-native Windows installer" | Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Encoding utf8 -Append
    "" | Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Encoding utf8 -Append
    "- Asset: $installerName" | Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Encoding utf8 -Append
    "- SHA-256: $checksum" | Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Encoding utf8 -Append
    "- Signing: unsigned POC" | Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Encoding utf8 -Append
}

[PSCustomObject]@{
    Version = $version
    Tag = $tag
    InstallerName = $installerName
    InstallerPath = $stagedInstaller
    Checksum = $checksum
}
