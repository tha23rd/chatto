[CmdletBinding()]
param(
    [string]$PackagePath,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$OutputDirectory,

    [string]$ExpectedSignerSubject,

    [switch]$SkipAuthenticode,

    [string]$UpdaterSignaturePath,

    [string]$UpdaterPublicKey
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$desktopRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($env:CARGO_TARGET_DIR)) {
    $cargoTargetDirectory = Join-Path $desktopRoot 'src-tauri\target'
}
else {
    $cargoTargetDirectory = [System.IO.Path]::GetFullPath($env:CARGO_TARGET_DIR)
}
$defaultPackageDirectory = Join-Path $cargoTargetDirectory 'release\bundle\nsis'

if ([string]::IsNullOrWhiteSpace($PackagePath)) {
    $candidate = Get-ChildItem -LiteralPath $defaultPackageDirectory -Filter '*.exe' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
    if ($null -eq $candidate) {
        throw "No NSIS package was found in the configured Cargo target directory. Run the native Windows desktop build first."
    }
    $PackagePath = $candidate.FullName
}

if (-not (Test-Path -LiteralPath $PackagePath -PathType Leaf)) {
    throw "The package file was not found."
}
$resolvedPackage = (Resolve-Path -LiteralPath $PackagePath).Path
$package = Get-Item -LiteralPath $resolvedPackage
if ($package.Extension -ine '.exe') {
    throw "The package must be an NSIS .exe file."
}
if ($package.Length -le 0) {
    throw "The package is empty."
}

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
[void](New-Item -ItemType Directory -Path $resolvedOutput -Force)
$hash = Get-FileHash -LiteralPath $resolvedPackage -Algorithm SHA256
$signature = Get-AuthenticodeSignature -LiteralPath $resolvedPackage
if ($SkipAuthenticode -and -not [string]::IsNullOrWhiteSpace($ExpectedSignerSubject)) {
    throw 'ExpectedSignerSubject cannot be used when Authenticode verification is skipped.'
}
if (-not $SkipAuthenticode) {
    if ([string]::IsNullOrWhiteSpace($ExpectedSignerSubject)) {
        throw 'ExpectedSignerSubject is required unless Authenticode verification is skipped.'
    }
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "The Authenticode signature is not valid: $($signature.Status)."
    }
    if ($null -eq $signature.SignerCertificate -or
        $signature.SignerCertificate.Subject -cne $ExpectedSignerSubject) {
        throw 'The Authenticode signer does not match the configured publisher.'
    }
}

if ([string]::IsNullOrWhiteSpace($UpdaterSignaturePath) -xor
    [string]::IsNullOrWhiteSpace($UpdaterPublicKey)) {
    throw 'UpdaterSignaturePath and UpdaterPublicKey must be provided together.'
}
if (-not [string]::IsNullOrWhiteSpace($UpdaterSignaturePath)) {
    if (-not (Test-Path -LiteralPath $UpdaterSignaturePath -PathType Leaf)) {
        throw 'The updater signature file was not found.'
    }
    Push-Location ([System.IO.Path]::GetFullPath((Join-Path $desktopRoot '..\..')))
    try {
        & cargo run --quiet `
            --manifest-path apps/desktop-tauri/src-tauri/Cargo.toml `
            --features release-verifier `
            --bin verify-updater-signature `
            -- $resolvedPackage $UpdaterSignaturePath $UpdaterPublicKey
        if ($LASTEXITCODE -ne 0) {
            throw 'The Tauri updater signature does not verify against the configured public key.'
        }
    }
    finally {
        Pop-Location
    }
}
$fileTimestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$reportPath = Join-Path $resolvedOutput "chatto-package-$fileTimestamp.json"

$report = [PSCustomObject]@{
    VerifiedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    PackageName = $package.Name
    SizeBytes = [long]$package.Length
    Sha256 = $hash.Hash
    SignatureStatus = [string]$signature.Status
    SignerSubject = if ($null -ne $signature.SignerCertificate) {
        [string]$signature.SignerCertificate.Subject
    }
    else {
        $null
    }
    ProductName = [string]$package.VersionInfo.ProductName
    ProductVersion = [string]$package.VersionInfo.ProductVersion
    AuthenticodeRequired = -not $SkipAuthenticode
    UpdaterSignatureVerified = -not [string]::IsNullOrWhiteSpace($UpdaterSignaturePath)
}

$report | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $reportPath -Encoding UTF8
$report
[PSCustomObject]@{ ReportFile = [System.IO.Path]::GetFileName($reportPath) }
