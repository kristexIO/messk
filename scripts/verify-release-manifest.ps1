param(
  [Parameter(Mandatory = $true)]
  [string]$ArtifactRoot,

  [string]$ManifestPath = ""
)

$ErrorActionPreference = "Stop"

$resolvedRoot = (Resolve-Path -LiteralPath $ArtifactRoot).Path
if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
  $ManifestPath = Join-Path $resolvedRoot "release-manifest.json"
}
$resolvedManifest = (Resolve-Path -LiteralPath $ManifestPath).Path
$rootPrefix = $resolvedRoot.TrimEnd("\", "/") + [System.IO.Path]::DirectorySeparatorChar
if (-not $resolvedManifest.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Release manifest must be inside the artifact root."
}

$manifest = Get-Content -Raw -LiteralPath $resolvedManifest | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1 -or $null -eq $manifest.artifacts -or [string]::IsNullOrWhiteSpace($manifest.sourceCommit)) {
  throw "Release manifest contract is invalid."
}

foreach ($artifact in $manifest.artifacts) {
  if ([string]::IsNullOrWhiteSpace($artifact.path) -or $artifact.path -match '(^|/)\.\.(/|$)') {
    throw "Release manifest contains an unsafe artifact path."
  }
  $fullPath = [System.IO.Path]::GetFullPath((Join-Path $resolvedRoot $artifact.path))
  if (-not $fullPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Release manifest artifact path escaped the artifact root."
  }
  if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    throw "Release artifact is missing: $($artifact.path)"
  }
  $file = Get-Item -LiteralPath $fullPath
  $hash = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ([int64]$artifact.size -ne $file.Length -or $artifact.sha256 -ne $hash) {
    throw "Release artifact integrity verification failed: $($artifact.path)"
  }
}

$checksumsPath = Join-Path $resolvedRoot "SHA256SUMS.txt"
if (-not (Test-Path -LiteralPath $checksumsPath -PathType Leaf)) {
  throw "SHA256SUMS.txt is missing."
}
$expectedManifestHash = (Get-FileHash -LiteralPath $resolvedManifest -Algorithm SHA256).Hash.ToLowerInvariant()
$checksumLines = @(Get-Content -LiteralPath $checksumsPath)
if (-not ($checksumLines -contains "$expectedManifestHash  release-manifest.json")) {
  throw "SHA256SUMS.txt does not authenticate the release manifest payload."
}

Write-Host "Release manifest verified for $($manifest.artifacts.Count) artifacts from commit $($manifest.sourceCommit)."
