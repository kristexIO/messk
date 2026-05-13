# Release Checklist

## Before Shipping
- Set `VITE_BACKEND_URL`, `PORT`, `ALLOWED_ORIGINS`, `DB_PATH`, `MAX_UPLOAD_MB`, `ALLOWED_UPLOAD_MIME_TYPES`, and optional `REDIS_ADDR` for the target environment.
- Run `powershell -ExecutionPolicy Bypass -File scripts/configure-release.ps1 -BackendOrigin https://your-production-backend.example` to sync `VITE_BACKEND_URL` with the production backend origin.
- Keep `ENABLE_METADATA_PROXY` disabled unless there is a reviewed production use case.
- Verify `powershell -ExecutionPolicy Bypass -File scripts/check-all.ps1` is green on the release commit.
- Run `powershell -ExecutionPolicy Bypass -File scripts/release-preflight.ps1 -BackendOrigin https://your-production-backend.example` before packaging a production release.
- Run `powershell -ExecutionPolicy Bypass -File scripts/release-build.ps1 -BackendOrigin https://your-production-backend.example` to create release artifacts.
- Run `powershell -ExecutionPolicy Bypass -File scripts/smoke-check.ps1` from the workspace root before tagging a release.
- Run `powershell -ExecutionPolicy Bypass -File scripts/backend-health-smoke.ps1` when validating a backend-only deploy.
- Run `powershell -ExecutionPolicy Bypass -File scripts/docker-check.ps1` before shipping a containerized backend.
- Confirm `/health` returns `status: ok` or an explicitly accepted `status: degraded`.
- Confirm `/version` reports the expected release version, commit, and build timestamp.
- Test login, reconnect, message send, offline delivery, file upload, backup export/import, and logout wipe on the release build.

## Security Checks
- Confirm upload/download access works only for authorized session holders or per-file tokens.
- Confirm encrypted uploads use an allowed MIME type, usually `application/octet-stream`.
- Confirm local logout clears IndexedDB and in-memory keys.
- Confirm backup export does not contain secret keys or ratchet session secrets.
- Confirm rate limiting and proxy restrictions are enabled in the deployed backend config.

## UX Checks
- Confirm chat list search, message search, drafts, pins, reactions, edit/delete, and read receipts all behave correctly.
- Confirm call overlay handles reject, timeout, reconnect loss, and remote end cleanly.
- Confirm connection status banners are visible and understandable when the socket is not fully connected.

## Ops Checks
- Monitor backend logs for `request_start`, `request_end`, auth failures, and offline message saves during staging smoke tests.
- Verify Redis is either healthy or intentionally absent with acceptable degraded behavior.
- Keep a tested rollback artifact for backend, web, and native Windows packages.
