use anyhow::{Context, Result, anyhow};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::{
    fs::{self, File},
    io::BufWriter,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};
use uuid::Uuid;

type SharedWriter = Arc<Mutex<Option<hound::WavWriter<BufWriter<File>>>>>;

#[derive(Debug, Clone)]
pub struct RecordedVoice {
    pub path: PathBuf,
    pub duration_seconds: u64,
}

pub struct VoiceRecorder {
    stream: cpal::Stream,
    writer: SharedWriter,
    samples_written: Arc<AtomicU64>,
    path: PathBuf,
    sample_rate: u32,
    channels: u16,
    device_name: String,
    started_at: Instant,
}

impl VoiceRecorder {
    pub fn start() -> Result<Self> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| anyhow!("no input audio device is available"))?;
        let device_name = device
            .description()
            .map(|description| description.name().to_string())
            .unwrap_or_else(|_| "microphone".to_string());
        let supported_config = device
            .default_input_config()
            .context("failed to read default input audio config")?;
        let sample_format = supported_config.sample_format();
        let config: cpal::StreamConfig = supported_config.into();
        let sample_rate = config.sample_rate;
        let channels = config.channels;
        if channels == 0 {
            return Err(anyhow!("input audio device reported zero channels"));
        }

        let path = std::env::temp_dir().join(format!("messk-voice-{}.wav", Uuid::new_v4()));
        let writer = hound::WavWriter::create(
            &path,
            hound::WavSpec {
                channels,
                sample_rate,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .with_context(|| format!("failed to create voice recording {}", path.display()))?;
        let writer = Arc::new(Mutex::new(Some(writer)));
        let samples_written = Arc::new(AtomicU64::new(0));

        let stream = build_input_stream(
            &device,
            &config,
            sample_format,
            Arc::clone(&writer),
            Arc::clone(&samples_written),
        )?;
        stream
            .play()
            .context("failed to start microphone capture")?;

        Ok(Self {
            stream,
            writer,
            samples_written,
            path,
            sample_rate,
            channels,
            device_name,
            started_at: Instant::now(),
        })
    }

    pub fn device_name(&self) -> &str {
        &self.device_name
    }

    pub fn elapsed_seconds(&self) -> u64 {
        self.started_at.elapsed().as_secs()
    }

    pub fn stop(self) -> Result<RecordedVoice> {
        let VoiceRecorder {
            stream,
            writer,
            samples_written,
            path,
            sample_rate,
            channels,
            started_at,
            ..
        } = self;
        drop(stream);
        if let Some(writer) = writer
            .lock()
            .map_err(|_| anyhow!("voice recorder writer lock was poisoned"))?
            .take()
        {
            writer.finalize().context("failed to finalize voice WAV")?;
        }
        let samples = samples_written.load(Ordering::Relaxed);
        if samples == 0 {
            let _ = fs::remove_file(&path);
            return Err(anyhow!("voice recording is empty"));
        }
        let duration_seconds = recorded_duration_seconds(samples, channels, sample_rate)
            .max(started_at.elapsed().as_secs().min(1));
        Ok(RecordedVoice {
            path,
            duration_seconds,
        })
    }

    pub fn cancel(self) {
        let path = self.path.clone();
        drop(self);
        let _ = fs::remove_file(path);
    }
}

fn build_input_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    sample_format: cpal::SampleFormat,
    writer: SharedWriter,
    samples_written: Arc<AtomicU64>,
) -> Result<cpal::Stream> {
    let err_fn = |error| eprintln!("voice recorder stream error: {error}");
    match sample_format {
        cpal::SampleFormat::F32 => device
            .build_input_stream(
                config,
                move |data: &[f32], _| write_f32_samples(data, &writer, &samples_written),
                err_fn,
                None,
            )
            .context("failed to build f32 input stream"),
        cpal::SampleFormat::I16 => device
            .build_input_stream(
                config,
                move |data: &[i16], _| write_i16_samples(data, &writer, &samples_written),
                err_fn,
                None,
            )
            .context("failed to build i16 input stream"),
        cpal::SampleFormat::U16 => device
            .build_input_stream(
                config,
                move |data: &[u16], _| write_u16_samples(data, &writer, &samples_written),
                err_fn,
                None,
            )
            .context("failed to build u16 input stream"),
        other => Err(anyhow!("unsupported microphone sample format {other:?}")),
    }
}

fn write_f32_samples(data: &[f32], writer: &SharedWriter, samples_written: &AtomicU64) {
    write_samples(
        data.iter().copied().map(f32_to_i16),
        data.len(),
        writer,
        samples_written,
    );
}

fn write_i16_samples(data: &[i16], writer: &SharedWriter, samples_written: &AtomicU64) {
    write_samples(data.iter().copied(), data.len(), writer, samples_written);
}

fn write_u16_samples(data: &[u16], writer: &SharedWriter, samples_written: &AtomicU64) {
    write_samples(
        data.iter().copied().map(u16_to_i16),
        data.len(),
        writer,
        samples_written,
    );
}

fn write_samples(
    samples: impl IntoIterator<Item = i16>,
    count: usize,
    writer: &SharedWriter,
    samples_written: &AtomicU64,
) {
    let Ok(mut guard) = writer.lock() else {
        return;
    };
    let Some(writer) = guard.as_mut() else {
        return;
    };
    for sample in samples {
        if writer.write_sample(sample).is_err() {
            return;
        }
    }
    samples_written.fetch_add(count as u64, Ordering::Relaxed);
}

fn f32_to_i16(sample: f32) -> i16 {
    (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16
}

fn u16_to_i16(sample: u16) -> i16 {
    (sample as i32 - 32_768).clamp(i16::MIN as i32, i16::MAX as i32) as i16
}

fn recorded_duration_seconds(samples: u64, channels: u16, sample_rate: u32) -> u64 {
    let channels = channels.max(1) as u64;
    let sample_rate = sample_rate.max(1) as u64;
    let frames = samples / channels;
    frames.div_ceil(sample_rate).max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_common_sample_formats_to_i16() {
        assert_eq!(f32_to_i16(0.0), 0);
        assert_eq!(f32_to_i16(2.0), i16::MAX);
        assert_eq!(f32_to_i16(-2.0), i16::MIN + 1);
        assert_eq!(u16_to_i16(32_768), 0);
        assert_eq!(u16_to_i16(u16::MAX), i16::MAX);
    }

    #[test]
    fn duration_rounds_up_to_seconds() {
        assert_eq!(recorded_duration_seconds(48_000, 1, 48_000), 1);
        assert_eq!(recorded_duration_seconds(48_001, 1, 48_000), 2);
        assert_eq!(recorded_duration_seconds(96_000, 2, 48_000), 1);
    }
}
