param(
  [Parameter(Mandatory = $true)]
  [Alias("Host")]
  [string]$ServerHost,

  [string]$Password = "",
  [string]$KeyFile = "",
  [int]$Port = 22,

  [string]$User = "root",
  [string]$Domain = "",
  [string]$LocalRoot = "",
  [int]$KeepReleases = 3,
  [string]$TurnHost = "",
  [string]$TurnUsername = "",
  [string]$TurnPassword = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Password) -and [string]::IsNullOrWhiteSpace($KeyFile)) {
  throw "Provide -KeyFile for SSH-key deploys, or -Password only for one-time bootstrap."
}

if (-not [string]::IsNullOrWhiteSpace($KeyFile)) {
  $KeyFile = (Resolve-Path $KeyFile).Path
} elseif (-not [string]::IsNullOrWhiteSpace($Password)) {
  Write-Warning "Password deploy is intended only for initial bootstrap. Prefer -KeyFile and disable SSH password login after rotation."
}

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
set -euo pipefail

RELEASE_ID=\$(date -u +%Y%m%dT%H%M%SZ)
APP_ROOT=/opt/messan
RELEASES_DIR=\$APP_ROOT/releases
RELEASE_DIR=\$RELEASES_DIR/\$RELEASE_ID
CURRENT_LINK=\$APP_ROOT/current
SHARED_DIR=\$APP_ROOT/shared
BACKUP_DIR=\$APP_ROOT/backups
PREVIOUS_RELEASE=""
UPLOAD_DIR=/var/lib/messan/uploads
DB_PATH=/var/lib/messan/messenger.db
DOMAIN='__DOMAIN__'
TURN_HOST='__TURN_HOST__'
TURN_USERNAME='__TURN_USERNAME__'
TURN_PASSWORD='__TURN_PASSWORD__'
KEEP_RELEASES=__KEEP_RELEASES__

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
trap 'rm -f __REMOTE_ARCHIVE__ __REMOTE_SCRIPT__' EXIT

mkdir -p \$RELEASES_DIR \$SHARED_DIR \$BACKUP_DIR \$UPLOAD_DIR \$APP_ROOT/bin
touch \$DB_PATH
if [ -L "\$CURRENT_LINK" ]; then
  PREVIOUS_RELEASE=\$(readlink -f "\$CURRENT_LINK" || true)
fi

if [ -z "\$TURN_HOST" ]; then
  if [ -n "\$DOMAIN" ]; then
    TURN_HOST="\$DOMAIN"
  else
    TURN_HOST="__HOST__"
  fi
fi

cat > /etc/sysctl.d/99-messan.conf <<'EOF'
fs.file-max = 200000
net.core.somaxconn = 8192
net.core.netdev_max_backlog = 16384
net.ipv4.tcp_max_syn_backlog = 8192
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_synack_retries = 3
net.ipv4.tcp_max_tw_buckets = 2000000
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_keepalive_time = 600
net.ipv4.tcp_tw_reuse = 1
net.ipv4.ip_local_port_range = 10240 65535
vm.swappiness = 10
EOF
sysctl --system || true

if ! swapon --show=NAME | grep -qx /swapfile; then
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile || true
fi
if ! grep -q '^/swapfile ' /etc/fstab; then
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if [ ! -f \$SHARED_DIR/backend.env ]; then
  if [ -f \$APP_ROOT/app/mess/.env ]; then
    cp \$APP_ROOT/app/mess/.env \$SHARED_DIR/backend.env
  elif [ -L \$CURRENT_LINK ] && [ -f \$CURRENT_LINK/mess/.env ]; then
    cp \$CURRENT_LINK/mess/.env \$SHARED_DIR/backend.env
  else
    cat > \$SHARED_DIR/backend.env <<'EOF'
