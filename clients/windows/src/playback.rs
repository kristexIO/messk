use anyhow::{Context, Result};
use rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player, Source};
use std::{
    fs::{self, File},
    path::{Path, PathBuf},
    time::Duration,
};

pub struct VoicePlayback {
    msg_id: String,
    path: PathBuf,
    _sink: MixerDeviceSink,
    player: Player,
    duration: Option<Duration>,
}

impl VoicePlayback {
    pub fn start(msg_id: String, path: PathBuf, fallback_duration_seconds: u64) -> Result<Self> {
        let result = Self::start_inner(msg_id, path.clone(), fallback_duration_seconds);
        if result.is_err() {
            let _ = fs::remove_file(path);
        }
        result
    }

    fn start_inner(msg_id: String, path: PathBuf, fallback_duration_seconds: u64) -> Result<Self> {
        let sink =
            DeviceSinkBuilder::open_default_sink().context("failed to open output audio device")?;
        let player = Player::connect_new(sink.mixer());
        let file =
            File::open(&path).with_context(|| format!("failed to open {}", path.display()))?;
        let source = Decoder::try_from(file).context("failed to decode voice message")?;
        let duration = source
            .total_duration()
            .or_else(|| fallback_duration(fallback_duration_seconds));
        player.append(source);
        Ok(Self {
            msg_id,
            path,
            _sink: sink,
            player,
            duration,
        })
    }

    pub fn msg_id(&self) -> &str {
        &self.msg_id
    }

    pub fn toggle_pause(&self) {
        if self.player.is_paused() {
            self.player.play();
        } else {
            self.player.pause();
        }
    }

    pub fn is_paused(&self) -> bool {
        self.player.is_paused()
    }

    pub fn is_finished(&self) -> bool {
        self.player.empty()
    }

    pub fn stop(&self) {
        self.player.stop();
    }

    pub fn position_seconds(&self) -> u64 {
        self.player.get_pos().as_secs()
    }

    pub fn duration_seconds(&self) -> Option<u64> {
        self.duration.map(|duration| duration.as_secs().max(1))
    }

    pub fn progress(&self) -> f32 {
        let Some(duration) = self.duration else {
            return 0.0;
        };
        let duration = duration.as_secs_f32();
        if duration <= 0.0 {
            return 0.0;
        }
        (self.player.get_pos().as_secs_f32() / duration).clamp(0.0, 1.0)
    }
}

impl Drop for VoicePlayback {
    fn drop(&mut self) {
        self.player.stop();
        let _ = fs::remove_file(&self.path);
    }
}

pub fn temp_voice_playback_path(msg_id: &str, extension: &str) -> PathBuf {
    let extension = safe_extension(extension);
    std::env::temp_dir().join(format!("messk-play-{}.{extension}", safe_stem(msg_id)))
}

fn fallback_duration(seconds: u64) -> Option<Duration> {
    if seconds == 0 {
        None
    } else {
        Some(Duration::from_secs(seconds))
    }
}

fn safe_stem(value: &str) -> String {
    let stem: String = value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .take(64)
        .collect();
    if stem.is_empty() {
        "voice".to_string()
    } else {
        stem
    }
}

fn safe_extension(value: &str) -> String {
    let extension: String = value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(12)
        .collect();
    if extension.is_empty() {
        "audio".to_string()
    } else {
        extension
    }
}

#[allow(dead_code)]
pub fn remove_temp_voice_file(path: &Path) {
    let _ = fs::remove_file(path);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temp_path_sanitizes_ids_and_extensions() {
        let path = temp_voice_playback_path("../abc+123", "w@v");
        let text = path.to_string_lossy();
        assert!(text.contains("abc123"));
        assert!(text.ends_with(".wv"));
    }

    #[test]
    fn progress_is_zero_without_duration() {
        assert_eq!(fallback_duration(0), None);
        assert_eq!(fallback_duration(3), Some(Duration::from_secs(3)));
    }
}
