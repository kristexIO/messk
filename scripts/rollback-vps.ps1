param(
  [Parameter(Mandatory = $true)]
  [Alias("Host")]
  [string]$ServerHost,

  [Parameter(Mandatory = $true)]
  [string]$KeyFile,

  [int]$Port = 22,
  [string]$KnownHostsFile = "",
  [string]$HostPublicKey = "",
  [string]$User = "root",
  [string]$Domain = "",
  [string]$ReleaseId = ""
)

$ErrorActionPreference = "Stop"
$temporaryKnownHostsPath = ""
$pythonRollbackPath = Join-Path ([System.IO.Path]::GetTempPath()) "messan_rollback_$([Guid]::NewGuid().ToString('N')).py"

if (-not [string]::IsNullOrWhiteSpace($ReleaseId) -and $ReleaseId -notmatch '^\d{8}T\d{6}Z$') {
  throw "ReleaseId must match the UTC release format YYYYMMDDTHHMMSSZ."
}

$KeyFile = (Resolve-Path $KeyFile).Path
if (-not [string]::IsNullOrWhiteSpace($KnownHostsFile) -and -not [string]::IsNullOrWhiteSpace($HostPublicKey)) {
  throw "Provide either -KnownHostsFile or -HostPublicKey, not both."
}
if (-not [string]::IsNullOrWhiteSpace($HostPublicKey)) {
  $HostPublicKey = $HostPublicKey.Trim()
  if ($HostPublicKey -notmatch '^ssh-ed25519\s+[A-Za-z0-9+/]+={0,2}(?:\s+\S+)?$') {
    throw "HostPublicKey must be an ssh-ed25519 public host key line."
  }
  $knownHostsHost = if ($Port -eq 22) { $ServerHost } else { "[$ServerHost]:$Port" }
  $temporaryKnownHostsPath = Join-Path ([System.IO.Path]::GetTempPath()) "messan_known_hosts_$([Guid]::NewGuid().ToString('N'))"
  [System.IO.File]::WriteAllText(
    $temporaryKnownHostsPath,
    "$knownHostsHost $HostPublicKey`n",
    [System.Text.UTF8Encoding]::new($false)
  )
  $KnownHostsFile = $temporaryKnownHostsPath
} elseif (-not [string]::IsNullOrWhiteSpace($KnownHostsFile)) {
  $KnownHostsFile = (Resolve-Path $KnownHostsFile).Path
} else {
  throw "Provide -HostPublicKey or -KnownHostsFile so the VPS SSH host key is verified before rollback."
}

& python -m pip install paramiko
if ($LASTEXITCODE -ne 0) {
  throw "Failed to ensure paramiko is installed"
}

$remoteRollbackTemplate = @'
#!/usr/bin/env bash
set -euo pipefail

APP_ROOT=/opt/messan
CURRENT_LINK=$APP_ROOT/current
RELEASES_DIR=$APP_ROOT/releases
REQUESTED_RELEASE='__RELEASE_ID__'

if [ ! -L "$CURRENT_LINK" ]; then
  echo "Current release symlink is missing." >&2
  exit 1
fi

CURRENT_TARGET=$(readlink -f "$CURRENT_LINK")
if [ -n "$REQUESTED_RELEASE" ]; then
  TARGET="$RELEASES_DIR/$REQUESTED_RELEASE/source"
else
  TARGET=$(find "$RELEASES_DIR" -mindepth 2 -maxdepth 2 -type d -name source -print | sort -r | grep -Fvx "$CURRENT_TARGET" | head -n 1 || true)
fi

if [ -z "$TARGET" ] || [ ! -d "$TARGET" ]; then
  echo "No rollback release is available." >&2
  exit 1
fi
if [ "$(readlink -f "$TARGET")" = "$CURRENT_TARGET" ]; then
  echo "Requested rollback target is already active." >&2
  exit 1
fi

ln -sfn "$TARGET" "$CURRENT_LINK"
systemctl restart messan
systemctl restart messan-relay-announce || true
systemctl restart nginx

curl -fsS http://127.0.0.1:8080/health >/dev/null
curl -fsS http://127.0.0.1:8080/version
curl -fsS http://127.0.0.1:8080/protocol >/dev/null
curl -fsS http://127.0.0.1:8080/relay/health >/dev/null
curl -fsS http://127.0.0.1:8080/bootstrap >/dev/null

printf '\nRolled back from %s to %s\n' "$CURRENT_TARGET" "$(readlink -f "$CURRENT_LINK")"
'@
$remoteRollback = $remoteRollbackTemplate.Replace("__RELEASE_ID__", $ReleaseId).Replace("`r`n", "`n").Replace("`r", "`n")
$remoteRollbackBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($remoteRollback))

$pythonRollbackTemplate = @'
import base64
import paramiko
import sys

host = r'''__HOST__'''
user = r'''__USER__'''
port = int(r'''__PORT__''')
key_file = r'''__KEY_FILE__'''
known_hosts_file = r'''__KNOWN_HOSTS_FILE__'''
remote_script = base64.b64decode(r'''__SCRIPT_B64__''').decode("utf-8")

client = paramiko.SSHClient()
client.load_host_keys(known_hosts_file)
client.set_missing_host_key_policy(paramiko.RejectPolicy())
client.connect(
    hostname=host,
    username=user,
    port=port,
    key_filename=key_file,
    timeout=20,
    banner_timeout=60,
    auth_timeout=60,
)
stdin, stdout, stderr = client.exec_command("bash -s", get_pty=True)
stdin.write(remote_script)
stdin.channel.shutdown_write()
output = stdout.read().decode("utf-8", errors="replace")
error_output = stderr.read().decode("utf-8", errors="replace")
sys.stdout.buffer.write(output.encode("utf-8", errors="replace"))
if error_output:
    sys.stdout.buffer.write(b"\nSTDERR:\n")
    sys.stdout.buffer.write(error_output.encode("utf-8", errors="replace"))
status = stdout.channel.recv_exit_status()
client.close()
raise SystemExit(status)
'@

$pythonRollback = (
  $pythonRollbackTemplate.Replace("__HOST__", $ServerHost)
).Replace("__USER__", $User).
  Replace("__PORT__", [string]$Port).
  Replace("__KEY_FILE__", $KeyFile).
  Replace("__KNOWN_HOSTS_FILE__", $KnownHostsFile).
  Replace("__SCRIPT_B64__", $remoteRollbackBase64)

try {
  [System.IO.File]::WriteAllText($pythonRollbackPath, $pythonRollback, [System.Text.Encoding]::UTF8)
  & python $pythonRollbackPath
  if ($LASTEXITCODE -ne 0) {
    throw "Remote rollback failed"
  }
} finally {
  Remove-Item -LiteralPath $pythonRollbackPath -Force -ErrorAction SilentlyContinue
  if (-not [string]::IsNullOrWhiteSpace($temporaryKnownHostsPath)) {
    Remove-Item -LiteralPath $temporaryKnownHostsPath -Force -ErrorAction SilentlyContinue
  }
}

if (-not [string]::IsNullOrWhiteSpace($Domain)) {
  & (Join-Path $PSScriptRoot "production-smoke.ps1") -BackendOrigin "https://$Domain"
  if ($LASTEXITCODE -ne 0) {
    throw "Post-rollback public smoke failed"
  }
}

Write-Host "Rollback completed successfully."
