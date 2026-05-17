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
- `offline_ack`: client acknowledgement that an offline message with `msg_id` was processed.

## Offline Delivery

When a recipient is offline, the server stores the normalized ciphertext
envelope in `offline_messages`. The unique key is `(recipient_pub_key, msg_id)`,
so retries update stale ciphertext instead of creating duplicates.

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

## Health And Admin Signals

`GET /health` returns service status plus database counts, upload storage stats,
hub queue sizes, active sockets, and release version metadata. It is the smoke
check endpoint for local release and VPS deploy gates.

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
