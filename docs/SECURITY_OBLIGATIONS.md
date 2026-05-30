# Messk Security Obligations

This register maps release-critical work from the improvement catalogue to
evidence in the repository. It is a status record, not an independent audit.

## Enforced In Main

| Obligation | State | Evidence |
| --- | --- | --- |
| Seed phrase confirmation before new identity use | Implemented | Web verification flow in `messk/src/pages/Auth.tsx`; native confirmation in `clients/windows/src/app.rs`. |
| Local key status without secret exposure | Implemented and regression-tested | Settings renders `messk/src/lib/localKeyStatus.ts` posture items for unlocked identity, PIN, restore, database scope, and auto-lock without exposing raw seed or secret-key values. |
| Verified-contact key change warning | Implemented and regression-tested | Web fingerprint warning in `messk/src/pages/Chat.tsx`; public profile refresh preserves verification state in `messk/src/lib/socketApi.test.ts`. |
| Panic reset with confirmed local wipe | Implemented and regression-tested | Settings requires typing `RESET`; `messk/src/lib/panicReset.ts` removes Messk localStorage keys and all Messk IndexedDB databases while preserving unrelated origin data. |
| Retry-safe offline encrypted delivery | Implemented | Backend dedupe/ack tests in `mess/hub_test.go`; protocol documentation in `docs/PROTOCOL_CONTRACT.md`. |
| Reliable delivery status visualization | Implemented and regression-tested | `messk/src/lib/deliveryStatus.ts` provides one direct/group status contract for pending, sent, delivered, read, distributed, and failed states. |
| Auth-bound sender normalization and protected admin endpoints | Implemented | Backend validation and tests in `mess/main_test.go`; `/admin/health` authorization. |
| Signed relay capabilities and revocation controls | Implemented for staging | `mess/relay_routes.go`, tests, and operator relay announcer. |
| Metadata-resistance foundations and gated mesh work | Implemented as staged foundations | `clients/core/src/metadata.rs`, `clients/core/src/mesh.rs`; mesh remains feature-gated. |
| Public security claims and plain-language threat model | Implemented | Pre-auth web route `/trust` separates implemented controls, experimental work, production blockers, and relay-visible metadata; its contract is regression-tested in `messk/src/lib/trustCenter.test.ts`. |

## Release Hardening Added

| Obligation | Control |
| --- | --- |
| Secrets outside git and release artifacts | `scripts/secret-scan.ps1` runs from local preflight/check-all and CI. It blocks private key material, high-confidence access tokens, tracked private-key filenames, and non-placeholder sensitive assignments. |
| VPS host authenticity | `scripts/deploy-vps.ps1` and `scripts/rollback-vps.ps1` require `-HostPublicKey` or a trusted `-KnownHostsFile`; unknown SSH host keys are rejected. |
| Restricted operational metrics | Public `/health` omits counters; `/admin/health` holds queue/upload/socket metrics behind token or loopback policy. |
| Queue and process-event monitoring | `scripts/ops-health-check.ps1` validates protected queue thresholds and surfaces privacy-bounded rate-limit, disconnect, and upload failure counters. |
| Backup integrity | VPS deploy and the scheduled backup task fail when SQLite `PRAGMA quick_check` does not validate the fresh backup. |
| One-command rollback | `scripts/rollback-vps.ps1` activates a previous retained release through verified SSH and re-runs health smoke. |
| Staging-before-production enforcement | `scripts/staging-verify.ps1` records smoke evidence for a commit; production `scripts/deploy-vps.ps1` rejects missing, expired, production-origin, or mismatched evidence. |
| Protocol compatibility visibility | `/protocol` advertises the supported client state; web and Windows clients reject incompatible websocket connection attempts with an actionable upgrade message. |
| Transport and download-token downgrade protection | Web and Windows accept remote backend/bootstrap origins only over HTTPS; loopback HTTP remains available for local development. Attachment requests are restricted to trusted `/download/` routes before session headers are attached, and tests reject changed ciphertext. |
| Secret lifetime reduction | Windows X3DH and ratchet state use zeroization-on-drop, wipe decrypted persistence buffers, and clear seed UI copies; web seed derivation, direct/X3DH, ratchet, group sender-key, PIN vault, local vault, attachment, and encrypted-backup paths wipe mutable temporary key/plaintext buffers after use. Browser string/runtime copies remain a platform limitation. |
| Versioned encrypted backup manifest | `messk/src/lib/backup.ts` emits `messk.encrypted-backup.v2` metadata with counts and explicit exclusions for identity seed, secret key, ratchet sessions, prekeys, and group sender keys. |
| Artifact tamper detection and source binding | `scripts/release-build.ps1` emits a SHA-256 release manifest and rejects dirty release sources by default; `scripts/verify-release-manifest.ps1` verifies packaged payloads. VPS deploy rejects dirty worktrees. |
| Release governance and privacy disclosure | `.github/CODEOWNERS`, `.github/release.yml`, `docs/PRIVACY_GUIDE.md`, `docs/SECURITY_REVIEW_PLAN.md`, and ADR 0001 establish an ownership map, generated release-note categories, user disclosure, and independent-review scope. Requiring owner approval still depends on GitHub branch protection settings. |
| Stable/beta and EOL contract | `scripts/release-build.ps1 -Channel <stable|beta>` records the channel in manifests; `docs/SUPPORTED_VERSIONS.md` publishes compatibility and retirement rules. |

## Still Blocking A Production Claim

| Obligation | Required evidence before marking done |
| --- | --- |
| Staging exercise evidence | The automated gate is implemented; deploy to a separate staging node, run smoke and rollback rehearsal, and retain its generated report before production. |
| Signed Windows installer | Obtain a code-signing certificate, sign artifacts in a protected release workflow, and verify signatures on a clean machine. |
| Native audio and screen-share parity | Voice-message recording exists, but realtime Windows media is not implemented. Windows now fails closed instead of initiating signal-only calls and rejects incoming offers with `native_media_unavailable`; complete and test actual audio/video/screen media transport before claiming parity. |
| External cryptographic/security review | Obtain an independent review; Messk must not be represented as audited before that result. |
| Live production deploy | Confirm VPS address/DNS, key-based SSH access, verified server host key, relay/admin configuration, and post-deploy smoke results. |

## Operator Gates

Run before a release candidate:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\secret-scan.ps1
powershell -ExecutionPolicy Bypass -File scripts\check-all.ps1
powershell -ExecutionPolicy Bypass -File scripts\release-preflight.ps1 -BackendOrigin https://messk.online
```

Build artifacts with their checksum manifest:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\release-build.ps1 -BackendOrigin https://staging.example
powershell -ExecutionPolicy Bypass -File scripts\verify-release-manifest.ps1 -ArtifactRoot dist
```

For production metrics, tunnel the protected loopback endpoint and evaluate
thresholds locally:

```powershell
ssh -L 18080:127.0.0.1:8080 -i $env:USERPROFILE\.ssh\messk_prod_ed25519 root@<server-host>
powershell -ExecutionPolicy Bypass -File scripts\ops-health-check.ps1 -BackendOrigin http://127.0.0.1:18080
```
