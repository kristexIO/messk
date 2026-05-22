use anyhow::{Context, Result, anyhow};
use std::path::Path;

const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE_NAME: &str = "Messk";

pub fn is_supported() -> bool {
    cfg!(target_os = "windows")
}

pub fn set_enabled(enabled: bool) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        if enabled {
            let exe = std::env::current_exe().context("failed to resolve current executable")?;
            run_reg(&[
                "add",
                RUN_KEY,
                "/v",
                VALUE_NAME,
                "/t",
                "REG_SZ",
                "/d",
                &quote_run_value(&exe),
                "/f",
            ])
        } else {
            run_reg(&["delete", RUN_KEY, "/v", VALUE_NAME, "/f"])
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = enabled;
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn run_reg(args: &[&str]) -> Result<()> {
    let output = std::process::Command::new("reg.exe")
        .args(args)
        .output()
        .context("failed to run reg.exe")?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    Err(anyhow!(
        "registry update failed: {}{}",
        stdout.trim(),
        stderr.trim()
    ))
}

fn quote_run_value(path: &Path) -> String {
    format!("\"{}\"", path.display())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn quotes_run_value_for_paths_with_spaces() {
        let path = PathBuf::from(r"C:\Program Files\Messk\messk-windows.exe");
        assert_eq!(
            quote_run_value(&path),
            r#""C:\Program Files\Messk\messk-windows.exe""#
        );
    }
}
