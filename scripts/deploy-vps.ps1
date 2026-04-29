param(
  [Parameter(Mandatory = $true)]
  [Alias("Host")]
  [string]$ServerHost,

  [Parameter(Mandatory = $true)]
  [string]$Password,

  [string]$User = "root",
  [string]$Domain = "",
  [string]$LocalRoot = "",
  [int]$KeepReleases = 3
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($LocalRoot)) {
  $LocalRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

$LocalRoot = (Resolve-Path $LocalRoot).Path
$archivePath = Join-Path ([System.IO.Path]::GetTempPath()) "messan_deploy_bundle.tar.gz"
$remoteArchivePath = "/root/messan_deploy_bundle.tar.gz"
$remoteScriptPath = "/root/messan_run_deploy.sh"
$commitSHA = "archive-deploy"
try {
  $resolvedCommit = (& git -C $LocalRoot rev-parse --short=12 HEAD 2>$null).Trim()
  if (-not [string]::IsNullOrWhiteSpace($resolvedCommit)) {
    $commitSHA = $resolvedCommit
  }
} catch {
  $commitSHA = "archive-deploy"
}

& python -m pip install paramiko
if ($LASTEXITCODE -ne 0) {
  throw "Failed to ensure paramiko is installed"
}

$bundleScript = @"
import os
import tarfile

root = r'''$LocalRoot'''
out = r'''$archivePath'''
exclude_dirs = {'.git', 'node_modules', 'dist', 'target', '__pycache__', '.venv', 'venv'}
exclude_exact_files = {'.env', '.env.production', '.env.local'}
exclude_suffixes = ('.log', '.tar.gz')

if os.path.exists(out):
    os.remove(out)

with tarfile.open(out, 'w:gz') as tar:
    for folder, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in exclude_dirs]
        rel_folder = os.path.relpath(folder, root)
        for file_name in files:
            if file_name in exclude_exact_files:
                continue
            if file_name.endswith(exclude_suffixes):
                continue
            path = os.path.join(folder, file_name)
            rel = os.path.normpath(os.path.join('messan', rel_folder, file_name)) if rel_folder != '.' else os.path.join('messan', file_name)
            tar.add(path, arcname=rel)

print(out)
"@

& python -c $bundleScript
if ($LASTEXITCODE -ne 0) {
  throw "Failed to build deploy bundle"
}

$remoteDeployTemplate = @'
#!/usr/bin/env bash
set -euxo pipefail

RELEASE_ID=\$(date -u +%Y%m%dT%H%M%SZ)
APP_ROOT=/opt/messan
RELEASES_DIR=\$APP_ROOT/releases
RELEASE_DIR=\$RELEASES_DIR/\$RELEASE_ID
CURRENT_LINK=\$APP_ROOT/current
SHARED_DIR=\$APP_ROOT/shared
UPLOAD_DIR=/var/lib/messan/uploads
DB_PATH=/var/lib/messan/messenger.db
DOMAIN='__DOMAIN__'
KEEP_RELEASES=__KEEP_RELEASES__

mkdir -p \$RELEASES_DIR \$SHARED_DIR \$UPLOAD_DIR \$APP_ROOT/bin
touch \$DB_PATH

cat > /etc/sysctl.d/99-messan.conf <<'EOF'
fs.file-max = 100000
net.core.somaxconn = 4096
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_keepalive_time = 600
net.ipv4.tcp_tw_reuse = 1
EOF
sysctl --system || true

if [ ! -f \$SHARED_DIR/backend.env ]; then
  if [ -f \$APP_ROOT/app/mess/.env ]; then
    cp \$APP_ROOT/app/mess/.env \$SHARED_DIR/backend.env
  elif [ -L \$CURRENT_LINK ] && [ -f \$CURRENT_LINK/mess/.env ]; then
    cp \$CURRENT_LINK/mess/.env \$SHARED_DIR/backend.env
  else
    cat > \$SHARED_DIR/backend.env <<'EOF'
PORT=8080
ALLOWED_ORIGINS=http://__HOST__
DB_PATH=/var/lib/messan/messenger.db
UPLOAD_DIR=/var/lib/messan/uploads
MAX_UPLOAD_MB=80
ALLOWED_UPLOAD_MIME_TYPES=application/octet-stream
FILE_TOKEN_TTL_MINUTES=60
SESSION_TOKEN_TTL_MINUTES=1440
RATE_LIMIT_PER_MINUTE=200
REDIS_ADDR=127.0.0.1:6379
ENABLE_METADATA_PROXY=false
EOF
  fi
fi

if [ -n "\$DOMAIN" ]; then
  python3 - <<'PY'
