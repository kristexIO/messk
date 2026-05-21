use crate::{
    config,
    crypto::{Identity, decrypt_box_payload, decrypt_file_secretbox, encrypt_file_secretbox},
    media,
    protocol::Envelope,
    ratchet,
    storage::{LocalStore, MessageDirection, StoredChatMessage, now_ms},
};
use anyhow::{Context, Result, anyhow};
use futures_util::{SinkExt, StreamExt};
use messk_core::metadata::MetadataResistancePolicy;
use messk_core::payload::{EncryptedFilePayload, VoiceMessagePayload};
use messk_core::profile::UserProfile;
use messk_core::protocol as core_protocol;
use messk_core::transport;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::mpsc::UnboundedSender;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async, tungstenite::Message};
use url::Url;
use uuid::Uuid;

type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;
const BOOTSTRAP_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_BOOTSTRAP_DISCOVERY_ORIGINS: usize = 32;

#[derive(Debug, Clone)]
pub struct HealthStatus {
    pub status: String,
    pub raw: String,
}

#[derive(Debug, Clone)]
pub struct RealtimeSession {
    pub session_token: String,
}

#[derive(Debug, Clone)]
pub struct DirectSendResult {
    pub msg_id: String,
    pub used_prekey: bool,
    pub acknowledged: bool,
}

#[derive(Debug, Clone)]
pub struct DirectoryResolveResult {
    pub username: String,
    pub pub_key: String,
    pub nickname: String,
    pub avatar: String,
}

#[derive(Debug, Clone)]
pub struct RemoteProfile {
    pub pub_key: String,
    pub nickname: String,
    pub avatar: String,
    pub username: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DirectoryResolveResponse {
    #[serde(default)]
    username: String,
    #[serde(rename = "pubKey")]
    pub_key: String,
    #[serde(default)]
    nickname: String,
    #[serde(default)]
    avatar: String,
}

#[derive(Debug, Deserialize)]
struct RemoteProfileResponse {
    #[serde(rename = "pubKey")]
    pub_key: String,
    #[serde(default)]
    nickname: String,
    #[serde(default)]
    avatar: String,
    #[serde(default)]
    username: String,
}

#[derive(Debug, Deserialize)]
struct BootstrapResponse {
    #[serde(default)]
    relays: Vec<BootstrapRelayCapability>,
}

#[derive(Debug, Deserialize)]
struct BootstrapRelayCapability {
    #[serde(rename = "endpointOrigins", default)]
    endpoint_origins: Vec<String>,
    #[serde(default)]
    transports: Vec<String>,
}

#[derive(Debug, Serialize)]
struct SaveProfileRequest<'a> {
    nickname: &'a str,
    avatar: &'a str,
    username: Option<&'a str>,
}

#[derive(Debug, Deserialize)]
struct DirectHistoryResponse {
    #[serde(default)]
    messages: Vec<DirectHistoryRecord>,
    #[serde(rename = "nextCursor")]
    next_cursor: i64,
    limit: usize,
}

#[derive(Debug, Deserialize)]
struct DirectHistoryRecord {
    id: i64,
    #[serde(rename = "msgId")]
    msg_id: String,
    #[serde(rename = "envelopeType")]
    envelope_type: String,
    #[serde(rename = "senderPubKey")]
    sender_public_key: String,
    #[serde(rename = "recipientPubKey", default)]
    recipient_public_key: String,
    #[serde(rename = "ciphertextPayload")]
    ciphertext_payload: Envelope,
    #[serde(rename = "deliveryState", default)]
    delivery_state: String,
}

#[derive(Debug, Clone)]
pub struct DirectFileUpload {
    pub payload: EncryptedFilePayload,
    pub plaintext_json: String,
}

#[derive(Debug, Clone)]
pub struct DirectVoiceUpload {
    pub payload: VoiceMessagePayload,
    pub plaintext_json: String,
}

#[derive(Debug, Deserialize)]
struct UploadResponse {
    url: String,
}

#[derive(Debug, Clone)]
pub enum RealtimeEvent {
    Authenticated(RealtimeSession),
    Info(String),
    IncomingDirect {
        msg_id: String,
        peer_public_key: String,
        sender_public_key: String,
        plaintext: String,
        recovered: bool,
    },
    MessageStatus {
        msg_id: String,
        status: String,
    },
    DirectEdited {
        msg_id: String,
        peer_public_key: String,
        plaintext: String,
    },
    DirectDeleted {
        msg_id: String,
        peer_public_key: String,
    },
    DirectReaction {
        msg_id: String,
        peer_public_key: String,
        actor_public_key: String,
        reaction: Option<String>,
    },
    DirectPinUpdated {
        msg_id: String,
        peer_public_key: String,
        pinned: bool,
    },
    CallSignal {
        kind: String,
        sender_public_key: String,
        data: String,
    },
    DirectDecryptFailed {
        msg_id: String,
        sender_public_key: String,
    },
}

