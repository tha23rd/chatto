[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$FilePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

foreach ($name in @(
        'AZURE_ARTIFACT_SIGNING_ENDPOINT',
        'AZURE_ARTIFACT_SIGNING_ACCOUNT',
        'AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE',
        'CHATTO_WINDOWS_SIGNER_SUBJECT'
    )) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
        throw "$name is required for release signing."
    }
}

$resolvedFile = (Resolve-Path -LiteralPath $FilePath -ErrorAction Stop).Path
if (-not (Get-Command Invoke-ArtifactSigning -ErrorAction SilentlyContinue)) {
    throw 'The pinned ArtifactSigning PowerShell module is not installed.'
}

# azure/login acquires the federated OIDC token. Artifact Signing then uses only
# AzureCliCredential; every other DefaultAzureCredential source is disabled.
Invoke-ArtifactSigning `
    -Endpoint $env:AZURE_ARTIFACT_SIGNING_ENDPOINT `
    -CodeSigningAccountName $env:AZURE_ARTIFACT_SIGNING_ACCOUNT `
    -CertificateProfileName $env:AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE `
    -Files $resolvedFile `
    -FileDigest SHA256 `
    -TimestampRfc3161 'http://timestamp.acs.microsoft.com' `
    -TimestampDigest SHA256 `
    -ExcludeEnvironmentCredential $true `
    -ExcludeWorkloadIdentityCredential $true `
    -ExcludeManagedIdentityCredential $true `
    -ExcludeSharedTokenCacheCredential $true `
    -ExcludeVisualStudioCredential $true `
    -ExcludeVisualStudioCodeCredential $true `
    -ExcludeAzureCliCredential $false `
    -ExcludeAzurePowerShellCredential $true `
    -ExcludeAzureDeveloperCliCredential $true `
    -ExcludeInteractiveBrowserCredential $true

$signature = Get-AuthenticodeSignature -LiteralPath $resolvedFile
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Artifact Signing returned an invalid Authenticode status: $($signature.Status)."
}
if ($null -eq $signature.SignerCertificate -or
    $signature.SignerCertificate.Subject -cne $env:CHATTO_WINDOWS_SIGNER_SUBJECT) {
    throw 'The Authenticode signer does not match CHATTO_WINDOWS_SIGNER_SUBJECT.'
}