from pathlib import Path
path = Path("/opt/messan/shared/backend.env")
content = path.read_text(encoding="utf-8")
lines = []
domain = "__DOMAIN__"
host = "__HOST__"
for line in content.splitlines():
    if line.startswith("ALLOWED_ORIGINS="):
        line = f"ALLOWED_ORIGINS=http://{host},http://{domain},https://{domain}"
    elif line.startswith("MAX_UPLOAD_MB="):
        line = "MAX_UPLOAD_MB=80"
    lines.append(line)
path.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
else
  python3 - <<'PY'
from pathlib import Path
path = Path("/opt/messan/shared/backend.env")
content = path.read_text(encoding="utf-8")
lines = []
for line in content.splitlines():
    if line.startswith("MAX_UPLOAD_MB="):
        line = "MAX_UPLOAD_MB=80"
    elif line.startswith("ALLOWED_ORIGINS="):
        values = [part.strip() for part in line.split("=", 1)[1].split(",") if part.strip()]
        host_origin = "http://__HOST__"
        if host_origin not in values:
            values.append(host_origin)
        line = "ALLOWED_ORIGINS=" + ",".join(values)
    lines.append(line)
path.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
fi

rm -rf \$RELEASE_DIR
mkdir -p \$RELEASE_DIR
tar -xzf __REMOTE_ARCHIVE__ -C \$RELEASE_DIR
mv \$RELEASE_DIR/messan \$RELEASE_DIR/source

ln -sf \$SHARED_DIR/backend.env \$RELEASE_DIR/source/mess/.env

apt-get update
apt-get install -y curl ca-certificates build-essential rsync nginx redis-server certbot python3-certbot-nginx

