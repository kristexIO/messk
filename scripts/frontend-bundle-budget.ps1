param(
  [string]$DistPath = (Join-Path $PSScriptRoot "..\messk\dist"),
  [int]$EntryMaxBytes = 200000,
  [int]$AuthMaxBytes = 80000,
  [int]$ChatMaxBytes = 260000,
  [int]$SessionMaxBytes = 160000,
  [int]$TrustMaxBytes = 40000
)

$ErrorActionPreference = "Stop"

$assetsPath = Join-Path $DistPath "assets"
if (-not (Test-Path $assetsPath)) {
  throw "Frontend dist assets not found at $assetsPath. Run npm run build first."
}

function Get-AssetByPrefix([string]$Prefix) {
  $matches = Get-ChildItem -LiteralPath $assetsPath -File -Filter "$Prefix-*.js" | Sort-Object Length -Descending
  if ($matches.Count -eq 0) {
    throw "Expected lazy chunk matching $Prefix-*.js was not emitted."
  }
  return $matches[0]
}

function Assert-MaxBytes([System.IO.FileInfo]$Asset, [int]$MaxBytes) {
  if ($Asset.Length -gt $MaxBytes) {
    throw ("Bundle budget exceeded for {0}: {1} bytes > {2} bytes" -f $Asset.Name, $Asset.Length, $MaxBytes)
  }
}

$entry = Get-AssetByPrefix "index"
$auth = Get-AssetByPrefix "Auth"
$chat = Get-AssetByPrefix "Chat"
$session = Get-AssetByPrefix "AuthenticatedSession"
$trust = Get-AssetByPrefix "TrustCenter"

Assert-MaxBytes $entry $EntryMaxBytes
Assert-MaxBytes $auth $AuthMaxBytes
Assert-MaxBytes $chat $ChatMaxBytes
Assert-MaxBytes $session $SessionMaxBytes
Assert-MaxBytes $trust $TrustMaxBytes

$entryText = Get-Content -LiteralPath $entry.FullName -Raw
$authenticatedOnlyMarkers = @(
  "Joined group via invite link",
  "Failed to use invite link",
  "webrtc_signal",
  "socket_disconnected"
)

foreach ($marker in $authenticatedOnlyMarkers) {
  if ($entryText.Contains($marker)) {
    throw "Entry bundle contains authenticated-only marker: $marker"
  }
}

Write-Host ("Frontend bundle budget passed: entry={0} auth={1} session={2} chat={3} trust={4}" -f $entry.Length, $auth.Length, $session.Length, $chat.Length, $trust.Length)

