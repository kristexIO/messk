param(
  [Parameter(Mandatory = $true)]
  [string]$BackendOrigin,

  [string]$ExpectedCommitPrefix = ""
)

$ErrorActionPreference = "Stop"

function Get-ResponseHeader($Response, $Name) {
  foreach ($key in $Response.Headers.Keys) {
    if ($key -ieq $Name) {
      return $Response.Headers[$key]
    }
  }
  return $null
}

function Invoke-JsonEndpoint($Origin, $Path, $RequiredProperty) {
  $uri = "$Origin$Path"
  $response = Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec 15
  $contentType = Get-ResponseHeader $response "Content-Type"
  if ($contentType -notmatch "application/json") {
    $preview = $response.Content.Substring(0, [Math]::Min(120, $response.Content.Length))
    throw "$Path returned non-JSON content type '$contentType'. Body starts with: $preview"
  }

  $body = $response.Content | ConvertFrom-Json
  if ($null -eq $body.$RequiredProperty) {
    throw "$Path did not include required property '$RequiredProperty'."
  }
  return $body
}

$origin = $BackendOrigin.Trim().TrimEnd("/")
$parsed = $null
if (-not [Uri]::TryCreate($origin, [UriKind]::Absolute, [ref]$parsed)) {
  throw "BackendOrigin must be an absolute URL."
}
if ($parsed.Scheme -notin @("http", "https")) {
  throw "BackendOrigin must use http or https."
}

$health = Invoke-JsonEndpoint $origin "/health" "status"
if ($health.status -ne "ok" -and $health.status -ne "degraded") {
  throw "/health returned status '$($health.status)'."
}
if ($null -ne $health.stats) {
  throw "Public /health exposed protected operational metrics."
}

$version = Invoke-JsonEndpoint $origin "/version" "version"
if ([string]::IsNullOrWhiteSpace($version.commit) -or [string]::IsNullOrWhiteSpace($version.builtAt)) {
  throw "/version returned an incomplete payload."
}
if (-not [string]::IsNullOrWhiteSpace($ExpectedCommitPrefix) -and -not $version.commit.StartsWith($ExpectedCommitPrefix)) {
  throw "/version returned commit '$($version.commit)', expected prefix '$ExpectedCommitPrefix'."
}

$relayHealth = Invoke-JsonEndpoint $origin "/relay/health" "status"
if ($relayHealth.status -ne "ok") {
  throw "/relay/health returned status '$($relayHealth.status)'."
}

$bootstrap = Invoke-JsonEndpoint $origin "/bootstrap" "mode"
if ($bootstrap.mode -ne "bootstrap") {
  throw "/bootstrap returned mode '$($bootstrap.mode)'."
}

$relayPeers = Invoke-JsonEndpoint $origin "/relay/peers" "peers"
$peers = Invoke-JsonEndpoint $origin "/peers" "peers"
if ($null -eq $relayPeers.count -or $null -eq $peers.count) {
  throw "Peer discovery endpoints returned incomplete payloads."
}

Write-Host "Production smoke passed for $origin"
