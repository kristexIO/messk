param(
  [Parameter(Mandatory = $true)]
  [string]$BackendOrigin,

  [switch]$AllowLocalhost
)

$ErrorActionPreference = "Stop"

function Fail($Message) {
  throw "Release configuration failed: $Message"
}

function Test-LocalOrigin($Origin) {
  return $Origin -match "://(localhost|127\.0\.0\.1|\[::1\])(?::|/|$)"
}

function Set-EnvValue($Path, $Key, $Value) {
  $lines = @()
  $found = $false

  if (Test-Path $Path) {
    $lines = @(Get-Content $Path)
  }

  $updated = $lines | ForEach-Object {
    if ($_ -match "^\s*$([regex]::Escape($Key))=") {
      $found = $true
      "$Key=$Value"
    } else {
      $_
    }
  }

  if (-not $found) {
    $updated += "$Key=$Value"
  }

  $content = ($updated -join [Environment]::NewLine) + [Environment]::NewLine
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $content, $utf8NoBom)
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
  Fail "BackendOrigin points to localhost. Pass -AllowLocalhost only for local/dev configuration."
}

$root = Resolve-Path "$PSScriptRoot\.."
$frontendEnvPath = Join-Path $root "messk\.env.example"
$tauriConfigPath = Join-Path $root "messk\src-tauri\tauri.conf.json"

if (-not (Test-Path $tauriConfigPath)) {
  Fail "Tauri config is missing: $tauriConfigPath"
}

$httpOrigin = $backendUri.GetLeftPart([UriPartial]::Authority)
$wsScheme = if ($backendUri.Scheme -eq "https") { "wss" } else { "ws" }
$wsOrigin = "$($wsScheme)://$($backendUri.Authority)"

Set-EnvValue -Path $frontendEnvPath -Key "VITE_BACKEND_URL" -Value $httpOrigin

$csp = "default-src 'self'; connect-src 'self' $wsOrigin $httpOrigin; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: $httpOrigin; media-src 'self' blob: $httpOrigin"
$escapedCsp = $csp.Replace("\", "\\").Replace('"', '\"')
$tauriConfigRaw = Get-Content -Raw $tauriConfigPath

if ($tauriConfigRaw -notmatch '"csp"\s*:') {
  Fail "Tauri config does not contain app.security.csp"
}

$tauriConfigRaw = [regex]::Replace($tauriConfigRaw, '"csp"\s*:\s*"[^"]*"', "`"csp`": `"$escapedCsp`"", 1)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($tauriConfigPath, $tauriConfigRaw, $utf8NoBom)

& "$PSScriptRoot\release-preflight.ps1" -BackendOrigin $httpOrigin -AllowLocalhost:$AllowLocalhost

Write-Host "Release configuration updated for $httpOrigin"