if ! command -v node >/dev/null 2>&1 || [ "\$(node -p "Number(process.versions.node.split('.')[0])")" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if ! command -v go >/dev/null 2>&1 || [ "\$(go env GOVERSION 2>/dev/null || true)" != "go1.26.2" ]; then
  cd /tmp
  curl -fsSL https://go.dev/dl/go1.26.2.linux-amd64.tar.gz -o go1.26.2.linux-amd64.tar.gz
  rm -rf /usr/local/go
  tar -C /usr/local -xzf go1.26.2.linux-amd64.tar.gz
  ln -sf /usr/local/go/bin/go /usr/local/bin/go
  ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt
fi

cd \$RELEASE_DIR/source/mess
TEST_TMP_DIR=\$(mktemp -d)
DB_PATH=\$TEST_TMP_DIR/test.db UPLOAD_DIR=\$TEST_TMP_DIR/uploads /usr/local/bin/go test ./...
rm -rf \$TEST_TMP_DIR
APP_VERSION=\$(node -p "JSON.parse(require('fs').readFileSync('\$RELEASE_DIR/source/messk/package.json','utf8')).version")
COMMIT_SHA=__COMMIT_SHA__
BUILD_TIME=\$(date -u +%Y-%m-%dT%H:%M:%SZ)
/usr/local/bin/go build -trimpath -ldflags="-s -w -X main.appVersion=\${APP_VERSION} -X main.commitSHA=\${COMMIT_SHA} -X main.buildTime=\${BUILD_TIME}" -o \$APP_ROOT/bin/messenger-server .

cd \$RELEASE_DIR/source/messk
npm ci
npm run build

ln -sfn \$RELEASE_DIR/source \$CURRENT_LINK

cat > /etc/systemd/system/messan.service <<'EOF'
[Unit]
Description=Messan Backend
After=network.target redis-server.service
Wants=redis-server.service

[Service]
Type=simple
WorkingDirectory=/opt/messan/current/mess
EnvironmentFile=/opt/messan/current/mess/.env
ExecStart=/opt/messan/bin/messenger-server
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/nginx/sites-available/messan <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name __DOMAIN__ __HOST__ _;

    root /opt/messan/current/messk/dist;
    index index.html;
    client_max_body_size 80M;
    keepalive_timeout 65;
    client_body_timeout 120s;
    send_timeout 120s;

    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Permissions-Policy "camera=(self), microphone=(self), geolocation=()" always;

    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_proxied any;
    gzip_comp_level 5;
    gzip_types
        text/plain
        text/css
        text/javascript
        application/javascript
        application/json
        application/xml
        image/svg+xml;

    etag on;

    location /assets/ {
        expires 30d;
        add_header Cache-Control "public, immutable";
        try_files \$uri =404;
    }

    location = /index.html {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
        expires -1;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location /ws {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }

    location /upload {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        client_max_body_size 80M;
        proxy_request_buffering off;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }

    location /download {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /profile {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /resolve {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /groups {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /channels {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /group-invite-links {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /channel-invite-links {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /invite-links {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /health {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /version {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

if [ -n "\$DOMAIN" ] && [ -f "/etc/letsencrypt/live/\$DOMAIN/fullchain.pem" ]; then
  python3 - <<'PY'
from pathlib import Path

domain = "__DOMAIN__"
path = Path("/etc/nginx/sites-available/messan")
content = path.read_text(encoding="utf-8")
if "listen 443 ssl" not in content:
    marker = "    listen [::]:80;\n"
    ssl_lines = (
        "    listen 443 ssl http2;\n"
        "    listen [::]:443 ssl http2;\n"
        f"    ssl_certificate /etc/letsencrypt/live/{domain}/fullchain.pem;\n"
        f"    ssl_certificate_key /etc/letsencrypt/live/{domain}/privkey.pem;\n"
        "    include /etc/letsencrypt/options-ssl-nginx.conf;\n"
        "    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;\n"
    )
    content = content.replace(marker, marker + ssl_lines, 1)
    path.write_text(content, encoding="utf-8")
PY
fi

rm -f /etc/nginx/sites-enabled/default
ln -sfn /etc/nginx/sites-available/messan /etc/nginx/sites-enabled/messan
nginx -t
systemctl daemon-reload
systemctl enable redis-server
systemctl restart redis-server
systemctl enable messan
systemctl restart messan
systemctl restart nginx

if [ -n "\$DOMAIN" ] && [ ! -f "/etc/letsencrypt/live/\$DOMAIN/fullchain.pem" ]; then
  certbot --nginx -d "\$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect || true
fi

cd \$RELEASES_DIR
ls -1dt */ | tail -n +\$((KEEP_RELEASES + 1)) | xargs -r rm -rf

curl -fsS http://127.0.0.1:8080/health
curl -fsS http://127.0.0.1:8080/version
'@

$remoteDeployScript = (
  $remoteDeployTemplate.Replace("__DOMAIN__", $Domain)
).Replace("__HOST__", $ServerHost).
  Replace("__COMMIT_SHA__", $commitSHA).
  Replace("__KEEP_RELEASES__", [string]$KeepReleases).
  Replace("__REMOTE_ARCHIVE__", $remoteArchivePath).
  Replace("\$", "$")

$remoteDeployScriptBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($remoteDeployScript))

$pythonDeployTemplate = @'
import paramiko
import sys
import base64

host = r'''__HOST__'''
user = r'''__USER__'''
password = r'''__PASSWORD__'''
local_archive = r'''__LOCAL_ARCHIVE__'''
remote_archive = r'''__REMOTE_ARCHIVE__'''
remote_script = r'''__REMOTE_SCRIPT__'''
remote_script_body = base64.b64decode(r'''__SCRIPT_B64__''').decode('utf-8')

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname=host, username=user, password=password, timeout=20, banner_timeout=60, auth_timeout=60)

sftp = client.open_sftp()
sftp.put(local_archive, remote_archive)
with sftp.open(remote_script, 'w') as fh:
    fh.write(remote_script_body)
sftp.chmod(remote_script, 0o755)
sftp.close()

stdin, stdout, stderr = client.exec_command("bash " + remote_script, get_pty=True)
output = stdout.read().decode('utf-8', errors='replace')
error_output = stderr.read().decode('utf-8', errors='replace')

sys.stdout.buffer.write(output.encode('utf-8', errors='replace'))
if error_output:
    sys.stdout.buffer.write(b"\\nSTDERR:\\n")
    sys.stdout.buffer.write(error_output.encode('utf-8', errors='replace'))

status = stdout.channel.recv_exit_status()
client.close()
raise SystemExit(status)
'@

$pythonDeploy = (
  $pythonDeployTemplate.Replace("__HOST__", $ServerHost)
).Replace("__USER__", $User).
  Replace("__PASSWORD__", $Password).
  Replace("__LOCAL_ARCHIVE__", $archivePath).
  Replace("__REMOTE_ARCHIVE__", $remoteArchivePath).
  Replace("__REMOTE_SCRIPT__", $remoteScriptPath).
  Replace("__SCRIPT_B64__", $remoteDeployScriptBase64)

$pythonDeployPath = Join-Path ([System.IO.Path]::GetTempPath()) "messan_run_deploy.py"
[System.IO.File]::WriteAllText($pythonDeployPath, $pythonDeploy, [System.Text.Encoding]::UTF8)

$deployExitCode = 0
try {
  & python $pythonDeployPath
  $deployExitCode = $LASTEXITCODE
} finally {
  Remove-Item -LiteralPath $pythonDeployPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
}

if ($deployExitCode -ne 0) {
  throw "Remote deploy failed"
}

Write-Host "Deploy completed successfully."