PORT=8080
BIND_ADDR=127.0.0.1
ALLOWED_ORIGINS=http://__HOST__
DB_PATH=/var/lib/messan/messenger.db
UPLOAD_DIR=/var/lib/messan/uploads
MAX_UPLOAD_MB=80
ALLOWED_UPLOAD_MIME_TYPES=application/octet-stream
FILE_TOKEN_TTL_MINUTES=60
SESSION_TOKEN_TTL_MINUTES=1440
RATE_LIMIT_PER_MINUTE=200
REDIS_ADDR=127.0.0.1:6379
RELAY_ANNOUNCE_TOKEN=
RELAY_MAX_TTL_MINUTES=1440
RELAY_MAX_NODES=256
RELAY_MIN_REVOCATION_EPOCH=0
RELAY_REVOKED_NODES=
RELAY_REVOKED_PUBLIC_KEYS=
RELAY_ANNOUNCER_ENABLED=true
RELAY_ANNOUNCE_TARGET=http://127.0.0.1:8080
RELAY_NODE_ID=relay-__HOST__
RELAY_SIGNING_KEY_FILE=/opt/messan/shared/relay-ed25519.b64
RELAY_ENDPOINT_ORIGINS=http://__HOST__
RELAY_TRANSPORTS=central_ws,fallback_wss
RELAY_REGION_HINT=
RELAY_CAPACITY_CLASS=small
RELAY_TTL=12h
RELAY_REFRESH_INTERVAL=6h
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

python3 - <<'PY'
from pathlib import Path

path = Path("/opt/messan/shared/backend.env")
updates = {
    "PORT": "8080",
    "BIND_ADDR": "127.0.0.1",
    "DB_PATH": "/var/lib/messan/messenger.db",
    "UPLOAD_DIR": "/var/lib/messan/uploads",
    "MAX_UPLOAD_MB": "80",
    "ALLOWED_UPLOAD_MIME_TYPES": "application/octet-stream",
    "FILE_TOKEN_TTL_MINUTES": "60",
    "SESSION_TOKEN_TTL_MINUTES": "1440",
    "RATE_LIMIT_PER_MINUTE": "200",
    "REDIS_ADDR": "127.0.0.1:6379",
    "RELAY_MAX_TTL_MINUTES": "1440",
    "RELAY_MAX_NODES": "256",
    "ENABLE_METADATA_PROXY": "false",
}
lines = path.read_text(encoding="utf-8").splitlines()
seen = set()
out = []
for line in lines:
    if "=" not in line or line.lstrip().startswith("#"):
        out.append(line)
        continue
    key, _ = line.split("=", 1)
    key = key.strip()
    if key in updates:
        out.append(f"{key}={updates[key]}")
        seen.add(key)
    else:
        out.append(line)
for key, value in updates.items():
    if key not in seen:
        out.append(f"{key}={value}")
domain = "__DOMAIN__".strip()
host = "__HOST__".strip()
public_origin = f"https://{domain}" if domain else f"http://{host}"
node_source = domain or host or "local"
node_id = "relay-" + "".join(ch.lower() if ch.isalnum() or ch in "._-" else "-" for ch in node_source)
operator_defaults = {
    "RELAY_MIN_REVOCATION_EPOCH": "0",
    "RELAY_REVOKED_NODES": "",
    "RELAY_REVOKED_PUBLIC_KEYS": "",
    "RELAY_ANNOUNCER_ENABLED": "true",
    "RELAY_ANNOUNCE_TARGET": "http://127.0.0.1:8080",
    "RELAY_NODE_ID": node_id,
    "RELAY_SIGNING_KEY_FILE": "/opt/messan/shared/relay-ed25519.b64",
    "RELAY_ENDPOINT_ORIGINS": public_origin,
    "RELAY_TRANSPORTS": "central_ws,fallback_wss",
    "RELAY_REGION_HINT": "",
    "RELAY_CAPACITY_CLASS": "small",
    "RELAY_TTL": "12h",
    "RELAY_REFRESH_INTERVAL": "6h",
}
existing_keys = set()
for line in out:
    if "=" in line and not line.lstrip().startswith("#"):
        existing_keys.add(line.split("=", 1)[0].strip())
for key, value in operator_defaults.items():
    if key not in existing_keys:
        out.append(f"{key}={value}")
path.write_text("\n".join(out) + "\n", encoding="utf-8")
PY

if [ ! -f \$SHARED_DIR/turn.env ]; then
  if [ -z "\$TURN_USERNAME" ]; then
    TURN_USERNAME="messkturn"
  fi
  if [ -z "\$TURN_PASSWORD" ]; then
    TURN_PASSWORD=\$(python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(24))
PY
)
  fi
  cat > \$SHARED_DIR/turn.env <<EOF
TURN_PUBLIC_HOST=\$TURN_HOST
TURN_PORT=3478
TURNS_PORT=5349
TURN_USERNAME=\$TURN_USERNAME
TURN_PASSWORD=\$TURN_PASSWORD
TURN_MIN_PORT=49160
TURN_MAX_PORT=49200
EOF
fi

