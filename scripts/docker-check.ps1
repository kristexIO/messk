$ErrorActionPreference = "Stop"

function Invoke-External($Description, $Command, $Arguments) {
  Write-Host $Description
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed with exit code $LASTEXITCODE"
  }
}

$docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $docker) {
  Write-Host "Docker is not installed or not on PATH; skipping Docker checks."
  exit 0
}

$root = Resolve-Path "$PSScriptRoot\.."
$backendDir = Join-Path $root "mess"

Push-Location $backendDir
Invoke-External "== Docker compose config ==" "docker" @("compose", "config")

$dockerInfoOut = Join-Path ([System.IO.Path]::GetTempPath()) "messan-docker-info.out"
$dockerInfoErr = Join-Path ([System.IO.Path]::GetTempPath()) "messan-docker-info.err"
$dockerInfo = Start-Process -FilePath $docker.Source -ArgumentList @("info") -Wait -PassThru -NoNewWindow -RedirectStandardOutput $dockerInfoOut -RedirectStandardError $dockerInfoErr
if ($dockerInfo.ExitCode -ne 0) {
  Write-Host "Docker daemon is not available; skipping image build."
  Pop-Location
  exit 0
}

Invoke-External "== Backend Docker image build ==" "docker" @("build", "-t", "e2ee-messenger-backend:local-check", ".")
Pop-Location

Write-Host "Docker checks completed."
