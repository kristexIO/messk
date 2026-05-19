use crate::mesh::{
    BlindMeshEnvelope, MESH_MAX_CIPHERTEXT_LEN, MESH_PROTOCOL_VERSION, MeshError,
    is_valid_mesh_topic,
};
use libp2p::{
    PeerId, autonat, dcutr,
    gossipsub::{self, IdentTopic, MessageAuthenticity, ValidationMode},
    identify, identity,
    kad::{self, Mode, store::MemoryStore},
    relay,
    swarm::{NetworkBehaviour, behaviour::toggle::Toggle},
};

pub const MESSK_LIBP2P_PROTOCOL: &str = "/messk/mesh/1";
pub const MESSK_IDENTIFY_PROTOCOL: &str = "/messk/mesh/identify/1";
pub const MESSK_MAX_GOSSIPSUB_BYTES: usize = MESH_MAX_CIPHERTEXT_LEN + 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Libp2pMeshConfig {
    pub protocol_id_prefix: String,
    pub identify_protocol: String,
    pub max_transmit_size: usize,
    pub kad_server_mode: bool,
    pub enable_autonat: bool,
    pub enable_dcutr: bool,
    pub enable_relay_client: bool,
    pub enable_relay_server: bool,
}

impl Default for Libp2pMeshConfig {
    fn default() -> Self {
        Self {
            protocol_id_prefix: MESSK_LIBP2P_PROTOCOL.to_string(),
            identify_protocol: MESSK_IDENTIFY_PROTOCOL.to_string(),
            max_transmit_size: MESSK_MAX_GOSSIPSUB_BYTES,
            kad_server_mode: false,
            enable_autonat: true,
            enable_dcutr: true,
            enable_relay_client: true,
            enable_relay_server: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Libp2pMeshCapability {
    Gossipsub,
    Kademlia,
    Identify,
    AutoNat,
    Dcutr,
    CircuitRelayClient,
    CircuitRelayServer,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Libp2pMeshError {
    Mesh(MeshError),
    InvalidEnvelopeBytes,
    Config(String),
    Publish(String),
}

impl From<MeshError> for Libp2pMeshError {
    fn from(error: MeshError) -> Self {
        Self::Mesh(error)
    }
}

impl From<gossipsub::ConfigBuilderError> for Libp2pMeshError {
    fn from(error: gossipsub::ConfigBuilderError) -> Self {
        Self::Config(error.to_string())
    }
}

impl From<gossipsub::PublishError> for Libp2pMeshError {
    fn from(error: gossipsub::PublishError) -> Self {
        Self::Publish(error.to_string())
    }
}

pub struct Libp2pMeshBehaviours {
    pub local_peer_id: PeerId,
    pub identify: identify::Behaviour,
    pub gossipsub: gossipsub::Behaviour,
    pub kademlia: kad::Behaviour<MemoryStore>,
    pub autonat: Option<autonat::Behaviour>,
    pub dcutr: Option<dcutr::Behaviour>,
    pub relay_client_transport: Option<relay::client::Transport>,
    pub relay_client: Option<relay::client::Behaviour>,
    pub relay_server: Option<relay::Behaviour>,
}

#[derive(NetworkBehaviour)]
#[behaviour(prelude = "libp2p::swarm::derive_prelude")]
pub struct MesskMeshBehaviour {
    pub identify: identify::Behaviour,
    pub gossipsub: gossipsub::Behaviour,
    pub kademlia: kad::Behaviour<MemoryStore>,
    pub autonat: Toggle<autonat::Behaviour>,
    pub dcutr: Toggle<dcutr::Behaviour>,
    pub relay_client: Toggle<relay::client::Behaviour>,
    pub relay_server: Toggle<relay::Behaviour>,
}

pub struct Libp2pMeshSwarmParts {
    pub local_peer_id: PeerId,
    pub relay_client_transport: Option<relay::client::Transport>,
    pub behaviour: MesskMeshBehaviour,
}

pub fn enabled_capabilities(config: &Libp2pMeshConfig) -> Vec<Libp2pMeshCapability> {
    let mut capabilities = vec![
        Libp2pMeshCapability::Gossipsub,
        Libp2pMeshCapability::Kademlia,
        Libp2pMeshCapability::Identify,
    ];
    if config.enable_autonat {
        capabilities.push(Libp2pMeshCapability::AutoNat);
    }
    if config.enable_dcutr {
        capabilities.push(Libp2pMeshCapability::Dcutr);
    }
    if config.enable_relay_client {
        capabilities.push(Libp2pMeshCapability::CircuitRelayClient);
    }
    if config.enable_relay_server {
        capabilities.push(Libp2pMeshCapability::CircuitRelayServer);
    }
    capabilities
}

pub fn build_mesh_behaviours(
    local_key: identity::Keypair,
    config: Libp2pMeshConfig,
) -> Result<Libp2pMeshBehaviours, Libp2pMeshError> {
    let local_peer_id = PeerId::from(local_key.public());
    let identify = build_identify(&local_key, &config);
    let gossipsub = build_gossipsub(&config)?;
    let kademlia = build_kademlia(local_peer_id, &config);
    let autonat = config.enable_autonat.then(|| build_autonat(local_peer_id));
    let dcutr = config.enable_dcutr.then(|| build_dcutr(local_peer_id));
    let (relay_client_transport, relay_client) = if config.enable_relay_client {
        let (transport, behaviour) = build_relay_client(local_peer_id);
        (Some(transport), Some(behaviour))
    } else {
        (None, None)
    };
    let relay_server = config
        .enable_relay_server
        .then(|| build_relay_server(local_peer_id));

    Ok(Libp2pMeshBehaviours {
        local_peer_id,
        identify,
        gossipsub,
        kademlia,
        autonat,
        dcutr,
        relay_client_transport,
        relay_client,
        relay_server,
    })
}

pub fn build_swarm_parts(
    local_key: identity::Keypair,
    config: Libp2pMeshConfig,
) -> Result<Libp2pMeshSwarmParts, Libp2pMeshError> {
    let local_peer_id = PeerId::from(local_key.public());
    let identify = build_identify(&local_key, &config);
    let gossipsub = build_gossipsub(&config)?;
    let kademlia = build_kademlia(local_peer_id, &config);
    let autonat = Toggle::from(config.enable_autonat.then(|| build_autonat(local_peer_id)));
    let dcutr = Toggle::from(config.enable_dcutr.then(|| build_dcutr(local_peer_id)));
    let (relay_client_transport, relay_client) = if config.enable_relay_client {
        let (transport, behaviour) = build_relay_client(local_peer_id);
        (Some(transport), Some(behaviour))
    } else {
        (None, None)
    };
    let relay_server = Toggle::from(
        config
            .enable_relay_server
            .then(|| build_relay_server(local_peer_id)),
    );

    Ok(Libp2pMeshSwarmParts {
        local_peer_id,
        relay_client_transport,
        behaviour: MesskMeshBehaviour {
            identify,
            gossipsub,
            kademlia,
            autonat,
            dcutr,
            relay_client: Toggle::from(relay_client),
            relay_server,
        },
    })
}

pub fn build_identify(
    local_key: &identity::Keypair,
    config: &Libp2pMeshConfig,
) -> identify::Behaviour {
    let identify_config =
        identify::Config::new(config.identify_protocol.clone(), local_key.public());
    identify::Behaviour::new(identify_config)
}

pub fn build_gossipsub(config: &Libp2pMeshConfig) -> Result<gossipsub::Behaviour, Libp2pMeshError> {
    let gossipsub_config = gossipsub::ConfigBuilder::default()
        .protocol_id_prefix(config.protocol_id_prefix.clone())
        .validation_mode(ValidationMode::Anonymous)
        .max_transmit_size(config.max_transmit_size)
        .build()
        .map_err(Libp2pMeshError::from)?;

    gossipsub::Behaviour::new(MessageAuthenticity::Anonymous, gossipsub_config)
        .map_err(|error| Libp2pMeshError::Config(error.to_string()))
}

pub fn build_kademlia(
    local_peer_id: PeerId,
    config: &Libp2pMeshConfig,
) -> kad::Behaviour<MemoryStore> {
    let mut kademlia = kad::Behaviour::new(local_peer_id, MemoryStore::new(local_peer_id));
    kademlia.set_mode(Some(if config.kad_server_mode {
        Mode::Server
    } else {
        Mode::Client
    }));
    kademlia
}

pub fn build_autonat(local_peer_id: PeerId) -> autonat::Behaviour {
    autonat::Behaviour::new(local_peer_id, autonat::Config::default())
}

pub fn build_dcutr(local_peer_id: PeerId) -> dcutr::Behaviour {
    dcutr::Behaviour::new(local_peer_id)
}

pub fn build_relay_client(
    local_peer_id: PeerId,
) -> (relay::client::Transport, relay::client::Behaviour) {
    relay::client::new(local_peer_id)
}

pub fn build_relay_server(local_peer_id: PeerId) -> relay::Behaviour {
    relay::Behaviour::new(local_peer_id, relay::Config::default())
}

pub fn mesh_ident_topic(topic: &str) -> Result<IdentTopic, MeshError> {
    if !is_valid_mesh_topic(topic) {
        return Err(MeshError::InvalidTopic);
    }
    Ok(IdentTopic::new(topic))
}

pub fn envelope_to_gossipsub_data(
    envelope: &BlindMeshEnvelope,
    now_ms: u64,
) -> Result<Vec<u8>, Libp2pMeshError> {
    envelope.validate(now_ms)?;
    serde_json::to_vec(envelope).map_err(|_| Libp2pMeshError::InvalidEnvelopeBytes)
}

pub fn envelope_from_gossipsub_data(
    data: &[u8],
    now_ms: u64,
) -> Result<BlindMeshEnvelope, Libp2pMeshError> {
    if data.is_empty() || data.len() > MESSK_MAX_GOSSIPSUB_BYTES {
        return Err(Libp2pMeshError::InvalidEnvelopeBytes);
    }
    let envelope = serde_json::from_slice::<BlindMeshEnvelope>(data)
        .map_err(|_| Libp2pMeshError::InvalidEnvelopeBytes)?;
    envelope.validate(now_ms)?;
    Ok(envelope)
}

pub fn publish_envelope(
    gossipsub: &mut gossipsub::Behaviour,
    envelope: &BlindMeshEnvelope,
    now_ms: u64,
) -> Result<gossipsub::MessageId, Libp2pMeshError> {
    let topic = mesh_ident_topic(&envelope.topic)?;
    let data = envelope_to_gossipsub_data(envelope, now_ms)?;
    gossipsub
        .publish(topic, data)
        .map_err(Libp2pMeshError::from)
}

pub fn is_blind_mesh_json(data: &[u8], now_ms: u64) -> bool {
    const FORBIDDEN_FIELDS: &[&str] = &[
        "sender",
        "sender_pub_key",
        "senderPubKey",
        "recipient",
        "recipient_pub_key",
        "recipientPubKey",
        "identity",
        "plaintext",
        "file_key",
        "fileKey",
        "session_secret",
        "sessionSecret",
        "session_token",
        "sessionToken",
        "ratchet_secret",
        "ratchetSecret",
    ];

    envelope_from_gossipsub_data(data, now_ms).is_ok_and(|envelope| {
        serde_json::to_value(envelope).is_ok_and(|value| {
            FORBIDDEN_FIELDS
                .iter()
                .all(|field| value.get(*field).is_none())
        })
    })
}

pub fn mesh_protocol_version() -> u8 {
    MESH_PROTOCOL_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mesh::{BlindMeshEnvelope, MeshThreadKind, MeshThreadRef};

    #[test]
    fn capabilities_follow_config_flags() {
        let config = Libp2pMeshConfig {
            enable_autonat: false,
            enable_dcutr: false,
            enable_relay_client: false,
            enable_relay_server: true,
            ..Default::default()
        };

        assert_eq!(
            enabled_capabilities(&config),
            vec![
                Libp2pMeshCapability::Gossipsub,
                Libp2pMeshCapability::Kademlia,
                Libp2pMeshCapability::Identify,
                Libp2pMeshCapability::CircuitRelayServer,
            ]
        );
    }

    #[test]
    fn builds_libp2p_behaviours_behind_feature_flag() {
        let key = identity::Keypair::generate_ed25519();
        let expected_peer_id = PeerId::from(key.public());
        let behaviours = build_mesh_behaviours(key, Libp2pMeshConfig::default()).unwrap();

        assert_eq!(behaviours.local_peer_id, expected_peer_id);
        assert!(behaviours.autonat.is_some());
        assert!(behaviours.dcutr.is_some());
        assert!(behaviours.relay_client_transport.is_some());
        assert!(behaviours.relay_client.is_some());
        assert!(behaviours.relay_server.is_none());
    }

    #[test]
    fn builds_composable_swarm_parts_with_toggle_behaviours() {
        let key = identity::Keypair::generate_ed25519();
        let expected_peer_id = PeerId::from(key.public());
        let parts = build_swarm_parts(
            key,
            Libp2pMeshConfig {
                enable_autonat: false,
                enable_relay_server: true,
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(parts.local_peer_id, expected_peer_id);
        assert!(parts.relay_client_transport.is_some());
        assert!(!parts.behaviour.autonat.is_enabled());
        assert!(parts.behaviour.dcutr.is_enabled());
        assert!(parts.behaviour.relay_client.is_enabled());
        assert!(parts.behaviour.relay_server.is_enabled());
    }

    #[test]
    fn maps_valid_mesh_topics_to_ident_topics() {
        let thread = MeshThreadRef::new(MeshThreadKind::Direct, "direct_a").unwrap();
        let topic = mesh_ident_topic(&thread.topic()).unwrap();

        assert_eq!(topic.to_string(), "messk/v1/direct/direct_a");
        assert!(matches!(
            mesh_ident_topic("messk/v1/direct/bad/slash"),
            Err(MeshError::InvalidTopic)
        ));
    }

    #[test]
    fn serializes_only_blind_envelope_fields_for_gossipsub() {
        let thread = MeshThreadRef::new(MeshThreadKind::Group, "grp_a").unwrap();
        let envelope = BlindMeshEnvelope::new(&thread, "msg-1", "ciphertext", 10_000).unwrap();

        let data = envelope_to_gossipsub_data(&envelope, 1_000).unwrap();
        let json = String::from_utf8(data.clone()).unwrap();
        let decoded = envelope_from_gossipsub_data(&data, 1_000).unwrap();

        assert_eq!(decoded, envelope);
        assert!(is_blind_mesh_json(&data, 1_000));
        assert!(!json.contains("sender"));
        assert!(!json.contains("recipient"));
        assert!(!json.contains("ratchet"));
        assert!(!json.contains("session"));
    }

    #[test]
    fn rejects_malformed_or_expired_gossipsub_payloads() {
        let thread = MeshThreadRef::new(MeshThreadKind::Channel, "chan_a").unwrap();
        let envelope = BlindMeshEnvelope::new(&thread, "msg-1", "ciphertext", 10_000).unwrap();
        let data = envelope_to_gossipsub_data(&envelope, 1_000).unwrap();

        assert!(matches!(
            envelope_from_gossipsub_data(b"{not-json", 1_000),
            Err(Libp2pMeshError::InvalidEnvelopeBytes)
        ));
        assert!(matches!(
            envelope_from_gossipsub_data(&data, 10_001),
            Err(Libp2pMeshError::Mesh(MeshError::Expired))
        ));
    }
}