pub async fn fetch_health(origin: String) -> Result<HealthStatus> {
    let url = config::health_url(&origin);
    let response = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .with_context(|| format!("failed to reach {url}"))?;
    let status_code = response.status();
    let raw = response.text().await.unwrap_or_default();
    if !status_code.is_success() {
        return Err(anyhow!("backend returned {status_code}: {raw}"));
    }
    let status = serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|value| {
            value
                .get("status")
                .and_then(|status| status.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "unknown".to_string());
    Ok(HealthStatus { status, raw })
}

pub async fn fetch_health_with_fallback(origins: Vec<String>) -> Result<HealthStatus> {
    let mut errors = Vec::new();
    for origin in expand_origins_via_bootstrap(origins).await {
        match fetch_health(origin.clone()).await {
            Ok(status) => return Ok(status),
            Err(error) => errors.push(format!("{origin}: {error}")),
        }
    }
    Err(anyhow!(
        "all backend health checks failed: {}",
        errors.join(" | ")
    ))
}

#[allow(dead_code)]
pub async fn resolve_username(
    origin: String,
    identity: Identity,
    username: String,
) -> Result<DirectoryResolveResult> {
    resolve_username_with_fallback(vec![origin], identity, username).await
}

pub async fn resolve_username_with_fallback(
    origins: Vec<String>,
    identity: Identity,
    username: String,
) -> Result<DirectoryResolveResult> {
    let username = username.trim().trim_start_matches('@').to_ascii_lowercase();
    if username.is_empty() {
        return Err(anyhow!("username is empty"));
    }

    let (_socket, session_token, origin) =
        connect_authenticated_with_fallback(&origins, &identity).await?;
    if session_token.trim().is_empty() {
        return Err(anyhow!("server did not return a session token"));
    }

    let url = config::directory_resolve_url(&origin, &username);
    let response = reqwest::Client::new()
        .get(&url)
        .header("X-Session-Token", session_token)
        .send()
        .await
        .with_context(|| format!("failed to resolve @{username}"))?;
    let status_code = response.status();
    let raw = response.text().await.unwrap_or_default();
    if status_code == reqwest::StatusCode::NOT_FOUND {
        return Err(anyhow!("@{username} was not found"));
    }
    if !status_code.is_success() {
        return Err(anyhow!("directory returned {status_code}: {raw}"));
    }

    let body: DirectoryResolveResponse =
        serde_json::from_str(&raw).context("directory response JSON is invalid")?;
    if body.pub_key.trim().is_empty() {
        return Err(anyhow!("directory response is missing public key"));
    }

    Ok(DirectoryResolveResult {
        username: if body.username.trim().is_empty() {
            username
        } else {
            body.username
        },
        pub_key: body.pub_key,
        nickname: body.nickname,
        avatar: body.avatar,
    })
}

#[allow(dead_code)]
pub async fn fetch_profile(
    origin: String,
    identity: Identity,
    public_key: String,
) -> Result<RemoteProfile> {
    fetch_profile_with_fallback(vec![origin], identity, public_key).await
}

pub async fn fetch_profile_with_fallback(
    origins: Vec<String>,
    identity: Identity,
    public_key: String,
) -> Result<RemoteProfile> {
    let (_socket, session_token, origin) =
        connect_authenticated_with_fallback(&origins, &identity).await?;
    if session_token.trim().is_empty() {
        return Err(anyhow!("server did not return a session token"));
    }
    let response = reqwest::Client::new()
        .get(config::profile_get_url(&origin, &public_key))
        .header("X-Session-Token", session_token)
        .send()
        .await
        .with_context(|| {
            format!(
                "failed to load profile {}",
                public_key.chars().take(8).collect::<String>()
            )
        })?;
    let status_code = response.status();
    let raw = response.text().await.unwrap_or_default();
    if status_code == reqwest::StatusCode::NOT_FOUND {
        return Err(anyhow!("profile was not found"));
    }
    if !status_code.is_success() {
        return Err(anyhow!("profile returned {status_code}: {raw}"));
    }
    let body: RemoteProfileResponse =
        serde_json::from_str(&raw).context("profile response JSON is invalid")?;
    Ok(RemoteProfile {
        pub_key: body.pub_key,
        nickname: body.nickname,
        avatar: body.avatar,
        username: if body.username.trim().is_empty() {
            None
        } else {
            Some(body.username.trim().to_string())
        },
    })
}

#[allow(dead_code)]
pub async fn save_profile(origin: String, identity: Identity, profile: UserProfile) -> Result<()> {
    save_profile_with_fallback(vec![origin], identity, profile).await
}

pub async fn save_profile_with_fallback(
    origins: Vec<String>,
    identity: Identity,
    profile: UserProfile,
) -> Result<()> {
    let (_socket, session_token, origin) =
        connect_authenticated_with_fallback(&origins, &identity).await?;
    if session_token.trim().is_empty() {
        return Err(anyhow!("server did not return a session token"));
    }
    let request = SaveProfileRequest {
        nickname: &profile.nickname,
        avatar: &profile.avatar,
        username: profile.username.as_deref(),
    };
    let response = reqwest::Client::new()
        .post(config::profile_url(&origin))
        .header("X-Session-Token", session_token)
        .json(&request)
        .send()
        .await
        .context("failed to save profile")?;
    let status_code = response.status();
    let raw = response.text().await.unwrap_or_default();
    if status_code == reqwest::StatusCode::CONFLICT {
        return Err(anyhow!("username is already taken"));
    }
    if !status_code.is_success() {
        return Err(anyhow!("profile save returned {status_code}: {raw}"));
    }
    Ok(())
}

#[allow(dead_code)]
pub async fn upload_direct_file(
    origin: String,
    identity: Identity,
    recipient_public_key: String,
    path: PathBuf,
) -> Result<DirectFileUpload> {
    upload_direct_file_with_fallback(vec![origin], identity, recipient_public_key, path).await
}

pub async fn upload_direct_file_with_fallback(
    origins: Vec<String>,
    identity: Identity,
    recipient_public_key: String,
    path: PathBuf,
) -> Result<DirectFileUpload> {
    let (_socket, session_token, origin) =
        connect_authenticated_with_fallback(&origins, &identity).await?;
    if session_token.trim().is_empty() {
        return Err(anyhow!("server did not return a session token"));
    }
    if recipient_public_key.trim().is_empty() {
        return Err(anyhow!("recipient public key is empty"));
    }

    let original =
        std::fs::read(&path).with_context(|| format!("failed to read {}", path.display()))?;
    if original.is_empty() {
        return Err(anyhow!("file is empty"));
    }
    let original_size = original.len() as u64;
    if original_size > media::MAX_ATTACHMENT_SIZE_BYTES {
        return Err(anyhow!("file is larger than 75 MB"));
    }
    let (encrypted, key) =
        encrypt_file_secretbox(&original).context("failed to encrypt attachment")?;
    let file_name = safe_file_name(&path);
    let mime_type = guess_mime_from_path(&path).to_string();

    let upload_name = format!("{file_name}.bin");
    let part = reqwest::multipart::Part::bytes(encrypted)
        .file_name(upload_name)
        .mime_str("application/octet-stream")?;
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("recipient_pub_key", recipient_public_key);

    let response = reqwest::Client::new()
        .post(config::upload_url(&origin))
        .header("X-Session-Token", session_token)
        .multipart(form)
        .send()
        .await
        .context("failed to upload attachment")?;
    let status_code = response.status();
    let raw = response.text().await.unwrap_or_default();
    if !status_code.is_success() {
        return Err(anyhow!("upload returned {status_code}: {raw}"));
    }
    let body: UploadResponse =
        serde_json::from_str(&raw).context("upload response JSON invalid")?;
    if body.url.trim().is_empty() {
        return Err(anyhow!("upload response is missing download URL"));
    }

    let payload = EncryptedFilePayload {
        url: absolute_url(&origin, &body.url),
        key,
        name: file_name,
        size: original_size,
        mime_type,
    };
    let plaintext_json = payload.to_plaintext_json();

    Ok(DirectFileUpload {
        payload,
        plaintext_json,
    })
}

#[allow(dead_code)]
pub async fn upload_direct_voice(
    origin: String,
    identity: Identity,
    recipient_public_key: String,
    path: PathBuf,
    duration_seconds: u64,
) -> Result<DirectVoiceUpload> {
    upload_direct_voice_with_fallback(
        vec![origin],
        identity,
        recipient_public_key,
        path,
        duration_seconds,
    )
    .await
}

pub async fn upload_direct_voice_with_fallback(
    origins: Vec<String>,
    identity: Identity,
    recipient_public_key: String,
    path: PathBuf,
    duration_seconds: u64,
) -> Result<DirectVoiceUpload> {
    let upload =
        upload_direct_file_with_fallback(origins, identity, recipient_public_key, path).await?;
    let payload = VoiceMessagePayload {
        url: upload.payload.url,
        key: upload.payload.key,
        duration_seconds,
        mime_type: media::normalized_voice_mime(&upload.payload.mime_type),
        size: upload.payload.size,
    };
    Ok(DirectVoiceUpload {
        plaintext_json: payload.to_plaintext_json(),
        payload,
    })
}

#[allow(dead_code)]
pub async fn download_encrypted_file(
    origin: String,
    identity: Identity,
    payload: EncryptedFilePayload,
    output_path: PathBuf,
) -> Result<()> {
    download_encrypted_file_with_fallback(vec![origin], identity, payload, output_path).await
}

pub async fn download_encrypted_file_with_fallback(
    origins: Vec<String>,
    identity: Identity,
    payload: EncryptedFilePayload,
    output_path: PathBuf,
) -> Result<()> {
    let (_socket, session_token, origin) =
        connect_authenticated_with_fallback(&origins, &identity).await?;
    if session_token.trim().is_empty() {
        return Err(anyhow!("server did not return a session token"));
    }
    let response = reqwest::Client::new()
        .get(absolute_url(&origin, &payload.url))
        .header("X-Session-Token", session_token)
        .send()
        .await
        .context("failed to download attachment")?;
    let status_code = response.status();
    let bytes = response.bytes().await.unwrap_or_default();
    if !status_code.is_success() {
        return Err(anyhow!(
            "download returned {status_code}: {}",
            String::from_utf8_lossy(&bytes)
        ));
    }
    let plaintext = decrypt_file_secretbox(&bytes, &payload.key)
        .context("failed to decrypt downloaded attachment")?;
    std::fs::write(&output_path, plaintext)
        .with_context(|| format!("failed to save {}", output_path.display()))?;
    Ok(())
}

#[allow(dead_code)]
pub async fn run_realtime(
    origin: String,
    identity: Identity,
    store: LocalStore,
    events: UnboundedSender<RealtimeEvent>,
) -> Result<()> {
    run_realtime_with_fallback(vec![origin], identity, store, events).await
}

pub async fn run_realtime_with_fallback(
    origins: Vec<String>,
    identity: Identity,
    store: LocalStore,
    events: UnboundedSender<RealtimeEvent>,
) -> Result<()> {
    let (mut socket, session_token, active_origin) =
        connect_authenticated_with_fallback(&origins, &identity).await?;
    send_realtime_event(
        &events,
        RealtimeEvent::Authenticated(RealtimeSession {
            session_token: session_token.clone(),
        }),
    );
    send_realtime_event(
        &events,
        RealtimeEvent::Info(format!(
            "realtime connected via {active_origin}; syncing prekeys and retry outbox"
        )),
    );
    ensure_prekeys_uploaded(&mut socket, &identity, &store, &events).await;

    let mut sessions: HashMap<String, ratchet::Session> = HashMap::new();
    let mut flush_interval = tokio::time::interval(Duration::from_secs(12));
    flush_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    flush_outbox(&origins, &identity, &store, &events).await;
    sync_known_direct_history(
        &active_origin,
        &session_token,
        &mut socket,
        &identity,
        &store,
        &mut sessions,
        &events,
    )
    .await;

    loop {
        tokio::select! {
            _ = flush_interval.tick() => {
                flush_outbox(&origins, &identity, &store, &events).await;
            }
            message = socket.next() => {
                let Some(message) = message else {
                    return Err(anyhow!("websocket closed"));
                };
                let message = message?;
                if !message.is_text() {
                    continue;
                }
                let text = message
                    .into_text()
                    .context("websocket message is not text")?;
                let envelope: Envelope =
                    serde_json::from_str(&text).context("websocket message JSON is invalid")?;
                handle_realtime_envelope(&mut socket, &identity, &store, &mut sessions, &events, envelope).await?;
            }
        }
    }
}

#[allow(dead_code)]
pub async fn send_direct_message_once(
    origin: String,
    identity: Identity,
    store: LocalStore,
    recipient_public_key: String,
    plaintext: String,
    msg_id: Option<String>,
) -> Result<DirectSendResult> {
    send_direct_message_once_with_fallback(
        vec![origin],
        identity,
        store,
        recipient_public_key,
        plaintext,
        msg_id,
    )
    .await
}

pub async fn send_direct_message_once_with_fallback(
    origins: Vec<String>,
    identity: Identity,
    store: LocalStore,
    recipient_public_key: String,
    plaintext: String,
    msg_id: Option<String>,
) -> Result<DirectSendResult> {
    let msg_id = msg_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    store.upsert_message(
        &identity.public_key,
        &StoredChatMessage {
            msg_id: msg_id.clone(),
            peer_public_key: recipient_public_key.clone(),
            sender_public_key: identity.public_key.clone(),
            text: plaintext.clone(),
            direction: MessageDirection::Outgoing,
            status: "pending".to_string(),
            created_at_ms: now_ms(),
        },
    )?;
    store.enqueue_outbox(
        &identity.public_key,
        &msg_id,
        &recipient_public_key,
        &plaintext,
    )?;

    match send_direct_message_network_to_origins(
        &origins,
        &identity,
        &store,
        recipient_public_key,
        plaintext,
        msg_id.clone(),
    )
    .await
    {
        Ok(result) => {
            if result.acknowledged {
                store.delete_outbox(&identity.public_key, &msg_id)?;
                store.update_message_status(&identity.public_key, &msg_id, "sent")?;
            } else {
                store.mark_outbox_attempt(
                    &identity.public_key,
                    &msg_id,
                    Some("server ack timeout"),
                )?;
            }
            Ok(result)
        }
        Err(error) => {
            let error_message = error.to_string();
            store.mark_outbox_attempt(&identity.public_key, &msg_id, Some(&error_message))?;
            store.update_message_status(&identity.public_key, &msg_id, "waiting_retry")?;
            Err(error)
        }
    }
}

#[allow(dead_code)]
pub async fn send_direct_edit_once(
    origin: String,
    identity: Identity,
    store: LocalStore,
    recipient_public_key: String,
    target_msg_id: String,
    plaintext: String,
) -> Result<DirectSendResult> {
    send_direct_edit_once_with_fallback(
        vec![origin],
        identity,
        store,
        recipient_public_key,
        target_msg_id,
        plaintext,
    )
    .await
}

pub async fn send_direct_edit_once_with_fallback(
    origins: Vec<String>,
    identity: Identity,
    store: LocalStore,
    recipient_public_key: String,
    target_msg_id: String,
    plaintext: String,
) -> Result<DirectSendResult> {
    if target_msg_id.trim().is_empty() {
        return Err(anyhow!("target message id is empty"));
    }
    let event_id = Uuid::new_v4().to_string();
    let mut session = store
        .load_session(&identity.public_key, &recipient_public_key)?
        .ok_or_else(|| anyhow!("secure session is not ready for edit"))?;
    let data = ratchet::encrypt_existing_direct_payload(&mut session, &plaintext)
        .context("failed to encrypt edit payload")?;
    store.save_session(&identity.public_key, &recipient_public_key, &session)?;
    let envelope = Envelope::direct_edit(
        event_id.clone(),
        target_msg_id,
        identity.public_key.clone(),
        recipient_public_key,
        data,
    );
    send_direct_control_network_to_origins(&origins, &identity, envelope, event_id).await
}

#[allow(dead_code)]
pub async fn send_direct_delete_once(
    origin: String,
    identity: Identity,
    recipient_public_key: String,
    target_msg_id: String,
) -> Result<DirectSendResult> {
    send_direct_delete_once_with_fallback(
        vec![origin],
        identity,
        recipient_public_key,
        target_msg_id,
    )
    .await
}

pub async fn send_direct_delete_once_with_fallback(
    origins: Vec<String>,
    identity: Identity,
    recipient_public_key: String,
    target_msg_id: String,
) -> Result<DirectSendResult> {
    send_direct_plain_control_once_with_fallback(
        origins,
        identity,
        recipient_public_key,
        target_msg_id,
        "delete",
        None,
    )
    .await
}

#[allow(dead_code)]
pub async fn send_direct_reaction_once(
    origin: String,
    identity: Identity,
    recipient_public_key: String,
    target_msg_id: String,
    reaction: Option<String>,
) -> Result<DirectSendResult> {
    send_direct_reaction_once_with_fallback(
        vec![origin],
        identity,
        recipient_public_key,
        target_msg_id,
        reaction,
    )
    .await
}

pub async fn send_direct_reaction_once_with_fallback(
    origins: Vec<String>,
    identity: Identity,
    recipient_public_key: String,
    target_msg_id: String,
    reaction: Option<String>,
) -> Result<DirectSendResult> {
    send_direct_plain_control_once_with_fallback(
        origins,
        identity,
        recipient_public_key,
        target_msg_id,
        "reaction",
        reaction,
    )
    .await
}

#[allow(dead_code)]
pub async fn send_direct_pin_once(
    origin: String,
    identity: Identity,
    recipient_public_key: String,
    target_msg_id: String,
    pinned: bool,
) -> Result<DirectSendResult> {
    send_direct_pin_once_with_fallback(
        vec![origin],
        identity,
        recipient_public_key,
        target_msg_id,
        pinned,
    )
    .await
}

pub async fn send_direct_pin_once_with_fallback(
    origins: Vec<String>,
    identity: Identity,
    recipient_public_key: String,
    target_msg_id: String,
    pinned: bool,
) -> Result<DirectSendResult> {
    let kind = if pinned { "pin" } else { "unpin" };
    send_direct_plain_control_once_with_fallback(
        origins,
        identity,
        recipient_public_key,
        target_msg_id,
        kind,
        None,
    )
    .await
}

#[allow(dead_code)]
pub async fn send_call_signal_once(
    origin: String,
    identity: Identity,
    recipient_public_key: String,
    kind: String,
    data: String,
) -> Result<DirectSendResult> {
    send_call_signal_once_with_fallback(vec![origin], identity, recipient_public_key, kind, data)
        .await
}

pub async fn send_call_signal_once_with_fallback(
    origins: Vec<String>,
    identity: Identity,
    recipient_public_key: String,
    kind: String,
    data: String,
) -> Result<DirectSendResult> {
    if recipient_public_key.trim().is_empty() {
        return Err(anyhow!("recipient public key is empty"));
    }
    if !core_protocol::is_call_signal(&kind) {
        return Err(anyhow!("unsupported call signal type {kind}"));
    }

    let event_id = Uuid::new_v4().to_string();
    let envelope = Envelope {
        kind,
        msg_id: Some(event_id.clone()),
        target_msg_id: None,
        recipient_pub_key: Some(recipient_public_key),
        sender_pub_key: Some(identity.public_key.clone()),
        data: Some(data),
        reaction: None,
        challenge: None,
        ephemeral: None,
        session_token: None,
        prekeys: None,
        prekey: None,
        signed_prekey: None,
        signed_prekey_sig: None,
        ack_type: None,
        message: None,
    };
    send_direct_control_network_to_origins(&origins, &identity, envelope, event_id).await
}

#[allow(dead_code)]
pub async fn flush_outbox_once(
    origin: String,
    identity: Identity,
    store: LocalStore,
    events: UnboundedSender<RealtimeEvent>,
) {
    flush_outbox_once_with_fallback(vec![origin], identity, store, events).await;
}

pub async fn flush_outbox_once_with_fallback(
    origins: Vec<String>,
    identity: Identity,
    store: LocalStore,
    events: UnboundedSender<RealtimeEvent>,
) {
    flush_outbox(&origins, &identity, &store, &events).await;
}

#[allow(dead_code)]
async fn send_direct_message_network(
    origin: String,
    identity: &Identity,
    store: &LocalStore,
    recipient_public_key: String,
    plaintext: String,
    msg_id: String,
) -> Result<DirectSendResult> {
    send_direct_message_network_to_origins(
        &[origin],
        identity,
        store,
        recipient_public_key,
        plaintext,
        msg_id,
    )
    .await
}

async fn send_direct_message_network_to_origins(
    origins: &[String],
    identity: &Identity,
    store: &LocalStore,
    recipient_public_key: String,
    plaintext: String,
    msg_id: String,
) -> Result<DirectSendResult> {
    let (mut socket, _, _active_origin) =
        connect_authenticated_with_fallback(origins, identity).await?;
    let (data, used_prekey) = if let Some(mut session) =
        store.load_session(&identity.public_key, &recipient_public_key)?
    {
        let data = ratchet::encrypt_existing_direct_payload(&mut session, &plaintext)
            .context("failed to encrypt direct message with existing session")?;
        store.save_session(&identity.public_key, &recipient_public_key, &session)?;
        (data, false)
    } else {
        let prekey = request_prekey(&mut socket, &recipient_public_key).await?;
        let handshake = crate::crypto::x3dh_initiate(
            identity.secret_key.expose(),
            &recipient_public_key,
            prekey.as_deref(),
        )
        .context("failed to create X3DH session")?;
        let (data, session) = ratchet::encrypt_initial_direct_payload_with_session(
            &recipient_public_key,
            &handshake,
            &plaintext,
        )
        .context("failed to encrypt initial direct message")?;
        store.save_session(&identity.public_key, &recipient_public_key, &session)?;
        (data, prekey.is_some())
    };

    let envelope = Envelope::direct_message(
        msg_id.clone(),
        identity.public_key.clone(),
        recipient_public_key,
        data,
    );
    apply_metadata_batch_delay(
        envelope.recipient_pub_key.as_deref().unwrap_or_default(),
        &msg_id,
    )
    .await;
    socket
        .send(Message::Text(serde_json::to_string(&envelope)?.into()))
        .await
        .context("failed to send direct message")?;

    let acknowledged = wait_for_server_ack(&mut socket, &msg_id)
        .await
        .unwrap_or(false);

    Ok(DirectSendResult {
        msg_id,
        used_prekey,
        acknowledged,
    })
}

#[allow(dead_code)]
async fn send_direct_plain_control_once(
    origin: String,
    identity: Identity,
    recipient_public_key: String,
    target_msg_id: String,
    kind: &str,
    reaction: Option<String>,
) -> Result<DirectSendResult> {
    send_direct_plain_control_once_with_fallback(
        vec![origin],
        identity,
        recipient_public_key,
        target_msg_id,
        kind,
        reaction,
    )
    .await
}

async fn send_direct_plain_control_once_with_fallback(
    origins: Vec<String>,
    identity: Identity,
    recipient_public_key: String,
    target_msg_id: String,
    kind: &str,
    reaction: Option<String>,
) -> Result<DirectSendResult> {
    if target_msg_id.trim().is_empty() {
        return Err(anyhow!("target message id is empty"));
    }
    let event_id = Uuid::new_v4().to_string();
    let envelope = match kind {
        "delete" => Envelope::direct_delete(
            event_id.clone(),
            target_msg_id,
            identity.public_key.clone(),
            recipient_public_key,
        ),
        "reaction" => Envelope::direct_reaction(
            event_id.clone(),
            target_msg_id,
            identity.public_key.clone(),
            recipient_public_key,
            reaction,
        ),
        "pin" => Envelope::direct_pin(
            event_id.clone(),
            target_msg_id,
            identity.public_key.clone(),
            recipient_public_key,
        ),
        "unpin" => Envelope::direct_unpin(
            event_id.clone(),
            target_msg_id,
            identity.public_key.clone(),
            recipient_public_key,
        ),
        other => return Err(anyhow!("unsupported direct control type {other}")),
    };
    send_direct_control_network_to_origins(&origins, &identity, envelope, event_id).await
}

#[allow(dead_code)]
async fn send_direct_control_network(
    origin: String,
    identity: &Identity,
    envelope: Envelope,
    event_id: String,
) -> Result<DirectSendResult> {
    send_direct_control_network_to_origins(&[origin], identity, envelope, event_id).await
}

async fn send_direct_control_network_to_origins(
    origins: &[String],
    identity: &Identity,
    envelope: Envelope,
    event_id: String,
) -> Result<DirectSendResult> {
    let (mut socket, _, _active_origin) =
        connect_authenticated_with_fallback(origins, identity).await?;
    apply_metadata_batch_delay(
        envelope.recipient_pub_key.as_deref().unwrap_or_default(),
        &event_id,
    )
    .await;
    socket
        .send(Message::Text(serde_json::to_string(&envelope)?.into()))
        .await
        .context("failed to send direct control event")?;
    let acknowledged = wait_for_server_ack(&mut socket, &event_id)
        .await
        .unwrap_or(false);
    Ok(DirectSendResult {
        msg_id: event_id,
        used_prekey: false,
        acknowledged,
    })
}

async fn apply_metadata_batch_delay(thread_id: &str, msg_id: &str) {
    let delay_ms = MetadataResistancePolicy::default().batch_delay_ms(thread_id, msg_id);
    if delay_ms > 0 {
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
    }
}

async fn handle_realtime_envelope(
    socket: &mut WsStream,
    identity: &Identity,
    store: &LocalStore,
    sessions: &mut HashMap<String, ratchet::Session>,
    events: &UnboundedSender<RealtimeEvent>,
    envelope: Envelope,
) -> Result<()> {
    match envelope.kind.as_str() {
        "server_ack" => Ok(()),
        "delivery_receipt" | "read_receipt" => {
            if let Some(msg_id) = envelope.msg_id {
                let status = if envelope.kind == "read_receipt" {
                    "read"
                } else {
                    "delivered"
                };
                store.update_message_status(&identity.public_key, &msg_id, status)?;
                send_realtime_event(
                    events,
                    RealtimeEvent::MessageStatus {
                        msg_id,
                        status: status.to_string(),
                    },
                );
            }
            Ok(())
        }
        "message" | "offline_message" => {
            handle_direct_envelope(socket, identity, store, sessions, events, envelope, false).await
        }
        "edit" | "delete" | "reaction" | "pin" | "unpin" => {
            handle_direct_control_envelope(socket, identity, store, sessions, events, envelope)
                .await
        }
        kind if core_protocol::is_call_signal(kind) => {
            send_realtime_event(
                events,
                RealtimeEvent::CallSignal {
                    kind: envelope.kind,
                    sender_public_key: envelope.sender_pub_key.unwrap_or_default(),
                    data: envelope.data.unwrap_or_default(),
                },
            );
            Ok(())
        }
        "rate_limited" => {
            send_realtime_event(
                events,
                RealtimeEvent::Info(
                    envelope
                        .message
                        .unwrap_or_else(|| "server rate limit".to_string()),
                ),
            );
            Ok(())
        }
        "dummy" => Ok(()),
        other => {
            send_realtime_event(
                events,
                RealtimeEvent::Info(format!("ignored ws event: {other}")),
            );
            Ok(())
        }
    }
}

async fn handle_direct_envelope(
    socket: &mut WsStream,
    identity: &Identity,
    store: &LocalStore,
    sessions: &mut HashMap<String, ratchet::Session>,
    events: &UnboundedSender<RealtimeEvent>,
    envelope: Envelope,
    recovered: bool,
) -> Result<()> {
    let is_offline_message = envelope.kind == "offline_message";
    let my_public_key = identity.public_key.trim();
    let sender_public_key = envelope.sender_pub_key.clone().unwrap_or_default();
    let recipient_public_key = envelope.recipient_pub_key.clone().unwrap_or_default();
    let msg_id = envelope
        .msg_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    if sender_public_key.is_empty() || recipient_public_key.is_empty() {
        return Ok(());
    }

    let is_for_me = recipient_public_key == my_public_key;
    let is_from_me = sender_public_key == my_public_key;
    if !is_for_me && !is_from_me {
        return Ok(());
    }

    if is_from_me && !is_for_me {
        if is_offline_message {
            acknowledge_offline(socket, &msg_id).await?;
        }
        return Ok(());
    }

    if sender_public_key == recipient_public_key {
        if is_offline_message {
            acknowledge_offline(socket, &msg_id).await?;
        }
        return Ok(());
    }

    let peer_public_key = if is_from_me {
        recipient_public_key.clone()
    } else {
        sender_public_key.clone()
    };
    if store.message_exists(&identity.public_key, &msg_id)? {
        if sender_public_key != my_public_key {
            let receipt = Envelope::delivery_receipt(
                msg_id.clone(),
                identity.public_key.clone(),
                sender_public_key.clone(),
            );
            send_envelope(socket, &receipt).await?;
            acknowledge_offline(socket, &msg_id).await?;
        } else if is_offline_message {
            acknowledge_offline(socket, &msg_id).await?;
        }
        return Ok(());
    }
    let Some(data) = envelope.data.as_deref() else {
        if is_offline_message {
            acknowledge_offline(socket, &msg_id).await?;
        }
        return Ok(());
    };
    let plaintext = match decrypt_direct_payload(identity, store, sessions, &peer_public_key, data)
    {
        Ok(plaintext) => plaintext,
        Err(error) => {
            send_realtime_event(
                events,
                RealtimeEvent::Info(format!("invalid direct payload {msg_id}: {error}")),
            );
            if is_offline_message {
                acknowledge_offline(socket, &msg_id).await?;
            }
            return Ok(());
        }
    };

    if let Some(plaintext) = plaintext {
        let stored_plaintext = plaintext.clone();
        send_realtime_event(
            events,
            RealtimeEvent::IncomingDirect {
                msg_id: msg_id.clone(),
                peer_public_key: peer_public_key.clone(),
                sender_public_key: sender_public_key.clone(),
                plaintext,
                recovered,
            },
        );
        store.upsert_message(
            &identity.public_key,
            &StoredChatMessage {
                msg_id: msg_id.clone(),
                peer_public_key: peer_public_key.clone(),
                sender_public_key: sender_public_key.clone(),
                text: stored_plaintext,
                direction: MessageDirection::Incoming,
                status: "delivered".to_string(),
                created_at_ms: now_ms(),
            },
        )?;
        if sender_public_key != my_public_key {
            let receipt = Envelope::delivery_receipt(
                msg_id.clone(),
                identity.public_key.clone(),
                sender_public_key.clone(),
            );
            send_envelope(socket, &receipt).await?;
        }
    } else {
        sessions.remove(&peer_public_key);
        store.delete_session(&identity.public_key, &peer_public_key)?;
        send_realtime_event(
            events,
            RealtimeEvent::DirectDecryptFailed {
                msg_id: msg_id.clone(),
                sender_public_key: sender_public_key.clone(),
            },
        );
    }

    if sender_public_key != my_public_key || is_offline_message {
        acknowledge_offline(socket, &msg_id).await?;
    }
    Ok(())
}

async fn handle_direct_control_envelope(
    socket: &mut WsStream,
    identity: &Identity,
    store: &LocalStore,
    sessions: &mut HashMap<String, ratchet::Session>,
    events: &UnboundedSender<RealtimeEvent>,
    envelope: Envelope,
) -> Result<()> {
    let my_public_key = identity.public_key.trim();
    let sender_public_key = envelope.sender_pub_key.clone().unwrap_or_default();
    let recipient_public_key = envelope.recipient_pub_key.clone().unwrap_or_default();
    let event_id = envelope
        .msg_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let target_msg_id = envelope
        .target_msg_id
        .clone()
        .or_else(|| envelope.msg_id.clone())
        .unwrap_or_default();

    if sender_public_key.is_empty() || recipient_public_key.is_empty() {
        return Ok(());
    }

    let is_for_me = recipient_public_key == my_public_key;
    let is_from_me = sender_public_key == my_public_key;
    if !is_for_me && !is_from_me {
        return Ok(());
    }

    let peer_public_key = if is_from_me {
        recipient_public_key.clone()
    } else {
        sender_public_key.clone()
    };
    if peer_public_key.trim().is_empty() || target_msg_id.trim().is_empty() {
        if !is_from_me {
            acknowledge_offline(socket, &event_id).await?;
        }
        return Ok(());
    }

    match envelope.kind.as_str() {
        "edit" => {
            let Some(data) = envelope.data.as_deref() else {
                if !is_from_me {
                    acknowledge_offline(socket, &event_id).await?;
                }
                return Ok(());
            };
            match decrypt_direct_payload(identity, store, sessions, &peer_public_key, data) {
                Ok(Some(plaintext)) => {
                    store.update_message_text(&identity.public_key, &target_msg_id, &plaintext)?;
                    send_realtime_event(
                        events,
                        RealtimeEvent::DirectEdited {
                            msg_id: target_msg_id.clone(),
                            peer_public_key: peer_public_key.clone(),
                            plaintext,
                        },
                    );
                }
                Ok(None) => {
                    send_realtime_event(
                        events,
                        RealtimeEvent::DirectDecryptFailed {
                            msg_id: target_msg_id.clone(),
                            sender_public_key: sender_public_key.clone(),
                        },
                    );
                }
                Err(error) => send_realtime_event(
                    events,
                    RealtimeEvent::Info(format!("invalid edit payload {event_id}: {error}")),
                ),
            }
        }
        "delete" => {
            store.soft_delete_message(&identity.public_key, &target_msg_id)?;
            send_realtime_event(
                events,
                RealtimeEvent::DirectDeleted {
                    msg_id: target_msg_id.clone(),
                    peer_public_key: peer_public_key.clone(),
                },
            );
        }
        "reaction" => {
            let reaction = envelope
                .reaction
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned);
            store.set_message_reaction(
                &identity.public_key,
                &target_msg_id,
                &sender_public_key,
                reaction.as_deref(),
            )?;
            send_realtime_event(
                events,
                RealtimeEvent::DirectReaction {
                    msg_id: target_msg_id.clone(),
                    peer_public_key: peer_public_key.clone(),
                    actor_public_key: sender_public_key.clone(),
                    reaction,
                },
            );
        }
        "pin" => {
            store.pin_message(&identity.public_key, &target_msg_id)?;
            send_realtime_event(
                events,
                RealtimeEvent::DirectPinUpdated {
                    msg_id: target_msg_id.clone(),
                    peer_public_key: peer_public_key.clone(),
                    pinned: true,
                },
            );
        }
        "unpin" => {
            store.unpin_message(&identity.public_key, &target_msg_id)?;
            send_realtime_event(
                events,
                RealtimeEvent::DirectPinUpdated {
                    msg_id: target_msg_id.clone(),
                    peer_public_key: peer_public_key.clone(),
                    pinned: false,
                },
            );
        }
        _ => {}
    }

    if !is_from_me {
        acknowledge_offline(socket, &event_id).await?;
    }
    Ok(())
}

