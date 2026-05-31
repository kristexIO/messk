param(
  [switch]$Update
)

$ErrorActionPreference = "Stop"

function Escape-Xml([object]$Value) {
  return [System.Security.SecurityElement]::Escape([string]$Value)
}

function Get-Viewport([string]$Name) {
  switch ($Name) {
    "mobile" { return [pscustomobject]@{ Width = 390; Height = 844; Label = "Mobile 390x844" } }
    "tablet" { return [pscustomobject]@{ Width = 820; Height = 1180; Label = "Tablet 820x1180" } }
    "desktop" { return [pscustomobject]@{ Width = 1440; Height = 900; Label = "Desktop 1440x900" } }
    default { throw "Unknown visual regression viewport '$Name'." }
  }
}

function Get-ToneColor([string]$Tone) {
  switch ($Tone) {
    "danger" { return "#fb7185" }
    "info" { return "#38bdf8" }
    "success" { return "#34d399" }
    "muted" { return "#94a3b8" }
    default { return "#cbd5e1" }
  }
}

function New-VisualBaselineSvg([pscustomobject]$Scenario) {
  $viewport = Get-Viewport $Scenario.viewport
  $width = [int]$viewport.Width
  $height = [int]$viewport.Height
  $padding = if ($Scenario.viewport -eq "mobile") { 24 } elseif ($Scenario.viewport -eq "tablet") { 48 } else { 64 }
  $headerHeight = if ($Scenario.viewport -eq "mobile") { 72 } else { 84 }
  $sidebarWidth = if ($Scenario.viewport -eq "desktop") { 300 } elseif ($Scenario.viewport -eq "tablet") { 220 } else { 0 }
  $contentX = $padding + $sidebarWidth + $(if ($sidebarWidth -gt 0) { 24 } else { 0 })
  $contentY = $headerHeight + $padding
  $contentWidth = $width - $contentX - $padding
  $panelHeight = $height - $contentY - $padding
  $accent = [string]$Scenario.accent
  $background = [string]$Scenario.background

  $lines = [System.Collections.Generic.List[string]]::new()
  $lines.Add('<?xml version="1.0" encoding="UTF-8"?>')
  $lines.Add(('<svg xmlns="http://www.w3.org/2000/svg" width="{0}" height="{1}" viewBox="0 0 {0} {1}" role="img" aria-label="{2} visual baseline">' -f $width, $height, (Escape-Xml $Scenario.title)))
  $lines.Add(('  <title>{0}</title>' -f (Escape-Xml $Scenario.title)))
  $lines.Add(('  <desc>{0}; {1}; state {2}; synthetic UI baseline with no private data.</desc>' -f (Escape-Xml $viewport.Label), (Escape-Xml $Scenario.density), (Escape-Xml $Scenario.state)))
  $lines.Add(('  <rect width="{0}" height="{1}" fill="{2}"/>' -f $width, $height, $background))
  $lines.Add(('  <rect x="0" y="0" width="{0}" height="{1}" fill="#0f172a" opacity="0.96"/>' -f $width, $headerHeight))
  $lines.Add(('  <circle cx="{0}" cy="{1}" r="14" fill="{2}"/>' -f $padding, [Math]::Floor($headerHeight / 2), $accent))
  $lines.Add(('  <text x="{0}" y="{1}" fill="#e5e7eb" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="20" font-weight="700">Messk</text>' -f ($padding + 28), ([Math]::Floor($headerHeight / 2) + 7)))
  $lines.Add(('  <rect x="{0}" y="{1}" width="128" height="28" rx="14" fill="#111827" stroke="{2}" stroke-opacity="0.56"/>' -f ($width - $padding - 128), ([Math]::Floor($headerHeight / 2) - 14), $accent))
  $lines.Add(('  <text x="{0}" y="{1}" fill="#cbd5e1" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="12">{2}</text>' -f ($width - $padding - 112), ([Math]::Floor($headerHeight / 2) + 5), (Escape-Xml $Scenario.viewport)))

  if ($sidebarWidth -gt 0) {
    $lines.Add(('  <rect x="{0}" y="{1}" width="{2}" height="{3}" rx="28" fill="#0b1220" stroke="#1f2937"/>' -f $padding, $contentY, $sidebarWidth, $panelHeight))
    $lines.Add(('  <text x="{0}" y="{1}" fill="#f8fafc" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="18" font-weight="700">Navigation</text>' -f ($padding + 28), ($contentY + 44)))
    for ($index = 0; $index -lt 4; $index++) {
      $itemY = $contentY + 74 + ($index * 58)
      $fill = if ($index -eq 0) { $accent } else { "#1f2937" }
      $opacity = if ($index -eq 0) { "0.18" } else { "0.72" }
      $lines.Add(('  <rect x="{0}" y="{1}" width="{2}" height="42" rx="14" fill="{3}" opacity="{4}"/>' -f ($padding + 20), $itemY, ($sidebarWidth - 40), $fill, $opacity))
      $lines.Add(('  <circle cx="{0}" cy="{1}" r="8" fill="{2}"/>' -f ($padding + 44), ($itemY + 21), $(if ($index -eq 0) { $accent } else { "#64748b" })))
      $lines.Add(('  <rect x="{0}" y="{1}" width="{2}" height="8" rx="4" fill="#cbd5e1" opacity="{3}"/>' -f ($padding + 62), ($itemY + 17), (95 + ($index * 16)), $(if ($index -eq 0) { "0.90" } else { "0.45" })))
    }
  }

  $lines.Add(('  <rect x="{0}" y="{1}" width="{2}" height="{3}" rx="32" fill="#0b1220" stroke="#1f2937"/>' -f $contentX, $contentY, $contentWidth, $panelHeight))
  $lines.Add(('  <rect x="{0}" y="{1}" width="{2}" height="6" rx="3" fill="{3}"/>' -f ($contentX + 32), ($contentY + 34), [Math]::Min(280, [Math]::Floor($contentWidth * 0.46)), $accent))
  $lines.Add(('  <text x="{0}" y="{1}" fill="#f8fafc" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="24" font-weight="800">{2}</text>' -f ($contentX + 32), ($contentY + 82), (Escape-Xml $Scenario.title)))
  $lines.Add(('  <text x="{0}" y="{1}" fill="#94a3b8" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="14">state: {2} | density: {3}</text>' -f ($contentX + 32), ($contentY + 110), (Escape-Xml $Scenario.state), (Escape-Xml $Scenario.density)))

  $cardY = $contentY + 148
  foreach ($card in @($Scenario.cards)) {
    $tone = Get-ToneColor $card.tone
    $barWidth = [Math]::Max(120, [Math]::Floor($contentWidth * ([int]$card.width / 100)))
    $lines.Add(('  <rect x="{0}" y="{1}" width="{2}" height="76" rx="22" fill="#111827" stroke="#1f2937"/>' -f ($contentX + 32), $cardY, ($contentWidth - 64)))
    $lines.Add(('  <rect x="{0}" y="{1}" width="6" height="44" rx="3" fill="{2}"/>' -f ($contentX + 56), ($cardY + 16), $tone))
    $lines.Add(('  <text x="{0}" y="{1}" fill="#e5e7eb" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="16" font-weight="700">{2}</text>' -f ($contentX + 78), ($cardY + 33), (Escape-Xml $card.label)))
    $lines.Add(('  <rect x="{0}" y="{1}" width="{2}" height="10" rx="5" fill="{3}" opacity="0.32"/>' -f ($contentX + 78), ($cardY + 48), $barWidth, $tone))
    $cardY += 96
  }

  $footerY = $height - $padding - 44
  $lines.Add(('  <rect x="{0}" y="{1}" width="{2}" height="44" rx="22" fill="#020617" stroke="{3}" stroke-opacity="0.38"/>' -f $contentX, $footerY, $contentWidth, $accent))
  $lines.Add(('  <text x="{0}" y="{1}" fill="#94a3b8" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="13">visual baseline | synthetic fixtures | no private data</text>' -f ($contentX + 24), ($footerY + 28)))
  $lines.Add('</svg>')

  return ($lines -join "`n") + "`n"
}

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$scenarioPath = Join-Path $root "messk\visual-regression\scenarios.json"
$baselineRoot = Join-Path $root "docs\visual-regression"

