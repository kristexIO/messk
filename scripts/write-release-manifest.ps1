param(
  [Parameter(Mandatory = $true)]
  [string]$ArtifactRoot,

  [Parameter(Mandatory = $true)]
  [string]$Version,

  [Parameter(Mandatory = $true)]
  [string]$Commit,

  [Parameter(Mandatory = $true)]
  [string]$BuiltAt,

  [Parameter(Mandatory = $true)]
  [string]$BackendOrigin,

  [ValidateSet("stable", "beta")]
  [string]$Channel = "stable",

  [bool]$SourceDirty = $false,

  [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"

$resolvedRoot = (Resolve-Path -LiteralPath $ArtifactRoot).Path
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  $OutputPath = Join-Path $resolvedRoot "release-manifest.json"
}
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
$rootPrefix = $resolvedRoot.TrimEnd("\", "/") + [System.IO.Path]::DirectorySeparatorChar
if (-not $resolvedOutput.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Release manifest must be written inside the artifact root."
}
$checksumsPath = Join-Path $resolvedRoot "SHA256SUMS.txt"

$artifacts = @(
  Get-ChildItem -LiteralPath $resolvedRoot -Recurse -File |
    Where-Object { $_.FullName -ne $resolvedOutput -and $_.FullName -ne $checksumsPath } |
    ForEach-Object {
      if (-not $_.FullName.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Release artifact escaped the artifact root."
      }
      $relativePath = $_.FullName.Substring($rootPrefix.Length).Replace("\", "/")
      [ordered]@{
        path = $relativePath
        size = $_.Length
        sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      }
    } |
    Sort-Object path
)

$manifest = [ordered]@{
  schemaVersion = 1
  app = "messk"
  version = $Version
  channel = $Channel
  sourceCommit = $Commit
  sourceDirty = $SourceDirty
  builtAt = $BuiltAt
  backendOrigin = $BackendOrigin
  artifacts = $artifacts
}

$encoding = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($resolvedOutput, ($manifest | ConvertTo-Json -Depth 5) + "`n", $encoding)
$manifestHash = (Get-FileHash -LiteralPath $resolvedOutput -Algorithm SHA256).Hash.ToLowerInvariant()
$lines = @($artifacts | ForEach-Object { "$($_.sha256)  $($_.path)" })
$lines += "$manifestHash  release-manifest.json"
[System.IO.File]::WriteAllText($checksumsPath, ($lines -join "`n") + "`n", $encoding)

Write-Host "Release manifest written: $resolvedOutput"
