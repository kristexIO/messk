param(
  [Parameter(Mandatory = $true)]
  [string]$BackendOrigin,

  [switch]$AllowLocalhost,
  [switch]$SkipWindowsClient
)

$ErrorActionPreference = "Stop"

function Invoke-External($Description, $Command, $Arguments) {
  Write-Host $Description
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed with exit code $LASTEXITCODE"
  }
}

$root = Resolve-Path "$PSScriptRoot\.."
$dist = Join-Path $root "dist"
$backendDist = Join-Path $dist "backend"
$windowsDist = Join-Path $dist "windows"
$buildTime = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$version = (Get-Content -Raw (Join-Path $root "messk\package.json") | ConvertFrom-Json).version
$commit = "unknown"

& "$PSScriptRoot\configure-release.ps1" -BackendOrigin $BackendOrigin -AllowLocalhost:$AllowLocalhost
& "$PSScriptRoot\release-preflight.ps1" -BackendOrigin $BackendOrigin -AllowLocalhost:$AllowLocalhost

New-Item -ItemType Directory -Force $backendDist | Out-Null

Push-Location (Join-Path $root "mess")
$git = Get-Command git -ErrorAction SilentlyContinue
if ($git) {
  $resolvedCommit = (& git rev-parse --short HEAD 2>$null)
  if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($resolvedCommit)) {
    $commit = $resolvedCommit.Trim()
  }
}

Invoke-External "== Backend tests ==" "go" @("test", "./...")

$backendOut = Join-Path $backendDist "messenger-server.exe"
$ldflags = "-s -w -X main.appVersion=$version -X main.commitSHA=$commit -X main.buildTime=$buildTime"
Invoke-External "== Backend build ==" "go" @("build", "-trimpath", "-ldflags=$ldflags", "-o", $backendOut, ".")
Pop-Location

Push-Location (Join-Path $root "messk")
Invoke-External "== Frontend install ==" "npm" @("ci")
Invoke-External "== Frontend lint ==" "npm" @("run", "lint")
Invoke-External "== Frontend tests ==" "npm" @("test")
Invoke-External "== Frontend build ==" "npm" @("run", "build")
Pop-Location

if (-not $SkipWindowsClient) {
  & "$PSScriptRoot\build-windows-client.ps1" -Configuration release -RunTests
  if ($LASTEXITCODE -ne 0) {
    throw "Native Windows client release build failed"
  }
  New-Item -ItemType Directory -Force $windowsDist | Out-Null
  Copy-Item -Force `
    -LiteralPath (Join-Path $root "clients\windows\target\release\messk-windows.exe") `
    -Destination (Join-Path $windowsDist "messk-windows.exe")
}

Write-Host "Release build completed. Artifacts:"
Write-Host "- Backend: $backendOut"
Write-Host "- Frontend dist: $(Join-Path $root "messk\dist")"
if (-not $SkipWindowsClient) {
  Write-Host "- Windows client: $(Join-Path $windowsDist "messk-windows.exe")"
}