source \$SHARED_DIR/turn.env

rm -rf \$RELEASE_DIR
mkdir -p \$RELEASE_DIR
tar -xzf __REMOTE_ARCHIVE__ -C \$RELEASE_DIR
mv \$RELEASE_DIR/messan \$RELEASE_DIR/source

ln -sf \$SHARED_DIR/backend.env \$RELEASE_DIR/source/mess/.env

cat > \$RELEASE_DIR/source/messk/.env.production <<EOF
VITE_BACKEND_URL=$(if [ -n "\$DOMAIN" ]; then printf 'https://%s' "\$DOMAIN"; else printf 'http://%s' "__HOST__"; fi)
VITE_STUN_URLS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302,stun:stun2.l.google.com:19302,stun:global.stun.twilio.com:3478
VITE_TURN_URLS=turn:\${TURN_PUBLIC_HOST}:\${TURN_PORT}?transport=udp,turn:\${TURN_PUBLIC_HOST}:\${TURN_PORT}?transport=tcp,turns:\${TURN_PUBLIC_HOST}:\${TURNS_PORT}?transport=tcp
VITE_TURN_USERNAME=\${TURN_USERNAME}
VITE_TURN_CREDENTIAL=\${TURN_PASSWORD}
EOF

apt-get update
apt-get install -y curl ca-certificates build-essential rsync nginx redis-server certbot python3-certbot-nginx coturn sqlite3 ufw fail2ban

if [ -s "\$DB_PATH" ]; then
  sqlite3 "\$DB_PATH" ".backup '\$BACKUP_DIR/messenger-\$RELEASE_ID.db'" || cp "\$DB_PATH" "\$BACKUP_DIR/messenger-\$RELEASE_ID.db"
fi
if [ -f "\$SHARED_DIR/backend.env" ]; then
  cp "\$SHARED_DIR/backend.env" "\$BACKUP_DIR/backend-\$RELEASE_ID.env"
fi
if [ -f "\$SHARED_DIR/turn.env" ]; then
  cp "\$SHARED_DIR/turn.env" "\$BACKUP_DIR/turn-\$RELEASE_ID.env"
fi

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

cat > /etc/default/coturn <<'EOF'
TURNSERVER_ENABLED=1
EOF

mkdir -p /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/99-messan-hardening.conf <<'EOF'
LoginGraceTime 20
MaxAuthTries 3
MaxSessions 4
MaxStartups 10:30:60
ClientAliveInterval 300
ClientAliveCountMax 2
X11Forwarding no
AllowTcpForwarding no
AllowAgentForwarding no
EOF
if [ -s /root/.ssh/authorized_keys ]; then
  cat >> /etc/ssh/sshd_config.d/99-messan-hardening.conf <<'EOF'
PubkeyAuthentication yes
PasswordAuthentication no
PermitRootLogin prohibit-password
EOF
fi
sshd -t
systemctl reload ssh || systemctl reload sshd || true

render_turn_config() {
  cat > /etc/turnserver.conf <<EOF
listening-port=\${TURN_PORT}
tls-listening-port=\${TURNS_PORT}
listening-ip=0.0.0.0
external-ip=__HOST__
realm=\${TURN_PUBLIC_HOST}
server-name=\${TURN_PUBLIC_HOST}
fingerprint
lt-cred-mech
user=\${TURN_USERNAME}:\${TURN_PASSWORD}
total-quota=200
bps-capacity=0
stale-nonce=600
no-cli
no-loopback-peers
no-multicast-peers
min-port=\${TURN_MIN_PORT}
max-port=\${TURN_MAX_PORT}
log-file=/var/log/turnserver.log
simple-log
$(if [ -n "\$DOMAIN" ] && [ -f "/etc/letsencrypt/live/\$DOMAIN/fullchain.pem" ]; then printf 'cert=/etc/letsencrypt/live/%s/fullchain.pem\npkey=/etc/letsencrypt/live/%s/privkey.pem\n' "\$DOMAIN" "\$DOMAIN"; fi)
EOF
}

render_turn_config

