pub fn clean_status(status: &str) -> &str {
    match status {
        "editing" => "editing",
        "deleted" => "deleted",
        "waiting_retry" => "retrying",
        "waiting retry" => "retrying",
        "pending" => "sending",
        "sent" => "sent",
        "delivered" => "delivered",
        "read" => "read",
        other => other,
    }
}

pub fn trim_line(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let take = max_chars.saturating_sub(3);
    let mut output: String = value.chars().take(take).collect();
    output.push_str("...");
    output
}

pub fn short_key(value: &str) -> String {
    if value.len() <= 18 {
        return value.to_string();
    }
    format!("{}...{}", &value[..10], &value[value.len() - 6..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_line_is_stable_for_short_and_long_text() {
        assert_eq!(trim_line("hello", 10), "hello");
        assert_eq!(trim_line("hello world", 8), "hello...");
    }

    #[test]
    fn short_key_keeps_edges() {
        assert_eq!(short_key("short"), "short");
        assert_eq!(
            short_key("abcdefghijklmnopqrstuvwxyz"),
            "abcdefghij...uvwxyz"
        );
    }

    #[test]
    fn clean_status_normalizes_retry() {
        assert_eq!(clean_status("waiting_retry"), "retrying");
        assert_eq!(clean_status("delivered"), "delivered");
    }
}
