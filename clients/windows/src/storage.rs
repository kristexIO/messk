use crate::{crypto, ratchet, vault};
use anyhow::{Context, Result, anyhow};
use messk_core::payload::{encrypted_file_payload, voice_message_payload};
use messk_core::profile::UserProfile;
use messk_core::transport;
use rusqlite::{Connection, OptionalExtension, params, types::Value};
use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub const LOCAL_SCHEMA_VERSION: i64 = 1;

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

#[derive(Debug, Clone)]
pub struct MessageReaction {
    pub actor_public_key: String,
    pub reaction: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredAttachmentMetadata {
    pub msg_id: String,
    pub kind: String,
    pub url: String,
    pub name: String,
    pub mime_type: String,
    pub size: u64,
    pub duration_seconds: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StoredAppSettings {
    pub backend_origin: String,
    pub fallback_origins: Vec<String>,
    pub theme: String,
    pub density: String,
    pub font_scale: f32,
    pub auto_connect: bool,
    pub desktop_notifications: bool,
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
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub next_retry_at_ms: i64,
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
pub struct StoredOwnProfile {
    pub nickname: String,
    pub username: Option<String>,
    pub avatar: String,
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
        let version = store.schema_version()?;
        if version < LOCAL_SCHEMA_VERSION {
            return Err(anyhow!(
                "local store schema version {version} is older than required {LOCAL_SCHEMA_VERSION}"
            ));
        }
        Ok(store)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn schema_version(&self) -> Result<i64> {
        let raw = self
            .connection()?
            .query_row(
                "SELECT value FROM schema_meta WHERE key = 'schema_version'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .unwrap_or_default();
        Ok(raw.parse::<i64>().unwrap_or(0))
    }

    pub fn load_app_settings(&self) -> Result<StoredAppSettings> {
        let conn = self.connection()?;
        let mut settings = StoredAppSettings::default();
        if let Some(value) = load_app_setting(&conn, "backend_origin")? {
            settings.backend_origin = sanitize_backend_origin(&value);
        }
        if let Some(value) = load_app_setting(&conn, "fallback_origins")? {
            settings.fallback_origins = sanitize_backend_origin_list(&value);
        }
        if let Some(value) = load_app_setting(&conn, "theme")?
            && is_valid_theme(&value)
        {
            settings.theme = value;
        }
        if let Some(value) = load_app_setting(&conn, "density")?
            && is_valid_density(&value)
        {
            settings.density = value;
        }
        if let Some(value) = load_app_setting(&conn, "font_scale")?
            && let Ok(parsed) = value.parse::<f32>()
        {
            settings.font_scale = clamp_font_scale(parsed);
        }
        if let Some(value) = load_app_setting(&conn, "auto_connect")? {
            settings.auto_connect = value == "true";
        }
        if let Some(value) = load_app_setting(&conn, "desktop_notifications")? {
            settings.desktop_notifications = value == "true";
        }
        Ok(settings)
    }

    pub fn save_app_settings(&self, settings: &StoredAppSettings) -> Result<()> {
        let mut conn = self.connection()?;
        let tx = conn.transaction()?;
        let now = now_ms();
        {
            let mut statement = tx.prepare(
                r#"
                INSERT INTO app_settings(key, value, updated_at_ms)
                VALUES(?1, ?2, ?3)
                ON CONFLICT(key)
                DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms
                "#,
            )?;
            for (key, value) in [
                (
                    "backend_origin",
                    sanitize_backend_origin(&settings.backend_origin),
                ),
                (
                    "fallback_origins",
                    encode_backend_origin_list(&settings.fallback_origins),
                ),
                ("theme", sanitize_theme(&settings.theme)),
                ("density", sanitize_density(&settings.density)),
                (
                    "font_scale",
                    format!("{:.2}", clamp_font_scale(settings.font_scale)),
                ),
                ("auto_connect", settings.auto_connect.to_string()),
                (
                    "desktop_notifications",
                    settings.desktop_notifications.to_string(),
                ),
            ] {
                statement.execute(params![key, value, now])?;
            }
        }
        tx.commit()?;
        Ok(())
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

    pub fn save_own_profile(&self, account_public_key: &str, profile: &UserProfile) -> Result<()> {
        let now = now_ms();
        self.connection()?.execute(
            r#"
            INSERT INTO account_profiles(
                account_pub_key, nickname, username, avatar, updated_at_ms
            )
            VALUES(?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(account_pub_key)
            DO UPDATE SET
                nickname = excluded.nickname,
                username = excluded.username,
                avatar = excluded.avatar,
                updated_at_ms = excluded.updated_at_ms
            "#,
            params![
                account_public_key,
                &profile.nickname,
                profile.username.as_deref(),
                &profile.avatar,
                now,
            ],
        )?;
        Ok(())
    }

    pub fn load_own_profile(&self, account_public_key: &str) -> Result<Option<StoredOwnProfile>> {
        self.connection()?
            .query_row(
                r#"
                SELECT nickname, username, avatar, updated_at_ms
                FROM account_profiles
                WHERE account_pub_key = ?1
                "#,
                params![account_public_key],
                |row| {
                    Ok(StoredOwnProfile {
                        nickname: row.get(0)?,
                        username: row.get(1)?,
                        avatar: row.get(2)?,
                        updated_at_ms: row.get(3)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
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
            "message_attachments",
            "message_reactions",
            "message_pins",
            "messages",
            "sessions",
            "prekeys",
            "contacts",
            "account_profiles",
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
        let conn = self.connection()?;
        conn.execute(
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
                &message.msg_id,
                &message.peer_public_key,
                &message.sender_public_key,
                &message.text,
                message.direction.as_str(),
                &message.status,
                message.created_at_ms,
                now,
            ],
        )?;
        sync_attachment_metadata(
            &conn,
            account_public_key,
            &message.msg_id,
            &message.text,
            message.created_at_ms,
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

    pub fn update_message_text(
        &self,
        account_public_key: &str,
        msg_id: &str,
        text: &str,
    ) -> Result<()> {
        let conn = self.connection()?;
        let now = now_ms();
        let updated = conn.execute(
            "UPDATE messages SET text = ?3, updated_at_ms = ?4 WHERE account_pub_key = ?1 AND msg_id = ?2",
            params![account_public_key, msg_id, text, now],
        )?;
        if updated > 0 {
            sync_attachment_metadata(&conn, account_public_key, msg_id, text, now)?;
        }
        Ok(())
    }

    pub fn soft_delete_message(&self, account_public_key: &str, msg_id: &str) -> Result<()> {
        let mut conn = self.connection()?;
        let tx = conn.transaction()?;
        tx.execute(
            "UPDATE messages SET text = ?3, status = ?4, updated_at_ms = ?5 WHERE account_pub_key = ?1 AND msg_id = ?2",
            params![account_public_key, msg_id, deleted_message_payload(), "deleted", now_ms()],
        )?;
        tx.execute(
            "DELETE FROM message_pins WHERE account_pub_key = ?1 AND msg_id = ?2",
            params![account_public_key, msg_id],
        )?;
        tx.execute(
            "DELETE FROM message_reactions WHERE account_pub_key = ?1 AND msg_id = ?2",
            params![account_public_key, msg_id],
        )?;
        tx.execute(
            "DELETE FROM message_attachments WHERE account_pub_key = ?1 AND msg_id = ?2",
            params![account_public_key, msg_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn message_exists(&self, account_public_key: &str, msg_id: &str) -> Result<bool> {
        let count = self.connection()?.query_row(
            "SELECT COUNT(*) FROM messages WHERE account_pub_key = ?1 AND msg_id = ?2",
            params![account_public_key, msg_id],
            |row| row.get::<_, i64>(0),
        )?;
        Ok(count > 0)
    }

    pub fn delete_message(&self, account_public_key: &str, msg_id: &str) -> Result<()> {
        let mut conn = self.connection()?;
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM message_pins WHERE account_pub_key = ?1 AND msg_id = ?2",
            params![account_public_key, msg_id],
        )?;
        tx.execute(
            "DELETE FROM message_reactions WHERE account_pub_key = ?1 AND msg_id = ?2",
            params![account_public_key, msg_id],
        )?;
        tx.execute(
            "DELETE FROM outbox WHERE account_pub_key = ?1 AND msg_id = ?2",
            params![account_public_key, msg_id],
        )?;
        tx.execute(
            "DELETE FROM message_attachments WHERE account_pub_key = ?1 AND msg_id = ?2",
            params![account_public_key, msg_id],
        )?;
        tx.execute(
            "DELETE FROM messages WHERE account_pub_key = ?1 AND msg_id = ?2",
            params![account_public_key, msg_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn load_attachment_metadata(
        &self,
        account_public_key: &str,
        msg_id: &str,
    ) -> Result<Option<StoredAttachmentMetadata>> {
        self.connection()?
            .query_row(
                r#"
                SELECT msg_id, kind, url, name, mime_type, size, duration_seconds
                FROM message_attachments
                WHERE account_pub_key = ?1 AND msg_id = ?2
                "#,
                params![account_public_key, msg_id],
                |row| {
                    let size: i64 = row.get(5)?;
                    let duration_seconds: Option<i64> = row.get(6)?;
                    Ok(StoredAttachmentMetadata {
                        msg_id: row.get(0)?,
                        kind: row.get(1)?,
                        url: row.get(2)?,
                        name: row.get(3)?,
                        mime_type: row.get(4)?,
                        size: size.max(0) as u64,
                        duration_seconds: duration_seconds.map(|value| value.max(0) as u64),
                    })
                },
            )
            .optional()
            .map_err(Into::into)
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

    pub fn set_message_reaction(
        &self,
        account_public_key: &str,
        msg_id: &str,
        actor_public_key: &str,
        reaction: Option<&str>,
    ) -> Result<()> {
        let reaction = reaction.map(str::trim).filter(|value| !value.is_empty());
        if let Some(reaction) = reaction {
            self.connection()?.execute(
                r#"
                INSERT INTO message_reactions(
                    account_pub_key, msg_id, actor_pub_key, reaction, updated_at_ms
                )
                VALUES(?1, ?2, ?3, ?4, ?5)
                ON CONFLICT(account_pub_key, msg_id, actor_pub_key)
                DO UPDATE SET reaction = excluded.reaction, updated_at_ms = excluded.updated_at_ms
                "#,
                params![
                    account_public_key,
                    msg_id,
                    actor_public_key,
                    reaction,
                    now_ms()
                ],
            )?;
        } else {
            self.connection()?.execute(
                "DELETE FROM message_reactions WHERE account_pub_key = ?1 AND msg_id = ?2 AND actor_pub_key = ?3",
                params![account_public_key, msg_id, actor_public_key],
            )?;
        }
        Ok(())
    }

    pub fn list_reactions_for_messages(
        &self,
        account_public_key: &str,
        msg_ids: &[String],
    ) -> Result<BTreeMap<String, Vec<MessageReaction>>> {
        if msg_ids.is_empty() {
            return Ok(BTreeMap::new());
        }

        let conn = self.connection()?;
        let mut output = BTreeMap::<String, Vec<MessageReaction>>::new();
        let mut statement = conn.prepare(
            r#"
            SELECT actor_pub_key, reaction
            FROM message_reactions
            WHERE account_pub_key = ?1 AND msg_id = ?2
            ORDER BY updated_at_ms ASC
            "#,
        )?;
        for msg_id in msg_ids {
            let rows = statement.query_map(params![account_public_key, msg_id], |row| {
                Ok(MessageReaction {
                    actor_public_key: row.get(0)?,
                    reaction: row.get(1)?,
                })
            })?;
            let reactions = rows.collect::<rusqlite::Result<Vec<_>>>()?;
            if !reactions.is_empty() {
                output.insert(msg_id.clone(), reactions);
            }
        }
        Ok(output)
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
            SELECT msg_id, recipient_pub_key, plaintext, attempts, last_error, created_at_ms, updated_at_ms
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
                let updated_at_ms = row.get(6)?;
                Ok(OutboxMessage {
                    msg_id: row.get(0)?,
                    recipient_public_key: row.get(1)?,
                    plaintext: row.get(2)?,
                    attempts,
                    last_error: row.get(4)?,
                    created_at_ms: row.get(5)?,
                    updated_at_ms,
                    next_retry_at_ms: updated_at_ms + outbox_retry_delay_ms(attempts),
                })
            })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn list_outbox_preview(
        &self,
        account_public_key: &str,
        limit: usize,
    ) -> Result<Vec<OutboxMessage>> {
        let conn = self.connection()?;
        let mut statement = conn.prepare(
            r#"
            SELECT msg_id, recipient_pub_key, plaintext, attempts, last_error, created_at_ms, updated_at_ms
            FROM outbox
            WHERE account_pub_key = ?1
            ORDER BY updated_at_ms DESC, created_at_ms ASC
            LIMIT ?2
            "#,
        )?;
        let rows = statement.query_map(params![account_public_key, limit as i64], |row| {
            let attempts = row.get::<_, i64>(3)?.max(0) as u32;
            let updated_at_ms = row.get(6)?;
            Ok(OutboxMessage {
                msg_id: row.get(0)?,
                recipient_public_key: row.get(1)?,
                plaintext: row.get(2)?,
                attempts,
                last_error: row.get(4)?,
                created_at_ms: row.get(5)?,
                updated_at_ms,
                next_retry_at_ms: updated_at_ms + outbox_retry_delay_ms(attempts),
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

            CREATE TABLE IF NOT EXISTS schema_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at_ms INTEGER NOT NULL
            );

            INSERT OR IGNORE INTO schema_meta(key, value, updated_at_ms)
            VALUES('schema_version', '1', 0);

            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at_ms INTEGER NOT NULL
            );

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

            CREATE TABLE IF NOT EXISTS message_reactions (
                account_pub_key TEXT NOT NULL,
                msg_id TEXT NOT NULL,
                actor_pub_key TEXT NOT NULL,
                reaction TEXT NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                PRIMARY KEY(account_pub_key, msg_id, actor_pub_key)
            );

            CREATE INDEX IF NOT EXISTS idx_message_reactions_account_msg
            ON message_reactions(account_pub_key, msg_id);

            CREATE TABLE IF NOT EXISTS message_attachments (
                account_pub_key TEXT NOT NULL,
                msg_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                url TEXT NOT NULL,
                name TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                size INTEGER NOT NULL DEFAULT 0,
                duration_seconds INTEGER,
                created_at_ms INTEGER NOT NULL,
                PRIMARY KEY(account_pub_key, msg_id)
            );

            CREATE INDEX IF NOT EXISTS idx_message_attachments_account_kind
            ON message_attachments(account_pub_key, kind);

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

            CREATE TABLE IF NOT EXISTS account_profiles (
                account_pub_key TEXT PRIMARY KEY,
                nickname TEXT NOT NULL,
                username TEXT,
                avatar TEXT NOT NULL,
                updated_at_ms INTEGER NOT NULL
            );

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

fn sync_attachment_metadata(
    conn: &Connection,
    account_public_key: &str,
    msg_id: &str,
    plaintext: &str,
    created_at_ms: i64,
) -> Result<()> {
    if let Some(voice) = voice_message_payload(plaintext) {
        conn.execute(
            r#"
            INSERT INTO message_attachments(
                account_pub_key, msg_id, kind, url, name, mime_type,
                size, duration_seconds, created_at_ms
            )
            VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ON CONFLICT(account_pub_key, msg_id)
            DO UPDATE SET
                kind = excluded.kind,
                url = excluded.url,
                name = excluded.name,
                mime_type = excluded.mime_type,
                size = excluded.size,
                duration_seconds = excluded.duration_seconds
            "#,
            params![
                account_public_key,
                msg_id,
                "voice",
                voice.url,
                "voice.webm",
                voice.mime_type,
                voice.size as i64,
                voice.duration_seconds as i64,
                created_at_ms,
            ],
        )?;
        return Ok(());
    }

    if let Some(file) = encrypted_file_payload(plaintext) {
        conn.execute(
            r#"
            INSERT INTO message_attachments(
                account_pub_key, msg_id, kind, url, name, mime_type,
                size, duration_seconds, created_at_ms
            )
            VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8)
            ON CONFLICT(account_pub_key, msg_id)
            DO UPDATE SET
                kind = excluded.kind,
                url = excluded.url,
                name = excluded.name,
                mime_type = excluded.mime_type,
                size = excluded.size,
                duration_seconds = NULL
            "#,
            params![
                account_public_key,
                msg_id,
                "file",
                file.url,
                file.name,
                file.mime_type,
                file.size as i64,
                created_at_ms,
            ],
        )?;
        return Ok(());
    }

    conn.execute(
        "DELETE FROM message_attachments WHERE account_pub_key = ?1 AND msg_id = ?2",
        params![account_public_key, msg_id],
    )?;
    Ok(())
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

impl Default for StoredAppSettings {
    fn default() -> Self {
        Self {
            backend_origin: "https://messk.online".to_string(),
            fallback_origins: Vec::new(),
            theme: "telegram".to_string(),
            density: "comfortable".to_string(),
            font_scale: 1.0,
            auto_connect: false,
            desktop_notifications: true,
        }
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

fn deleted_message_payload() -> &'static str {
    r#"{"type":"deleted","text":"Message deleted"}"#
}

fn load_app_setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .map_err(Into::into)
}

fn sanitize_backend_origin(value: &str) -> String {
    transport::normalize_origin(value)
        .unwrap_or_else(|| StoredAppSettings::default().backend_origin)
}

pub fn sanitize_backend_origin_list(value: &str) -> Vec<String> {
    if let Ok(values) = serde_json::from_str::<Vec<String>>(value) {
        let mut origins = Vec::new();
        for value in values {
            if let Some(origin) = transport::normalize_origin(&value)
                && !origins.contains(&origin)
            {
                origins.push(origin);
            }
        }
        return origins;
    }
    transport::parse_origin_list(value)
}

fn encode_backend_origin_list(origins: &[String]) -> String {
    serde_json::to_string(&transport::ordered_origins("", origins))
        .unwrap_or_else(|_| "[]".to_string())
}

fn sanitize_theme(value: &str) -> String {
    if is_valid_theme(value) {
        value.to_string()
    } else {
        StoredAppSettings::default().theme
    }
}

fn sanitize_density(value: &str) -> String {
    if is_valid_density(value) {
        value.to_string()
    } else {
        StoredAppSettings::default().density
    }
}

fn is_valid_theme(value: &str) -> bool {
    matches!(value, "telegram" | "graphite" | "midnight")
}

fn is_valid_density(value: &str) -> bool {
    matches!(value, "compact" | "comfortable")
}

fn clamp_font_scale(value: f32) -> f32 {
    value.clamp(0.9, 1.2)
}

fn outbox_retry_delay_ms(attempts: u32) -> i64 {
    match attempts {
        0 | 1 => 0,
        2 => 5_000,
        3 => 15_000,
        4 => 60_000,
        _ => 300_000,
    }
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
        assert_eq!(store.schema_version().unwrap(), LOCAL_SCHEMA_VERSION);
        let mut settings = store.load_app_settings().unwrap();
        assert_eq!(settings.backend_origin, "https://messk.online");
        assert!(settings.fallback_origins.is_empty());
        settings.backend_origin = "https://example.com/".to_string();
        settings.fallback_origins = vec![
            "https://relay.example/".to_string(),
            "bad".to_string(),
            "https://relay.example".to_string(),
        ];
        settings.theme = "graphite".to_string();
        settings.density = "compact".to_string();
        settings.font_scale = 1.15;
        settings.auto_connect = true;
        settings.desktop_notifications = false;
        store.save_app_settings(&settings).unwrap();
        let settings = store.load_app_settings().unwrap();
        assert_eq!(settings.backend_origin, "https://example.com");
        assert_eq!(settings.fallback_origins, vec!["https://relay.example"]);
        assert_eq!(settings.theme, "graphite");
        assert_eq!(settings.density, "compact");
        assert_eq!(settings.font_scale, 1.15);
        assert!(settings.auto_connect);
        assert!(!settings.desktop_notifications);

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
        assert!(store.message_exists("account", "m1").unwrap());
        assert!(!store.message_exists("account", "missing").unwrap());
        store
            .update_message_text(
                "account",
                "m1",
                r#"{"type":"voice","url":"https://messk.online/download/v.webm","key":"abc","duration":4,"mimeType":"audio/webm","size":2048}"#,
            )
            .unwrap();
        let attachment = store
            .load_attachment_metadata("account", "m1")
            .unwrap()
            .unwrap();
        assert_eq!(attachment.kind, "voice");
        assert_eq!(attachment.duration_seconds, Some(4));
        store
            .update_message_text("account", "m1", "edited")
            .unwrap();
        assert_eq!(
            store.list_recent_messages("account", 10).unwrap()[0].text,
            "edited"
        );
        assert!(
            store
                .load_attachment_metadata("account", "m1")
                .unwrap()
                .is_none()
        );
        store
            .set_message_reaction("account", "m1", &peer.public_key, Some("+1"))
            .unwrap();
        let reactions = store
            .list_reactions_for_messages("account", &[String::from("m1")])
            .unwrap();
        assert_eq!(reactions["m1"][0].reaction, "+1");
        store
            .set_message_reaction("account", "m1", &peer.public_key, None)
            .unwrap();
        assert!(
            store
                .list_reactions_for_messages("account", &[String::from("m1")])
                .unwrap()
                .is_empty()
        );

        store.pin_message("account", "m1").unwrap();
        assert_eq!(
            store.list_pinned_message_ids("account").unwrap(),
            vec!["m1".to_string()]
        );
        store.unpin_message("account", "m1").unwrap();
        assert!(store.list_pinned_message_ids("account").unwrap().is_empty());
        store.pin_message("account", "m1").unwrap();
        store.soft_delete_message("account", "m1").unwrap();
        assert_eq!(
            store.list_recent_messages("account", 10).unwrap()[0].status,
            "deleted"
        );
        assert!(store.list_pinned_message_ids("account").unwrap().is_empty());

        store
            .enqueue_outbox("account", "m1", &peer.public_key, "hello")
            .unwrap();
        assert_eq!(store.list_outbox("account", 10).unwrap().len(), 1);
        let queued = store.list_outbox_preview("account", 10).unwrap();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].msg_id, "m1");
        assert_eq!(queued[0].recipient_public_key, peer.public_key);
        assert_eq!(queued[0].plaintext, "hello");
        assert_eq!(queued[0].attempts, 0);
        assert!(queued[0].created_at_ms > 0);
        assert!(queued[0].updated_at_ms > 0);
        assert_eq!(queued[0].next_retry_at_ms, queued[0].updated_at_ms);
        store
            .mark_outbox_attempt("account", "m1", Some("network down"))
            .unwrap();
        let queued = store.list_outbox_preview("account", 10).unwrap();
        assert_eq!(queued[0].attempts, 1);
        assert_eq!(queued[0].last_error.as_deref(), Some("network down"));
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
        let profile = UserProfile::new("Alice", Some("alice_01"), "").unwrap();
        store.save_own_profile("account", &profile).unwrap();
        let stored_profile = store.load_own_profile("account").unwrap().unwrap();
        assert_eq!(stored_profile.nickname, "Alice");
        assert_eq!(stored_profile.username.as_deref(), Some("alice_01"));
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
