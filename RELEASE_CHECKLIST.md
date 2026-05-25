# Release Checklist

## Before Shipping
- Set `VITE_BACKEND_URL`, `PORT`, `ALLOWED_ORIGINS`, `DB_PATH`, `MAX_UPLOAD_MB`, `ALLOWED_UPLOAD_MIME_TYPES`, and optional `REDIS_ADDR` for the target environment.
- Set `VITE_FALLBACK_BACKEND_URLS` when the web release should try static relay/bootstrap origins before relying on dynamic `/bootstrap` discovery.
- Run `powershell -ExecutionPolicy Bypass -File scripts/secret-scan.ps1`; the gate must pass before packaging or deploying.
- Change the tracked default `VITE_BACKEND_URL` with `scripts/configure-release.ps1` only when the product default origin itself changes; release builds receive their target origin at build time.
- Keep `ENABLE_METADATA_PROXY` disabled unless there is a reviewed production use case.
- Verify `powershell -ExecutionPolicy Bypass -File scripts/check-all.ps1` is green on the release commit.
- Run `powershell -ExecutionPolicy Bypass -File scripts/release-preflight.ps1 -BackendOrigin https://your-production-backend.example` before packaging a production release.
- Run `powershell -ExecutionPolicy Bypass -File scripts/release-build.ps1 -BackendOrigin https://your-production-backend.example` to create release artifacts.
- Use `-Channel stable` for promoted builds and `-Channel beta` for pre-release testing; release builds inject the selected backend origin without rewriting tracked configuration.
- Build and deploy only from a clean committed worktree; `-AllowDirtyTree` is for local diagnostic artifacts and sets `sourceDirty: true` in the manifest.
- Verify `dist/release-manifest.json` and `dist/SHA256SUMS.txt` with `scripts/verify-release-manifest.ps1`; publish the manifest alongside the release artifact.
- Run `powershell -ExecutionPolicy Bypass -File scripts/smoke-check.ps1` from the workspace root before tagging a release.
- Run `powershell -ExecutionPolicy Bypass -File scripts/backend-health-smoke.ps1` when validating a backend-only deploy.
- Run `powershell -ExecutionPolicy Bypass -File scripts/production-smoke.ps1 -BackendOrigin https://your-production-backend.example -ExpectedCommitPrefix <release-commit>` after DNS and nginx are live.
- Run `powershell -ExecutionPolicy Bypass -File scripts/docker-check.ps1` before shipping a containerized backend.
- Deploy the commit to staging with `scripts/deploy-vps.ps1 -Environment staging -StagingReportPath <report.json>`, storing the report outside the repository so the worktree stays clean; then use that report with `-Environment production -StagingReportPath <report.json>` for production. Both deployments require `-KeyFile <ssh-key> -HostPublicKey '<verified server host public key>'` (or `-KnownHostsFile <trusted-known-hosts>`).
- Confirm `clients/core` tests pass through `scripts/check-all.ps1`; native client protocol changes must not live only in the Windows UI shell.
- Confirm public `/health` returns `status: ok` or an explicitly accepted `status: degraded` and does not return protected operational counters.
- Confirm `/admin/health` is reachable only from loopback or with the configured `ADMIN_TOKEN`, then run `scripts/ops-health-check.ps1` through a loopback SSH tunnel.
- Confirm relay/bootstrap mode is intentional: `/relay/health` is reachable, `RELAY_ANNOUNCE_TOKEN` is configured for public announce, and `/relay/peers` contains only expected signed relay capabilities.
- Publish staging relay capabilities with `go run ./tools/relay-announce` using a signing key file outside the repository; use `-refresh-interval` or a systemd timer so registrations refresh before TTL expiry.
- For VPS deploys, confirm `messan-relay-announce.service` is active and `/bootstrap` plus `/relay/health` pass through nginx.
- Confirm relay revoke controls are current: `RELAY_MIN_REVOCATION_EPOCH`, `RELAY_REVOKED_NODES`, and `RELAY_REVOKED_PUBLIC_KEYS`.
- Confirm `/version` reports the expected release version, commit, and build timestamp.
- Confirm `/protocol` reports the expected wire version and a supported client-state version; verify both web and native clients show an update-required error for a mismatched state.
- Test login, reconnect, message send, offline delivery, file upload, backup export/import, and logout wipe on the release build.

## Security Checks
- Confirm upload/download access works only for authorized session holders or per-file tokens.
- Confirm encrypted uploads use an allowed MIME type, usually `application/octet-stream`.
- Confirm configured and bootstrap-discovered remote backend origins use HTTPS; only loopback may use HTTP for local tests.
- Confirm an attachment URL outside the trusted backend `/download/` route is rejected before any session header is sent.
- Confirm local logout clears IndexedDB and in-memory keys.
- Confirm backup export does not contain secret keys or ratchet session secrets.
- Confirm rate limiting and proxy restrictions are enabled in the deployed backend config.
- Confirm relay credentials, signing keys, VPS keys, and operator tokens are not committed or logged.
- Confirm direct `edit`, `delete`, `reaction`, `reply`, `pin`, and `unpin` envelopes include `target_msg_id` and never plaintext.
- Confirm metadata resistance remains active: direct ratchet payloads include encrypted padding, short batch windows do not break outbox retry, and `dummy` envelopes are online-only.
- Confirm mesh prototype code is disabled in production unless explicitly staged; `mesh_libp2p` must require `--features mesh-prototype`, and blind mesh envelopes must not include sender, recipient, plaintext, file keys, session secrets, or session tokens.

## UX Checks
- Confirm chat list search, message search, drafts, pins, reactions, edit/delete, and read receipts all behave correctly.
- Confirm call overlay handles reject, timeout, reconnect loss, and remote end cleanly.
- Confirm Windows without a realtime media engine does not initiate call offers and rejects incoming offers with `native_media_unavailable`.
- Confirm connection status banners are visible and understandable when the socket is not fully connected.

## Ops Checks
- Monitor backend logs for `request_start` and `request_end`, and check protected operational event counters for auth failures, rate-limit hits, websocket disconnects, and upload failures during staging smoke tests.
- Verify Redis is either healthy or intentionally absent with acceptable degraded behavior.
- Keep a tested rollback artifact for backend, web, and native Windows packages; rehearse `scripts/rollback-vps.ps1` in staging.
- Verify the VPS deploy script created and integrity-checked a fresh SQLite backup before switching `/opt/messan/current`.
