use crate::{crypto, ratchet, vault};
use anyhow::{Context, Result, anyhow};
use rusqlite::{Connection, OptionalExtension, params, types::Value};
use std::{
    env, fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone)]
pub struct LocalStore {
    path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct StoredChatMessage {
    pub msg_id: String,
    pub peer_public_key: String,
    pub sender_public_key: String,
    pub text: String,
    pub direction: MessageDirection,
    pub status: String,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageDirection {
    Incoming,
    Outgoing,
}

#[derive(Debug, Clone)]
pub struct OutboxMessage {
    pub msg_id: String,
    pub recipient_public_key: String,
    pub plaintext: String,
    pub attempts: u32,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct StoredIdentity {
    pub account_public_key: String,
    pub protected_seed_phrase: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct StoredContact {
    pub peer_public_key: String,
    pub display_name: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone)]
pub struct StoredPreKey {
    pub secret_key: String,
}

impl LocalStore {
    pub fn new_default() -> Result<Self> {
        let path = default_store_path()?;
        Self::with_path(path)
    }

    pub fn with_path(path: impl Into<PathBuf>) -> Result<Self> {
        let store = Self { path: path.into() };
        store.init()?;
        Ok(store)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn save_session(
        &self,
        account_public_key: &str,
        peer_public_key: &str,
        session: &ratchet::Session,
    ) -> Result<()> {
        let session_json = serde_json::to_string(session)?;
        let protected_session = vault::protect_secret(session_json.as_bytes())?;
        let now = now_ms();
        self.connection()?.execute(
            r#"
            INSERT INTO sessions(account_pub_key, peer_pub_key, session_json, updated_at_ms)
            VALUES(?1, ?2, ?3, ?4)
            ON CONFLICT(account_pub_key, peer_pub_key)
            DO UPDATE SET session_json = excluded.session_json, updated_at_ms = excluded.updated_at_ms
            "#,
            params![account_public_key, peer_public_key, protected_session, now],
        )?;
        Ok(())
    }

    pub fn load_session(
        &self,
        account_public_key: &str,
        peer_public_key: &str,
    ) -> Result<Option<ratchet::Session>> {
        let session_blob = self
            .connection()?
            .query_row(
                "SELECT session_json FROM sessions WHERE account_pub_key = ?1 AND peer_pub_key = ?2",
                params![account_public_key, peer_public_key],
                |row| row.get::<_, Value>(0),
            )
            .optional()?;
        session_blob
            .map(|value| {
                let bytes = match value {
                    Value::Blob(bytes) => bytes,
                    Value::Text(text) => text.into_bytes(),
                    other => return Err(anyhow!("invalid stored session value: {other:?}")),
                };
                let opened = vault::unprotect_secret(&bytes).unwrap_or(bytes);
                let json = String::from_utf8(opened)?;
                serde_json::from_str(&json).map_err(Into::into)
            })
            .transpose()
    }

    pub fn delete_session(&self, account_public_key: &str, peer_public_key: &str) -> Result<()> {
        self.connection()?.execute(
            "DELETE FROM sessions WHERE account_pub_key = ?1 AND peer_pub_key = ?2",
            params![account_public_key, peer_public_key],
        )?;
        Ok(())
    }

    pub fn save_identity_blob(
        &self,
        account_public_key: &str,
        protected_seed_phrase: &[u8],
    ) -> Result<()> {
        let now = now_ms();
        self.connection()?.execute(
            r#"
            INSERT INTO identities(account_pub_key, protected_seed_phrase, created_at_ms, last_used_at_ms)
            VALUES(?1, ?2, ?3, ?3)
            ON CONFLICT(account_pub_key)
            DO UPDATE SET
                protected_seed_phrase = excluded.protected_seed_phrase,
                last_used_at_ms = excluded.last_used_at_ms
            "#,
            params![account_public_key, protected_seed_phrase, now],
        )?;
        Ok(())
    }

    pub fn load_last_identity_blob(&self) -> Result<Option<StoredIdentity>> {
        self.connection()?
            .query_row(
                r#"
                SELECT account_pub_key, protected_seed_phrase
                FROM identities
                ORDER BY last_used_at_ms DESC
                LIMIT 1
                "#,
                [],
                |row| {
                    Ok(StoredIdentity {
                        account_public_key: row.get(0)?,
                        protected_seed_phrase: row.get(1)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn forget_identity(&self, account_public_key: &str) -> Result<()> {
        self.connection()?.execute(
            "DELETE FROM identities WHERE account_pub_key = ?1",
            params![account_public_key],
        )?;
        Ok(())
    }

    pub fn delete_account_data(&self, account_public_key: &str) -> Result<()> {
        let mut conn = self.connection()?;
        let tx = conn.transaction()?;
        for table in [
            "outbox",
            "message_pins",
            "messages",
            "sessions",
            "prekeys",
            "contacts",
            "identities",
        ] {
            tx.execute(
                &format!("DELETE FROM {table} WHERE account_pub_key = ?1"),
                params![account_public_key],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn save_contact(
        &self,
        account_public_key: &str,
        peer_public_key: &str,
        display_name: &str,
    ) -> Result<()> {
        let now = now_ms();
        let display_name = display_name.trim();
        if peer_public_key.trim().is_empty() || display_name.is_empty() {
            return Ok(());
        }
        self.connection()?.execute(
            r#"
            INSERT INTO contacts(
                account_pub_key, peer_pub_key, display_name, created_at_ms, updated_at_ms
            )
            VALUES(?1, ?2, ?3, ?4, ?4)
            ON CONFLICT(account_pub_key, peer_pub_key)
            DO UPDATE SET
                display_name = excluded.display_name,
                updated_at_ms = excluded.updated_at_ms
            "#,
            params![
                account_public_key,
                peer_public_key.trim(),
                display_name,
                now
            ],
        )?;
        Ok(())
    }

    pub fn list_contacts(&self, account_public_key: &str) -> Result<Vec<StoredContact>> {
        let conn = self.connection()?;
        let mut statement = conn.prepare(
            r#"
            SELECT peer_pub_key, display_name, created_at_ms, updated_at_ms
            FROM contacts
            WHERE account_pub_key = ?1
            ORDER BY updated_at_ms DESC
            "#,
        )?;
        let rows = statement.query_map(params![account_public_key], |row| {
            Ok(StoredContact {
                peer_public_key: row.get(0)?,
                display_name: row.get(1)?,
                created_at_ms: row.get(2)?,
                updated_at_ms: row.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn save_prekeys(
        &self,
        account_public_key: &str,
        prekeys: &[crypto::BoxKeyPair],
    ) -> Result<()> {
        let mut conn = self.connection()?;
        let tx = conn.transaction()?;
        let now = now_ms();
        {
            let mut statement = tx.prepare(
                r#"
                INSERT OR IGNORE INTO prekeys(
                    account_pub_key, public_key, protected_secret_key, created_at_ms
                )
                VALUES(?1, ?2, ?3, ?4)
                "#,
            )?;
            for prekey in prekeys {
                let protected_secret =
                    vault::protect_secret(prekey.secret_key.expose().as_bytes())?;
                statement.execute(params![
                    account_public_key,
                    prekey.public_key,
                    protected_secret,
                    now,
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn count_prekeys(&self, account_public_key: &str) -> Result<usize> {
        let count = self.connection()?.query_row(
            "SELECT COUNT(*) FROM prekeys WHERE account_pub_key = ?1",
            params![account_public_key],
            |row| row.get::<_, i64>(0),
        )?;
        Ok(count.max(0) as usize)
    }

    pub fn list_prekey_public_keys(
        &self,
        account_public_key: &str,
        limit: usize,
    ) -> Result<Vec<String>> {
        let conn = self.connection()?;
        let mut statement = conn.prepare(
            r#"
            SELECT public_key
            FROM prekeys
            WHERE account_pub_key = ?1
            ORDER BY created_at_ms DESC
            LIMIT ?2
            "#,
        )?;
        let rows =
            statement.query_map(params![account_public_key, limit as i64], |row| row.get(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn load_prekey(
        &self,
        account_public_key: &str,
        public_key: &str,
    ) -> Result<Option<StoredPreKey>> {
        let row = self
            .connection()?
            .query_row(
                r#"
                SELECT protected_secret_key
                FROM prekeys
                WHERE account_pub_key = ?1 AND public_key = ?2
                "#,
                params![account_public_key, public_key],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional()?;
        row.map(|protected_secret_key| {
            let secret_bytes = vault::unprotect_secret(&protected_secret_key)?;
            let secret_key = String::from_utf8(secret_bytes)?;
            Ok(StoredPreKey { secret_key })
        })
        .transpose()
    }

    pub fn delete_prekey(&self, account_public_key: &str, public_key: &str) -> Result<()> {
        self.connection()?.execute(
            "DELETE FROM prekeys WHERE account_pub_key = ?1 AND public_key = ?2",
            params![account_public_key, public_key],
        )?;
        Ok(())
    }

    pub fn upsert_message(
        &self,
        account_public_key: &str,
        message: &StoredChatMessage,
    ) -> Result<()> {
        let now = now_ms();
        self.connection()?.execute(
            r#"
            INSERT INTO messages(
                account_pub_key, msg_id, peer_pub_key, sender_pub_key,
                text, direction, status, created_at_ms, updated_at_ms
            )
            VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ON CONFLICT(account_pub_key, msg_id)
            DO UPDATE SET
                peer_pub_key = excluded.peer_pub_key,
                sender_pub_key = excluded.sender_pub_key,
                text = excluded.text,
                direction = excluded.direction,
                status = excluded.status,
                updated_at_ms = excluded.updated_at_ms
            "#,
            params![
                account_public_key,
                message.msg_id,
                message.peer_public_key,
                message.sender_public_key,
                message.text,
                message.direction.as_str(),
                message.status,
                message.created_at_ms,
                now,
            ],
        )?;
        Ok(())
    }

    pub fn update_message_status(
        &self,
        account_public_key: &str,
        msg_id: &str,
        status: &str,
    ) -> Result<()> {
        self.connection()?.execute(
            "UPDATE messages SET status = ?3, updated_at_ms = ?4 WHERE account_pub_key = ?1 AND msg_id = ?2",
            params![account_public_key, msg_id, status, now_ms()],
        )?;
        Ok(())
    }

    pub fn delete_message(&self, account_public_key: &str, msg_id: &str) -> Result<()> {
        let mut conn = self.connection()?;
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM message_pins WHERE account_pub_key = ?1 AND msg_id = ?2",
            params![account_public_key, msg_id],
        )?;
        tx.execute(
            "DELETE FROM outbox WHERE account_pub_key = ?1 AND msg_id = ?2",
            params![account_public_key, msg_id],
        )?;
        tx.execute(
            "DELETE FROM messages WHERE account_pub_key = ?1 AND msg_id = ?2",
            params![account_public_key, msg_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn pin_message(&self, account_public_key: &str, msg_id: &str) -> Result<()> {
        self.connection()?.execute(
            r#"
            INSERT INTO message_pins(account_pub_key, msg_id, pinned_at_ms)
            VALUES(?1, ?2, ?3)
            ON CONFLICT(account_pub_key, msg_id)
            DO UPDATE SET pinned_at_ms = excluded.pinned_at_ms
            "#,
            params![account_public_key, msg_id, now_ms()],
        )?;
        Ok(())
    }

    pub fn unpin_message(&self, account_public_key: &str, msg_id: &str) -> Result<()> {
        self.connection()?.execute(
            "DELETE FROM message_pins WHERE account_pub_key = ?1 AND msg_id = ?2",
            params![account_public_key, msg_id],
        )?;
        Ok(())
    }

    pub fn list_pinned_message_ids(&self, account_public_key: &str) -> Result<Vec<String>> {
        let conn = self.connection()?;
        let mut statement = conn.prepare(
            r#"
            SELECT msg_id
            FROM message_pins
            WHERE account_pub_key = ?1
            ORDER BY pinned_at_ms DESC
            "#,
        )?;
        let rows = statement.query_map(params![account_public_key], |row| row.get(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn list_recent_messages(
        &self,
        account_public_key: &str,
        limit: usize,
    ) -> Result<Vec<StoredChatMessage>> {
        let conn = self.connection()?;
        let mut statement = conn.prepare(
            r#"
            SELECT msg_id, peer_pub_key, sender_pub_key, text, direction, status, created_at_ms
            FROM messages
            WHERE account_pub_key = ?1
            ORDER BY created_at_ms DESC
            LIMIT ?2
            "#,
        )?;
        let rows = statement.query_map(params![account_public_key, limit as i64], |row| {
            let direction = row.get::<_, String>(4)?;
            Ok(StoredChatMessage {
                msg_id: row.get(0)?,
                peer_public_key: row.get(1)?,
                sender_public_key: row.get(2)?,
                text: row.get(3)?,
                direction: MessageDirection::from_str(&direction),
                status: row.get(5)?,
                created_at_ms: row.get(6)?,
            })
        })?;

        let mut messages = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        messages.reverse();
        Ok(messages)
    }

    pub fn enqueue_outbox(
        &self,
        account_public_key: &str,
        msg_id: &str,
        recipient_public_key: &str,
        plaintext: &str,
    ) -> Result<()> {
        let now = now_ms();
        self.connection()?.execute(
            r#"
            INSERT INTO outbox(
                account_pub_key, msg_id, recipient_pub_key, plaintext,
                attempts, last_error, created_at_ms, updated_at_ms
            )
            VALUES(?1, ?2, ?3, ?4, 0, NULL, ?5, ?5)
            ON CONFLICT(account_pub_key, msg_id)
            DO UPDATE SET
                recipient_pub_key = excluded.recipient_pub_key,
                plaintext = excluded.plaintext,
                updated_at_ms = excluded.updated_at_ms
            "#,
            params![
                account_public_key,
                msg_id,
                recipient_public_key,
                plaintext,
                now,
            ],
        )?;
        Ok(())
    }

    pub fn list_outbox(
        &self,
        account_public_key: &str,
        limit: usize,
    ) -> Result<Vec<OutboxMessage>> {
        let conn = self.connection()?;
        let mut statement = conn.prepare(
            r#"
            SELECT msg_id, recipient_pub_key, plaintext, attempts, last_error
            FROM outbox
            WHERE account_pub_key = ?1
              AND (?3 - updated_at_ms) >= CASE
                  WHEN attempts <= 1 THEN 0
                  WHEN attempts = 2 THEN 5000
                  WHEN attempts = 3 THEN 15000
                  WHEN attempts = 4 THEN 60000
                  ELSE 300000
              END
            ORDER BY created_at_ms ASC
            LIMIT ?2
            "#,
        )?;
        let rows =
            statement.query_map(params![account_public_key, limit as i64, now_ms()], |row| {
                let attempts = row.get::<_, i64>(3)?.max(0) as u32;
                Ok(OutboxMessage {
                    msg_id: row.get(0)?,
                    recipient_public_key: row.get(1)?,
                    plaintext: row.get(2)?,
                    attempts,
                    last_error: row.get(4)?,
                })
            })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn outbox_count(&self, account_public_key: &str) -> Result<usize> {
        let count = self.connection()?.query_row(
            "SELECT COUNT(*) FROM outbox WHERE account_pub_key = ?1",
            params![account_public_key],
            |row| row.get::<_, i64>(0),
        )?;
        Ok(count.max(0) as usize)
    }

    pub fn mark_outbox_attempt(
        &self,
        account_public_key: &str,
        msg_id: &str,
        error: Option<&str>,
    ) -> Result<()> {
        self.connection()?.execute(
            r#"
            UPDATE outbox
            SET attempts = attempts + 1, last_error = ?3, updated_at_ms = ?4
            WHERE account_pub_key = ?1 AND msg_id = ?2
            "#,
            params![account_public_key, msg_id, error, now_ms()],
        )?;
        Ok(())
    }

    pub fn delete_outbox(&self, account_public_key: &str, msg_id: &str) -> Result<()> {
        self.connection()?.execute(
            "DELETE FROM outbox WHERE account_pub_key = ?1 AND msg_id = ?2",
            params![account_public_key, msg_id],
        )?;
        Ok(())
    }

    fn init(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!("failed to create store directory {}", parent.display())
            })?;
        }
        let conn = self.connection()?;
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS sessions (
                account_pub_key TEXT NOT NULL,
                peer_pub_key TEXT NOT NULL,
                session_json BLOB NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                PRIMARY KEY(account_pub_key, peer_pub_key)
            );

            CREATE TABLE IF NOT EXISTS identities (
                account_pub_key TEXT PRIMARY KEY,
                protected_seed_phrase BLOB NOT NULL,
                created_at_ms INTEGER NOT NULL,
                last_used_at_ms INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS prekeys (
                account_pub_key TEXT NOT NULL,
                public_key TEXT NOT NULL,
                protected_secret_key BLOB NOT NULL,
                created_at_ms INTEGER NOT NULL,
                PRIMARY KEY(account_pub_key, public_key)
            );

            CREATE INDEX IF NOT EXISTS idx_prekeys_account_created
            ON prekeys(account_pub_key, created_at_ms);

            CREATE TABLE IF NOT EXISTS messages (
                account_pub_key TEXT NOT NULL,
                msg_id TEXT NOT NULL,
                peer_pub_key TEXT NOT NULL,
                sender_pub_key TEXT NOT NULL,
                text TEXT NOT NULL,
                direction TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                PRIMARY KEY(account_pub_key, msg_id)
            );

            CREATE INDEX IF NOT EXISTS idx_messages_account_created
            ON messages(account_pub_key, created_at_ms);

            CREATE TABLE IF NOT EXISTS message_pins (
                account_pub_key TEXT NOT NULL,
                msg_id TEXT NOT NULL,
                pinned_at_ms INTEGER NOT NULL,
                PRIMARY KEY(account_pub_key, msg_id)
            );

            CREATE INDEX IF NOT EXISTS idx_message_pins_account_pinned
            ON message_pins(account_pub_key, pinned_at_ms);

            CREATE TABLE IF NOT EXISTS contacts (
                account_pub_key TEXT NOT NULL,
                peer_pub_key TEXT NOT NULL,
                display_name TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                PRIMARY KEY(account_pub_key, peer_pub_key)
            );

            CREATE INDEX IF NOT EXISTS idx_contacts_account_updated
            ON contacts(account_pub_key, updated_at_ms);

            CREATE TABLE IF NOT EXISTS outbox (
                account_pub_key TEXT NOT NULL,
                msg_id TEXT NOT NULL,
                recipient_pub_key TEXT NOT NULL,
                plaintext TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                PRIMARY KEY(account_pub_key, msg_id)
            );

            CREATE INDEX IF NOT EXISTS idx_outbox_account_created
            ON outbox(account_pub_key, created_at_ms);
            "#,
        )?;
        Ok(())
    }

    fn connection(&self) -> Result<Connection> {
        Connection::open(&self.path)
            .with_context(|| format!("failed to open local store {}", self.path.display()))
    }
}

impl MessageDirection {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Incoming => "incoming",
            Self::Outgoing => "outgoing",
        }
    }

    pub fn from_str(value: &str) -> Self {
        if value == "incoming" {
            Self::Incoming
        } else {
            Self::Outgoing
        }
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

fn default_store_path() -> Result<PathBuf> {
    if let Some(appdata) = env::var_os("APPDATA") {
        return Ok(PathBuf::from(appdata).join("Messk").join("state.sqlite"));
    }
    let cwd =
        env::current_dir().map_err(|error| anyhow!("failed to resolve current dir: {error}"))?;
    Ok(cwd.join("messk-state.sqlite"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto;
    use uuid::Uuid;

    #[test]
    fn stores_sessions_messages_and_outbox() {
        let path = env::temp_dir().join(format!("messk-store-{}.sqlite", Uuid::new_v4()));
        let store = LocalStore::with_path(&path).unwrap();

        let peer = crypto::generate_box_keypair().unwrap();
        let session =
            ratchet::Session::new_sender(peer.public_key.clone(), [7u8; 32], None).unwrap();
        store
            .save_session("account", &peer.public_key, &session)
            .unwrap();
        assert!(
            store
                .load_session("account", &peer.public_key)
                .unwrap()
                .is_some()
        );

        store
            .upsert_message(
                "account",
                &StoredChatMessage {
                    msg_id: "m1".to_string(),
                    peer_public_key: peer.public_key.clone(),
                    sender_public_key: "account".to_string(),
                    text: "hello".to_string(),
                    direction: MessageDirection::Outgoing,
                    status: "pending".to_string(),
                    created_at_ms: now_ms(),
                },
            )
            .unwrap();
        assert_eq!(store.list_recent_messages("account", 10).unwrap().len(), 1);

        store.pin_message("account", "m1").unwrap();
        assert_eq!(
            store.list_pinned_message_ids("account").unwrap(),
            vec!["m1".to_string()]
        );
        store.unpin_message("account", "m1").unwrap();
        assert!(store.list_pinned_message_ids("account").unwrap().is_empty());
        store.pin_message("account", "m1").unwrap();

        store
            .enqueue_outbox("account", "m1", &peer.public_key, "hello")
            .unwrap();
        assert_eq!(store.list_outbox("account", 10).unwrap().len(), 1);
        store.delete_outbox("account", "m1").unwrap();
        assert!(store.list_outbox("account", 10).unwrap().is_empty());
        store.delete_message("account", "m1").unwrap();
        assert!(
            store
                .list_recent_messages("account", 10)
                .unwrap()
                .is_empty()
        );
        assert!(store.list_pinned_message_ids("account").unwrap().is_empty());

        store
            .save_contact("account", &peer.public_key, "Alice")
            .unwrap();
        let contacts = store.list_contacts("account").unwrap();
        assert_eq!(contacts.len(), 1);
        assert_eq!(contacts[0].display_name, "Alice");
        assert_eq!(contacts[0].peer_public_key, peer.public_key);

        store.save_identity_blob("account", b"protected").unwrap();
        let identity = store.load_last_identity_blob().unwrap().unwrap();
        assert_eq!(identity.account_public_key, "account");
        assert_eq!(identity.protected_seed_phrase, b"protected");
        store.forget_identity("account").unwrap();
        assert!(store.load_last_identity_blob().unwrap().is_none());

        let prekey = crypto::generate_box_keypair().unwrap();
        store
            .save_prekeys("account", std::slice::from_ref(&prekey))
            .unwrap();
        assert_eq!(store.count_prekeys("account").unwrap(), 1);
        assert_eq!(
            store.list_prekey_public_keys("account", 10).unwrap().len(),
            1
        );
        let stored_prekey = store
            .load_prekey("account", &prekey.public_key)
            .unwrap()
            .unwrap();
        assert_eq!(stored_prekey.secret_key, prekey.secret_key.expose());
        store.delete_prekey("account", &prekey.public_key).unwrap();
        assert_eq!(store.count_prekeys("account").unwrap(), 0);

        store.delete_account_data("account").unwrap();
        assert!(
            store
                .list_recent_messages("account", 10)
                .unwrap()
                .is_empty()
        );
        assert!(store.list_outbox("account", 10).unwrap().is_empty());
        assert!(store.list_contacts("account").unwrap().is_empty());
        assert!(store.list_pinned_message_ids("account").unwrap().is_empty());
        assert!(store.load_last_identity_blob().unwrap().is_none());

        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(path.with_extension("sqlite-shm"));
        let _ = fs::remove_file(path.with_extension("sqlite-wal"));
    }
}
