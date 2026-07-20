[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F]{40}$')]
    [string]$CommitSha,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$TimestampUtc,

    [Parameter(Mandatory = $true)]
    [ValidateRange(1, [int]::MaxValue)]
    [int]$RunNumber,

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
$manifest = Get-Content -LiteralPath (Join-Path $desktopRoot 'package.json') -Raw | ConvertFrom-Json
$baseVersion = [string]$manifest.version
if ($baseVersion -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') {
    throw 'Desktop base version must be a stable three-component semantic version.'
}
$timestamp = [DateTimeOffset]::Parse(
    $TimestampUtc,
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::AssumeUniversal
).ToUniversalTime()
$version = "$baseVersion-nightly.$($timestamp.ToString('yyyyMMddHHmmss')).$RunNumber"

& (Join-Path $PSScriptRoot 'build-release.ps1') `
    -Version $version `
    -CommitSha $CommitSha `
    -Channel nightly `
    -PublishedAt $timestamp.ToString('o') `
    -OutputDirectory $OutputDirectory `
    -VerificationDirectory $VerificationDirectory `
    -GitHubOutputPath $GitHubOutputPath
