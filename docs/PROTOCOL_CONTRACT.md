# Messk Protocol Contract

This document is the server/client wire contract for Messk. The backend is a
ciphertext router and recovery store; it must never receive plaintext message
text, decrypted files, ratchet secrets, identity seeds, or session secrets.

## Envelope

All WebSocket routed client events use this JSON shape:

```json
{
  "type": "message",
  "msg_id": "client-generated-id",
  "target_msg_id": "message-being-edited-or-reacted-to",
  "sender_pub_key": "base64 identity public key",
  "recipient_pub_key": "base64 identity public key",
  "group_id": "optional group/channel id",
  "data": "client-defined encrypted payload",
  "reaction": "optional reaction marker"
}
```

The server overwrites `sender_pub_key` with the authenticated identity before
routing. Clients must treat `msg_id` as the event idempotency key and dedupe
repeated events. Control events that act on an existing message must put the
target message id in `target_msg_id`; new server validation rejects direct
`edit`, `delete`, `reaction`, `reply`, `pin`, and `unpin` events without it.
Events carrying message bodies must include encrypted `data`; plaintext bodies
are not valid protocol input.

## Direct Ratchet Plaintext

Direct E2EE payloads use X3DH session setup followed by Double Ratchet message
encryption. Routed backend envelopes carry only ratchet ciphertext.

Ratchet authenticated plaintext version `1` contains:

```json
{
  "v": 1,
  "header": {"ratchetPubKey": "...", "n": 0, "pn": 0},
  "plaintext": "client-visible payload",
  "padding": "optional encrypted filler"
}
```

`padding` is ignored after decryption. Current clients use interactive padding
buckets for direct ratchet payloads so short messages do not map cleanly to
ciphertext size. Web and Windows also apply a short deterministic batch window
before direct sends, currently 0-250 ms per `(thread, msg_id)`, so rapid sends
can share a small timing window without losing outbox durability. Legacy
payloads without `padding` remain valid.

## Direct Event Types

- `message`: encrypted direct chat message.
- `edit`: encrypted edit body for `target_msg_id`.
- `delete`: delete/tombstone event for `target_msg_id`.
- `reaction`: reaction change for `target_msg_id`.
- `reply`: encrypted reply metadata plus message body.
- `pin`: encrypted pin event for `target_msg_id`.
- `unpin`: encrypted unpin event for `target_msg_id`.
- `attachment`: encrypted attachment metadata; file bytes stay encrypted before upload.
- `forward`: encrypted forwarded message metadata plus body.
- `delivery_receipt`: delivery state notification.
- `read_receipt`: read state notification.
- `session_repair`: encrypted E2EE repair control message.
- `dummy`: encrypted online-only cover envelope; never stored in history or offline queues.
- `offline_ack`: client acknowledgement that an offline message with `msg_id` was processed.

## Offline Delivery

When a recipient is offline, the server stores the normalized ciphertext
envelope in `offline_messages`. The unique key is `(recipient_pub_key, msg_id)`,
so retries update stale ciphertext instead of creating duplicates.
`dummy` envelopes are deliberately online-only: the backend may acknowledge the
sender, but drops them instead of storing them when the recipient is offline.

Clients must send:

```json
{ "type": "offline_ack", "msg_id": "processed-id" }
```

after decrypting or intentionally tombstoning an offline event.

## History Recovery

Direct chat recovery uses:

```http
GET /history/direct?peer=<public_key>&cursor=<last_id>&limit=100
X-Session-Token: <token>
```

Response:

```json
{
  "messages": [
    {
      "id": 1,
      "threadType": "direct",
      "threadId": "direct_<sha256>",
      "msgId": "client-generated-id",
      "envelopeType": "message",
      "senderPubKey": "...",
      "recipientPubKey": "...",
      "ciphertextPayload": { "type": "message", "data": "..." },
      "serverReceivedAt": "2026-05-14T00:00:00Z",
      "deliveryState": "accepted"
    }
  ],
  "nextCursor": 1,
  "limit": 100
}
```

The server stores only opaque envelopes. For message envelopes, `data` is
ciphertext. For control envelopes, `msgId` is the control event id and
`ciphertextPayload.target_msg_id` points at the affected message. Clients
resume with `nextCursor` and must avoid replaying ratchet-consuming events that
were already applied.

## Directory

New chat by username uses:

```http
GET /directory/resolve?username=<name>
X-Session-Token: <token>
```

Response:

```json
{
  "username": "alice",
  "pubKey": "base64 public key",
  "nickname": "Alice",
  "avatar": ""
}
```

Legacy unauthenticated `/resolve` and `/profile/resolve` stay for compatibility,
but new clients should use `/directory/resolve`.

