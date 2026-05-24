param(
  [switch]$SkipFrontend
)

$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

& (Join-Path $root "scripts\secret-scan.ps1")
if ($LASTEXITCODE -ne 0) {
  throw "Secret scan failed"
}
& (Join-Path $root "scripts\secret-scan-test.ps1")
if ($LASTEXITCODE -ne 0) {
  throw "Secret scan negative test failed"
}

Push-Location (Join-Path $root "mess")
try {
  go test ./...
  if ($LASTEXITCODE -ne 0) { throw "Backend tests failed" }
  go build ./...
  if ($LASTEXITCODE -ne 0) { throw "Backend build failed" }
}
finally {
  Pop-Location
}

if (-not $SkipFrontend) {
  Push-Location (Join-Path $root "messk")
  try {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw "Frontend install failed" }
    npm run lint
    if ($LASTEXITCODE -ne 0) { throw "Frontend lint failed" }
    npm test
    if ($LASTEXITCODE -ne 0) { throw "Frontend tests failed" }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "Frontend build failed" }
  }
  finally {
    Pop-Location
  }
}

& (Join-Path $root "scripts\build-windows-client.ps1") -Configuration debug -RunTests
if ($LASTEXITCODE -ne 0) {
  throw "Windows client check failed"
}

Write-Host "All checks passed."
