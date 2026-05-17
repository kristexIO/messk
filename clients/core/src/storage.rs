pub const LOCAL_SCHEMA_VERSION: i64 = 1;

pub trait LocalSchema {
    fn schema_version(&self) -> i64;

    fn is_supported(&self) -> bool {
        self.schema_version() >= LOCAL_SCHEMA_VERSION
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Store(i64);

    impl LocalSchema for Store {
        fn schema_version(&self) -> i64 {
            self.0
        }
    }

    #[test]
    fn schema_support_is_versioned() {
        assert!(Store(LOCAL_SCHEMA_VERSION).is_supported());
        assert!(!Store(0).is_supported());
    }
}