fn decrypt_direct_payload(
    identity: &Identity,
    store: &LocalStore,
    sessions: &mut HashMap<String, ratchet::Session>,
    peer_public_key: &str,
    data: &str,
) -> Result<Option<String>> {
    let payload: ratchet::RatchetPayload =
        serde_json::from_str(data).context("ratchet payload JSON is invalid")?;
    let message = ratchet::RatchetMessage {
        header: payload.header.clone(),
        ciphertext: payload.ciphertext.clone(),
    };

    let mut plaintext = if let Some(session) = sessions.get_mut(peer_public_key) {
        let plaintext = ratchet::decrypt(session, &message).ok().flatten();
        if plaintext.is_some() {
            store.save_session(&identity.public_key, peer_public_key, session)?;
        }
        plaintext
    } else if let Some(mut session) = store.load_session(&identity.public_key, peer_public_key)? {
        let plaintext = ratchet::decrypt(&mut session, &message).ok().flatten();
        if plaintext.is_some() {
            store.save_session(&identity.public_key, peer_public_key, &session)?;
            sessions.insert(peer_public_key.to_string(), session);
        }
        plaintext
    } else {
        None
    };

    if plaintext.is_none()
        && let Some(x3dh) = &payload.x3dh
    {
        let prekey_secret = if let Some(prekey_public) = &x3dh.pre_key_public_key {
            store
                .load_prekey(&identity.public_key, prekey_public)?
                .map(|prekey| prekey.secret_key)
        } else {
            None
        };
        let shared_secret = crate::crypto::x3dh_respond(
            identity.secret_key.expose(),
            prekey_secret.as_deref(),
            peer_public_key,
            &x3dh.ephemeral_public_key,
        )
        .context("failed to create responder X3DH session")?;
        let mut fresh_session = ratchet::Session::new_responder(
            peer_public_key.to_string(),
            shared_secret,
            payload.header.ratchet_pub_key.clone(),
        )?;
        plaintext = ratchet::decrypt(&mut fresh_session, &message)?;
        if plaintext.is_some() {
            store.save_session(&identity.public_key, peer_public_key, &fresh_session)?;
            if let Some(prekey_public) = &x3dh.pre_key_public_key {
                store.delete_prekey(&identity.public_key, prekey_public)?;
            }
            sessions.insert(peer_public_key.to_string(), fresh_session);
        }
    }

    Ok(plaintext)
}

