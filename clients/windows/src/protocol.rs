use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub msg_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recipient_pub_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender_pub_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub challenge: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ephemeral: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prekeys: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prekey: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signed_prekey: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signed_prekey_sig: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ack_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl Envelope {
    pub fn auth_response(challenge: String) -> Self {
        Self {
            kind: "auth_response".to_string(),
            msg_id: None,
            recipient_pub_key: None,
            sender_pub_key: None,
            data: None,
            challenge: Some(challenge),
            ephemeral: None,
            session_token: None,
            prekeys: None,
            prekey: None,
            signed_prekey: None,
            signed_prekey_sig: None,
            ack_type: None,
            message: None,
        }
    }

    pub fn get_prekey(recipient_public_key: String) -> Self {
        Self {
            kind: "get_prekey".to_string(),
            msg_id: None,
            recipient_pub_key: Some(recipient_public_key),
            sender_pub_key: None,
            data: None,
            challenge: None,
            ephemeral: None,
            session_token: None,
            prekeys: None,
            prekey: None,
            signed_prekey: None,
            signed_prekey_sig: None,
            ack_type: None,
            message: None,
        }
    }

    pub fn clear_prekeys() -> Self {
        Self {
            kind: "clear_prekeys".to_string(),
            msg_id: None,
            recipient_pub_key: None,
            sender_pub_key: None,
            data: None,
            challenge: None,
            ephemeral: None,
            session_token: None,
            prekeys: None,
            prekey: None,
            signed_prekey: None,
            signed_prekey_sig: None,
            ack_type: None,
            message: None,
        }
    }

    pub fn upload_prekeys(
        sender_public_key: String,
        prekeys: Vec<String>,
        signed_prekey: String,
        signed_prekey_sig: String,
    ) -> Self {
        Self {
            kind: "upload_prekeys".to_string(),
            msg_id: None,
            recipient_pub_key: None,
            sender_pub_key: Some(sender_public_key),
            data: None,
            challenge: None,
            ephemeral: None,
            session_token: None,
            prekeys: Some(prekeys),
            prekey: None,
            signed_prekey: Some(signed_prekey),
            signed_prekey_sig: Some(signed_prekey_sig),
            ack_type: None,
            message: None,
        }
    }

    pub fn direct_message(
        msg_id: String,
        sender_public_key: String,
        recipient_public_key: String,
        data: String,
    ) -> Self {
        Self {
            kind: "message".to_string(),
            msg_id: Some(msg_id),
            recipient_pub_key: Some(recipient_public_key),
            sender_pub_key: Some(sender_public_key),
            data: Some(data),
            challenge: None,
            ephemeral: None,
            session_token: None,
            prekeys: None,
            prekey: None,
            signed_prekey: None,
            signed_prekey_sig: None,
            ack_type: None,
            message: None,
        }
    }

    pub fn delivery_receipt(
        msg_id: String,
        sender_public_key: String,
        recipient_public_key: String,
    ) -> Self {
        Self {
            kind: "delivery_receipt".to_string(),
            msg_id: Some(msg_id),
            recipient_pub_key: Some(recipient_public_key),
            sender_pub_key: Some(sender_public_key),
            data: None,
            challenge: None,
            ephemeral: None,
            session_token: None,
            prekeys: None,
            prekey: None,
            signed_prekey: None,
            signed_prekey_sig: None,
            ack_type: None,
            message: None,
        }
    }

    pub fn offline_ack(msg_id: String) -> Self {
        Self {
            kind: "offline_ack".to_string(),
            msg_id: Some(msg_id),
            recipient_pub_key: None,
            sender_pub_key: None,
            data: None,
            challenge: None,
            ephemeral: None,
            session_token: None,
            prekeys: None,
            prekey: None,
            signed_prekey: None,
            signed_prekey_sig: None,
            ack_type: None,
            message: None,
        }
    }
}
