param(
  [Parameter(Mandatory = $true)]
  [string]$BackendOrigin,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedCommit,

  [Parameter(Mandatory = $true)]
  [string]$ReportPath,

  [string]$ProductionOrigin = "https://messk.online",
  [switch]$AllowLocalhost
)

$ErrorActionPreference = "Stop"

$origin = $BackendOrigin.Trim().TrimEnd("/")
$parsed = $null
if (-not [Uri]::TryCreate($origin, [UriKind]::Absolute, [ref]$parsed)) {
  throw "BackendOrigin must be an absolute URL."
}
if (-not $AllowLocalhost -and $parsed.Scheme -ne "https") {
  throw "Staging verification requires HTTPS unless -AllowLocalhost is used for tests."
}
if ($origin -eq $ProductionOrigin.Trim().TrimEnd("/")) {
  throw "Staging verification cannot target the production origin."
}
if ([string]::IsNullOrWhiteSpace($ExpectedCommit)) {
  throw "ExpectedCommit must be provided."
}

$commitPrefix = $ExpectedCommit.Substring(0, [Math]::Min(12, $ExpectedCommit.Length))
& (Join-Path $PSScriptRoot "production-smoke.ps1") -BackendOrigin $origin -ExpectedCommitPrefix $commitPrefix
if ($LASTEXITCODE -ne 0) {
  throw "Staging smoke failed."
}

$version = Invoke-RestMethod -Uri "$origin/version" -TimeoutSec 15
$protocol = Invoke-RestMethod -Uri "$origin/protocol" -TimeoutSec 15
$report = [ordered]@{
  schemaVersion = 1
  environment = "staging"
  status = "passed"
  origin = $origin
  testedCommit = $ExpectedCommit
  observedCommit = $version.commit
  version = $version.version
  protocolVersion = $protocol.protocolVersion
  verifiedAt = [DateTimeOffset]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
}
$reportDirectory = Split-Path -Parent ([System.IO.Path]::GetFullPath($ReportPath))
if (-not (Test-Path -LiteralPath $reportDirectory)) {
  New-Item -ItemType Directory -Force -Path $reportDirectory | Out-Null
}
[System.IO.File]::WriteAllText(
  [System.IO.Path]::GetFullPath($ReportPath),
  ($report | ConvertTo-Json) + "`n",
  [System.Text.UTF8Encoding]::new($false)
)

Write-Host "Staging verification report written: $ReportPath"