async fn sync_known_direct_history(
    origin: &str,
    session_token: &str,
    socket: &mut WsStream,
    identity: &Identity,
    store: &LocalStore,
    sessions: &mut HashMap<String, ratchet::Session>,
    events: &UnboundedSender<RealtimeEvent>,
) {
    if session_token.trim().is_empty() {
        return;
    }

    let contacts = match store.list_contacts(&identity.public_key) {
        Ok(contacts) => contacts,
        Err(error) => {
            send_realtime_event(
                events,
                RealtimeEvent::Info(format!("history contact list failed: {error}")),
            );
            return;
        }
    };
    if contacts.is_empty() {
        return;
    }

    let mut recovered = 0usize;
    for contact in contacts.into_iter().take(20) {
        match sync_direct_history_for_peer(
            origin,
            session_token,
            socket,
            identity,
            store,
            sessions,
            events,
            &contact.peer_public_key,
        )
        .await
        {
            Ok(count) => recovered += count,
            Err(error) => send_realtime_event(
                events,
                RealtimeEvent::Info(format!(
                    "history sync failed for {}: {error}",
                    short_key(&contact.peer_public_key)
                )),
            ),
        }
    }

    if recovered > 0 {
        send_realtime_event(
            events,
            RealtimeEvent::Info(format!("recovered {recovered} direct history messages")),
        );
    }
}

