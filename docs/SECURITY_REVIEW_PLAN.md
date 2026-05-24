# Independent Security Review Plan

Messk must not be described as audited until an independent review is complete.
This file defines the evidence package and acceptance process for that review.

## Scope

- Identity creation, seed handling, verification fingerprints, and local vault.
- Direct-message ratchet and encrypted attachment/backup payloads.
- Backend authentication, authorization, offline/history storage, and uploads.
- Relay/bootstrap capability validation and metadata-resistance claims.
- Windows client parity, release artifacts, deployment, rollback, and secret
  handling.

## Required Evidence

- Protocol contract, threat model statements, and privacy guide.
- Reproducible test command output and SHA-256 release manifest.
- Staging deployment, smoke, rollback, backup verification, and incident
  exercise reports.
- Explicit list of known limitations, including native media and signed
  distribution status.

## Review Completion Criteria

1. Reviewer identity, scope, commit SHA, and methodology are recorded.
2. Critical and high findings are fixed or formally accepted with rationale.
3. Regression tests exist for corrected security boundaries.
4. A public summary states what was and was not reviewed.
5. Documentation changes only use the term audited after completion.
