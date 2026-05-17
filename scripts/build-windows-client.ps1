param(
  [ValidateSet("debug", "release")]
  [string]$Configuration = "debug",
  [switch]$RunTests
)

$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$coreRoot = Join-Path $root "clients\core"
$clientRoot = Join-Path $root "clients\windows"

if (-not (Test-Path -LiteralPath $coreRoot)) {
  throw "Shared Rust core project not found: $coreRoot"
}
if (-not (Test-Path -LiteralPath $clientRoot)) {
  throw "Windows client project not found: $clientRoot"
}

$args = @("build", "--manifest-path", (Join-Path $clientRoot "Cargo.toml"))
if ($Configuration -eq "release") {
  $args += "--release"
}

& cargo fmt --manifest-path (Join-Path $coreRoot "Cargo.toml") --check
if ($LASTEXITCODE -ne 0) {
  throw "Shared Rust core format check failed"
}

& cargo fmt --manifest-path (Join-Path $clientRoot "Cargo.toml") --check
if ($LASTEXITCODE -ne 0) {
  throw "Windows client format check failed"
}

if ($RunTests) {
  & cargo test --manifest-path (Join-Path $coreRoot "Cargo.toml")
  if ($LASTEXITCODE -ne 0) {
    throw "Shared Rust core tests failed"
  }
  & cargo test --manifest-path (Join-Path $clientRoot "Cargo.toml")
  if ($LASTEXITCODE -ne 0) {
    throw "Windows client tests failed"
  }
}

& cargo build --manifest-path (Join-Path $coreRoot "Cargo.toml")
if ($LASTEXITCODE -ne 0) {
  throw "Shared Rust core build failed"
}

& cargo @args
if ($LASTEXITCODE -ne 0) {
  throw "Windows client build failed"
}

$profile = if ($Configuration -eq "release") { "release" } else { "debug" }
$exe = Join-Path $clientRoot "target\$profile\messk-windows.exe"
Write-Host "Built $exe"
