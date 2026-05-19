use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};

pub const MESH_PROTOCOL_VERSION: u8 = 1;
pub const MESH_TOPIC_PREFIX: &str = "messk/v1";
pub const MESH_DEFAULT_HOP_LIMIT: u8 = 3;
pub const MESH_MAX_HOP_LIMIT: u8 = 8;
pub const MESH_MAX_CIPHERTEXT_LEN: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeshThreadKind {
    Direct,
    Group,
    Channel,
}

impl MeshThreadKind {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::Group => "group",
            Self::Channel => "channel",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshThreadRef {
    pub kind: MeshThreadKind,
    pub thread_id: String,
}

impl MeshThreadRef {
    pub fn new(kind: MeshThreadKind, thread_id: impl Into<String>) -> Result<Self, MeshError> {
        let thread_id =
            normalize_topic_segment(&thread_id.into()).ok_or(MeshError::InvalidThreadId)?;
        Ok(Self { kind, thread_id })
    }

    pub fn topic(&self) -> String {
        mesh_topic(self.kind, &self.thread_id).expect("MeshThreadRef validates thread_id")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlindMeshEnvelope {
    pub v: u8,
    pub topic: String,
    pub msg_id: String,
    pub ciphertext: String,
    pub hop_limit: u8,
    pub expires_at_ms: u64,
}

impl BlindMeshEnvelope {
    pub fn new(
        thread: &MeshThreadRef,
        msg_id: impl Into<String>,
        ciphertext: impl Into<String>,
        expires_at_ms: u64,
    ) -> Result<Self, MeshError> {
        let msg_id = normalize_message_id(&msg_id.into()).ok_or(MeshError::InvalidMessageId)?;
        let ciphertext = ciphertext.into();
        if ciphertext.trim().is_empty() || ciphertext.len() > MESH_MAX_CIPHERTEXT_LEN {
            return Err(MeshError::InvalidCiphertext);
        }
        Ok(Self {
            v: MESH_PROTOCOL_VERSION,
            topic: thread.topic(),
            msg_id,
            ciphertext,
            hop_limit: MESH_DEFAULT_HOP_LIMIT,
            expires_at_ms,
        })
    }

    pub fn validate(&self, now_ms: u64) -> Result<(), MeshError> {
        if self.v != MESH_PROTOCOL_VERSION {
            return Err(MeshError::UnsupportedVersion);
        }
        if !is_valid_topic(&self.topic) {
            return Err(MeshError::InvalidTopic);
        }
        if normalize_message_id(&self.msg_id).as_deref() != Some(self.msg_id.as_str()) {
            return Err(MeshError::InvalidMessageId);
        }
        if self.ciphertext.trim().is_empty() || self.ciphertext.len() > MESH_MAX_CIPHERTEXT_LEN {
            return Err(MeshError::InvalidCiphertext);
        }
        if self.hop_limit > MESH_MAX_HOP_LIMIT {
            return Err(MeshError::InvalidHopLimit);
        }
        if self.expires_at_ms <= now_ms {
            return Err(MeshError::Expired);
        }
        Ok(())
    }

    pub fn next_hop(&self) -> Option<Self> {
        if self.hop_limit == 0 {
            return None;
        }
        let mut next = self.clone();
        next.hop_limit -= 1;
        Some(next)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MeshError {
    InvalidThreadId,
    InvalidTopic,
    InvalidMessageId,
    InvalidCiphertext,
    InvalidHopLimit,
    UnsupportedVersion,
    Expired,
    Duplicate,
    UnknownNode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshDelivery {
    pub node_id: String,
    pub topic: String,
    pub msg_id: String,
    pub hop_limit: u8,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct MeshSimulationReport {
    pub delivered: Vec<MeshDelivery>,
    pub forwarded: usize,
    pub dropped_duplicates: usize,
    pub dropped_expired: usize,
    pub dropped_hop_limit: usize,
    pub dropped_unknown_nodes: usize,
}

#[derive(Debug, Default)]
pub struct MeshDedupeCache {
    seen: HashMap<String, u64>,
    order: VecDeque<String>,
}

impl MeshDedupeCache {
    pub fn remember(
        &mut self,
        envelope: &BlindMeshEnvelope,
        now_ms: u64,
    ) -> Result<bool, MeshError> {
        envelope.validate(now_ms)?;
        self.prune(now_ms);

        let key = mesh_dedupe_key(&envelope.topic, &envelope.msg_id);
        if self.seen.contains_key(&key) {
            return Ok(false);
        }

        self.seen.insert(key.clone(), envelope.expires_at_ms);
        self.order.push_back(key);
        Ok(true)
    }

    pub fn prune(&mut self, now_ms: u64) {
        while let Some(key) = self.order.front().cloned() {
            let Some(expires_at_ms) = self.seen.get(&key).copied() else {
                self.order.pop_front();
                continue;
            };
            if expires_at_ms > now_ms {
                break;
            }
            self.order.pop_front();
            self.seen.remove(&key);
        }
    }
}

#[derive(Debug, Default)]
pub struct MeshSimulatorNode {
    subscriptions: HashSet<String>,
    dedupe: MeshDedupeCache,
}

impl MeshSimulatorNode {
    pub fn subscribe(&mut self, topic: impl Into<String>) -> Result<(), MeshError> {
        let topic = topic.into();
        if !is_valid_topic(&topic) {
            return Err(MeshError::InvalidTopic);
        }
        self.subscriptions.insert(topic);
        Ok(())
    }

    fn is_subscribed(&self, topic: &str) -> bool {
        self.subscriptions.contains(topic)
    }
}

#[derive(Debug)]
pub struct MeshSimulator {
    nodes: HashMap<String, MeshSimulatorNode>,
    links: HashMap<String, HashSet<String>>,
    now_ms: u64,
}

impl MeshSimulator {
    pub fn new(now_ms: u64) -> Self {
        Self {
            nodes: HashMap::new(),
            links: HashMap::new(),
            now_ms,
        }
    }

    pub fn add_node(&mut self, node_id: impl Into<String>) -> Result<(), MeshError> {
        let node_id = normalize_node_id(&node_id.into()).ok_or(MeshError::UnknownNode)?;
        self.nodes.entry(node_id.clone()).or_default();
        self.links.entry(node_id).or_default();
        Ok(())
    }

    pub fn subscribe(&mut self, node_id: &str, topic: impl Into<String>) -> Result<(), MeshError> {
        self.node_mut(node_id)?.subscribe(topic)
    }

    pub fn link_bidirectional(&mut self, left: &str, right: &str) -> Result<(), MeshError> {
        let left = normalize_node_id(left).ok_or(MeshError::UnknownNode)?;
        let right = normalize_node_id(right).ok_or(MeshError::UnknownNode)?;
        if !self.nodes.contains_key(&left) || !self.nodes.contains_key(&right) {
            return Err(MeshError::UnknownNode);
        }
        self.links
            .entry(left.clone())
            .or_default()
            .insert(right.clone());
        self.links.entry(right).or_default().insert(left);
        Ok(())
    }

    pub fn unlink_bidirectional(&mut self, left: &str, right: &str) -> Result<(), MeshError> {
        let left = normalize_node_id(left).ok_or(MeshError::UnknownNode)?;
        let right = normalize_node_id(right).ok_or(MeshError::UnknownNode)?;
        if !self.nodes.contains_key(&left) || !self.nodes.contains_key(&right) {
            return Err(MeshError::UnknownNode);
        }
        if let Some(neighbors) = self.links.get_mut(&left) {
            neighbors.remove(&right);
        }
        if let Some(neighbors) = self.links.get_mut(&right) {
            neighbors.remove(&left);
        }
        Ok(())
    }

    pub fn remove_node(&mut self, node_id: &str) -> Result<(), MeshError> {
        let node_id = normalize_node_id(node_id).ok_or(MeshError::UnknownNode)?;
        if self.nodes.remove(&node_id).is_none() {
            return Err(MeshError::UnknownNode);
        }
        self.links.remove(&node_id);
        for neighbors in self.links.values_mut() {
            neighbors.remove(&node_id);
        }
        Ok(())
    }

    pub fn set_now_ms(&mut self, now_ms: u64) {
        self.now_ms = now_ms;
        for node in self.nodes.values_mut() {
            node.dedupe.prune(now_ms);
        }
    }

    pub fn publish(
        &mut self,
        origin_node_id: &str,
        envelope: BlindMeshEnvelope,
    ) -> Result<MeshSimulationReport, MeshError> {
        envelope.validate(self.now_ms)?;
        let origin_node_id = normalize_node_id(origin_node_id).ok_or(MeshError::UnknownNode)?;
        if !self.nodes.contains_key(&origin_node_id) {
            return Err(MeshError::UnknownNode);
        }

        let mut report = MeshSimulationReport::default();
        let mut queue = VecDeque::new();
        self.accept_at_node(&origin_node_id, None, envelope, &mut queue, &mut report);

        while let Some(delivery) = queue.pop_front() {
            self.accept_at_node(
                &delivery.to_node_id,
                Some(&delivery.from_node_id),
                delivery.envelope,
                &mut queue,
                &mut report,
            );
        }

        Ok(report)
    }

    fn accept_at_node(
        &mut self,
        node_id: &str,
        from_node_id: Option<&str>,
        envelope: BlindMeshEnvelope,
        queue: &mut VecDeque<PendingMeshDelivery>,
        report: &mut MeshSimulationReport,
    ) {
        if envelope.validate(self.now_ms).is_err() {
            if envelope.expires_at_ms <= self.now_ms {
                report.dropped_expired += 1;
            }
            return;
        }

        let Some(node) = self.nodes.get_mut(node_id) else {
            report.dropped_unknown_nodes += 1;
            return;
        };
        match node.dedupe.remember(&envelope, self.now_ms) {
            Ok(true) => {}
            Ok(false) => {
                report.dropped_duplicates += 1;
                return;
            }
            Err(MeshError::Expired) => {
                report.dropped_expired += 1;
                return;
            }
            Err(_) => return,
        }

        if node.is_subscribed(&envelope.topic) {
            report.delivered.push(MeshDelivery {
                node_id: node_id.to_string(),
                topic: envelope.topic.clone(),
                msg_id: envelope.msg_id.clone(),
                hop_limit: envelope.hop_limit,
            });
        }

        let neighbors = self
            .links
            .get(node_id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|neighbor| Some(neighbor.as_str()) != from_node_id)
            .collect::<Vec<_>>();
        if neighbors.is_empty() {
            return;
        }

        let Some(next) = envelope.next_hop() else {
            report.dropped_hop_limit += neighbors.len();
            return;
        };
        for neighbor in neighbors {
            queue.push_back(PendingMeshDelivery {
                from_node_id: node_id.to_string(),
                to_node_id: neighbor,
                envelope: next.clone(),
            });
            report.forwarded += 1;
        }
    }

    fn node_mut(&mut self, node_id: &str) -> Result<&mut MeshSimulatorNode, MeshError> {
        let node_id = normalize_node_id(node_id).ok_or(MeshError::UnknownNode)?;
        self.nodes.get_mut(&node_id).ok_or(MeshError::UnknownNode)
    }
}

#[derive(Debug, Clone)]
struct PendingMeshDelivery {
    from_node_id: String,
    to_node_id: String,
    envelope: BlindMeshEnvelope,
}

pub fn mesh_topic(kind: MeshThreadKind, thread_id: &str) -> Option<String> {
    let thread_id = normalize_topic_segment(thread_id)?;
    Some(format!(
        "{}/{}/{}",
        MESH_TOPIC_PREFIX,
        kind.as_wire(),
        thread_id
    ))
}

pub fn mesh_dedupe_key(topic: &str, msg_id: &str) -> String {
    format!("{topic}:{msg_id}")
}

pub fn is_valid_mesh_topic(topic: &str) -> bool {
    is_valid_topic(topic)
}

fn is_valid_topic(topic: &str) -> bool {
    let Some(rest) = topic.strip_prefix(&format!("{MESH_TOPIC_PREFIX}/")) else {
        return false;
    };
    let mut parts = rest.split('/');
    let Some(kind) = parts.next() else {
        return false;
    };
    let Some(thread_id) = parts.next() else {
        return false;
    };
    if parts.next().is_some() {
        return false;
    }
    matches!(kind, "direct" | "group" | "channel") && normalize_topic_segment(thread_id).is_some()
}

fn normalize_topic_segment(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 160 {
        return None;
    }
    if value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    {
        Some(value.to_ascii_lowercase())
    } else {
        None
    }
}

fn normalize_message_id(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 128 {
        return None;
    }
    if value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':'))
    {
        Some(value.to_string())
    } else {
        None
    }
}

fn normalize_node_id(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 128 {
        return None;
    }
    if value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    {
        Some(value.to_ascii_lowercase())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mesh_topics_are_stable_and_sanitized() {
        let thread = MeshThreadRef::new(MeshThreadKind::Direct, "Direct_ABCD-1234").unwrap();

        assert_eq!(thread.thread_id, "direct_abcd-1234");
        assert_eq!(thread.topic(), "messk/v1/direct/direct_abcd-1234");
        assert!(MeshThreadRef::new(MeshThreadKind::Group, "bad/thread").is_err());
    }

    #[test]
    fn blind_envelope_has_no_identity_fields_and_validates() {
        let thread = MeshThreadRef::new(MeshThreadKind::Group, "grp_test").unwrap();
        let envelope = BlindMeshEnvelope::new(&thread, "msg-1", "ciphertext", 10_000).unwrap();
        let json = serde_json::to_string(&envelope).unwrap();

        assert!(!json.contains("sender"));
        assert!(!json.contains("recipient"));
        assert!(envelope.validate(1_000).is_ok());
        assert_eq!(
            envelope.next_hop().unwrap().hop_limit,
            MESH_DEFAULT_HOP_LIMIT - 1
        );
    }

    #[test]
    fn dedupe_rejects_repeats_until_expiry() {
        let thread = MeshThreadRef::new(MeshThreadKind::Channel, "chan_a").unwrap();
        let envelope = BlindMeshEnvelope::new(&thread, "msg-1", "ciphertext", 10_000).unwrap();
        let mut cache = MeshDedupeCache::default();

        assert_eq!(cache.remember(&envelope, 1_000), Ok(true));
        assert_eq!(cache.remember(&envelope, 2_000), Ok(false));
        cache.prune(10_001);
        assert_eq!(cache.remember(&envelope, 10_001), Err(MeshError::Expired));
    }

    #[test]
    fn invalid_mesh_envelopes_are_rejected() {
        let thread = MeshThreadRef::new(MeshThreadKind::Direct, "direct_a").unwrap();
        let mut envelope = BlindMeshEnvelope::new(&thread, "msg-1", "ciphertext", 10_000).unwrap();

        envelope.hop_limit = MESH_MAX_HOP_LIMIT + 1;
        assert_eq!(envelope.validate(1_000), Err(MeshError::InvalidHopLimit));
        envelope.hop_limit = MESH_DEFAULT_HOP_LIMIT;
        envelope.v = 99;
        assert_eq!(envelope.validate(1_000), Err(MeshError::UnsupportedVersion));
    }

    #[test]
    fn simulator_delivers_across_multi_hop_path() {
        let thread = MeshThreadRef::new(MeshThreadKind::Direct, "direct_a").unwrap();
        let envelope = BlindMeshEnvelope::new(&thread, "msg-1", "ciphertext", 10_000).unwrap();
        let mut simulator = MeshSimulator::new(1_000);
        for node in ["node-a", "node-b", "node-c"] {
            simulator.add_node(node).unwrap();
        }
        simulator.link_bidirectional("node-a", "node-b").unwrap();
        simulator.link_bidirectional("node-b", "node-c").unwrap();
        simulator.subscribe("node-c", thread.topic()).unwrap();

        let report = simulator.publish("node-a", envelope).unwrap();

        assert_eq!(report.delivered.len(), 1);
        assert_eq!(report.delivered[0].node_id, "node-c");
        assert_eq!(report.delivered[0].hop_limit, 1);
        assert_eq!(report.forwarded, 2);
    }

    #[test]
    fn simulator_dedupes_duplicate_gossip_paths() {
        let thread = MeshThreadRef::new(MeshThreadKind::Group, "grp_test").unwrap();
        let envelope = BlindMeshEnvelope::new(&thread, "msg-1", "ciphertext", 10_000).unwrap();
        let mut simulator = MeshSimulator::new(1_000);
        for node in ["node-a", "node-b", "node-c"] {
            simulator.add_node(node).unwrap();
        }
        simulator.link_bidirectional("node-a", "node-b").unwrap();
        simulator.link_bidirectional("node-a", "node-c").unwrap();
        simulator.link_bidirectional("node-b", "node-c").unwrap();
        simulator.subscribe("node-c", thread.topic()).unwrap();

        let report = simulator.publish("node-a", envelope).unwrap();

        assert_eq!(report.delivered.len(), 1);
        assert!(report.dropped_duplicates >= 1);
    }

    #[test]
    fn simulator_respects_hop_limit_and_expiry() {
        let thread = MeshThreadRef::new(MeshThreadKind::Channel, "chan_a").unwrap();
        let mut envelope = BlindMeshEnvelope::new(&thread, "msg-1", "ciphertext", 10_000).unwrap();
        envelope.hop_limit = 1;
        let mut simulator = MeshSimulator::new(1_000);
        for node in ["node-a", "node-b", "node-c"] {
            simulator.add_node(node).unwrap();
        }
        simulator.link_bidirectional("node-a", "node-b").unwrap();
        simulator.link_bidirectional("node-b", "node-c").unwrap();
        simulator.subscribe("node-c", thread.topic()).unwrap();

        let report = simulator.publish("node-a", envelope.clone()).unwrap();
        assert!(report.delivered.is_empty());
        assert_eq!(report.dropped_hop_limit, 1);

        simulator.set_now_ms(10_001);
        assert_eq!(
            simulator.publish("node-a", envelope),
            Err(MeshError::Expired)
        );
    }

    #[test]
    fn simulator_handles_nine_local_nodes_with_max_hop_limit() {
        let thread = MeshThreadRef::new(MeshThreadKind::Direct, "direct_long").unwrap();
        let mut envelope = BlindMeshEnvelope::new(&thread, "msg-1", "ciphertext", 10_000).unwrap();
        envelope.hop_limit = MESH_MAX_HOP_LIMIT;
        let mut simulator = MeshSimulator::new(1_000);
        for index in 0..=8 {
            simulator.add_node(format!("node-{index}")).unwrap();
            if index > 0 {
                simulator
                    .link_bidirectional(&format!("node-{}", index - 1), &format!("node-{index}"))
                    .unwrap();
            }
        }
        simulator.subscribe("node-8", thread.topic()).unwrap();

        let report = simulator.publish("node-0", envelope).unwrap();

        assert_eq!(report.delivered.len(), 1);
        assert_eq!(report.delivered[0].node_id, "node-8");
        assert_eq!(report.delivered[0].hop_limit, 0);
    }

    #[test]
    fn simulator_survives_relay_node_loss_with_alternate_path() {
        let thread = MeshThreadRef::new(MeshThreadKind::Group, "grp_relay").unwrap();
        let envelope = BlindMeshEnvelope::new(&thread, "msg-1", "ciphertext", 10_000).unwrap();
        let mut simulator = MeshSimulator::new(1_000);
        for node in ["origin", "relay-a", "relay-b", "target"] {
            simulator.add_node(node).unwrap();
        }
        simulator.link_bidirectional("origin", "relay-a").unwrap();
        simulator.link_bidirectional("relay-a", "target").unwrap();
        simulator.link_bidirectional("origin", "relay-b").unwrap();
        simulator.link_bidirectional("relay-b", "target").unwrap();
        simulator.remove_node("relay-a").unwrap();
        simulator.subscribe("target", thread.topic()).unwrap();

        let report = simulator.publish("origin", envelope).unwrap();

        assert_eq!(report.delivered.len(), 1);
        assert_eq!(report.delivered[0].node_id, "target");
    }
}
