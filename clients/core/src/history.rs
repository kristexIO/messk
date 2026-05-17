use crate::protocol;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectHistoryCursor {
    pub peer_public_key: String,
    pub cursor: i64,
    pub limit: usize,
}

impl DirectHistoryCursor {
    pub fn new(peer_public_key: impl Into<String>, cursor: i64, limit: usize) -> Self {
        Self {
            peer_public_key: peer_public_key.into(),
            cursor: cursor.max(0),
            limit: protocol::clamp_history_limit(limit),
        }
    }

    pub fn can_request(&self) -> bool {
        !self.peer_public_key.trim().is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_normalizes_negative_values() {
        let cursor = DirectHistoryCursor::new("peer", -20, 999);
        assert_eq!(cursor.cursor, 0);
        assert_eq!(cursor.limit, protocol::DIRECT_HISTORY_DEFAULT_LIMIT);
        assert!(cursor.can_request());
    }
}
