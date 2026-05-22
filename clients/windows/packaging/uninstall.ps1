[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Programs\Messk"),
  [switch]$KeepData
)

$ErrorActionPreference = "Stop"

$startMenuDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Messk"
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$stateDir = Join-Path $env:APPDATA "Messk"

if ($PSCmdlet.ShouldProcess($runKey, "Remove Messk auto-start")) {
  Remove-ItemProperty -Path $runKey -Name "Messk" -ErrorAction SilentlyContinue
}

if (Test-Path -LiteralPath $startMenuDir) {
  if ($PSCmdlet.ShouldProcess($startMenuDir, "Remove Start Menu shortcuts")) {
    Remove-Item -Recurse -Force -LiteralPath $startMenuDir
  }
}

if (Test-Path -LiteralPath $InstallDir) {
  if ($PSCmdlet.ShouldProcess($InstallDir, "Remove installed application files")) {
    Remove-Item -Recurse -Force -LiteralPath $InstallDir
  }
}

if (-not $KeepData -and (Test-Path -LiteralPath $stateDir)) {
  if ($PSCmdlet.ShouldProcess($stateDir, "Remove local Messk state")) {
    Remove-Item -Recurse -Force -LiteralPath $stateDir
  }
}

Write-Host "Messk uninstalled"