#[allow(clippy::too_many_arguments)]
async fn sync_direct_history_for_peer(
    origin: &str,
    session_token: &str,
    socket: &mut WsStream,
    identity: &Identity,
    store: &LocalStore,
    sessions: &mut HashMap<String, ratchet::Session>,
    events: &UnboundedSender<RealtimeEvent>,
    peer_public_key: &str,
) -> Result<usize> {
    let peer_public_key = peer_public_key.trim();
    if peer_public_key.is_empty() || peer_public_key == identity.public_key {
        return Ok(0);
    }

    let mut cursor = 0i64;
    let mut recovered = 0usize;
    for _ in 0..5 {
        let page =
            fetch_direct_history_page(origin, session_token, peer_public_key, cursor, 100).await?;
        if page.messages.is_empty() {
            break;
        }
        let page_len = page.messages.len();
        let page_limit = page.limit;
        let next_cursor = page.next_cursor;

        for record in page.messages {
            if record.id > cursor {
                cursor = record.id;
            }
            if record.sender_public_key == identity.public_key {
                if matches!(record.envelope_type.as_str(), "message" | "offline_message") {
                    let status = history_delivery_status(&record.delivery_state);
                    store.update_message_status(&identity.public_key, &record.msg_id, status)?;
                }
                continue;
            }

            let mut envelope = record.ciphertext_payload;
            if envelope.kind.is_empty() {
                envelope.kind = record.envelope_type.clone();
            }
            if envelope.msg_id.is_none() {
                envelope.msg_id = Some(record.msg_id.clone());
            }
            if envelope.sender_pub_key.is_none() && !record.sender_public_key.is_empty() {
                envelope.sender_pub_key = Some(record.sender_public_key.clone());
            }
            if envelope.recipient_pub_key.is_none() && !record.recipient_public_key.is_empty() {
                envelope.recipient_pub_key = Some(record.recipient_public_key.clone());
            }

            match envelope.kind.as_str() {
                "message" | "offline_message" => {
                    envelope.kind = "message".to_string();
                    let msg_id = envelope
                        .msg_id
                        .clone()
                        .unwrap_or_else(|| record.msg_id.clone());
                    let existed_before = store.message_exists(&identity.public_key, &msg_id)?;
                    handle_direct_envelope(
                        socket, identity, store, sessions, events, envelope, true,
                    )
                    .await?;
                    if !existed_before && store.message_exists(&identity.public_key, &msg_id)? {
                        recovered += 1;
                    }
                }
                "edit" | "delete" | "reaction" | "pin" | "unpin" => {
                    handle_direct_control_envelope(
                        socket, identity, store, sessions, events, envelope,
                    )
                    .await?;
                }
                _ => {}
            }
        }

        if next_cursor <= cursor {
            break;
        }
        cursor = next_cursor;
        if page_len < page_limit {
            break;
        }
    }

    Ok(recovered)
}

