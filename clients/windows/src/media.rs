pub const MAX_ATTACHMENT_SIZE_BYTES: u64 = 75 * 1024 * 1024;
pub const VOICE_EXTENSIONS: &[&str] = &["webm", "ogg", "opus", "m4a", "wav", "mp3"];

pub fn normalized_voice_mime(mime_type: &str) -> String {
    let mime_type = mime_type.trim();
    if mime_type.is_empty() || mime_type == "application/octet-stream" {
        "audio/webm".to_string()
    } else {
        mime_type.to_string()
    }
}

pub fn voice_extension_from_mime(mime_type: &str) -> &'static str {
    match mime_type.trim().to_ascii_lowercase().as_str() {
        "audio/wav" | "audio/wave" | "audio/x-wav" => "wav",
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/mp4" | "audio/aac" | "audio/x-m4a" => "m4a",
        "audio/ogg" | "audio/opus" => "ogg",
        "audio/webm" => "webm",
        _ => "audio",
    }
}
