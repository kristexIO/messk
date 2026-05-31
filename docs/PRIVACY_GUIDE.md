# Messk Privacy Guide

This guide explains what Messk protects, what remains visible as routing
metadata, and what users must protect themselves.

## Protected Content

- Direct message text is encrypted on the client before it reaches the server.
- Attachments and voice payloads are encrypted before upload; the server stores
  ciphertext.
- Identity seed phrases and ratchet/session secrets remain on the client.
- Native clients clear stored secret buffers when no longer needed; the web
  client clears mutable temporary seed, ratchet, key and plaintext buffers
  after crypto work where the runtime provides direct buffer access.
- Encrypted backups contain chat data, but deliberately exclude identity and
  ratchet secrets. The encrypted backup manifest lists included record counts
  and the excluded secret classes before distribution.

## Metadata That Still Exists

- The backend necessarily observes connection timing, authenticated public
  identity keys, routed recipients or room membership required for delivery,
  encrypted payload sizes, and basic abuse-control events.
- Operators can inspect aggregated reliability counters through protected
  `/admin/health`; those counters do not include message text.
- Chat recovery screens intentionally avoid raw exception messages so local
  message text, keys, and diagnostics are not printed into the UI after a
  render failure.
- Offline and reconnect banners show aggregate queue counts and generic sync
  state only; raw server errors, public keys, and message text are hidden from
  the chat surface.
- Interface density is a local appearance preference. It changes spacing only,
  is stored with other settings, and does not expose messages, routing details,
  seed phrases, or encryption keys.
- Modal and call control labels stay generic for assistive tools. They describe
  actions and state without exposing SDP, ICE candidates, tokens, seed phrases
  or message plaintext.
- Relay and bootstrap operation is not anonymity protection. Mesh work remains
  staged and feature-gated.

## User Safety Checklist

1. Store the seed phrase offline; anyone who has it can control the identity.
2. Compare a contact safety fingerprint out-of-band before treating a chat as
   verified, and stop if Messk warns that the key changed.
3. Use an encrypted backup password that is not reused elsewhere.
4. Never paste seeds, private keys, recovery backups, access tokens, or message
   plaintext into public issue reports.
5. Install only artifacts whose source and integrity manifest you can verify.
6. Use Settings -> Panic Reset Local Data when a browser profile or shared
   machine may be compromised; it wipes local Messk storage on that browser,
   but cannot delete messages already delivered to other devices.

## Limits

Messk is not independently audited cryptographic infrastructure. It does not
hide all traffic metadata from the server, hosting provider, or network
observer. Signed Windows distribution remains a release blocker until a
protected signing workflow and certificate are configured. JavaScript runtimes
cannot guarantee immediate removal of immutable string copies or garbage-
collected historical buffers, so web memory clearing is best-effort hardening.