cd \$RELEASE_DIR/source/mess
TEST_TMP_DIR=\$(mktemp -d)
DB_PATH=\$TEST_TMP_DIR/test.db UPLOAD_DIR=\$TEST_TMP_DIR/uploads /usr/local/bin/go test ./...
rm -rf \$TEST_TMP_DIR
APP_VERSION=\$(node -p "JSON.parse(require('fs').readFileSync('\$RELEASE_DIR/source/messk/package.json','utf8')).version")
COMMIT_SHA=__COMMIT_SHA__
BUILD_TIME=\$(date -u +%Y-%m-%dT%H:%M:%SZ)
/usr/local/bin/go build -trimpath -ldflags="-s -w -X main.appVersion=\${APP_VERSION} -X main.commitSHA=\${COMMIT_SHA} -X main.buildTime=\${BUILD_TIME}" -o \$APP_ROOT/bin/messenger-server .
/usr/local/bin/go build -trimpath -ldflags="-s -w" -o \$APP_ROOT/bin/relay-announce ./tools/relay-announce
chmod 0755 \$APP_ROOT/bin/messenger-server \$APP_ROOT/bin/relay-announce

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
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=full
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
MemoryDenyWriteExecute=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
SystemCallArchitectures=native
ReadWritePaths=/var/lib/messan /opt/messan

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/messan-relay-announce.service <<'EOF'
[Unit]
Description=Messan Relay Capability Announcer
After=network-online.target messan.service
Wants=network-online.target
Requires=messan.service

[Service]
Type=simple
WorkingDirectory=/opt/messan/current/mess
EnvironmentFile=/opt/messan/current/mess/.env
ExecStart=/bin/bash -lc 'if [ "${RELAY_ANNOUNCER_ENABLED:-false}" != "true" ]; then echo "relay announcer disabled"; exec sleep infinity; fi; interval="${RELAY_REFRESH_INTERVAL:-6h}"; if [ "$interval" = "0" ]; then interval="6h"; fi; exec /opt/messan/bin/relay-announce -generate-key -refresh-interval "$interval"'
Restart=always
RestartSec=30
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=full
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
MemoryDenyWriteExecute=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
SystemCallArchitectures=native
ReadWritePaths=/opt/messan/shared

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/cron.d/messan-backup <<'EOF'
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
17 3 * * * root mkdir -p /opt/messan/backups && sqlite3 /var/lib/messan/messenger.db ".backup '/opt/messan/backups/messenger-$(date -u +\%Y\%m\%dT\%H\%M\%SZ).db'" && find /opt/messan/backups -name 'messenger-*.db' -mtime +14 -delete
EOF

python3 - <<'PY'
from pathlib import Path
import re

path = Path("/etc/nginx/nginx.conf")
content = path.read_text(encoding="utf-8")
content = re.sub(r"worker_processes\s+[^;]+;", "worker_processes auto;", content, count=1)
if "worker_rlimit_nofile" not in content:
    content = content.replace("worker_processes auto;\n", "worker_processes auto;\nworker_rlimit_nofile 200000;\n", 1)
content = re.sub(
    r"events\s*\{[^}]*\}",
    "events {\n    worker_connections 8192;\n    multi_accept on;\n}",
    content,
    count=1,
    flags=re.S,
)
path.write_text(content, encoding="utf-8")
PY

cat > /etc/nginx/conf.d/messan-limits.conf <<'EOF'
server_tokens off;
client_body_timeout 30s;
client_header_timeout 10s;
keepalive_timeout 20s;
keepalive_requests 1000;
send_timeout 30s;
reset_timedout_connection on;

limit_req_status 429;
limit_conn_status 429;
limit_req_log_level error;
limit_conn_log_level error;

limit_conn_zone $binary_remote_addr zone=messan_conn:20m;
limit_req_zone $binary_remote_addr zone=messan_static:20m rate=60r/s;
limit_req_zone $binary_remote_addr zone=messan_api:20m rate=12r/s;
limit_req_zone $binary_remote_addr zone=messan_upload:10m rate=2r/s;
limit_req_zone $binary_remote_addr zone=messan_ws:10m rate=3r/s;

upstream messan_backend {
    server 127.0.0.1:8080 max_fails=3 fail_timeout=10s;
    keepalive 64;
}
EOF

cat > /etc/nginx/snippets/messan-proxy.conf <<'EOF'
proxy_pass http://messan_backend;
proxy_http_version 1.1;
proxy_set_header Connection "";
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host $host;
proxy_connect_timeout 5s;
proxy_send_timeout 60s;
proxy_read_timeout 60s;
proxy_buffering on;
proxy_buffers 32 16k;
proxy_busy_buffers_size 64k;
EOF

