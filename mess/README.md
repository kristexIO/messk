# E2EE Messenger Backend

## Configuration

Copy `.env.example` into your deployment environment and set these values:

- `PORT`: HTTP port, default `8080`.
- `ALLOWED_ORIGINS`: comma-separated browser origins allowed by CORS.
- `DB_PATH`: SQLite database path, default `messenger.db`.
- `UPLOAD_DIR`: encrypted attachment storage directory, default `uploads`.
- `MAX_UPLOAD_MB`: maximum encrypted attachment size in MB.
- `ALLOWED_UPLOAD_MIME_TYPES`: comma-separated upload MIME allowlist. The default encrypted attachment MIME is `application/octet-stream`.
- `FILE_TOKEN_TTL_MINUTES`: lifetime for per-file download links, default `60`.
- `SESSION_TOKEN_TTL_MINUTES`: lifetime for websocket-issued session tokens, default `1440`.
- `RATE_LIMIT_PER_MINUTE`: upload/proxy request limit per client IP, default `200`.
- `REDIS_ADDR`: optional Redis address for multi-instance routing.
- `ENABLE_METADATA_PROXY`: keep `false` for production unless the proxy is explicitly reviewed and needed.

## Local Checks

```powershell
go test ./...
```

## Docker

```powershell
docker compose up --build
```

The compose file stores SQLite data and uploads in Docker volumes.

## HTTP API

- `GET /health`: service health for DB/cache/Redis.
- `GET /version`: build metadata.
- `GET/POST /profile`: save and load public profile data (`nickname`, `avatar`).
- `GET/POST /groups`: list your groups or create a new group.
- `GET/POST /groups/{groupId}/members`: list or add group members.
- `GET/POST /channels`: list your channels or create a new channel.
- `GET/POST /channels/{channelId}/subscribers`: list or add channel subscribers.

All endpoints except `/health` and `/version` require `X-Session-Token` or `Authorization: Bearer <token>`.

## Manual Deploy

Minimal Linux deploy flow:

```bash
git clone <your-repo-url> messan
cd messan/mess
go test ./...
go build -o messenger-server .
export PORT=8080
export ALLOWED_ORIGINS=https://your-frontend-domain.example
export DB_PATH=/var/lib/messenger/messenger.db
export UPLOAD_DIR=/var/lib/messenger/uploads
export REDIS_ADDR=127.0.0.1:6379
./messenger-server
```

If you want a simple reverse proxy, put Nginx in front of it and proxy:

- `/ws` with websocket upgrade headers
- `/upload`, `/download`, `/profile`, `/groups`, `/channels`
- `/health` and `/version` for checks

## Release Notes

- `/health` reports database, cache, and Redis status.
- `/version` reports the backend version, commit, and build timestamp embedded at build time.
- Upload/download endpoints require an authenticated session or per-file token.
- `/proxy` is disabled by default and blocks private, loopback, link-local, multicast, unspecified, and unresolved targets.
- Responses include baseline security headers such as `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and HTTPS-only HSTS.
