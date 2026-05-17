use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MessagePayloadKind {
    Text,
    Voice,
    Attachment,
    Call,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessagePayloadPreview {
    pub kind: MessagePayloadKind,
    pub title: String,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EncryptedFilePayload {
    pub url: String,
    pub key: String,
    pub name: String,
    pub size: u64,
    pub mime_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VoiceMessagePayload {
    pub url: String,
    pub key: String,
    pub duration_seconds: u64,
    pub mime_type: String,
    pub size: u64,
}

impl EncryptedFilePayload {
    pub fn to_plaintext_json(&self) -> String {
        serde_json::json!({
            "type": "file",
            "url": &self.url,
            "key": &self.key,
            "name": &self.name,
            "size": self.size,
            "mimeType": &self.mime_type,
        })
        .to_string()
    }
}

impl VoiceMessagePayload {
    pub fn to_plaintext_json(&self) -> String {
        serde_json::json!({
            "type": "voice",
            "url": &self.url,
            "key": &self.key,
            "duration": self.duration_seconds,
            "mimeType": &self.mime_type,
            "size": self.size,
        })
        .to_string()
    }

    pub fn as_encrypted_file(&self) -> EncryptedFilePayload {
        EncryptedFilePayload {
            url: self.url.clone(),
            key: self.key.clone(),
            name: "voice.webm".to_string(),
            size: self.size,
            mime_type: self.mime_type.clone(),
        }
    }
}

pub fn message_payload_preview(raw: &str) -> Option<MessagePayloadPreview> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let value = serde_json::from_str::<serde_json::Value>(trimmed).ok()?;
    let payload_type = value
        .get("type")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    match payload_type.as_str() {
        "text" => json_first_string(&value, &["text", "message", "body"]).map(|text| {
            MessagePayloadPreview {
                kind: MessagePayloadKind::Text,
                title: text,
                detail: String::new(),
            }
        }),
        "voice" | "audio" | "voice_message" => Some(MessagePayloadPreview {
            kind: MessagePayloadKind::Voice,
            title: "Voice message".to_string(),
            detail: voice_payload_detail(&value),
        }),
        "file" | "attachment" | "image" | "video" | "document" => {
            let title = json_first_string(&value, &["name", "filename", "file_name", "title"])
                .unwrap_or_else(|| default_attachment_title(&payload_type).to_string());
            Some(MessagePayloadPreview {
                kind: MessagePayloadKind::Attachment,
                title,
                detail: attachment_payload_detail(&value),
            })
        }
        "call" | "voice_call" | "video_call" | "call_offer" | "call_answer" | "call_reject"
        | "call_end" | "call_missed" | "call_ice" | "ice_candidate" => {
            let call_kind = json_first_string(&value, &["kind", "media", "call_type"])
                .unwrap_or_else(|| {
                    if payload_type.contains("video") {
                        "Video".to_string()
                    } else {
                        "Voice".to_string()
                    }
                });
            let status = json_first_string(&value, &["status", "state"])
                .unwrap_or_else(|| call_status_from_type(&payload_type).to_string());
            Some(MessagePayloadPreview {
                kind: MessagePayloadKind::Call,
                title: format!("{} call", title_case_first(&call_kind)),
                detail: title_case_first(&status.replace('_', " ")),
            })
        }
        "deleted" => Some(MessagePayloadPreview {
            kind: MessagePayloadKind::Deleted,
            title: "Message deleted".to_string(),
            detail: String::new(),
        }),
        _ => None,
    }
}

pub fn encrypted_file_payload(raw: &str) -> Option<EncryptedFilePayload> {
    let value = serde_json::from_str::<serde_json::Value>(raw.trim()).ok()?;
    let payload_type = value
        .get("type")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(
        payload_type.as_str(),
        "file"
            | "attachment"
            | "image"
            | "video"
            | "document"
            | "voice"
            | "audio"
            | "voice_message"
    ) {
        return None;
    }

    let url = json_first_string(&value, &["url", "download_url"])?;
    let key = json_first_string(&value, &["key", "secret_key"])?;
    let name = json_first_string(&value, &["name", "filename", "file_name", "title"])
        .unwrap_or_else(|| default_attachment_title(&payload_type).to_string());
    let mime_type = json_first_string(&value, &["mime", "mimeType", "mime_type", "content_type"])
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let size = value
        .get("size")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);

    Some(EncryptedFilePayload {
        url,
        key,
        name,
        size,
        mime_type,
    })
}

pub fn voice_message_payload(raw: &str) -> Option<VoiceMessagePayload> {
    let value = serde_json::from_str::<serde_json::Value>(raw.trim()).ok()?;
    let payload_type = value
        .get("type")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(payload_type.as_str(), "voice" | "audio" | "voice_message") {
        return None;
    }

    let url = json_first_string(&value, &["url", "download_url"])?;
    let key = json_first_string(&value, &["key", "secret_key"])?;
    let mime_type = json_first_string(&value, &["mime", "mimeType", "mime_type", "content_type"])
        .unwrap_or_else(|| "audio/webm".to_string());
    let duration_seconds = value
        .get("duration")
        .and_then(|value| value.as_f64())
        .unwrap_or(0.0)
        .max(0.0)
        .round() as u64;
    let size = value
        .get("size")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);

    Some(VoiceMessagePayload {
        url,
        key,
        duration_seconds,
        mime_type,
        size,
    })
}

pub fn display_message_text(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    if let Some(payload) = message_payload_preview(trimmed) {
        return if payload.detail.trim().is_empty() {
            payload.title
        } else {
            format!("{} - {}", payload.title, payload.detail)
        };
    }

    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed)
        && let Some(text) = value.as_str()
    {
        return text.to_string();
    }

    trimmed.to_string()
}

