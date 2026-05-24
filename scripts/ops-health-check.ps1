param(
  [string]$BackendOrigin = "http://127.0.0.1:8080",
  [int]$MaxOfflineMessages = 1000,
  [int]$MaxWaitingDelivery = 1000,
  [int]$MaxRouteQueue = 100,
  [int]$MaxRedisQueue = 100,
  [switch]$AllowDegraded
)

$ErrorActionPreference = "Stop"

$origin = $BackendOrigin.Trim().TrimEnd("/")
$parsed = $null
if (-not [Uri]::TryCreate($origin, [UriKind]::Absolute, [ref]$parsed)) {
  throw "BackendOrigin must be an absolute URL."
}
if ($parsed.Scheme -notin @("http", "https")) {
  throw "BackendOrigin must use http or https."
}

$headers = @{}
$adminToken = [Environment]::GetEnvironmentVariable("MESSK_ADMIN_TOKEN")
if (-not [string]::IsNullOrWhiteSpace($adminToken)) {
  $headers["X-Admin-Token"] = $adminToken
}

try {
  $health = Invoke-RestMethod -Uri "$origin/admin/health" -Headers $headers -TimeoutSec 15
} catch {
  throw "Unable to read operator health at $origin/admin/health. Run this on the VPS loopback interface or set MESSK_ADMIN_TOKEN in the process environment."
}

if ($health.status -eq "error") {
  throw "Backend health reports an error state."
}
if ($health.status -eq "degraded" -and -not $AllowDegraded) {
  throw "Backend health is degraded. Pass -AllowDegraded only when the degradation is understood and accepted."
}
if ($null -eq $health.stats -or $null -eq $health.stats.database -or $null -eq $health.stats.hub) {
  throw "Operator health response does not include protected operational metrics."
}

$offlineMessages = [int64]$health.stats.database.offlineMessages
$waitingDelivery = [int64]$health.stats.database.messageHistoryWaitingDelivery
$routeQueue = [int64]$health.stats.hub.routeQueue
$redisQueue = [int64]$health.stats.hub.redisQueue
$alerts = [System.Collections.Generic.List[string]]::new()

if ($offlineMessages -gt $MaxOfflineMessages) {
  $alerts.Add("offline messages $offlineMessages exceed limit $MaxOfflineMessages")
}
if ($waitingDelivery -gt $MaxWaitingDelivery) {
  $alerts.Add("waiting delivery messages $waitingDelivery exceed limit $MaxWaitingDelivery")
}
if ($routeQueue -gt $MaxRouteQueue) {
  $alerts.Add("route queue $routeQueue exceeds limit $MaxRouteQueue")
}
if ($redisQueue -gt $MaxRedisQueue) {
  $alerts.Add("redis queue $redisQueue exceeds limit $MaxRedisQueue")
}

if ($alerts.Count -gt 0) {
  throw ("Operational alert: " + ($alerts -join "; "))
}

Write-Host "Operator health passed: status=$($health.status) offline=$offlineMessages waiting_delivery=$waitingDelivery route_queue=$routeQueue redis_queue=$redisQueue"
