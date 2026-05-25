use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransportKind {
    CentralWs,
    MeshRelay,
    DirectP2p,
    FallbackWss,
    UserProxy,
}

impl TransportKind {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::CentralWs => "central_ws",
            Self::MeshRelay => "mesh_relay",
            Self::DirectP2p => "direct_p2p",
            Self::FallbackWss => "fallback_wss",
            Self::UserProxy => "user_proxy",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TransportThread {
    Direct { peer_public_key: String },
    Group { group_id: String },
    Channel { channel_id: String },
    RelayControl,
}

impl TransportThread {
    pub fn is_routable(&self) -> bool {
        match self {
            Self::Direct { peer_public_key } => !peer_public_key.trim().is_empty(),
            Self::Group { group_id } => !group_id.trim().is_empty(),
            Self::Channel { channel_id } => !channel_id.trim().is_empty(),
            Self::RelayControl => true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadSubscription {
    pub thread: TransportThread,
    pub since_cursor: Option<i64>,
}

impl ThreadSubscription {
    pub fn normalized(thread: TransportThread, since_cursor: Option<i64>) -> Self {
        Self {
            thread,
            since_cursor: since_cursor.map(|cursor| cursor.max(0)),
        }
    }

    pub fn can_subscribe(&self) -> bool {
        self.thread.is_routable()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransportEnvelope {
    pub msg_id: String,
    pub wire_type: String,
    pub thread: TransportThread,
    pub ciphertext_payload: serde_json::Value,
}

impl TransportEnvelope {
    pub fn can_send(&self) -> bool {
        !self.msg_id.trim().is_empty()
            && !self.wire_type.trim().is_empty()
            && self.thread.is_routable()
            && !self.ciphertext_payload.is_null()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransportState {
    Healthy,
    Degraded,
    Unhealthy,
    Disabled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransportFailoverReason {
    Unhealthy,
    RateLimited,
    Timeout,
    UserConfiguredFallback,
    Unsupported,
    Manual,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransportHealth {
    pub kind: TransportKind,
    pub state: TransportState,
    pub latency_ms: Option<u64>,
    pub queue_depth: usize,
    pub last_error: Option<String>,
    pub checked_at_ms: u64,
}

impl TransportHealth {
    pub fn is_usable(&self) -> bool {
        matches!(
            self.state,
            TransportState::Healthy | TransportState::Degraded
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransportSendReceipt {
    pub msg_id: String,
    pub transport: TransportKind,
    pub accepted_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransportError {
    pub transport: TransportKind,
    pub reason: TransportFailoverReason,
    pub message: String,
}

pub trait TransportLayer {
    fn kind(&self) -> TransportKind;
    fn send(&mut self, envelope: TransportEnvelope)
    -> Result<TransportSendReceipt, TransportError>;
    fn subscribe(&mut self, subscription: ThreadSubscription) -> Result<(), TransportError>;
    fn health(&self) -> TransportHealth;
    fn failover_reason(&self) -> Option<TransportFailoverReason>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransportPolicy {
    pub priority: Vec<TransportKind>,
}

impl Default for TransportPolicy {
    fn default() -> Self {
        Self {
            priority: vec![
                TransportKind::CentralWs,
                TransportKind::MeshRelay,
                TransportKind::DirectP2p,
                TransportKind::FallbackWss,
                TransportKind::UserProxy,
            ],
        }
    }
}

impl TransportPolicy {
    pub fn normalized(mut self) -> Self {
        let mut seen = Vec::new();
        self.priority.retain(|kind| {
            if seen.contains(kind) {
                false
            } else {
                seen.push(*kind);
                true
            }
        });
        if self.priority.is_empty() {
            Self::default()
        } else {
            self
        }
    }

    pub fn first_usable(&self, health: &[TransportHealth]) -> Option<TransportKind> {
        let normalized = self.clone().normalized();
        normalized.priority.into_iter().find(|kind| {
            health
                .iter()
                .find(|entry| entry.kind == *kind)
                .is_some_and(TransportHealth::is_usable)
        })
    }

    pub fn next_after(
        &self,
        current: TransportKind,
        health: &[TransportHealth],
    ) -> Option<TransportKind> {
        let normalized = self.clone().normalized();
        let mut after_current = false;
        for kind in normalized.priority {
            if !after_current {
                after_current = kind == current;
                continue;
            }
            if health
                .iter()
                .find(|entry| entry.kind == kind)
                .is_some_and(TransportHealth::is_usable)
            {
                return Some(kind);
            }
        }
        None
    }
}

pub fn normalize_origin(value: &str) -> Option<String> {
    let parsed = url::Url::parse(value.trim()).ok()?;
    let scheme = parsed.scheme().to_ascii_lowercase();
    let host = parsed
        .host_str()?
        .trim_matches(|character| character == '[' || character == ']')
        .to_ascii_lowercase();
    if scheme != "https" && !(scheme == "http" && is_loopback_host(&host)) {
        return None;
    }
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || (parsed.path() != "" && parsed.path() != "/")
    {
        return None;
    }
    let authority_host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host
    };
    let authority = parsed.port().map_or(authority_host.clone(), |port| {
        format!("{authority_host}:{port}")
    });
    Some(format!("{scheme}://{authority}"))
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

pub fn ordered_origins(primary: &str, fallbacks: &[String]) -> Vec<String> {
    let mut origins = Vec::new();
    if let Some(origin) = normalize_origin(primary) {
        origins.push(origin);
    }
    for fallback in fallbacks {
        if let Some(origin) = normalize_origin(fallback)
            && !origins.contains(&origin)
        {
            origins.push(origin);
        }
    }
    origins
}

pub fn parse_origin_list(raw: &str) -> Vec<String> {
    let mut origins = Vec::new();
    for part in raw.split(['\n', '\r', ',', ';']) {
        if let Some(origin) = normalize_origin(part)
            && !origins.contains(&origin)
        {
            origins.push(origin);
        }
    }
    origins
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayCapability {
    pub node_id: String,
    pub public_key: String,
    pub transports: Vec<TransportKind>,
    #[serde(default)]
    pub endpoint_origins: Vec<String>,
    pub region_hint: String,
    pub capacity_class: String,
    pub expires_at: String,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayCredential {
    pub token_proof: String,
    pub scope: String,
    pub expires_at: String,
    pub revocation_epoch: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn health(kind: TransportKind, state: TransportState) -> TransportHealth {
        TransportHealth {
            kind,
            state,
            latency_ms: Some(25),
            queue_depth: 0,
            last_error: None,
            checked_at_ms: 1,
        }
    }

    #[test]
    fn default_policy_prefers_central_then_mesh() {
        let policy = TransportPolicy::default();
        let entries = [
            health(TransportKind::CentralWs, TransportState::Unhealthy),
            health(TransportKind::MeshRelay, TransportState::Healthy),
            health(TransportKind::DirectP2p, TransportState::Healthy),
        ];

        assert_eq!(
            policy.first_usable(&entries),
            Some(TransportKind::MeshRelay)
        );
        assert_eq!(
            policy.next_after(TransportKind::CentralWs, &entries),
            Some(TransportKind::MeshRelay)
        );
    }

    #[test]
    fn policy_dedupes_and_keeps_order() {
        let policy = TransportPolicy {
            priority: vec![
                TransportKind::FallbackWss,
                TransportKind::FallbackWss,
                TransportKind::CentralWs,
            ],
        }
        .normalized();

        assert_eq!(
            policy.priority,
            vec![TransportKind::FallbackWss, TransportKind::CentralWs]
        );
    }

    #[test]
    fn thread_subscriptions_normalize_cursors() {
        let subscription = ThreadSubscription::normalized(
            TransportThread::Direct {
                peer_public_key: "peer".to_string(),
            },
            Some(-10),
        );

        assert_eq!(subscription.since_cursor, Some(0));
        assert!(subscription.can_subscribe());
    }

    #[test]
    fn origins_are_normalized_and_deduped() {
        assert_eq!(
            ordered_origins(
                "https://messk.online/",
                &[
                    "https://relay.example/".to_string(),
                    "http://downgrade.example".to_string(),
                    "http://localhost:8080/".to_string(),
                    "https://relay.example".to_string(),
                ],
            ),
            vec![
                "https://messk.online",
                "https://relay.example",
                "http://localhost:8080"
            ]
        );
        assert_eq!(
            parse_origin_list(
                "https://a.example\nhttps://b.example/;http://bad.example,http://127.0.0.1:8080,https://a.example"
            ),
            vec![
                "https://a.example",
                "https://b.example",
                "http://127.0.0.1:8080"
            ]
        );
        assert_eq!(
            normalize_origin("http://[::1]:8080/"),
            Some("http://[::1]:8080".to_string())
        );
        assert_eq!(normalize_origin("http://relay.example"), None);
        assert_eq!(normalize_origin("https://user:pass@relay.example"), None);
        assert_eq!(normalize_origin("https://relay.example/path"), None);
    }

    #[test]
    fn envelopes_require_ciphertext_and_ids() {
        let envelope = TransportEnvelope {
            msg_id: "m1".to_string(),
            wire_type: "message".to_string(),
            thread: TransportThread::Direct {
                peer_public_key: "peer".to_string(),
            },
            ciphertext_payload: serde_json::json!({"data":"opaque"}),
        };

        assert!(envelope.can_send());
    }

    #[test]
    fn relay_capability_uses_backend_json_names() {
        let capability: RelayCapability = serde_json::from_str(
            r#"{
                "nodeId":"relay-1",
                "publicKey":"pk",
                "transports":["central_ws","fallback_wss"],
                "endpointOrigins":["https://relay.example"],
                "regionHint":"eu",
                "capacityClass":"small",
                "expiresAt":"2026-05-18T18:00:00Z",
                "signature":"sig"
            }"#,
        )
        .unwrap();

        assert_eq!(capability.node_id, "relay-1");
        assert_eq!(
            capability.transports,
            vec![TransportKind::CentralWs, TransportKind::FallbackWss]
        );
        assert_eq!(capability.endpoint_origins, vec!["https://relay.example"]);
        assert!(
            serde_json::to_string(&capability)
                .unwrap()
                .contains("endpointOrigins")
        );
    }
}
