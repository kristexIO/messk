#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod config;
mod crypto;
mod net;
mod protocol;
mod ratchet;
mod storage;
mod vault;

fn main() -> eframe::Result<()> {
    let options = eframe::NativeOptions {
        viewport: eframe::egui::ViewportBuilder::default()
            .with_title("Messk")
            .with_inner_size([1320.0, 820.0])
            .with_min_inner_size([1040.0, 680.0]),
        ..Default::default()
    };

    eframe::run_native(
        "Messk",
        options,
        Box::new(|creation_context| Ok(Box::new(app::MesskApp::new(creation_context)))),
    )
}
