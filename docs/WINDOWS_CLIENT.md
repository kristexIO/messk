# Windows Client Direction

The Windows client is moving to a native Rust implementation.

Goals:

- no WebView runtime;
- protocol compatibility with the existing Go backend;
- memory-conscious crypto code with explicit secret ownership;
- reusable core for later Android/iOS bindings;
- native Windows packaging once messaging is stable.

Repository layout:

- `mess/` - Go backend, kept as the server source of truth.
- `messk/` - web client kept temporarily as protocol/UI reference.
- `clients/windows/` - new native Rust Windows client.

Removed legacy clients:

- `messkapk/` Flutter client;
- `messk/src-tauri/` Tauri/WebView wrapper.

The first working milestone now includes native authentication and first-pass direct messaging:

1. seed and identity compatibility;
2. NaCl box challenge auth;
3. X3DH root-key derivation;
4. initial double-ratchet direct send;
5. live direct receive with `delivery_receipt` and `offline_ack`;
6. backend `clear_prekeys` cleanup for stale server one-time prekeys after account migration;
7. SQLite local store for messages, ratchet sessions, prekeys, and direct retry outbox;
8. DPAPI-protected identity seed/session/prekey persistence for the current Windows user;
9. persisted `upload_prekeys` with backend `clear_prekeys` cleanup for stale server one-time prekeys;
10. retry backoff and local panic reset for native client state.

Next implementation order:

1. contact list and chat routing by username;
2. richer delivery history and message status UI;
3. media/files and notifications;
4. tray, auto-start, and installer;
5. shared Rust core extraction for future mobile clients.
