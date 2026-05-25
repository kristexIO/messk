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
- `clients/core/` - shared Rust core for protocol constants, retry decisions, history cursor rules, and future crypto/session extraction.
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
11. encrypted file upload/download through the backend upload routes;
12. drag-and-drop file send for the active direct chat.

Current productionization track:

1. keep `clients/core/` free of egui, Windows APIs, and filesystem assumptions;
2. move identity, ratchet, protocol serialization, outbox retry, and history sync into `clients/core/` only after the matching tests are green;
3. keep `clients/windows/` as the egui shell over the core plus platform features such as DPAPI, notifications, tray, installer, and app paths;
4. keep every new message action represented in backend tests, web protocol tests, and Rust core tests before expanding UI.

Transport resilience:

- Settings support one primary backend origin plus newline-separated fallback origins.
- The client normalizes and dedupes origins through `clients/core::transport`.
- Before health checks and websocket auth, the client queries `/bootstrap` on
  configured origins and merges signed relay `endpointOrigins` that advertise
  `central_ws` or `fallback_wss`.
- Health checks, realtime auth, outbox retry, direct sends, uploads, downloads,
  profile sync, and username lookup try the configured origins in order.
- Outbox remains local and authoritative, so failed sends stay queued when every
  configured origin is unavailable.

Metadata resistance:

- Direct ratchet plaintext uses the shared core padding buckets before
  secretbox encryption, while decrypt still returns only the user-visible text.
- Direct sends and control envelopes use the shared short batch window before
  network send, without removing messages from the retry outbox until ack.
- Incoming `dummy` envelopes are ignored by the Windows shell and are not shown
  as chat events.

Current realtime media limitation:

- Native voice-message capture and playback are available for encrypted messages.
- Realtime Windows calls are fail-closed: the native app does not initiate an
  unusable call offer and rejects incoming offers with
  `reason: native_media_unavailable`.
- Live audio, video, and screen sharing still require a media engine implementation
  and end-to-end verification before they can be represented as shipped.