async fn fetch_direct_history_page(
    origin: &str,
    session_token: &str,
    peer_public_key: &str,
    cursor: i64,
    limit: usize,
) -> Result<DirectHistoryResponse> {
    let url = config::direct_history_url(origin, peer_public_key, cursor, limit);
    let response = reqwest::Client::new()
        .get(&url)
        .header("X-Session-Token", session_token)
        .send()
        .await
        .with_context(|| {
            format!(
                "failed to load direct history {}",
                short_key(peer_public_key)
            )
        })?;
    let status_code = response.status();
    let raw = response.text().await.unwrap_or_default();
    if !status_code.is_success() {
        return Err(anyhow!("history returned {status_code}: {raw}"));
    }
    serde_json::from_str(&raw).context("direct history response JSON is invalid")
}

fn history_delivery_status(delivery_state: &str) -> &'static str {
    match delivery_state {
        "delivered" => "delivered",
        "read" => "read",
        _ => "sent",
    }
}

fn short_key(value: &str) -> String {
    if value.len() <= 16 {
        return value.to_string();
    }
    format!("{}...{}", &value[..10], &value[value.len() - 6..])
}

async fn ensure_prekeys_uploaded(
    socket: &mut WsStream,
    identity: &Identity,
    store: &LocalStore,
    events: &UnboundedSender<RealtimeEvent>,
) {
    let count = match store.count_prekeys(&identity.public_key) {
        Ok(count) => count,
        Err(error) => {
            send_realtime_event(
                events,
                RealtimeEvent::Info(format!("prekey count failed: {error}")),
            );
            return;
        }
    };

    if count == 0 {
        if let Err(error) = send_envelope(socket, &Envelope::clear_prekeys()).await {
            send_realtime_event(
                events,
                RealtimeEvent::Info(format!("failed to clear stale server prekeys: {error}")),
            );
        } else {
            send_realtime_event(
                events,
                RealtimeEvent::Info("requested stale server prekey cleanup".to_string()),
            );
        }
    }

    if count < 50 {
        let missing = 100usize.saturating_sub(count);
        let mut generated = Vec::with_capacity(missing);
        for _ in 0..missing {
            match crate::crypto::generate_box_keypair() {
                Ok(prekey) => generated.push(prekey),
                Err(error) => {
                    send_realtime_event(
                        events,
                        RealtimeEvent::Info(format!("prekey generation failed: {error}")),
                    );
                    return;
                }
            }
        }
        if let Err(error) = store.save_prekeys(&identity.public_key, &generated) {
            send_realtime_event(
                events,
                RealtimeEvent::Info(format!("prekey store failed: {error}")),
            );
            return;
        }
    }

    let public_prekeys = match store.list_prekey_public_keys(&identity.public_key, 100) {
        Ok(prekeys) => prekeys,
        Err(error) => {
            send_realtime_event(
                events,
                RealtimeEvent::Info(format!("prekey list failed: {error}")),
            );
            return;
        }
    };
    if public_prekeys.is_empty() {
        return;
    }

    let envelope = Envelope::upload_prekeys(identity.public_key.clone(), public_prekeys.clone());
    match send_envelope(socket, &envelope).await {
        Ok(()) => send_realtime_event(
            events,
            RealtimeEvent::Info(format!("uploaded {} native prekeys", public_prekeys.len())),
        ),
        Err(error) => send_realtime_event(
            events,
            RealtimeEvent::Info(format!("prekey upload failed: {error}")),
        ),
    }
}

