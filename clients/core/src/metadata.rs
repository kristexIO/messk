use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaddingProfile {
    Disabled,
    Interactive,
    Balanced,
    HighPrivacy,
}

impl PaddingProfile {
    pub fn buckets(self) -> &'static [usize] {
        match self {
            Self::Disabled => &[],
            Self::Interactive => &[256, 1024, 4096, 16 * 1024],
            Self::Balanced => &[2 * 1024, 16 * 1024, 64 * 1024],
            Self::HighPrivacy => &[16 * 1024, 64 * 1024, 256 * 1024],
        }
    }

    pub fn target_len(self, payload_len: usize) -> usize {
        if matches!(self, Self::Disabled) {
            return payload_len;
        }
        let buckets = self.buckets();
        for bucket in buckets {
            if payload_len <= *bucket {
                return *bucket;
            }
        }
        let block = *buckets.last().unwrap_or(&payload_len.max(1));
        round_up(payload_len, block)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaddingPlan {
    pub profile: PaddingProfile,
    pub original_len: usize,
    pub padded_len: usize,
    pub overhead_len: usize,
}

impl PaddingPlan {
    pub fn new(profile: PaddingProfile, original_len: usize) -> Self {
        let padded_len = profile.target_len(original_len);
        Self {
            profile,
            original_len,
            padded_len,
            overhead_len: padded_len.saturating_sub(original_len),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MetadataError {
    PayloadTooLarge,
}

pub const MAX_PADDED_PAYLOAD_LEN: usize = 1024 * 1024;

pub fn pad_payload_with_byte(
    mut payload: Vec<u8>,
    profile: PaddingProfile,
    filler: u8,
) -> Result<(Vec<u8>, PaddingPlan), MetadataError> {
    let plan = PaddingPlan::new(profile, payload.len());
    if plan.padded_len > MAX_PADDED_PAYLOAD_LEN {
        return Err(MetadataError::PayloadTooLarge);
    }
    payload.resize(plan.padded_len, filler);
    Ok((payload, plan))
}

pub fn pad_json_envelope_with_padding_field(
    mut envelope: serde_json::Value,
    profile: PaddingProfile,
) -> Result<(String, PaddingPlan), MetadataError> {
    let base =
        serde_json::to_string(&envelope).expect("serde_json::Value serialization cannot fail");
    if matches!(profile, PaddingProfile::Disabled) {
        let plan = PaddingPlan::new(profile, base.len());
        return Ok((base, plan));
    }

    if !envelope.is_object() {
        let plan = PaddingPlan::new(profile, base.len());
        if plan.padded_len > MAX_PADDED_PAYLOAD_LEN {
            return Err(MetadataError::PayloadTooLarge);
        }
        return Ok((base, plan));
    }

    envelope
        .as_object_mut()
        .expect("object shape was checked")
        .insert(
            "padding".to_string(),
            serde_json::Value::String(String::new()),
        );
    let empty_padding =
        serde_json::to_string(&envelope).expect("serde_json::Value serialization cannot fail");
    let padded_len = profile.target_len(empty_padding.len());
    if padded_len > MAX_PADDED_PAYLOAD_LEN {
        return Err(MetadataError::PayloadTooLarge);
    }
    let padding_len = padded_len.saturating_sub(empty_padding.len());
    envelope
        .as_object_mut()
        .expect("object shape was checked")
        .insert(
            "padding".to_string(),
            serde_json::Value::String("0".repeat(padding_len)),
        );
    let padded =
        serde_json::to_string(&envelope).expect("serde_json::Value serialization cannot fail");
    Ok((
        padded.clone(),
        PaddingPlan {
            profile,
            original_len: base.len(),
            padded_len: padded.len(),
            overhead_len: padded.len().saturating_sub(base.len()),
        },
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DummyTrafficMode {
    Off,
    Conservative,
    Balanced,
    HighPrivacy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MetadataResistancePolicy {
    pub padding_profile: PaddingProfile,
    pub dummy_traffic: DummyTrafficMode,
    pub min_batch_delay_ms: u64,
    pub max_batch_delay_ms: u64,
}

impl Default for MetadataResistancePolicy {
    fn default() -> Self {
        Self {
            padding_profile: PaddingProfile::Interactive,
            dummy_traffic: DummyTrafficMode::Off,
            min_batch_delay_ms: 0,
            max_batch_delay_ms: 250,
        }
    }
}

impl MetadataResistancePolicy {
    pub fn normalized(mut self) -> Self {
        if self.max_batch_delay_ms < self.min_batch_delay_ms {
            self.max_batch_delay_ms = self.min_batch_delay_ms;
        }
        self
    }

    pub fn batch_delay_ms(&self, thread_id: &str, msg_id: &str) -> u64 {
        let policy = self.clone().normalized();
        stable_batch_delay_ms(
            policy.min_batch_delay_ms,
            policy.max_batch_delay_ms,
            thread_id,
            msg_id,
        )
    }

    pub fn dummy_interval_ms(&self) -> Option<u64> {
        match self.dummy_traffic {
            DummyTrafficMode::Off => None,
            DummyTrafficMode::Conservative => Some(5 * 60 * 1000),
            DummyTrafficMode::Balanced => Some(60 * 1000),
            DummyTrafficMode::HighPrivacy => Some(15 * 1000),
        }
    }
}

pub fn stable_batch_delay_ms(min_ms: u64, max_ms: u64, thread_id: &str, msg_id: &str) -> u64 {
    let max_ms = max_ms.max(min_ms);
    let window = max_ms.saturating_sub(min_ms);
    if window == 0 {
        return min_ms;
    }
    min_ms + u64::from(stable_metadata_hash32(&[thread_id, msg_id])) % (window + 1)
}

fn stable_metadata_hash32(parts: &[&str]) -> u32 {
    let mut hash = 0x811c_9dc5u32;
    for part in parts {
        for byte in part.as_bytes() {
            hash ^= u32::from(*byte);
            hash = hash.wrapping_mul(0x0100_0193);
        }
        hash ^= 0xff;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

fn round_up(value: usize, block: usize) -> usize {
    if value == 0 || block == 0 {
        return value;
    }
    value.div_ceil(block).saturating_mul(block)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn padding_profile_uses_expected_buckets() {
        assert_eq!(PaddingProfile::Disabled.target_len(7), 7);
        assert_eq!(PaddingProfile::Interactive.target_len(7), 256);
        assert_eq!(PaddingProfile::Interactive.target_len(257), 1024);
        assert_eq!(PaddingProfile::Balanced.target_len(2049), 16 * 1024);
        assert_eq!(
            PaddingProfile::HighPrivacy.target_len(70 * 1024),
            256 * 1024
        );
    }

    #[test]
    fn padding_never_shrinks_payload() {
        let (padded, plan) =
            pad_payload_with_byte(vec![1, 2, 3], PaddingProfile::Interactive, 9).unwrap();

        assert_eq!(plan.original_len, 3);
        assert_eq!(plan.padded_len, 256);
        assert_eq!(padded.len(), 256);
        assert_eq!(&padded[..3], &[1, 2, 3]);
        assert!(padded[3..].iter().all(|byte| *byte == 9));
    }

    #[test]
    fn json_padding_adds_encrypted_padding_field() {
        let (padded, plan) = pad_json_envelope_with_padding_field(
            serde_json::json!({
                "v": 1,
                "plaintext": "hello",
            }),
            PaddingProfile::Interactive,
        )
        .unwrap();
        let value: serde_json::Value = serde_json::from_str(&padded).unwrap();

        assert_eq!(padded.len(), 256);
        assert!(plan.original_len < plan.padded_len);
        assert_eq!(plan.padded_len, 256);
        assert_eq!(
            value.get("plaintext").and_then(|value| value.as_str()),
            Some("hello")
        );
        assert!(
            value
                .get("padding")
                .and_then(|value| value.as_str())
                .is_some()
        );
    }

    #[test]
    fn batch_policy_orders_delay_bounds() {
        let policy = MetadataResistancePolicy {
            min_batch_delay_ms: 500,
            max_batch_delay_ms: 50,
            ..MetadataResistancePolicy::default()
        }
        .normalized();

        assert_eq!(policy.max_batch_delay_ms, 500);
    }

    #[test]
    fn batch_delay_is_stable_and_bounded() {
        let policy = MetadataResistancePolicy::default();
        let first = policy.batch_delay_ms("thread-a", "msg-a");
        let second = policy.batch_delay_ms("thread-a", "msg-a");

        assert_eq!(first, second);
        assert!(first <= 250);
        assert_eq!(stable_batch_delay_ms(40, 20, "thread-a", "msg-a"), 40);
    }

    #[test]
    fn dummy_modes_map_to_intervals() {
        assert_eq!(
            DummyTrafficMode::Off,
            MetadataResistancePolicy::default().dummy_traffic
        );
        let policy = MetadataResistancePolicy {
            dummy_traffic: DummyTrafficMode::HighPrivacy,
            ..MetadataResistancePolicy::default()
        };
        assert_eq!(policy.dummy_interval_ms(), Some(15_000));
    }
}
