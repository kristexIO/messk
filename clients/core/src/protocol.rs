use serde::{Deserialize, Serialize};

pub const WIRE_AUTH_RESPONSE: &str = "auth_response";
pub const WIRE_CLEAR_PREKEYS: &str = "clear_prekeys";
pub const WIRE_DELIVERY_RECEIPT: &str = "delivery_receipt";
pub const WIRE_DELETE: &str = "delete";
pub const WIRE_DUMMY: &str = "dummy";
pub const WIRE_EDIT: &str = "edit";
pub const WIRE_FORWARD: &str = "forward";
pub const WIRE_GET_PREKEY: &str = "get_prekey";
pub const WIRE_MESSAGE: &str = "message";
pub const WIRE_OFFLINE_ACK: &str = "offline_ack";
pub const WIRE_PIN: &str = "pin";
pub const WIRE_REACTION: &str = "reaction";
pub const WIRE_READ_RECEIPT: &str = "read_receipt";
pub const WIRE_REPLY: &str = "reply";
pub const WIRE_SESSION_REPAIR: &str = "session_repair";
pub const WIRE_SESSION_RESET: &str = "session_reset";
pub const WIRE_TYPING: &str = "typing";
pub const WIRE_UNPIN: &str = "unpin";
pub const WIRE_UPLOAD_PREKEYS: &str = "upload_prekeys";
pub const WIRE_ATTACHMENT: &str = "attachment";
pub const WIRE_CALL_OFFER: &str = "call_offer";
pub const WIRE_CALL_ANSWER: &str = "call_answer";
pub const WIRE_CALL_REJECT: &str = "call_reject";
pub const WIRE_CALL_END: &str = "call_end";
pub const WIRE_CALL_ICE: &str = "ice_candidate";
pub const WIRE_PROTOCOL_VERSION: u32 = 1;

pub const DIRECT_HISTORY_DEFAULT_LIMIT: usize = 100;
pub const DIRECT_HISTORY_MAX_LIMIT: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DirectControlKind {
    Edit,
    Delete,
    Reaction,
    Reply,
    Pin,
    Unpin,
    Attachment,
    Forward,
}

impl DirectControlKind {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Edit => WIRE_EDIT,
            Self::Delete => WIRE_DELETE,
            Self::Reaction => WIRE_REACTION,
            Self::Reply => WIRE_REPLY,
            Self::Pin => WIRE_PIN,
            Self::Unpin => WIRE_UNPIN,
            Self::Attachment => WIRE_ATTACHMENT,
            Self::Forward => WIRE_FORWARD,
        }
    }
}

pub fn is_direct_history_event(kind: &str) -> bool {
    matches!(
        kind,
        WIRE_MESSAGE
            | WIRE_EDIT
            | WIRE_DELETE
            | WIRE_REACTION
            | WIRE_REPLY
            | WIRE_PIN
            | WIRE_UNPIN
            | WIRE_ATTACHMENT
            | WIRE_FORWARD
    )
}

pub fn requires_message_id(kind: &str) -> bool {
    !matches!(
        kind,
        WIRE_AUTH_RESPONSE
            | WIRE_CLEAR_PREKEYS
            | WIRE_GET_PREKEY
            | WIRE_TYPING
            | WIRE_UPLOAD_PREKEYS
    )
}

pub fn requires_target_message_id(kind: &str) -> bool {
    matches!(
        kind,
        WIRE_EDIT | WIRE_DELETE | WIRE_REACTION | WIRE_REPLY | WIRE_PIN | WIRE_UNPIN
    )
}

pub fn carries_encrypted_data(kind: &str) -> bool {
    matches!(
        kind,
        WIRE_MESSAGE
            | WIRE_DUMMY
            | WIRE_EDIT
            | WIRE_REPLY
            | WIRE_ATTACHMENT
            | WIRE_FORWARD
            | WIRE_SESSION_REPAIR
    )
}

pub fn is_call_signal(kind: &str) -> bool {
    matches!(
        kind,
        WIRE_CALL_OFFER | WIRE_CALL_ANSWER | WIRE_CALL_REJECT | WIRE_CALL_END | WIRE_CALL_ICE
    )
}

pub fn clamp_history_limit(limit: usize) -> usize {
    if limit == 0 || limit > DIRECT_HISTORY_MAX_LIMIT {
        DIRECT_HISTORY_DEFAULT_LIMIT
    } else {
        limit
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_history_events_match_actions() {
        for kind in [
            WIRE_MESSAGE,
            WIRE_EDIT,
            WIRE_DELETE,
            WIRE_REACTION,
            WIRE_REPLY,
            WIRE_PIN,
            WIRE_UNPIN,
            WIRE_ATTACHMENT,
            WIRE_FORWARD,
        ] {
            assert!(is_direct_history_event(kind), "{kind} must be recoverable");
            assert!(requires_message_id(kind), "{kind} must be idempotent");
        }
    }

    #[test]
    fn target_id_is_required_for_mutating_controls() {
        for kind in [
            WIRE_EDIT,
            WIRE_DELETE,
            WIRE_REACTION,
            WIRE_REPLY,
            WIRE_PIN,
            WIRE_UNPIN,
        ] {
            assert!(requires_target_message_id(kind));
        }
        assert!(!requires_target_message_id(WIRE_MESSAGE));
        assert!(!requires_target_message_id(WIRE_ATTACHMENT));
    }

    #[test]
    fn history_limit_is_bounded() {
        assert_eq!(clamp_history_limit(0), DIRECT_HISTORY_DEFAULT_LIMIT);
        assert_eq!(clamp_history_limit(42), 42);
        assert_eq!(clamp_history_limit(501), DIRECT_HISTORY_DEFAULT_LIMIT);
    }

    #[test]
    fn dummy_is_encrypted_but_not_history() {
        assert!(requires_message_id(WIRE_DUMMY));
        assert!(carries_encrypted_data(WIRE_DUMMY));
        assert!(!is_direct_history_event(WIRE_DUMMY));
    }

    #[test]
    fn typing_is_ephemeral_presence_not_history() {
        assert!(!requires_message_id(WIRE_TYPING));
        assert!(!requires_target_message_id(WIRE_TYPING));
        assert!(!is_direct_history_event(WIRE_TYPING));
        assert!(!carries_encrypted_data(WIRE_TYPING));
    }

    #[test]
    fn call_signal_names_match_backend_and_web() {
        for kind in [
            WIRE_CALL_OFFER,
            WIRE_CALL_ANSWER,
            WIRE_CALL_REJECT,
            WIRE_CALL_END,
            WIRE_CALL_ICE,
        ] {
            assert!(is_call_signal(kind));
            assert!(requires_message_id(kind));
            assert!(!requires_target_message_id(kind));
        }
    }

    #[test]
    fn wire_protocol_version_is_explicit() {
        assert_eq!(WIRE_PROTOCOL_VERSION, 1);
    }
}
