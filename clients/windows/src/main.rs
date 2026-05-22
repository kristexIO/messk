#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod app_icon;
mod autostart;
mod config;
mod crypto;
mod media;
mod net;
mod notifier;
mod playback;
mod protocol;
mod ratchet;
mod storage;
mod ui;
mod vault;
mod voice;

fn main() -> eframe::Result<()> {
    let options = eframe::NativeOptions {
        viewport: eframe::egui::ViewportBuilder::default()
            .with_title("Messk")
            .with_inner_size([1320.0, 820.0])
            .with_min_inner_size([1040.0, 680.0])
            .with_icon(app_icon::messk_icon()),
        ..Default::default()
    };

    eframe::run_native(
        "Messk",
        options,
        Box::new(|creation_context| Ok(Box::new(app::MesskApp::new(creation_context)))),
    )
}