if (-not (Test-Path -LiteralPath $scenarioPath)) {
  throw "Visual regression scenario file is missing: $scenarioPath"
}

$definition = Get-Content -Raw -LiteralPath $scenarioPath | ConvertFrom-Json
if ([int]$definition.schemaVersion -ne 1) {
  throw "Unsupported visual regression scenario schema version '$($definition.schemaVersion)'."
}

if ($Update -and -not (Test-Path -LiteralPath $baselineRoot)) {
  New-Item -ItemType Directory -Force -Path $baselineRoot | Out-Null
}

$errors = [System.Collections.Generic.List[string]]::new()

foreach ($scenario in @($definition.scenarios)) {
  $svg = New-VisualBaselineSvg $scenario
  $baselineName = if ([string]::IsNullOrWhiteSpace([string]$scenario.baseline)) {
    "$($scenario.id).svg"
  } else {
    [string]$scenario.baseline
  }
  $baselinePath = Join-Path $baselineRoot $baselineName

  if ($Update) {
    [System.IO.File]::WriteAllText($baselinePath, $svg, [System.Text.UTF8Encoding]::new($false))
    Write-Host "Updated visual baseline: $baselineName"
    continue
  }

  if (-not (Test-Path -LiteralPath $baselinePath)) {
    $errors.Add("Missing visual baseline: $baselineName")
    continue
  }

  $existing = [System.IO.File]::ReadAllText($baselinePath)
  if ($existing -ne $svg) {
    $errors.Add("Outdated visual baseline: $baselineName")
  }
}

if ($errors.Count -gt 0) {
  foreach ($errorMessage in $errors) {
    Write-Error $errorMessage
  }
  Write-Error "Run scripts\visual-regression-baselines.ps1 -Update to refresh deterministic baselines."
  exit 1
}

Write-Host "Visual regression baselines verified."