cat > /etc/nginx/snippets/messan-websocket-proxy.conf <<'EOF'
proxy_pass http://messan_backend;
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host $host;
proxy_connect_timeout 5s;
proxy_read_timeout 600s;
proxy_send_timeout 600s;
proxy_buffering off;
EOF

cat > /etc/nginx/sites-available/messan <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name __DOMAIN__ __HOST__ _;

    root /opt/messan/current/messk/dist;
    index index.html;
    client_max_body_size 80M;
    limit_conn messan_conn 60;

    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Permissions-Policy "camera=(self), microphone=(self), geolocation=()" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

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

    location = /ws {
        limit_conn messan_conn 20;
        limit_req zone=messan_ws burst=12 nodelay;
        include /etc/nginx/snippets/messan-websocket-proxy.conf;
    }

    location ^~ /ws/ {
        return 444;
    }

    location ^~ /upload {
        limit_req zone=messan_upload burst=8 nodelay;
        client_max_body_size 80M;
        client_body_timeout 60s;
        proxy_request_buffering on;
        include /etc/nginx/snippets/messan-proxy.conf;
    }

    location ^~ /download {
        limit_req zone=messan_api burst=80 nodelay;
        include /etc/nginx/snippets/messan-proxy.conf;
    }

    location = /health {
        limit_req zone=messan_api burst=30 nodelay;
        include /etc/nginx/snippets/messan-proxy.conf;
    }

    location = /version {
        limit_req zone=messan_api burst=30 nodelay;
        include /etc/nginx/snippets/messan-proxy.conf;
    }

    location = /bootstrap {
        limit_req zone=messan_api burst=30 nodelay;
        include /etc/nginx/snippets/messan-proxy.conf;
    }

    location = /peers {
        limit_req zone=messan_api burst=30 nodelay;
        include /etc/nginx/snippets/messan-proxy.conf;
    }

    location ^~ /relay/ {
        limit_req zone=messan_api burst=30 nodelay;
        include /etc/nginx/snippets/messan-proxy.conf;
    }

    location ^~ /admin/ {
        allow 127.0.0.1;
        allow ::1;
        deny all;
        include /etc/nginx/snippets/messan-proxy.conf;
    }

    location ~ ^/(profile|sessions|resolve|directory|history|groups|channels|group-invite-links|channel-invite-links|invite-links)(/|$) {
        limit_req zone=messan_api burst=80 nodelay;
        include /etc/nginx/snippets/messan-proxy.conf;
    }

    location ~* (^|/)(\.git|\.env|vendor/phpunit|wp-admin|wp-login\.php|xmlrpc\.php|setup\.php) {
        return 444;
    }

    location ~* \.(php|asp|aspx|jsp|cgi|pl|env|bak|old|orig|sql|ini|log|conf)$ {
        return 444;
    }

    location ^~ /assets/ {
        limit_req zone=messan_static burst=120 nodelay;
        expires 30d;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }

    location = /index.html {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
        expires -1;
    }

    location / {
        limit_req zone=messan_static burst=120 nodelay;
        try_files $uri $uri/ /index.html;
    }
}
EOF

mkdir -p /etc/systemd/system/nginx.service.d
cat > /etc/systemd/system/nginx.service.d/99-messan-limits.conf <<'EOF'
[Service]
LimitNOFILE=200000
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
systemctl enable coturn
systemctl restart coturn
systemctl enable messan
systemctl restart messan
systemctl enable messan-relay-announce
systemctl restart messan-relay-announce
systemctl restart nginx

if [ -n "\$DOMAIN" ] && [ ! -f "/etc/letsencrypt/live/\$DOMAIN/fullchain.pem" ]; then
  certbot --nginx -d "\$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect || true
fi

if [ -n "\$DOMAIN" ] && [ -f "/etc/letsencrypt/live/\$DOMAIN/fullchain.pem" ]; then
  render_turn_config
  systemctl restart coturn
fi

if command -v ufw >/dev/null 2>&1; then
  ufw default deny incoming || true
  ufw default allow outgoing || true
  ufw allow OpenSSH || true
  ufw allow 'Nginx Full' || true
  ufw allow 3478/tcp || true
  ufw allow 3478/udp || true
  ufw allow 5349/tcp || true
  ufw allow 49160:49200/tcp || true
  ufw allow 49160:49200/udp || true
  ufw deny 8080/tcp || true
  ufw --force enable || true
  ufw reload || true
fi

