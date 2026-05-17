# Project Structure

Messk is now split by runtime instead of by experiments:

- `mess/` is the deployable backend. Keep protocol changes here first, then mirror them into clients.
- `messk/` is the browser client. It should not depend on Tauri or desktop-only packages.
- `clients/core/` is the shared Rust protocol/core crate. It owns cross-client constants and pure retry/history logic that must stay UI-independent.
- `clients/windows/` is the native Windows app. It owns local SQLite state, DPAPI vaulting, native UI, and desktop packaging.
- `scripts/` contains repeatable operational commands. Prefer updating scripts over documenting one-off shell commands.
- `docs/` stores architecture notes, checklists, and migration decisions.

Removed legacy surfaces:

- `messkapk/` Flutter prototype.
- `messk/src-tauri/` Tauri wrapper.
- tracked release JSON from the old desktop packaging flow.
- unused Vite starter assets.

Current native-client storage contract:

- identity seed is DPAPI-protected per Windows user;
- ratchet sessions and prekey secrets are DPAPI-protected before SQLite write;
- messages and outbox are local SQLite records;
- panic reset deletes identity, sessions, prekeys, messages, and queued sends for the active account.

Protocol ownership:

- backend validates routed envelopes and remains the wire-contract source of truth;
- `clients/core/` mirrors the stable Rust-side contract for native clients;
- `messk/src/lib/protocolContract.ts` mirrors the same contract for the web client;
- direct control events that mutate an existing message must carry `target_msg_id`.
