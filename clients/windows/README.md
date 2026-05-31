# Messk Windows

Native Windows client prototype. This is not a WebView/Tauri/Electron shell.

Current milestone:

- Rust native desktop window via `eframe`.
- BIP-39 seed phrase generation/import compatible with the existing web client.
- NaCl `crypto_box` auth challenge decryption compatible with the Go backend.
- WebSocket auth against `/ws?pub=...&state=clean_20260511`.
- Backend `/health` check.
- X3DH root-key derivation compatible with the web client.
- Double-ratchet initial direct message encryption compatible with the web client.
- Live WebSocket receive loop for direct messages with delivery/offline acknowledgements.
- SQLite local store under `%APPDATA%\Messk\state.sqlite`.
- Persisted direct messages, ratchet sessions, and retry outbox.
- Retry backoff for queued direct messages after network/server errors.
- Persisted one-time prekeys with safe server upload and stale prekey cleanup.
- Periodic outbox flush while realtime is connected.
- Visible retry outbox with queued message previews, attempts, last error, and next retry timing.
- Contact list and chat start by public key or @username.
- Direct typing indicators compatible with the web client; typing events are
  transient and are not written to local history or retry outbox.
- Optional Windows startup registration through the current user's Run key.
- Native window/taskbar icon.
- Portable install/uninstall scripts included in release packages.
- Visible client version metadata in the native UI.
- System tray menu with show, hide, quit, and optional close-to-tray mode.
- Local group/channel room list with create/edit, pin, mute, delete, and profile panels.
- Identity seed persistence through Windows DPAPI, scoped to the current OS user.
- Panic reset for local identity, sessions, prekeys, messages, and outbox.

Next milestones:

- Backend-synced room membership, invites, permissions, and room messages.
- Realtime media engine for audio/video/screen-share calls; current native call signaling advertises `supportsMedia: false`.
- Signed installer polish.
