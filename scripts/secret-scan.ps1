param(
  [switch]$TrackedOnly
)

$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$gitArgs = @("-C", $root, "ls-files", "--cached")
if (-not $TrackedOnly) {
  $gitArgs += @("--others", "--exclude-standard")
}

$relativeFiles = @(& git @gitArgs | Sort-Object -Unique)
if ($LASTEXITCODE -ne 0) {
  throw "Secret scan failed to enumerate git-visible files."
}

$sensitiveAssignments = @(
  "ADMIN_TOKEN",
  "RELAY_ANNOUNCE_TOKEN",
  "TURN_PASSWORD",
  "VITE_TURN_CREDENTIAL",
  "AWS_SECRET_ACCESS_KEY",
  "GITHUB_TOKEN",
  "SSH_PRIVATE_KEY"
)
$safeValuePattern = '^(?:|__[A-Za-z0-9_]+__|\\?\$\{[^}]+\}|\\?\$[A-Za-z_][A-Za-z0-9_]*|\\?\$\(.+|<[^>]+>|turn-password|relay-token|secret-token|test(?:-[A-Za-z0-9_-]+)?|example(?:-[A-Za-z0-9_-]+)?|change-?me|replace-?me|dummy(?:-[A-Za-z0-9_-]+)?)$'
$findings = [System.Collections.Generic.List[string]]::new()

foreach ($relativeFile in $relativeFiles) {
  $normalizedPath = $relativeFile.Replace("\", "/")
  if ($normalizedPath -match '(^|/)(id_(?:rsa|ecdsa|ed25519)|[^/]*_ed25519|[^/]*\.(?:pem|p12|pfx|key))$' -and -not $normalizedPath.EndsWith(".pub")) {
    $findings.Add("${relativeFile}: tracked private-key-like filename")
  }

  $fullPath = Join-Path $root $relativeFile
  if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    continue
  }

  try {
    $content = [System.IO.File]::ReadAllText($fullPath)
  } catch {
    continue
  }
  if ($content.Contains([char]0)) {
    continue
  }

  $lines = $content -split "`r?`n"
  for ($index = 0; $index -lt $lines.Length; $index++) {
    $line = $lines[$index]
    $lineNumber = $index + 1

    if ($line -match '-----BEGIN (?:OPENSSH |RSA |EC |DSA |PGP )?PRIVATE KEY-----') {
      $findings.Add("${relativeFile}:${lineNumber}: private key material")
    }
    if ($line -match '(?<![A-Za-z0-9])(?:gh[opusr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[0-9A-Z]{16})(?![A-Za-z0-9])') {
      $findings.Add("${relativeFile}:${lineNumber}: high-confidence access token")
    }
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
      $name = $Matches[1].ToUpperInvariant()
      if ($sensitiveAssignments -contains $name) {
        $value = $Matches[2].Trim().Trim("'`"")
        if ($value -notmatch $safeValuePattern) {
          $findings.Add("${relativeFile}:${lineNumber}: non-placeholder value assigned to $name")
        }
      }
    }
  }
}

if ($findings.Count -gt 0) {
  Write-Error ("Secret scan blocked the release:`n- " + ($findings -join "`n- "))
  throw "Remove sensitive material from git-visible files and rotate any exposed credentials."
}

Write-Host "Secret scan passed for $($relativeFiles.Count) git-visible files."