async fn flush_outbox(
    origins: &[String],
    identity: &Identity,
    store: &LocalStore,
    events: &UnboundedSender<RealtimeEvent>,
) {
    let queued = match store.list_outbox(&identity.public_key, 20) {
        Ok(queued) => queued,
        Err(error) => {
            send_realtime_event(
                events,
                RealtimeEvent::Info(format!("outbox read failed: {error}")),
            );
            return;
        }
    };

    if queued.is_empty() {
        return;
    }

    send_realtime_event(
        events,
        RealtimeEvent::Info(format!("flushing {} queued messages", queued.len())),
    );

    for message in queued {
        if let Some(last_error) = &message.last_error {
            send_realtime_event(
                events,
                RealtimeEvent::Info(format!(
                    "retrying {} after previous error: {}",
                    message.msg_id, last_error
                )),
            );
        }
        let result = send_direct_message_once_with_fallback(
            origins.to_vec(),
            identity.clone(),
            store.clone(),
            message.recipient_public_key.clone(),
            message.plaintext.clone(),
            Some(message.msg_id.clone()),
        )
        .await;
        match result {
            Ok(result) => {
                let status = if result.acknowledged {
                    "sent"
                } else {
                    "pending"
                };
                send_realtime_event(
                    events,
                    RealtimeEvent::MessageStatus {
                        msg_id: result.msg_id.clone(),
                        status: status.to_string(),
                    },
                );
                send_realtime_event(
                    events,
                    RealtimeEvent::Info(format!("outbox sent {}", result.msg_id)),
                );
            }
            Err(error) => {
                send_realtime_event(
                    events,
                    RealtimeEvent::MessageStatus {
                        msg_id: message.msg_id.clone(),
                        status: "waiting_retry".to_string(),
                    },
                );
                send_realtime_event(
                    events,
                    RealtimeEvent::Info(format!(
                        "outbox kept {} after attempt {}: {error}",
                        message.msg_id,
                        message.attempts + 1
                    )),
                );
            }
        }
    }
}

async fn acknowledge_offline(socket: &mut WsStream, msg_id: &str) -> Result<()> {
    send_envelope(socket, &Envelope::offline_ack(msg_id.to_string())).await
}

async fn send_envelope(socket: &mut WsStream, envelope: &Envelope) -> Result<()> {
    socket
        .send(Message::Text(serde_json::to_string(envelope)?.into()))
        .await?;
    Ok(())
}

fn send_realtime_event(events: &UnboundedSender<RealtimeEvent>, event: RealtimeEvent) {
    let _ = events.send(event);
}

async fn connect_authenticated(origin: String, identity: &Identity) -> Result<(WsStream, String)> {
    let url = config::websocket_url(&origin, &identity.public_key);
    let (mut socket, _) = connect_async(&url)
        .await
        .with_context(|| format!("failed to connect websocket {url}"))?;

    let challenge_message = socket
        .next()
        .await
        .ok_or_else(|| anyhow!("websocket closed before auth challenge"))??;
    let challenge_text = challenge_message
        .into_text()
        .context("auth challenge is not text")?;
    let challenge: Envelope =
        serde_json::from_str(&challenge_text).context("auth challenge JSON is invalid")?;
    if challenge.kind != "auth_challenge" {
        return Err(anyhow!("expected auth_challenge, got {}", challenge.kind));
    }

    let encrypted_challenge = challenge
        .challenge
        .as_deref()
        .ok_or_else(|| anyhow!("auth challenge is missing ciphertext"))?;
    let ephemeral = challenge
        .ephemeral
        .as_deref()
        .ok_or_else(|| anyhow!("auth challenge is missing ephemeral key"))?;
    let plaintext_challenge =
        decrypt_box_payload(encrypted_challenge, identity.secret_key.expose(), ephemeral)
            .context("failed to decrypt auth challenge")?;

    let response = serde_json::to_string(&Envelope::auth_response(plaintext_challenge))?;
    socket.send(Message::Text(response.into())).await?;

    let success_message = socket
        .next()
        .await
        .ok_or_else(|| anyhow!("websocket closed before auth result"))??;
    let success_text = success_message
        .into_text()
        .context("auth result is not text")?;
    let success: Envelope =
        serde_json::from_str(&success_text).context("auth result JSON is invalid")?;
    if success.kind != "auth_success" {
        let message = success
            .message
            .unwrap_or_else(|| "authentication failed".to_string());
        return Err(anyhow!("{message}"));
    }

    Ok((socket, success.session_token.unwrap_or_default()))
}

