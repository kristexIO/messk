#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetryDecision {
    pub should_retry: bool,
    pub delay_ms: u64,
}

pub const RETRY_BASE_DELAY_MS: u64 = 3_000;
pub const RETRY_MAX_DELAY_MS: u64 = 30_000;

pub fn retry_decision(attempts: u32) -> RetryDecision {
    let exponent = attempts.min(4);
    let delay = RETRY_BASE_DELAY_MS.saturating_mul(2_u64.saturating_pow(exponent));
    RetryDecision {
        should_retry: true,
        delay_ms: delay.min(RETRY_MAX_DELAY_MS),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_delay_is_exponential_and_capped() {
        assert_eq!(retry_decision(0).delay_ms, 3_000);
        assert_eq!(retry_decision(1).delay_ms, 6_000);
        assert_eq!(retry_decision(4).delay_ms, 30_000);
        assert_eq!(retry_decision(99).delay_ms, 30_000);
    }
}
