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
  $windowsExe = Join-Path $windowsDist "messk-windows.exe"
  Copy-Item -Force `
    -LiteralPath (Join-Path $root "clients\windows\target\release\messk-windows.exe") `
    -Destination $windowsExe

  $windowsReadme = Join-Path $windowsDist "README.txt"
  @"
Messk Windows Client
====================

Version: $version
Commit: $commit
Built: $buildTime
Backend: $BackendOrigin

Run:
  messk-windows.exe

Notes:
  - Native Rust/egui client, no WebView/Electron/Tauri.
  - Local state is stored in APPDATA\Messk\state.sqlite.
  - Identity seed and ratchet sessions are protected locally.
  - Settings include theme, density, backend origin, auto-connect, Windows startup and desktop notifications.
"@ | Set-Content -Encoding UTF8 -LiteralPath $windowsReadme

  $windowsManifest = Join-Path $windowsDist "release.json"
  [ordered]@{
    app = "messk-windows"
    version = $version
    commit = $commit
    builtAt = $buildTime
    backendOrigin = $BackendOrigin
    exe = "messk-windows.exe"
  } | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $windowsManifest

  $windowsZip = Join-Path $windowsDist ("messk-windows-{0}-{1}.zip" -f $version, $commit)
  if (Test-Path -LiteralPath $windowsZip) {
    Remove-Item -Force -LiteralPath $windowsZip
  }
  Compress-Archive -Force -LiteralPath @($windowsExe, $windowsReadme, $windowsManifest) -DestinationPath $windowsZip
}

Write-Host "Release build completed. Artifacts:"
Write-Host "- Backend: $backendOut"
Write-Host "- Frontend dist: $(Join-Path $root "messk\dist")"
if (-not $SkipWindowsClient) {
  Write-Host "- Windows client: $(Join-Path $windowsDist "messk-windows.exe")"
  Write-Host "- Windows package: $(Join-Path $windowsDist ("messk-windows-{0}-{1}.zip" -f $version, $commit))"
}
