$ErrorActionPreference = "Stop"

function Invoke-External($Description, $Command, $Arguments) {
  Write-Host $Description
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed with exit code $LASTEXITCODE"
  }
}

Write-Host "== Release preflight (local mode) =="
& "$PSScriptRoot\release-preflight.ps1" -BackendOrigin "http://localhost:8080" -AllowLocalhost

Push-Location "$PSScriptRoot\..\mess"
Invoke-External "== Backend tests ==" "go" @("test", "./...")
Pop-Location

Write-Host "== Backend health smoke =="
& "$PSScriptRoot\backend-health-smoke.ps1"

Push-Location "$PSScriptRoot\..\messk"
Invoke-External "== Frontend lint ==" "npm" @("run", "lint")
Invoke-External "== Frontend tests ==" "npm" @("test")
Invoke-External "== Frontend build ==" "npm" @("run", "build")
Pop-Location

Push-Location "$PSScriptRoot\..\messk\src-tauri"
Invoke-External "== Tauri cargo check ==" "cargo" @("check")
Pop-Location

Write-Host "Smoke check completed."
