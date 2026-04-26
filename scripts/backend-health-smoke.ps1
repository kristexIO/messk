$ErrorActionPreference = "Stop"

$backendDir = Join-Path $PSScriptRoot "..\mess"
$port = Get-Random -Minimum 18080 -Maximum 19080
$dbPath = Join-Path ([System.IO.Path]::GetTempPath()) "messenger-health-smoke.db"
$uploadDir = Join-Path ([System.IO.Path]::GetTempPath()) "messenger-health-smoke-uploads-$port"
$binaryPath = Join-Path ([System.IO.Path]::GetTempPath()) "messenger-health-smoke-$port.exe"

$previousPort = $env:PORT
$previousDbPath = $env:DB_PATH
$previousUploadDir = $env:UPLOAD_DIR
$previousOrigins = $env:ALLOWED_ORIGINS
$previousProxy = $env:ENABLE_METADATA_PROXY

$process = $null
$passed = $false

function Get-ResponseHeader($Response, $Name) {
  foreach ($key in $Response.Headers.Keys) {
    if ($key -ieq $Name) {
      return $Response.Headers[$key]
    }
  }
  return $null
}

try {
  $env:PORT = $port
  $env:DB_PATH = $dbPath
  $env:UPLOAD_DIR = $uploadDir
  $env:ALLOWED_ORIGINS = "http://localhost:5173"
  $env:ENABLE_METADATA_PROXY = "false"

  Push-Location $backendDir
  & go build -trimpath -o $binaryPath .
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to build backend smoke binary."
  }
  Pop-Location
  $process = Start-Process -FilePath $binaryPath -PassThru -WindowStyle Hidden

  $deadline = (Get-Date).AddSeconds(45)
  do {
    Start-Sleep -Milliseconds 500
    try {
      $healthResponse = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2
      $health = $healthResponse.Content | ConvertFrom-Json
      if ($health.status -eq "ok" -or $health.status -eq "degraded") {
        foreach ($header in @("X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy", "Permissions-Policy")) {
          if ([string]::IsNullOrWhiteSpace((Get-ResponseHeader $healthResponse $header))) {
            throw "Missing security header on /health: $header"
          }
        }

        $version = Invoke-RestMethod -Uri "http://127.0.0.1:$port/version" -TimeoutSec 2
        if ([string]::IsNullOrWhiteSpace($version.version) -or [string]::IsNullOrWhiteSpace($version.commit) -or [string]::IsNullOrWhiteSpace($version.builtAt)) {
          throw "Backend /version returned an incomplete payload."
        }

        Write-Host "Backend health smoke passed with status: $($health.status)"
        $passed = $true
        break
      }
    } catch {
      if ((Get-Date) -gt $deadline) {
        throw
      }
    }
  } while ((Get-Date) -lt $deadline)

  if (-not $passed) {
    throw "Backend health smoke timed out."
  }
} finally {
  if ($process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force
    Wait-Process -Id $process.Id -Timeout 10 -ErrorAction SilentlyContinue
  }
  foreach ($path in @($dbPath, "$dbPath-shm", "$dbPath-wal")) {
    if (Test-Path $path) {
      Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    }
  }
  if (Test-Path $binaryPath) {
    Remove-Item -LiteralPath $binaryPath -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path $uploadDir) {
    Remove-Item -LiteralPath $uploadDir -Recurse -Force -ErrorAction SilentlyContinue
  }

  $env:PORT = $previousPort
  $env:DB_PATH = $previousDbPath
  $env:UPLOAD_DIR = $previousUploadDir
  $env:ALLOWED_ORIGINS = $previousOrigins
  $env:ENABLE_METADATA_PROXY = $previousProxy
}
