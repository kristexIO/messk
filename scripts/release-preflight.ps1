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
$tauriConfigPath = Join-Path $root "messk\src-tauri\tauri.conf.json"

Assert-File $backendEnvPath
Assert-File $frontendEnvPath
Assert-File $frontendPackagePath
Assert-File $tauriConfigPath

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

$tauriConfig = Get-Content -Raw $tauriConfigPath | ConvertFrom-Json
$frontendPackage = Get-Content -Raw $frontendPackagePath | ConvertFrom-Json
$csp = [string]$tauriConfig.app.security.csp

if ($frontendPackage.version -ne $tauriConfig.version) {
  Fail "messk\package.json version '$($frontendPackage.version)' must match Tauri version '$($tauriConfig.version)'"
}

if ([string]::IsNullOrWhiteSpace($csp)) {
  Fail "Tauri CSP is empty"
}

if ($csp -match "'unsafe-eval'") {
  Fail "Tauri CSP still allows 'unsafe-eval'. Remove it before release."
}

$httpOrigin = $backendUri.GetLeftPart([UriPartial]::Authority)
$wsScheme = if ($backendUri.Scheme -eq "https") { "wss" } else { "ws" }
$wsOrigin = "$($wsScheme)://$($backendUri.Authority)"

if (-not $csp.Contains($httpOrigin)) {
  Fail "Tauri CSP does not include backend HTTP origin '$httpOrigin'"
}

if (-not $csp.Contains($wsOrigin)) {
  Fail "Tauri CSP does not include backend WebSocket origin '$wsOrigin'"
}

if (-not $AllowLocalhost -and ($csp -match "localhost|127\.0\.0\.1|\[::1\]")) {
  Fail "Tauri CSP still contains localhost entries. Replace them with production origins."
}

Write-Host "Release preflight passed for $httpOrigin"
