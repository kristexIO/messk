# Messk Roadmap

Messk is being developed as a full-platform E2EE messenger. The backend remains
the protocol source of truth, the web client remains the reference product, and
native clients share protocol and sync behavior through `clients/core`.

## Phase 1: Direct Chat Stability

- Keep direct messages idempotent with stable `msg_id` dedupe.
- Preserve retry-safe offline delivery and `offline_ack`.
- Keep message statuses visible in every client: `sending`, `sent`,
  `delivered`, `read`, `error`, and `waiting_retry`.
- Keep control envelopes encrypted: edit, delete, reaction, reply, pin, unpin.
- Ensure failed decrypt recovery never requires manually recreating a chat.

Exit criteria:

- Two accounts can send online, send offline, reconnect, retry, edit, delete,
  react, pin, and recover history without duplicate messages.
- `scripts/check-all.ps1` is green.

## Phase 2: Native Media

- Finish encrypted file upload/download parity in Windows and web.
- Add drag-and-drop polish and visible upload/download progress.
- Add image previews and local thumbnail cache.
- Add voice recording, waveform rendering, playback, and speed controls.
- Add attachment gallery per direct chat and per room.

Exit criteria:

- Files and voice messages are encrypted before upload.
- Server stores ciphertext only.
- Windows and web render the same payload contract.

## Phase 3: Calls

- Freeze encrypted signaling contract: `call_offer`, `call_answer`, `call_ice`,
  `call_end`, `call_missed`.
- Implement Windows call state machine and call overlay first.
- Add audio-only calls before video.
- Add timeout, reject, busy, missed, and lost-connection states.
- Until native realtime media exists, fail closed: Windows must not initiate
  signal-only calls and must reject incoming offers explicitly.

Exit criteria:

- Signaling envelopes are relay-only on the backend.
- Clients never log plaintext SDP, ICE, or device identifiers.

## Phase 4: Groups, Channels, Profiles

- Add room metadata contract with roles and permissions.
- Keep the Windows local room surface usable: room list, create/edit, pin, mute,
  delete, and profile panel for groups/channels.
- Implement member list, invites, join requests, pinned messages, and mute state.
- Show avatars for contacts, groups, and channels.
- Add safety number, key-change warning, and contact profile view parity.

Exit criteria:

- Groups and channels are not placeholders in Windows.
- Windows local room state persists per account.
- Room permissions are enforced by backend tests and reflected in UI.

## Phase 5: Production Hardening

- Add signed Windows installer.
- Grow the relay/bootstrap registry behind signed relay announcements,
  operator-issued announce tokens, a secret-free relay announce CLI, and
  health-visible relay metrics.
- Keep metadata resistance enabled for direct traffic: encrypted padding,
  short batch windows, and online-only dummy envelope support.
- Keep mesh work behind a feature flag until the blind envelope, topic, TTL,
  hop-limit, and dedupe contract passes web/Rust fixtures.
- Use the local mesh simulator to prove duplicate/drop behavior, relay-node
  loss, and 3-9 node propagation before enabling libp2p in staging.
- Keep the `mesh_libp2p` adapter compile-tested behind `mesh-prototype`;
  anonymous Gossipsub, Kademlia, AutoNAT, DCUtR, and Circuit Relay behaviours
  plus composable swarm parts must remain opt-in until the swarm runner and
  abuse controls are reviewed.
- Add staging release flow before production deploy.
- Require staging smoke evidence for the exact production commit and publish a
  SHA-256 release manifest for packaged artifacts.
- Advertise protocol/client-state compatibility and fail clients with an
  explicit upgrade-required message before websocket authentication.
- Reject remote plaintext fallback/bootstrap origins while retaining loopback
  HTTP for local verification, and regression-test attachment tamper rejection.
- Add monitoring for websocket disconnects, failed decrypts, queue growth,
  upload failures, relay churn, and rate-limit hits.
- Keep rollback and DB backup mandatory for VPS deploys.

Exit criteria:

- Release artifacts include backend, web dist, Windows exe/zip, and notes.
- Production deploy is blocked unless checks, smoke, backup, and health pass.

## Phase 6: Mobile Core

- Keep crypto/session/protocol logic UI-independent in `clients/core`.
- Add FFI bindings only after Windows and web behavior are stable.
- Build mobile clients against the shared Rust core rather than rewriting
  ratchet/session code per platform.

Exit criteria:

- Mobile clients reuse protocol fixtures and compatibility tests from
  `clients/core`.