pub fn is_deleted_message_payload(raw: &str) -> bool {
    matches!(
        message_payload_preview(raw).map(|payload| payload.kind),
        Some(MessagePayloadKind::Deleted)
    )
}

fn call_status_from_type(payload_type: &str) -> &'static str {
    match payload_type {
        "call_offer" => "ringing",
        "call_answer" => "answered",
        "call_reject" => "rejected",
        "call_end" => "ended",
        "call_missed" => "missed",
        "call_ice" | "ice_candidate" => "connecting",
        _ => "ready",
    }
}

fn default_attachment_title(payload_type: &str) -> &'static str {
    match payload_type {
        "image" => "Image",
        "video" => "Video",
        "document" => "Document",
        "voice" | "audio" | "voice_message" => "voice.webm",
        _ => "Attachment",
    }
}

fn json_first_string(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .filter_map(|key| value.get(*key).and_then(|value| value.as_str()))
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn voice_payload_detail(value: &serde_json::Value) -> String {
    let mut details = Vec::new();
    if let Some(duration) = value.get("duration").and_then(|value| value.as_f64()) {
        details.push(format_voice_duration(duration));
    }
    if json_first_string(value, &["url", "download_url"]).is_some() {
        details.push("download ready".to_string());
    }
    if details.is_empty() {
        "ready".to_string()
    } else {
        details.join(" - ")
    }
}

fn attachment_payload_detail(value: &serde_json::Value) -> String {
    let mut details = Vec::new();
    if let Some(mime) = json_first_string(value, &["mime", "mimeType", "mime_type", "content_type"])
    {
        details.push(mime);
    }
    if let Some(size) = value.get("size").and_then(|value| value.as_u64()) {
        details.push(format_file_size(size));
    }
    if details.is_empty() {
        "encrypted file".to_string()
    } else {
        details.join(" - ")
    }
}

fn format_voice_duration(seconds: f64) -> String {
    let total = seconds.max(0.0).round() as u64;
    format!("{:02}:{:02}", total / 60, total % 60)
}

fn format_file_size(bytes: u64) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / 1024.0 / 1024.0)
    } else if bytes >= 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{bytes} B")
    }
}

fn title_case_first(value: &str) -> String {
    let mut chars = value.trim().chars();
    let Some(first) = chars.next() else {
        return String::new();
    };
    let mut result = first.to_uppercase().collect::<String>();
    result.push_str(chars.as_str());
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_payload_unwraps_to_plain_text() {
        assert_eq!(display_message_text(r#"{"type":"text","text":"ky"}"#), "ky");
    }

    #[test]
    fn plain_text_stays_plain_text() {
        assert_eq!(display_message_text("hello"), "hello");
    }

    #[test]
    fn voice_payload_gets_stable_summary() {
        assert_eq!(
            display_message_text(
                r#"{"type":"voice","url":"https://messk.online/download/a.webm","duration":62}"#
            ),
            "Voice message - 01:02 - download ready"
        );
    }

    #[test]
    fn attachment_payload_accepts_web_mime_type_key() {
        assert_eq!(
            display_message_text(
                r#"{"type":"file","name":"photo.png","mimeType":"image/png","size":2048}"#
            ),
            "photo.png - image/png - 2.0 KB"
        );
    }

    #[test]
    fn call_payload_accepts_existing_backend_signaling_names() {
        assert_eq!(
            display_message_text(r#"{"type":"ice_candidate"}"#),
            "Voice call - Connecting"
        );
        assert_eq!(
            display_message_text(r#"{"type":"video_call","status":"missed"}"#),
            "Video call - Missed"
        );
    }

    #[test]
    fn deleted_payload_is_detected() {
        assert!(is_deleted_message_payload(r#"{"type":"deleted"}"#));
        assert!(!is_deleted_message_payload(
            r#"{"type":"text","text":"deleted"}"#
        ));
    }

    #[test]
    fn encrypted_file_payload_extracts_web_file_shape() {
        assert_eq!(
            encrypted_file_payload(
                r#"{"type":"file","url":"https://messk.online/download/a.bin","key":"abc","name":"photo.png","mimeType":"image/png","size":2048}"#
            ),
            Some(EncryptedFilePayload {
                url: "https://messk.online/download/a.bin".to_string(),
                key: "abc".to_string(),
                name: "photo.png".to_string(),
                size: 2048,
                mime_type: "image/png".to_string(),
            })
        );
    }

    #[test]
    fn encrypted_file_payload_builds_web_file_shape() {
        let payload = EncryptedFilePayload {
            url: "https://messk.online/download/a.bin".to_string(),
            key: "abc".to_string(),
            name: "photo.png".to_string(),
            size: 2048,
            mime_type: "image/png".to_string(),
        };
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&payload.to_plaintext_json()).unwrap(),
            serde_json::json!({
                "type": "file",
                "url": "https://messk.online/download/a.bin",
                "key": "abc",
                "name": "photo.png",
                "size": 2048,
                "mimeType": "image/png"
            })
        );
    }

    #[test]
    fn voice_payload_extracts_web_voice_shape() {
        assert_eq!(
            voice_message_payload(
                r#"{"type":"voice","url":"https://messk.online/download/v.webm","key":"abc","duration":3.8,"mimeType":"audio/webm","size":4096}"#
            ),
            Some(VoiceMessagePayload {
                url: "https://messk.online/download/v.webm".to_string(),
                key: "abc".to_string(),
                duration_seconds: 4,
                mime_type: "audio/webm".to_string(),
                size: 4096,
            })
        );
    }
}
