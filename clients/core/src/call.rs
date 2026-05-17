use serde::{Deserialize, Serialize};

pub const CALL_OFFER: &str = "call_offer";
pub const CALL_ANSWER: &str = "call_answer";
pub const CALL_REJECT: &str = "call_reject";
pub const CALL_END: &str = "call_end";
pub const CALL_ICE: &str = "ice_candidate";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CallMediaKind {
    Audio,
    Video,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CallDirection {
    Incoming,
    Outgoing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CallState {
    Idle,
    Incoming,
    Outgoing,
    Connecting,
    Active,
    Busy,
    Declined,
    Missed,
    Timeout,
    Failed,
    Disconnected,
    Ended,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CallSession {
    pub peer_public_key: String,
    pub direction: CallDirection,
    pub media: CallMediaKind,
    pub state: CallState,
    pub muted: bool,
    pub camera_enabled: bool,
}

impl CallSession {
    pub fn outgoing(peer_public_key: String, media: CallMediaKind) -> Self {
        Self {
            peer_public_key,
            direction: CallDirection::Outgoing,
            media,
            state: CallState::Outgoing,
            muted: false,
            camera_enabled: media == CallMediaKind::Video,
        }
    }

    pub fn incoming(peer_public_key: String, media: CallMediaKind) -> Self {
        Self {
            peer_public_key,
            direction: CallDirection::Incoming,
            media,
            state: CallState::Incoming,
            muted: false,
            camera_enabled: media == CallMediaKind::Video,
        }
    }

    pub fn accept(&mut self) {
        if self.state == CallState::Incoming {
            self.state = CallState::Connecting;
        }
    }

    pub fn answer_received(&mut self) {
        if matches!(self.state, CallState::Outgoing | CallState::Connecting) {
            self.state = CallState::Connecting;
        }
    }

    pub fn media_connected(&mut self) {
        if matches!(
            self.state,
            CallState::Outgoing | CallState::Incoming | CallState::Connecting
        ) {
            self.state = CallState::Active;
        }
    }

    pub fn reject(&mut self, reason: &str) {
        self.state = match reason {
            "busy" => CallState::Busy,
            "missed" => CallState::Missed,
            "timeout" | "connect_timeout" => CallState::Timeout,
            _ => CallState::Declined,
        };
    }

    pub fn fail(&mut self) {
        self.state = CallState::Failed;
    }

    pub fn disconnect(&mut self) {
        self.state = CallState::Disconnected;
    }

    pub fn end(&mut self) {
        self.state = CallState::Ended;
    }

    pub fn toggle_mute(&mut self) {
        self.muted = !self.muted;
    }

    pub fn toggle_camera(&mut self) {
        if self.media == CallMediaKind::Video {
            self.camera_enabled = !self.camera_enabled;
        }
    }
}

pub fn is_call_signal(kind: &str) -> bool {
    matches!(
        kind,
        CALL_OFFER | CALL_ANSWER | CALL_REJECT | CALL_END | CALL_ICE
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incoming_call_moves_to_active_through_connecting() {
        let mut call = CallSession::incoming("peer".to_string(), CallMediaKind::Video);
        assert_eq!(call.state, CallState::Incoming);
        assert!(call.camera_enabled);
        call.accept();
        assert_eq!(call.state, CallState::Connecting);
        call.media_connected();
        assert_eq!(call.state, CallState::Active);
    }

    #[test]
    fn reject_reason_maps_to_terminal_state() {
        let mut call = CallSession::outgoing("peer".to_string(), CallMediaKind::Audio);
        call.reject("busy");
        assert_eq!(call.state, CallState::Busy);
    }
}
