use messk_core::protocol as core_protocol;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub msg_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_msg_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recipient_pub_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender_pub_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reaction: Option<String>,
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
    fn new(kind: &str) -> Self {
        Self {
            kind: kind.to_string(),
            msg_id: None,
            target_msg_id: None,
            recipient_pub_key: None,
            sender_pub_key: None,
            data: None,
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
        }
    }

    pub fn auth_response(challenge: String) -> Self {
        Self {
            challenge: Some(challenge),
            ..Self::new(core_protocol::WIRE_AUTH_RESPONSE)
        }
    }

    pub fn get_prekey(recipient_public_key: String) -> Self {
        Self {
            recipient_pub_key: Some(recipient_public_key),
            ..Self::new(core_protocol::WIRE_GET_PREKEY)
        }
    }

    pub fn clear_prekeys() -> Self {
        Self::new(core_protocol::WIRE_CLEAR_PREKEYS)
    }

    pub fn upload_prekeys(sender_public_key: String, prekeys: Vec<String>) -> Self {
        Self {
            sender_pub_key: Some(sender_public_key),
            prekeys: Some(prekeys),
            ..Self::new(core_protocol::WIRE_UPLOAD_PREKEYS)
        }
    }

    pub fn direct_message(
        msg_id: String,
        sender_public_key: String,
        recipient_public_key: String,
        data: String,
    ) -> Self {
        Self {
            msg_id: Some(msg_id),
            recipient_pub_key: Some(recipient_public_key),
            sender_pub_key: Some(sender_public_key),
            data: Some(data),
            ..Self::new(core_protocol::WIRE_MESSAGE)
        }
    }

    pub fn direct_edit(
        event_id: String,
        target_msg_id: String,
        sender_public_key: String,
        recipient_public_key: String,
        data: String,
    ) -> Self {
        Self {
            msg_id: Some(event_id),
            target_msg_id: Some(target_msg_id),
            recipient_pub_key: Some(recipient_public_key),
            sender_pub_key: Some(sender_public_key),
            data: Some(data),
            ..Self::new(core_protocol::WIRE_EDIT)
        }
    }

    pub fn direct_delete(
        event_id: String,
        target_msg_id: String,
        sender_public_key: String,
        recipient_public_key: String,
    ) -> Self {
        Self {
            msg_id: Some(event_id),
            target_msg_id: Some(target_msg_id),
            recipient_pub_key: Some(recipient_public_key),
            sender_pub_key: Some(sender_public_key),
            ..Self::new(core_protocol::WIRE_DELETE)
        }
    }

    pub fn direct_reaction(
        event_id: String,
        target_msg_id: String,
        sender_public_key: String,
        recipient_public_key: String,
        reaction: Option<String>,
    ) -> Self {
        Self {
            msg_id: Some(event_id),
            target_msg_id: Some(target_msg_id),
            recipient_pub_key: Some(recipient_public_key),
            sender_pub_key: Some(sender_public_key),
            reaction,
            ..Self::new(core_protocol::WIRE_REACTION)
        }
    }

    pub fn direct_pin(
        event_id: String,
        target_msg_id: String,
        sender_public_key: String,
        recipient_public_key: String,
    ) -> Self {
        Self {
            msg_id: Some(event_id),
            target_msg_id: Some(target_msg_id),
            recipient_pub_key: Some(recipient_public_key),
            sender_pub_key: Some(sender_public_key),
            ..Self::new(core_protocol::WIRE_PIN)
        }
    }

    pub fn direct_unpin(
        event_id: String,
        target_msg_id: String,
        sender_public_key: String,
        recipient_public_key: String,
    ) -> Self {
        Self {
            msg_id: Some(event_id),
            target_msg_id: Some(target_msg_id),
            recipient_pub_key: Some(recipient_public_key),
            sender_pub_key: Some(sender_public_key),
            ..Self::new(core_protocol::WIRE_UNPIN)
        }
    }

    pub fn delivery_receipt(
        msg_id: String,
        sender_public_key: String,
        recipient_public_key: String,
    ) -> Self {
        Self {
            msg_id: Some(msg_id),
            recipient_pub_key: Some(recipient_public_key),
            sender_pub_key: Some(sender_public_key),
            ..Self::new(core_protocol::WIRE_DELIVERY_RECEIPT)
        }
    }

    pub fn offline_ack(msg_id: String) -> Self {
        Self {
            msg_id: Some(msg_id),
            ..Self::new(core_protocol::WIRE_OFFLINE_ACK)
        }
    }
}
