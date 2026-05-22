pub const APP_NAME: &str = "Messk";
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const CLIENT_STATE_VERSION: &str = "clean_20260511";
pub const DEFAULT_BACKEND_ORIGIN: &str = "https://messk.online";

pub fn health_url(origin: &str) -> String {
    format!("{}/health", trim_origin(origin))
}

pub fn bootstrap_url(origin: &str) -> String {
    format!("{}/bootstrap", trim_origin(origin))
}

pub fn directory_resolve_url(origin: &str, username: &str) -> String {
    format!(
        "{}/directory/resolve?username={}",
        trim_origin(origin),
        url_escape(username)
    )
}

pub fn direct_history_url(
    origin: &str,
    peer_public_key: &str,
    cursor: i64,
    limit: usize,
) -> String {
    format!(
        "{}/history/direct?peer={}&cursor={}&limit={}",
        trim_origin(origin),
        url_escape(peer_public_key),
        cursor.max(0),
        limit.clamp(1, 500)
    )
}

pub fn upload_url(origin: &str) -> String {
    format!("{}/upload", trim_origin(origin))
}

pub fn profile_url(origin: &str) -> String {
    format!("{}/profile", trim_origin(origin))
}

pub fn profile_get_url(origin: &str, public_key: &str) -> String {
    format!(
        "{}/profile?pub={}",
        trim_origin(origin),
        url_escape(public_key)
    )
}

pub fn websocket_url(origin: &str, public_key: &str) -> String {
    let origin = trim_origin(origin);
    let ws_origin = if let Some(rest) = origin.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = origin.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        origin
    };
    format!(
        "{ws_origin}/ws?pub={}&state={}",
        url_escape(public_key),
        url_escape(CLIENT_STATE_VERSION)
    )
}

fn trim_origin(origin: &str) -> String {
    origin.trim().trim_end_matches('/').to_string()
}

pub fn url_escape(value: &str) -> String {
    value
        .replace('%', "%25")
        .replace('+', "%2B")
        .replace('/', "%2F")
        .replace('=', "%3D")
}
