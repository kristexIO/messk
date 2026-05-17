use anyhow::Result;

#[cfg(target_os = "windows")]
pub fn show_message_notification(title: &str, body: &str) -> Result<()> {
    use winrt_notification::{Duration, Sound, Toast};

    Toast::new(Toast::POWERSHELL_APP_ID)
        .title(title)
        .text1(body)
        .duration(Duration::Short)
        .sound(Some(Sound::IM))
        .show()?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn show_message_notification(_title: &str, _body: &str) -> Result<()> {
    Ok(())
}
