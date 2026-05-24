param(
  [Parameter(Mandatory = $true)]
  [string]$ReportPath,

  [Parameter(Mandatory = $true)]
  [string]$Commit,

  [string]$ProductionOrigin = "",
  [int]$MaxAgeHours = 24
)

$ErrorActionPreference = "Stop"

if ($MaxAgeHours -lt 1) {
  throw "MaxAgeHours must be positive."
}
$resolvedReport = (Resolve-Path -LiteralPath $ReportPath).Path
$report = Get-Content -Raw -LiteralPath $resolvedReport | ConvertFrom-Json
if ($report.schemaVersion -ne 1 -or $report.environment -ne "staging" -or $report.status -ne "passed") {
  throw "Staging evidence report is not a passed staging validation."
}
if ($report.testedCommit -ne $Commit) {
  throw "Staging evidence is for commit '$($report.testedCommit)', expected '$Commit'."
}
if ([string]::IsNullOrWhiteSpace($report.origin)) {
  throw "Staging evidence does not identify the tested origin."
}
if (-not [string]::IsNullOrWhiteSpace($ProductionOrigin) -and $report.origin.TrimEnd("/") -eq $ProductionOrigin.TrimEnd("/")) {
  throw "Staging evidence cannot be collected from the production origin."
}

$verifiedAt = [DateTimeOffset]::MinValue
if (-not [DateTimeOffset]::TryParse([string]$report.verifiedAt, [ref]$verifiedAt)) {
  throw "Staging evidence has an invalid verification timestamp."
}
$age = [DateTimeOffset]::UtcNow - $verifiedAt.ToUniversalTime()
if ($age.TotalSeconds -lt -300 -or $age.TotalHours -gt $MaxAgeHours) {
  throw "Staging evidence is outside the allowed age window of $MaxAgeHours hours."
}

Write-Host "Staging evidence accepted for commit $Commit from $($report.origin)."
