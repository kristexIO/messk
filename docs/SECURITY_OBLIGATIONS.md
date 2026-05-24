# Messk Security Obligations

This register maps release-critical work from the improvement catalogue to
evidence in the repository. It is a status record, not an independent audit.

## Enforced In Main

| Obligation | State | Evidence |
| --- | --- | --- |
| Seed phrase confirmation before new identity use | Implemented | Web verification flow in `messk/src/pages/Auth.tsx`; native confirmation in `clients/windows/src/app.rs`. |
| Verified-contact key change warning | Implemented and regression-tested | Web fingerprint warning in `messk/src/pages/Chat.tsx`; public profile refresh preserves verification state in `messk/src/lib/socketApi.test.ts`. |
| Retry-safe offline encrypted delivery | Implemented | Backend dedupe/ack tests in `mess/hub_test.go`; protocol documentation in `docs/PROTOCOL_CONTRACT.md`. |
| Auth-bound sender normalization and protected admin endpoints | Implemented | Backend validation and tests in `mess/main_test.go`; `/admin/health` authorization. |
| Signed relay capabilities and revocation controls | Implemented for staging | `mess/relay_routes.go`, tests, and operator relay announcer. |
| Metadata-resistance foundations and gated mesh work | Implemented as staged foundations | `clients/core/src/metadata.rs`, `clients/core/src/mesh.rs`; mesh remains feature-gated. |

## Release Hardening Added

| Obligation | Control |
| --- | --- |
| Secrets outside git and release artifacts | `scripts/secret-scan.ps1` runs from local preflight/check-all and CI. It blocks private key material, high-confidence access tokens, tracked private-key filenames, and non-placeholder sensitive assignments. |
| VPS host authenticity | `scripts/deploy-vps.ps1` and `scripts/rollback-vps.ps1` require `-HostPublicKey` or a trusted `-KnownHostsFile`; unknown SSH host keys are rejected. |
| Restricted operational metrics | Public `/health` omits counters; `/admin/health` holds queue/upload/socket metrics behind token or loopback policy. |
| Queue-growth monitoring | `scripts/ops-health-check.ps1` validates protected metrics against operator thresholds. |
| Backup integrity | VPS deploy and the scheduled backup task fail when SQLite `PRAGMA quick_check` does not validate the fresh backup. |
| One-command rollback | `scripts/rollback-vps.ps1` activates a previous retained release through verified SSH and re-runs health smoke. |

## Still Blocking A Production Claim

| Obligation | Required evidence before marking done |
| --- | --- |
| Staging before production | Deploy to a separate staging node, run smoke and rollback rehearsal, and retain the report. |
| Signed Windows installer | Obtain a code-signing certificate, sign artifacts in a protected release workflow, and verify signatures on a clean machine. |
| Native audio and screen-share parity | Complete and test real Windows media transport, not only protocol/UI foundations. |
| External cryptographic/security review | Obtain an independent review; Messk must not be represented as audited before that result. |
| Live production deploy | Confirm VPS address/DNS, key-based SSH access, verified server host key, relay/admin configuration, and post-deploy smoke results. |

## Operator Gates

Run before a release candidate:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\secret-scan.ps1
powershell -ExecutionPolicy Bypass -File scripts\check-all.ps1
powershell -ExecutionPolicy Bypass -File scripts\release-preflight.ps1 -BackendOrigin https://messk.online
```

For production metrics, tunnel the protected loopback endpoint and evaluate
thresholds locally:

```powershell
ssh -L 18080:127.0.0.1:8080 -i $env:USERPROFILE\.ssh\messk_prod_ed25519 root@<server-host>
powershell -ExecutionPolicy Bypass -File scripts\ops-health-check.ps1 -BackendOrigin http://127.0.0.1:18080
```
