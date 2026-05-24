# ADR 0001: Release Promotion And Protocol Compatibility Gates

## Status

Accepted on 2026-05-25.

## Context

Production promotion previously depended on operator discipline, and websocket
clients could receive only a generic connection failure when local state no
longer matched the backend.

## Decision

- The backend exposes a public `/protocol` descriptor with its wire protocol
  and accepted client-state versions.
- Web and native Windows clients check this descriptor before websocket
  authentication and present upgrade-required failures.
- A production VPS deployment requires a recent successful staging report for
  the exact commit being promoted.
- Release artifacts contain a SHA-256 manifest. It detects unintended changes
  when the manifest is independently distributed; it is not code signing.
- Release builds and VPS deployment reject a dirty git worktree so commit
  identity is not attached to uncommitted payloads; diagnostic builds are
  explicitly marked `sourceDirty`.

## Consequences

- Breaking state migrations must update the descriptor and all clients.
- An operator needs a distinct staging origin before production promotion.
- Signed Windows installers and independent audit remain separate blockers.
