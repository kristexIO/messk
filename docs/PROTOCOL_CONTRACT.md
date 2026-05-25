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

## Calls

Realtime call signaling uses `call_offer`, `call_answer`, `call_reject`,
`call_end`, and `ice_candidate`. A client must not advertise or accept a live
call unless it can negotiate media for that call. The Windows native client
currently rejects incoming call offers with
`{"reason":"native_media_unavailable","supportsMedia":false}` and does not
initiate signal-only offers until its realtime media engine is implemented.
The web client rejects an offer with missing SDP or `supportsMedia: false`
instead of presenting it as an answerable call.

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
and decrypt the file. Clients use authenticated secretbox payloads and must
reject modified ciphertext instead of rendering it as a valid attachment.
Before sending a session token, clients also require the URL to resolve to
their trusted backend `/download/` route; encrypted content from a peer cannot
redirect authenticated download requests to an external origin.

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
reconnect attempts. Web and Windows clients reject remote `http://` origins
from settings or bootstrap discovery, preventing silent downgrade to plaintext
websocket transport; `http://localhost`, `http://127.0.0.1`, and `http://[::1]`
remain allowed for local development and tests only.

## Mesh Prototype Contract

The mesh layer is an R&D transport contract behind the Rust `mesh-prototype`
feature. It is not a production default yet. The goal is to let libp2p
Kademlia/Gossipsub/Circuit Relay adapters carry the same opaque envelopes as
the central backend without learning sender identity, recipient identity, or
plaintext.

Mesh topics use:

```text
messk/v1/<direct|group|channel>/<thread_id>
```

`thread_id` must already be a non-identifying route id, for example the
existing direct thread hash or a room id that is safe to reveal to subscribed
peers. Topic path segments are ASCII `A-Z`, `a-z`, `0-9`, `_`, `-`, or `.`, and
are normalized to lowercase.

Blind mesh envelopes contain only:

```json
{
  "v": 1,
  "topic": "messk/v1/direct/direct_abcd",
  "msgId": "client-generated-id",
  "ciphertext": "encrypted envelope bytes",
  "hopLimit": 3,
  "expiresAtMs": 1770000000000
}
```

They must not contain `sender_pub_key`, `recipient_pub_key`, plaintext, file
keys, session secrets, or server session tokens. Mesh adapters dedupe by
`topic + msgId`, decrement `hopLimit` before forwarding, drop expired envelopes,
and pass accepted ciphertext back into the normal client outbox/history/decrypt
pipeline.

`clients/core` includes a feature-flagged local simulator for this contract. It
models 3-9 local nodes today, duplicate gossip paths, hop-limit exhaustion, TTL
expiry, and relay-node loss with an alternate path.

`clients/core/src/mesh_libp2p.rs` is the first compile-tested libp2p adapter
layer behind the same feature flag. It builds anonymous Gossipsub, Kademlia,
Identify, AutoNAT, DCUtR, and Circuit Relay v2 client/server behaviours, maps
Messk topics to Gossipsub `IdentTopic`, and serializes/deserializes only blind
mesh envelopes at the network boundary. It also exposes composable swarm parts
with optional AutoNAT/DCUtR/Relay behaviours behind `Toggle`, so production code
can keep the feature disabled while staging builds experiment with real swarms.
The adapter must stay disabled in normal builds until a swarm runner, bootstrap
policy, and abuse controls are tested in staging.

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

`GET /health` returns service status and release version metadata only. It is
the public smoke check endpoint for local release and VPS deploy gates and must
not expose database counts, upload storage stats, queue sizes, or active socket
counts.

`GET /admin/health` returns protected operational status plus database counts,
upload storage stats, hub queue sizes, relay registry stats, and active socket
counts. It also reports process-lifetime counters for rate-limit hits,
authentication failures, stale-client rejection, websocket disconnects, and
upload outcomes without user identifiers or message contents. It requires
`X-Admin-Token` when `ADMIN_TOKEN` is configured; without a configured token it
only allows loopback requests. Nginx deploy config exposes it to localhost only.

`GET /protocol` is a public compatibility contract. It returns the wire
`protocolVersion`, `requiredClientStateVersion`, and the explicitly supported
client-state versions. Web and Windows clients query this endpoint before
opening a websocket, and surface an update-required state rather than retrying
an incompatible socket indefinitely.

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
