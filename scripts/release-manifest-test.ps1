$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) "messk_manifest_test_$([Guid]::NewGuid().ToString('N'))"

try {
  New-Item -ItemType Directory -Force -Path (Join-Path $testRoot "backend") | Out-Null
  [System.IO.File]::WriteAllText(
    (Join-Path $testRoot "backend\server.bin"),
    "test-artifact",
    [System.Text.UTF8Encoding]::new($false)
  )
  & (Join-Path $root "scripts\write-release-manifest.ps1") `
    -ArtifactRoot $testRoot `
    -Version "test" `
    -Commit "test-commit" `
    -BuiltAt "2026-05-25T00:00:00Z" `
    -BackendOrigin "https://staging.example"
  & (Join-Path $root "scripts\verify-release-manifest.ps1") -ArtifactRoot $testRoot

  [System.IO.File]::AppendAllText((Join-Path $testRoot "backend\server.bin"), "tampered")
  $rejected = $false
  try {
    & (Join-Path $root "scripts\verify-release-manifest.ps1") -ArtifactRoot $testRoot 2>$null
  } catch {
    $rejected = $true
  }
  if (-not $rejected) {
    throw "Release manifest test did not reject a tampered artifact."
  }
} finally {
  if (Test-Path -LiteralPath $testRoot) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force
  }
}

Write-Host "Release manifest tamper test passed."