cat > /etc/fail2ban/filter.d/messan-nginx-limit.conf <<'EOF'
[Definition]
failregex = limiting requests, excess: .* by zone "messan_[^"]+", client: <HOST>,
            limiting connections by zone "messan_[^"]+", client: <HOST>,
ignoreregex =
EOF

cat > /etc/fail2ban/jail.d/messan.conf <<'EOF'
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h

[messan-nginx-limit]
enabled = true
filter = messan-nginx-limit
port = http,https
logpath = /var/log/nginx/error.log
maxretry = 30
findtime = 60
bantime = 1h

[recidive]
enabled = true
logpath = /var/log/fail2ban.log
maxretry = 5
findtime = 1d
bantime = 1w
EOF

systemctl enable fail2ban || true
systemctl restart fail2ban || systemctl start fail2ban || true

cd \$RELEASES_DIR
ls -1dt */ | tail -n +\$((KEEP_RELEASES + 1)) | xargs -r rm -rf

if ! curl -fsS http://127.0.0.1:8080/health; then
  if [ -n "\$PREVIOUS_RELEASE" ] && [ -d "\$PREVIOUS_RELEASE" ]; then
    ln -sfn "\$PREVIOUS_RELEASE" "\$CURRENT_LINK"
    systemctl restart messan || true
    systemctl restart nginx || true
  fi
  exit 1
fi
if ! curl -fsS http://127.0.0.1:8080/version; then
  if [ -n "\$PREVIOUS_RELEASE" ] && [ -d "\$PREVIOUS_RELEASE" ]; then
    ln -sfn "\$PREVIOUS_RELEASE" "\$CURRENT_LINK"
    systemctl restart messan || true
    systemctl restart nginx || true
  fi
  exit 1
fi
if ! curl -fsS http://127.0.0.1:8080/relay/health; then
  if [ -n "\$PREVIOUS_RELEASE" ] && [ -d "\$PREVIOUS_RELEASE" ]; then
    ln -sfn "\$PREVIOUS_RELEASE" "\$CURRENT_LINK"
    systemctl restart messan || true
    systemctl restart nginx || true
  fi
  exit 1
fi
if ! curl -fsS http://127.0.0.1:8080/bootstrap; then
  if [ -n "\$PREVIOUS_RELEASE" ] && [ -d "\$PREVIOUS_RELEASE" ]; then
    ln -sfn "\$PREVIOUS_RELEASE" "\$CURRENT_LINK"
    systemctl restart messan || true
    systemctl restart nginx || true
  fi
  exit 1
fi
systemctl is-active coturn
systemctl is-active messan-relay-announce
'@

$remoteDeployScript = (
  $remoteDeployTemplate.Replace("__DOMAIN__", $Domain)
).Replace("__HOST__", $ServerHost).
  Replace("__TURN_HOST__", $TurnHost).
  Replace("__TURN_USERNAME__", $TurnUsername).
  Replace("__TURN_PASSWORD__", $TurnPassword).
  Replace("__COMMIT_SHA__", $commitSHA).
  Replace("__KEEP_RELEASES__", [string]$KeepReleases).
  Replace("__REMOTE_ARCHIVE__", $remoteArchivePath).
  Replace("__REMOTE_SCRIPT__", $remoteScriptPath).
  Replace("\$", "$")
$remoteDeployScript = $remoteDeployScript.Replace("`r`n", "`n").Replace("`r", "`n")

$remoteDeployScriptBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($remoteDeployScript))

$pythonDeployTemplate = @'
import paramiko
import sys
import base64

host = r'''__HOST__'''
user = r'''__USER__'''
port = int(r'''__PORT__''')
password = r'''__PASSWORD__'''
key_file = r'''__KEY_FILE__'''
local_archive = r'''__LOCAL_ARCHIVE__'''
remote_archive = r'''__REMOTE_ARCHIVE__'''
remote_script = r'''__REMOTE_SCRIPT__'''
remote_script_body = base64.b64decode(r'''__SCRIPT_B64__''').decode('utf-8')

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
connect_kwargs = {
    "hostname": host,
    "username": user,
    "port": port,
    "timeout": 20,
    "banner_timeout": 60,
    "auth_timeout": 60,
}
if key_file:
    connect_kwargs["key_filename"] = key_file
if password:
    connect_kwargs["password"] = password
client.connect(**connect_kwargs)

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
  Replace("__PORT__", [string]$Port).
  Replace("__PASSWORD__", $Password).
  Replace("__KEY_FILE__", $KeyFile).
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