## Files

Attachments are encrypted by the client before upload. The server stores opaque
bytes, validates access control, and returns a download URL/token. The
`attachment` event carries only encrypted metadata needed by clients to locate
and decrypt the file.

## Relay And Bootstrap

Relay/bootstrap mode lets clients discover signed relay capabilities without
trusting relay nodes with plaintext. Relays announce only routing capability:
node identity, supported transports, endpoint origins, expiry, and an Ed25519
signature. Endpoint origins are optional and must be normalized `http://` or
`https://` origins without credentials, path, query, or fragment.

Supported transport names are:

- `central_ws`
- `mesh_relay`
- `direct_p2p`
- `fallback_wss`
- `user_proxy`

Relay announcement uses:

```http
POST /relay/announce
X-Relay-Token: <operator-issued announce token>
```

Body:

```json
{
  "capability": {
    "nodeId": "relay-1",
    "publicKey": "base64 ed25519 public key",
    "transports": ["central_ws", "fallback_wss"],
    "endpointOrigins": ["https://relay.example"],
    "regionHint": "eu",
    "capacityClass": "small",
    "expiresAt": "2026-05-18T18:00:00Z",
    "signature": "base64 ed25519 signature"
  },
  "credential": {
    "scope": "relay:announce",
    "revocationEpoch": 0
  }
}
```

The signature covers this canonical string:

```text
nodeId
publicKey
comma-separated sorted transports
comma-separated sorted endpoint origins
regionHint
capacityClass
expiresAt as RFC3339 UTC
revocationEpoch
```

For compatibility, bootstrap accepts the previous canonical string only when
`endpointOrigins` is empty. New relay nodes should always sign the form above.

Public discovery endpoints:

- `GET /relay/health`
- `GET /relay/peers`
- `GET /peers`
- `GET /bootstrap`

Web clients can configure static fallback origins with
`VITE_FALLBACK_BACKEND_URLS`. On connect they keep the configured origin list
and refresh it from `/bootstrap`; relays that advertise `central_ws` or
`fallback_wss` contribute normalized `endpointOrigins` for subsequent websocket
reconnect attempts.

If `RELAY_ANNOUNCE_TOKEN` is unset, relay announcements are accepted only from
loopback for local development. Production nodes must configure an announce
token and keep relay signing keys outside git. Operators can revoke relay
access with `RELAY_REVOKED_NODES`, `RELAY_REVOKED_PUBLIC_KEYS`, or by raising
`RELAY_MIN_REVOCATION_EPOCH`; `/relay/health` reports only revocation counts,
not the revoked identifiers themselves.

Operators can publish a signed relay capability with:

```powershell
cd mess
go run ./tools/relay-announce `
  -backend https://bootstrap.example `
  -key-file C:\secure\messk-relay-ed25519.b64 `
  -generate-key `
  -node-id relay-eu-1 `
  -endpoint-origins https://relay.example `
  -ttl 12h `
  -refresh-interval 6h `
  -token $env:RELAY_ANNOUNCE_TOKEN
```

The tool prints only non-secret announce status. It reads tokens from
`RELAY_ANNOUNCE_TOKEN` or `-token-file` and never commits/generated keys.
With `-refresh-interval`, it re-signs and re-announces before expiry; failed
attempts are retried sooner while the process keeps running until interrupted.
The VPS deploy flow builds this tool as `/opt/messan/bin/relay-announce` and
installs `messan-relay-announce.service`; shared config lives in
`/opt/messan/shared/backend.env`, and the generated signing key path defaults
to `/opt/messan/shared/relay-ed25519.b64`.

## Health And Admin Signals

`GET /health` returns service status plus database counts, upload storage stats,
hub queue sizes, relay registry stats, active sockets, and release version
metadata. It is the smoke check endpoint for local release and VPS deploy gates.

`GET /admin/health` returns the same report for operators. It requires
`X-Admin-Token` when `ADMIN_TOKEN` is configured; without a configured token it
only allows loopback requests. Nginx deploy config exposes it to localhost only.

The database stats include direct history delivery buckets:

- `messageHistoryAccepted`
- `messageHistoryWaitingDelivery`
- `messageHistoryDelivered`

These counters are used to notice offline queue growth and stuck deliveries
without inspecting ciphertext.

## Cross-client Contract Mirrors

The contract is mirrored in code in three places:

- Go backend validation in `mess/client.go`.
- Web constants/tests in `messk/src/lib/protocolContract.ts`.
- Native Rust constants/tests in `clients/core/src/protocol.rs`.

When adding a protocol event, update all three before building UI around it.
