param(
  [Parameter(Mandatory = $true)]
  [string]$BackendOrigin,

  [switch]$AllowLocalhost,
  [switch]$SkipWindowsClient,
  [string]$BuildTime = "",
  [ValidateSet("stable", "beta")]
  [string]$Channel = "stable",
  [switch]$AllowDirtyTree
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
$webDist = Join-Path $dist "web"
$windowsDist = Join-Path $dist "windows"
$version = (Get-Content -Raw (Join-Path $root "messk\package.json") | ConvertFrom-Json).version
$commit = "unknown"
$sourceCommit = "unknown"
$sourceDirty = $false
$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) {
  if (-not $AllowDirtyTree) {
    throw "Release builds require a readable git worktree so artifacts can be bound to a source commit."
  }
  $sourceDirty = $true
} else {
  $resolvedCommit = (& git -C $root rev-parse HEAD 2>$null | Select-Object -First 1)
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string]$resolvedCommit)) {
    if (-not $AllowDirtyTree) {
      throw "Release builds require a resolvable git commit so artifacts can be bound to source."
    }
    $sourceDirty = $true
  } else {
    $sourceCommit = ([string]$resolvedCommit).Trim()
    $commit = $sourceCommit.Substring(0, [Math]::Min(12, $sourceCommit.Length))
  }
  $dirtyPaths = @(& git -C $root status --porcelain --untracked-files=normal 2>$null)
  if ($LASTEXITCODE -ne 0) {
    if (-not $AllowDirtyTree) {
      throw "Release builds require a readable git worktree so artifact source state can be verified."
    }
    $sourceDirty = $true
  } elseif ($dirtyPaths.Count -gt 0) {
    $sourceDirty = $true
  }
  if ($sourceDirty -and -not $AllowDirtyTree) {
    throw "Release builds require a clean git worktree. Commit intended source changes or pass -AllowDirtyTree only for local diagnostics."
  }
}

if ([string]::IsNullOrWhiteSpace($BuildTime)) {
  $sourceDateEpoch = [Environment]::GetEnvironmentVariable("SOURCE_DATE_EPOCH")
  if ([string]::IsNullOrWhiteSpace($sourceDateEpoch) -and $git -and $sourceCommit -ne "unknown") {
    $sourceDateEpoch = (& git -C $root show -s --format=%ct HEAD 2>$null).Trim()
  }
  if (-not [string]::IsNullOrWhiteSpace($sourceDateEpoch) -and $sourceDateEpoch -match '^\d+$') {
    $BuildTime = [DateTimeOffset]::FromUnixTimeSeconds([int64]$sourceDateEpoch).UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ssZ")
  } else {
    $BuildTime = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  }
}

$resolvedDist = [System.IO.Path]::GetFullPath($dist)
$expectedDist = [System.IO.Path]::GetFullPath((Join-Path $root "dist"))
if ($resolvedDist -ne $expectedDist) {
  throw "Refusing to reset an unexpected release artifact directory."
}
if (Test-Path -LiteralPath $resolvedDist) {
  Remove-Item -LiteralPath $resolvedDist -Recurse -Force
}

& "$PSScriptRoot\release-preflight.ps1" -BackendOrigin $BackendOrigin -AllowLocalhost:$AllowLocalhost -BuildTimeFrontendConfig

New-Item -ItemType Directory -Force $backendDist | Out-Null

Push-Location (Join-Path $root "mess")
Invoke-External "== Backend tests ==" "go" @("test", "./...")

$backendOut = Join-Path $backendDist "messenger-server.exe"
$ldflags = "-s -w -X main.appVersion=$version -X main.commitSHA=$commit -X main.buildTime=$BuildTime"
Invoke-External "== Backend build ==" "go" @("build", "-trimpath", "-ldflags=$ldflags", "-o", $backendOut, ".")
Pop-Location

