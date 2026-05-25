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
  ratchet secrets.

## Metadata That Still Exists

- The backend necessarily observes connection timing, authenticated public
  identity keys, routed recipients or room membership required for delivery,
  encrypted payload sizes, and basic abuse-control events.
- Operators can inspect aggregated reliability counters through protected
  `/admin/health`; those counters do not include message text.
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

## Limits

Messk is not independently audited cryptographic infrastructure. It does not
hide all traffic metadata from the server, hosting provider, or network
observer. Signed Windows distribution remains a release blocker until a
protected signing workflow and certificate are configured. JavaScript runtimes
cannot guarantee immediate removal of immutable string copies or garbage-
collected historical buffers, so web memory clearing is best-effort hardening.
