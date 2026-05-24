$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$fixturePath = Join-Path $root "secret-scan-negative-$([Guid]::NewGuid().ToString('N')).env"
$blocked = $false

try {
  [System.IO.File]::WriteAllText(
    $fixturePath,
    "ADMIN_TOKEN=fixture-secret-value-that-must-be-blocked`n",
    [System.Text.UTF8Encoding]::new($false)
  )

  try {
    & (Join-Path $PSScriptRoot "secret-scan.ps1") 2>$null
  } catch {
    $blocked = $true
  }
} finally {
  Remove-Item -LiteralPath $fixturePath -Force -ErrorAction SilentlyContinue
}

if (-not $blocked) {
  throw "Secret scan did not reject a non-placeholder token fixture."
}

& (Join-Path $PSScriptRoot "secret-scan.ps1")
if ($LASTEXITCODE -ne 0) {
  throw "Secret scan failed after cleaning the negative fixture."
}

Write-Host "Secret scan negative test passed."
