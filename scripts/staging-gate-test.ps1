$ErrorActionPreference = "Stop"

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) "messk_staging_test_$([Guid]::NewGuid().ToString('N'))"
$reportPath = Join-Path $testRoot "report.json"
$commit = "0123456789abcdef"
$encoding = [System.Text.UTF8Encoding]::new($false)

try {
  New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
  $valid = [ordered]@{
    schemaVersion = 1
    environment = "staging"
    status = "passed"
    origin = "https://staging.messk.example"
    testedCommit = $commit
    verifiedAt = [DateTimeOffset]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
  }
  [System.IO.File]::WriteAllText($reportPath, ($valid | ConvertTo-Json) + "`n", $encoding)
  & (Join-Path $PSScriptRoot "assert-staging-evidence.ps1") `
    -ReportPath $reportPath `
    -Commit $commit `
    -ProductionOrigin "https://messk.online"

  $valid.verifiedAt = [DateTimeOffset]::UtcNow.AddDays(-2).ToString("yyyy-MM-ddTHH:mm:ssZ")
  [System.IO.File]::WriteAllText($reportPath, ($valid | ConvertTo-Json) + "`n", $encoding)
  $rejected = $false
  try {
    & (Join-Path $PSScriptRoot "assert-staging-evidence.ps1") -ReportPath $reportPath -Commit $commit 2>$null
  } catch {
    $rejected = $true
  }
  if (-not $rejected) {
    throw "Staging gate test did not reject expired evidence."
  }
} finally {
  if (Test-Path -LiteralPath $testRoot) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force
  }
}

Write-Host "Staging evidence gate test passed."
