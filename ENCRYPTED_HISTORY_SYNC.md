# Encrypted History Sync

## Goal

Keep chat history recoverable across reinstall, refresh, and new devices without storing plaintext messages on the server.

## Security model

- The server stores ciphertext envelopes and metadata only.
- Message plaintext, session secrets, sender keys, and decrypted attachments never leave the client.
- History sync is append-only from the server point of view.
- Restoring history still requires the user's local identity plus chat decryption material.

## What to store on the server

Each persisted encrypted history record should include:

- `id`
- `thread_type`
  - `direct`
  - `group`
  - `channel`
- `thread_id`
- `msg_id`
- `sender_pub_key`
- `recipient_pub_key`
  - only for direct messages
- `group_id`
  - only for groups
- `channel_id`
  - only for channels
- `envelope_type`
  - `message`
  - `group_message`
  - `channel_message`
  - `edit`
  - `delete`
  - `reaction`
- `ciphertext_payload`
- `server_received_at`
- `client_created_at`
- `delivery_state`
  - `accepted`
  - `fanout_pending`
  - `fanout_complete`

## What not to store

- Plaintext message text
- Decrypted media
- Session root keys
- Ratchet state
- Sender keys in plaintext
- Unencrypted profile drafts or contact notes

## Proposed rollout

### Phase 1

Mirror accepted ciphertext envelopes into a durable `message_history` table without changing current delivery behavior.

### Phase 2

Add cursor-based history fetch endpoints:

- `GET /history/direct?peer=...&cursor=...`
- `GET /history/group?id=...&cursor=...`
- `GET /history/channel?id=...&cursor=...`

### Phase 3

Add client reconciliation:

- backfill missing local messages from encrypted server history
- keep local Dexie state authoritative for render ordering and decrypted cache
- avoid duplicate insertion via `msg_id`

### Phase 4

Add encrypted snapshot backup for device migration:

- client exports encrypted local archive
- archive is wrapped by a backup passphrase-derived key
- server or object storage keeps only encrypted blobs

## Schema sketch

```sql
CREATE TABLE IF NOT EXISTS message_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_type TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  envelope_type TEXT NOT NULL,
  sender_pub_key TEXT NOT NULL,
  recipient_pub_key TEXT,
  group_id TEXT,
  channel_id TEXT,
  ciphertext_payload BLOB NOT NULL,
  client_created_at TEXT,
  server_received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivery_state TEXT NOT NULL DEFAULT 'accepted'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_message_history_msg_id
  ON message_history(msg_id);

CREATE INDEX IF NOT EXISTS idx_message_history_thread
  ON message_history(thread_type, thread_id, server_received_at);
```

## Client implications

- Direct chats should continue to repair stale sessions locally.
- Realtime delivery remains primary; history sync is a recovery path, not a replacement.
- Restored history may appear before it can be decrypted if the required session material is not yet rebuilt.

## First implementation target

The safest first backend change is:

1. write accepted ciphertext envelopes into `message_history`
2. add read-only cursor endpoint for direct history
3. let the client import missing direct messages by `msg_id`

That gives recovery value without redesigning group and channel flows on day one.
