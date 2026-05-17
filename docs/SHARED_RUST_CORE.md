# Shared Rust Core

`clients/core/` is the migration path from a Windows-only native client to a
multi-platform native Messk stack.

## Current Scope

The crate currently contains pure, UI-free rules:

- protocol event names and envelope requirements;
- direct history cursor bounds;
- retry timing for outbox resend;
- local schema version trait.

These modules compile and test without egui, Windows APIs, SQLite, or networking.

## Extraction Rule

Move code from `clients/windows/` to `clients/core/` only when it satisfies all
of these constraints:

- no direct egui dependency;
- no DPAPI or Windows filesystem dependency;
- deterministic unit tests can run without a backend;
- wire behavior is already accepted by backend tests and web tests.

## Next Moves

1. Move protocol envelope builders from `clients/windows/src/protocol.rs`.
2. Move outbox retry state transitions from `clients/windows/src/net.rs`.
3. Move history sync cursor and dedupe logic.
4. Move identity and ratchet behind platform-neutral secret-storage traits.
5. Add FFI only after the native Rust API is stable.