Push-Location (Join-Path $root "messk")
Invoke-External "== Frontend install ==" "npm" @("ci")
Invoke-External "== Frontend lint ==" "npm" @("run", "lint")
Invoke-External "== Frontend tests ==" "npm" @("test")
$previousBackendUrl = [Environment]::GetEnvironmentVariable("VITE_BACKEND_URL", "Process")
try {
  [Environment]::SetEnvironmentVariable("VITE_BACKEND_URL", $BackendOrigin.Trim().TrimEnd("/"), "Process")
  Invoke-External "== Frontend build ==" "npm" @("run", "build")
  & "$PSScriptRoot\frontend-bundle-budget.ps1"
  if ($LASTEXITCODE -ne 0) {
    throw "Frontend bundle budget failed"
  }
} finally {
  [Environment]::SetEnvironmentVariable("VITE_BACKEND_URL", $previousBackendUrl, "Process")
}
Pop-Location
New-Item -ItemType Directory -Force $webDist | Out-Null
Copy-Item -Recurse -Force -Path (Join-Path $root "messk\dist\*") -Destination $webDist

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
  $windowsInstall = Join-Path $windowsDist "install.ps1"
  $windowsUninstall = Join-Path $windowsDist "uninstall.ps1"
  Copy-Item -Force `
    -LiteralPath (Join-Path $root "clients\windows\packaging\install.ps1") `
    -Destination $windowsInstall
  Copy-Item -Force `
    -LiteralPath (Join-Path $root "clients\windows\packaging\uninstall.ps1") `
    -Destination $windowsUninstall

  $windowsReadme = Join-Path $windowsDist "README.txt"
  @"
Messk Windows Client
====================

Version: $version
Commit: $commit
Built: $BuildTime
Backend: $BackendOrigin

Run:
  messk-windows.exe

Install:
  powershell -ExecutionPolicy Bypass -File install.ps1

Uninstall:
  powershell -ExecutionPolicy Bypass -File uninstall.ps1 -KeepData

Notes:
  - Native Rust/egui client, no WebView/Electron/Tauri.
  - Local state is stored in APPDATA\Messk\state.sqlite.
  - Identity seed and ratchet sessions are protected locally.
  - Settings include theme, density, backend origin, auto-connect, Windows startup, tray mode and desktop notifications.
  - Voice-message recording is available; realtime audio/video/screen-share calls are not yet implemented in the native client.
"@ | Set-Content -Encoding UTF8 -LiteralPath $windowsReadme

  $windowsManifest = Join-Path $windowsDist "release.json"
  [ordered]@{
    app = "messk-windows"
    version = $version
    commit = $commit
    builtAt = $BuildTime
    backendOrigin = $BackendOrigin
    exe = "messk-windows.exe"
  } | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $windowsManifest

  $windowsZip = Join-Path $windowsDist ("messk-windows-{0}-{1}.zip" -f $version, $commit)
  if (Test-Path -LiteralPath $windowsZip) {
    Remove-Item -Force -LiteralPath $windowsZip
  }
  Compress-Archive -Force -LiteralPath @($windowsExe, $windowsReadme, $windowsManifest, $windowsInstall, $windowsUninstall) -DestinationPath $windowsZip
}

& "$PSScriptRoot\write-release-manifest.ps1" `
  -ArtifactRoot $dist `
  -Version $version `
  -Commit $sourceCommit `
  -BuiltAt $BuildTime `
  -BackendOrigin $BackendOrigin `
  -Channel $Channel `
  -SourceDirty $sourceDirty
& "$PSScriptRoot\verify-release-manifest.ps1" -ArtifactRoot $dist

Write-Host "Release build completed. Artifacts:"
Write-Host "- Backend: $backendOut"
Write-Host "- Frontend dist: $webDist"
if (-not $SkipWindowsClient) {
  Write-Host "- Windows client: $(Join-Path $windowsDist "messk-windows.exe")"
  Write-Host "- Windows package: $(Join-Path $windowsDist ("messk-windows-{0}-{1}.zip" -f $version, $commit))"
}
Write-Host "- Integrity manifest: $(Join-Path $dist "release-manifest.json")"
