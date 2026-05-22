[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Programs\Messk"),
  [switch]$AutoStart,
  [switch]$NoShortcut
)

$ErrorActionPreference = "Stop"

$packageRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceExe = Join-Path $packageRoot "messk-windows.exe"
if (-not (Test-Path -LiteralPath $sourceExe)) {
  throw "messk-windows.exe not found next to install.ps1"
}

$startMenuDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Messk"
$shortcutPath = Join-Path $startMenuDir "Messk.lnk"
$targetExe = Join-Path $InstallDir "messk-windows.exe"
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"

if ($PSCmdlet.ShouldProcess($InstallDir, "Create install directory")) {
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
}

foreach ($file in @("messk-windows.exe", "README.txt", "release.json")) {
  $source = Join-Path $packageRoot $file
  if (Test-Path -LiteralPath $source) {
    $target = Join-Path $InstallDir $file
    if ($PSCmdlet.ShouldProcess($target, "Copy $file")) {
      Copy-Item -Force -LiteralPath $source -Destination $target
    }
  }
}

if (-not $NoShortcut) {
  if ($PSCmdlet.ShouldProcess($shortcutPath, "Create Start Menu shortcut")) {
    New-Item -ItemType Directory -Force -Path $startMenuDir | Out-Null
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $targetExe
    $shortcut.WorkingDirectory = $InstallDir
    $shortcut.Description = "Messk"
    $shortcut.Save()
  }
}

if ($AutoStart) {
  if ($PSCmdlet.ShouldProcess($runKey, "Register Messk auto-start")) {
    New-Item -Path $runKey -Force | Out-Null
    New-ItemProperty -Path $runKey -Name "Messk" -Value "`"$targetExe`"" -PropertyType String -Force | Out-Null
  }
}

Write-Host "Messk installed to $InstallDir"
