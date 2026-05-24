param(
  [Parameter(Mandatory = $true)]
  [string]$BackendOrigin,

  [switch]$AllowLocalhost
)

$ErrorActionPreference = "Stop"

function Fail($Message) {
  throw "Release preflight failed: $Message"
}

function Assert-File($Path) {
  if (-not (Test-Path $Path)) {
    Fail "Required file is missing: $Path"
  }
}

function Read-KeyValueFile($Path) {
  $values = @{}
  Get-Content $Path | ForEach-Object {
    $line = $_.Trim()
    if ($line -eq "" -or $line.StartsWith("#")) {
      return
    }

    $parts = $line.Split("=", 2)
    if ($parts.Length -eq 2) {
      $values[$parts[0].Trim()] = $parts[1].Trim()
    }
  }
  return $values
}

function Test-LocalOrigin($Origin) {
  return $Origin -match "://(localhost|127\.0\.0\.1|\[::1\])(?::|/|$)"
}

$root = Resolve-Path "$PSScriptRoot\.."
$backendEnvPath = Join-Path $root "mess\.env.example"
$frontendEnvPath = Join-Path $root "messk\.env.example"
$frontendPackagePath = Join-Path $root "messk\package.json"
$windowsCargoPath = Join-Path $root "clients\windows\Cargo.toml"
$windowsBuildScriptPath = Join-Path $root "scripts\build-windows-client.ps1"
$secretScanScriptPath = Join-Path $root "scripts\secret-scan.ps1"

Assert-File $backendEnvPath
Assert-File $frontendEnvPath
Assert-File $frontendPackagePath
Assert-File $windowsCargoPath
Assert-File $windowsBuildScriptPath
Assert-File $secretScanScriptPath

& $secretScanScriptPath
if ($LASTEXITCODE -ne 0) {
  Fail "secret scan failed"
}

try {
  $backendUri = [Uri]$BackendOrigin
} catch {
  Fail "BackendOrigin must be a valid absolute URL, got '$BackendOrigin'"
}

if ($backendUri.Scheme -notin @("http", "https")) {
  Fail "BackendOrigin must use http or https, got '$($backendUri.Scheme)'"
}

if (-not $AllowLocalhost -and (Test-LocalOrigin $BackendOrigin)) {
  Fail "BackendOrigin points to localhost. Pass -AllowLocalhost only for CI/local checks, not production releases."
}

$backendEnv = Read-KeyValueFile $backendEnvPath
$frontendEnv = Read-KeyValueFile $frontendEnvPath

if ($backendEnv["ENABLE_METADATA_PROXY"] -ne "false") {
  Fail "mess\.env.example must keep ENABLE_METADATA_PROXY=false"
}

if ([string]::IsNullOrWhiteSpace($backendEnv["DB_PATH"])) {
  Fail "mess\.env.example must define DB_PATH"
}

if ([string]::IsNullOrWhiteSpace($backendEnv["UPLOAD_DIR"])) {
  Fail "mess\.env.example must define UPLOAD_DIR"
}

if ([string]::IsNullOrWhiteSpace($backendEnv["MAX_UPLOAD_MB"])) {
  Fail "mess\.env.example must define MAX_UPLOAD_MB"
}

if ([string]::IsNullOrWhiteSpace($backendEnv["FILE_TOKEN_TTL_MINUTES"])) {
  Fail "mess\.env.example must define FILE_TOKEN_TTL_MINUTES"
}

if ([string]::IsNullOrWhiteSpace($backendEnv["SESSION_TOKEN_TTL_MINUTES"])) {
  Fail "mess\.env.example must define SESSION_TOKEN_TTL_MINUTES"
}

if ([string]::IsNullOrWhiteSpace($backendEnv["RATE_LIMIT_PER_MINUTE"])) {
  Fail "mess\.env.example must define RATE_LIMIT_PER_MINUTE"
}

if (($backendEnv["ALLOWED_UPLOAD_MIME_TYPES"] -split ",") -notcontains "application/octet-stream") {
  Fail "mess\.env.example must allow application/octet-stream uploads"
}

if ([string]::IsNullOrWhiteSpace($frontendEnv["VITE_BACKEND_URL"])) {
  Fail "messk\.env.example must define VITE_BACKEND_URL"
}

if ([string]::IsNullOrWhiteSpace($frontendEnv["VITE_STUN_URLS"])) {
  Fail "messk\.env.example must define VITE_STUN_URLS"
}

if ([string]::IsNullOrWhiteSpace($frontendEnv["VITE_TURN_URLS"])) {
  Fail "messk\.env.example must define VITE_TURN_URLS"
}

if ([string]::IsNullOrWhiteSpace($frontendEnv["VITE_TURN_USERNAME"])) {
  Fail "messk\.env.example must define VITE_TURN_USERNAME"
}

if ([string]::IsNullOrWhiteSpace($frontendEnv["VITE_TURN_CREDENTIAL"])) {
  Fail "messk\.env.example must define VITE_TURN_CREDENTIAL"
}

$frontendPackage = Get-Content -Raw $frontendPackagePath | ConvertFrom-Json

$httpOrigin = $backendUri.GetLeftPart([UriPartial]::Authority)

if (-not $AllowLocalhost -and $frontendEnv["VITE_BACKEND_URL"] -ne $httpOrigin) {
  Fail "messk\.env.example VITE_BACKEND_URL must match '$httpOrigin'"
}

$allFrontendDeps = @()
foreach ($section in @("dependencies", "devDependencies")) {
  if ($frontendPackage.PSObject.Properties.Name -contains $section) {
    $allFrontendDeps += $frontendPackage.$section.PSObject.Properties.Name
  }
}
if ($allFrontendDeps | Where-Object { $_ -like "@tauri-apps/*" }) {
  Fail "messk\package.json still contains Tauri dependencies"
}

Write-Host "Release preflight passed for $httpOrigin"
