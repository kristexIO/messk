pub const APP_NAME: &str = "Messk";
pub const CLIENT_STATE_VERSION: &str = "clean_20260511";
pub const DEFAULT_BACKEND_ORIGIN: &str = "https://messk.online";

pub fn health_url(origin: &str) -> String {
    format!("{}/health", trim_origin(origin))
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

fn url_escape(value: &str) -> String {
    value
        .replace('%', "%25")
        .replace('+', "%2B")
        .replace('/', "%2F")
        .replace('=', "%3D")
}