async fn connect_authenticated_with_fallback(
    origins: &[String],
    identity: &Identity,
) -> Result<(WsStream, String, String)> {
    let mut errors = Vec::new();
    for origin in expand_origins_via_bootstrap(origins.to_vec()).await {
        match connect_authenticated(origin.clone(), identity).await {
            Ok((socket, session_token)) => return Ok((socket, session_token, origin)),
            Err(error) => errors.push(format!("{origin}: {error}")),
        }
    }
    Err(anyhow!(
        "all websocket transports failed: {}",
        errors.join(" | ")
    ))
}

fn normalize_origin_candidates(origins: Vec<String>) -> Vec<String> {
    let primary = origins
        .first()
        .cloned()
        .unwrap_or_else(|| config::DEFAULT_BACKEND_ORIGIN.to_string());
    let fallbacks = origins.into_iter().skip(1).collect::<Vec<_>>();
    let normalized = transport::ordered_origins(&primary, &fallbacks);
    if normalized.is_empty() {
        vec![config::DEFAULT_BACKEND_ORIGIN.to_string()]
    } else {
        normalized
    }
}

async fn expand_origins_via_bootstrap(origins: Vec<String>) -> Vec<String> {
    let mut expanded = normalize_origin_candidates(origins);
    let client = match reqwest::Client::builder()
        .timeout(BOOTSTRAP_DISCOVERY_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(_) => return expanded,
    };
    let bootstrap_origins = expanded.clone();
    for origin in bootstrap_origins {
        if expanded.len() >= MAX_BOOTSTRAP_DISCOVERY_ORIGINS {
            break;
        }
        let url = config::bootstrap_url(&origin);
        let Ok(response) = client.get(&url).send().await else {
            continue;
        };
        if !response.status().is_success() {
            continue;
        }
        let Ok(body) = response.json::<BootstrapResponse>().await else {
            continue;
        };
        for endpoint in relay_endpoint_candidates(&body.relays) {
            if expanded.len() >= MAX_BOOTSTRAP_DISCOVERY_ORIGINS {
                break;
            }
            if !expanded.contains(&endpoint) {
                expanded.push(endpoint);
            }
        }
    }
    expanded
}

fn relay_endpoint_candidates(relays: &[BootstrapRelayCapability]) -> Vec<String> {
    let mut candidates = Vec::new();
    for relay in relays {
        if !relay_supports_websocket_endpoint(&relay.transports) {
            continue;
        }
        for endpoint in &relay.endpoint_origins {
            let Some(origin) = normalize_bootstrap_endpoint_origin(endpoint) else {
                continue;
            };
            if !candidates.contains(&origin) {
                candidates.push(origin);
            }
        }
    }
    candidates
}

fn relay_supports_websocket_endpoint(transports: &[String]) -> bool {
    transports.iter().any(|transport| {
        matches!(
            transport.trim().to_ascii_lowercase().as_str(),
            "central_ws" | "fallback_wss"
        )
    })
}

fn normalize_bootstrap_endpoint_origin(value: &str) -> Option<String> {
    let parsed = Url::parse(value.trim()).ok()?;
    let scheme = parsed.scheme().to_ascii_lowercase();
    if scheme != "https" && scheme != "http" {
        return None;
    }
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }
    if parsed.path() != "" && parsed.path() != "/" {
        return None;
    }
    let host = parsed.host_str()?.to_ascii_lowercase();
    let host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host
    };
    let authority = if let Some(port) = parsed.port() {
        format!("{host}:{port}")
    } else {
        host
    };
    Some(format!("{scheme}://{authority}"))
}

fn absolute_url(origin: &str, value: &str) -> String {
    let value = value.trim();
    if value.starts_with("https://") || value.starts_with("http://") {
        return value.to_string();
    }
    format!(
        "{}/{}",
        origin.trim().trim_end_matches('/'),
        value.trim_start_matches('/')
    )
}

fn safe_file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("attachment.bin")
        .chars()
        .map(|character| match character {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            other => other,
        })
        .collect()
}

fn guess_mime_from_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "apng" | "png" => "image/png",
        "avif" => "image/avif",
        "gif" => "image/gif",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "wav" => "audio/wav",
        "webm" => "audio/webm",
        "mp4" => "video/mp4",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}

async fn request_prekey(
    socket: &mut WsStream,
    recipient_public_key: &str,
) -> Result<Option<String>> {
    let request = Envelope::get_prekey(recipient_public_key.to_string());
    socket
        .send(Message::Text(serde_json::to_string(&request)?.into()))
        .await
        .context("failed to request prekey bundle")?;

    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(message) = socket.next().await {
            let message = message?;
            if !message.is_text() {
                continue;
            }
            let text = message.into_text().context("prekey response is not text")?;
            let envelope: Envelope =
                serde_json::from_str(&text).context("prekey response JSON is invalid")?;
            if envelope.kind == "prekey_bundle"
                && envelope.recipient_pub_key.as_deref() == Some(recipient_public_key)
            {
                return Ok(envelope.prekey);
            }
            if envelope.kind == "rate_limited" {
                return Err(anyhow!(
                    "{}",
                    envelope
                        .message
                        .unwrap_or_else(|| "request was rate limited".to_string())
                ));
            }
        }
        Err(anyhow!("websocket closed before prekey bundle"))
    })
    .await
    .unwrap_or(Ok(None))
}

async fn wait_for_server_ack(socket: &mut WsStream, msg_id: &str) -> Result<bool> {
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(message) = socket.next().await {
            let message = message?;
            if !message.is_text() {
                continue;
            }
            let text = message.into_text().context("server ack is not text")?;
            let envelope: Envelope =
                serde_json::from_str(&text).context("server ack JSON is invalid")?;
            if envelope.kind == "server_ack" && envelope.msg_id.as_deref() == Some(msg_id) {
                return Ok(true);
            }
            if envelope.kind == "rate_limited" {
                return Err(anyhow!(
                    "{}",
                    envelope
                        .message
                        .unwrap_or_else(|| "message was rate limited".to_string())
                ));
            }
        }
        Ok(false)
    })
    .await
    .unwrap_or(Ok(false))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_endpoint_candidates_keep_websocket_origins_only() {
        let relays = vec![
            BootstrapRelayCapability {
                endpoint_origins: vec!["https://mesh.example".to_string()],
                transports: vec!["mesh_relay".to_string()],
            },
            BootstrapRelayCapability {
                endpoint_origins: vec![
                    "https://relay.example/".to_string(),
                    "https://relay.example".to_string(),
                    "ftp://bad.example".to_string(),
                    "https://bad.example/path".to_string(),
                    "https://user:pass@bad.example".to_string(),
                    "HTTP://127.0.0.1:8080/".to_string(),
                ],
                transports: vec!["fallback_wss".to_string()],
            },
        ];

        assert_eq!(
            relay_endpoint_candidates(&relays),
            vec!["https://relay.example", "http://127.0.0.1:8080"]
        );
    }

    #[test]
    fn normalize_bootstrap_endpoint_origin_rejects_non_origins() {
        assert_eq!(
            normalize_bootstrap_endpoint_origin("https://Relay.Example/"),
            Some("https://relay.example".to_string())
        );
        assert_eq!(
            normalize_bootstrap_endpoint_origin("https://relay.example?x=1"),
            None
        );
        assert_eq!(
            normalize_bootstrap_endpoint_origin("wss://relay.example"),
            None
        );
    }
}
