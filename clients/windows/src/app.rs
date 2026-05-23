use crate::{
    autostart, config, crypto, media, net, notifier, playback, storage,
    ui::format::{clean_status, short_key, trim_line},
    vault, voice,
};
use eframe::egui;
use messk_core::payload::{
    EncryptedFilePayload, MessagePayloadKind, MessagePayloadPreview, VoiceMessagePayload,
    display_message_text, encrypted_file_payload, is_deleted_message_payload,
    message_payload_preview, voice_message_payload,
};
use messk_core::{call, profile, transport};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::task::JoinHandle;
use uuid::Uuid;

#[derive(Debug)]
enum UiEvent {
    HealthOk(net::HealthStatus),
    HealthErr(String),
    RealtimeErr(String),
    RealtimeEvent(net::RealtimeEvent),
    DirectOk(net::DirectSendResult),
    DirectErr {
        msg_id: String,
        error: String,
    },
    DirectFileOk {
        result: net::DirectSendResult,
        recipient_public_key: String,
        plaintext: String,
        file_name: String,
    },
    DirectFileErr {
        msg_id: String,
        recipient_public_key: String,
        plaintext: Option<String>,
        error: String,
    },
    FileDownloadOk {
        path: PathBuf,
    },
    FileDownloadErr {
        error: String,
    },
    VoicePlaybackReady {
        msg_id: String,
        path: PathBuf,
        duration_seconds: u64,
    },
    VoicePlaybackErr {
        msg_id: String,
        error: String,
    },
    CallSignalOk {
        kind: String,
        peer_public_key: String,
        acknowledged: bool,
    },
    CallSignalErr {
        kind: String,
        peer_public_key: String,
        error: String,
    },
    DirectControlOk {
        target_msg_id: String,
        action: String,
        acknowledged: bool,
    },
    DirectControlErr {
        target_msg_id: String,
        action: String,
        error: String,
    },
    TrayShow,
    TrayHide,
    TrayQuit,
    DirectoryResolved {
        result: net::DirectoryResolveResult,
        display_name: String,
    },
    DirectoryResolveErr(String),
    ProfileLoaded(net::RemoteProfile),
    ProfileLoadErr(String),
    ProfileSaved(profile::UserProfile),
    ProfileSaveErr(String),
    OutboxFlushed,
}

#[derive(Debug, Clone)]
struct ChatLine {
    peer_public_key: String,
    msg_id: String,
    text: String,
    incoming: bool,
    status: String,
    created_at_ms: i64,
    reactions: BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
struct ContactAlias {
    display_name: String,
    updated_at_ms: i64,
}

#[derive(Debug, Clone)]
struct RoomSummary {
    room_id: String,
    kind: String,
    title: String,
    avatar: String,
    role: String,
    muted: bool,
    pinned: bool,
    created_at_ms: i64,
    updated_at_ms: i64,
}

#[derive(Debug, Clone)]
struct ReplyDraft {
    msg_id: String,
    preview: String,
}

#[derive(Debug, Clone)]
struct EditDraft {
    msg_id: String,
    original: String,
}

#[derive(Debug, Clone)]
struct PendingCall {
    peer_public_key: String,
    incoming: bool,
    media: call::CallMediaKind,
}

pub struct MesskApp {
    runtime: tokio::runtime::Runtime,
    tx: mpsc::Sender<UiEvent>,
    rx: mpsc::Receiver<UiEvent>,
    backend_origin: String,
    identity: Option<crypto::Identity>,
    pending_identity: Option<crypto::Identity>,
    store: Option<storage::LocalStore>,
    seed_input: String,
    seed_confirmation_input: String,
    seed_confirmed: bool,
    profile_nickname: String,
    profile_username: String,
    profile_avatar: String,
    profile_status: String,
    health_status: String,
    realtime_status: String,
    call_status: String,
    pending_call: Option<PendingCall>,
    active_call: Option<call::CallSession>,
    voice_recorder: Option<voice::VoiceRecorder>,
    voice_playback: Option<playback::VoicePlayback>,
    voice_status: String,
    active_workspace: usize,
    active_filter: usize,
    chat_search: String,
    show_message_search: bool,
    message_search: String,
    selected_chat: usize,
    recipient_public_key: String,
    composer_text: String,
    reply_draft: Option<ReplyDraft>,
    edit_draft: Option<EditDraft>,
    show_new_chat: bool,
    new_chat_public_key: String,
    new_chat_name: String,
    new_chat_status: String,
    show_settings: bool,
    settings: storage::StoredAppSettings,
    settings_draft: storage::StoredAppSettings,
    settings_fallback_origins_text: String,
    show_contact_profile: bool,
    profile_public_key: String,
    profile_display_name: String,
    show_room_editor: bool,
    room_editor_id: String,
    room_editor_kind: String,
    room_editor_title: String,
    room_editor_avatar: String,
    room_editor_role: String,
    room_editor_muted: bool,
    room_editor_pinned: bool,
    room_editor_status: String,
    messages: Vec<ChatLine>,
    contacts: HashMap<String, ContactAlias>,
    rooms: Vec<RoomSummary>,
    selected_room_id: String,
    pinned_message_ids: HashSet<String>,
    outbox_count: usize,
    outbox_preview: Vec<storage::OutboxMessage>,
    tray_icon: Option<tray_icon::TrayIcon>,
    realtime_tasks: Vec<JoinHandle<()>>,
    logs: Vec<String>,
}

impl MesskApp {
    pub fn new(creation_context: &eframe::CreationContext<'_>) -> Self {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("messk-net")
            .build()
            .expect("failed to create async runtime");
        let (tx, rx) = mpsc::channel();
        let (store, store_log) = match storage::LocalStore::new_default() {
            Ok(store) => {
                let log = format!("local store: {}", store.path().display());
                (Some(store), log)
            }
            Err(error) => (None, format!("local store error: {error}")),
        };
        let settings = store
            .as_ref()
            .and_then(|store| store.load_app_settings().ok())
            .unwrap_or_default();
        let mut app = Self {
            runtime,
            tx,
            rx,
            backend_origin: settings.backend_origin.clone(),
            identity: None,
            pending_identity: None,
            store,
            seed_input: String::new(),
            seed_confirmation_input: String::new(),
            seed_confirmed: false,
            profile_nickname: String::new(),
            profile_username: String::new(),
            profile_avatar: String::new(),
            profile_status: String::new(),
            health_status: "not checked".to_string(),
            realtime_status: "offline".to_string(),
            call_status: String::new(),
            pending_call: None,
            active_call: None,
            voice_recorder: None,
            voice_playback: None,
            voice_status: String::new(),
            active_workspace: 0,
            active_filter: 0,
            chat_search: String::new(),
            show_message_search: false,
            message_search: String::new(),
            selected_chat: 0,
            recipient_public_key: String::new(),
            composer_text: String::new(),
            reply_draft: None,
            edit_draft: None,
            show_new_chat: false,
            new_chat_public_key: String::new(),
            new_chat_name: String::new(),
            new_chat_status: String::new(),
            show_settings: false,
            settings: settings.clone(),
            settings_draft: settings.clone(),
            settings_fallback_origins_text: fallback_origins_to_text(&settings.fallback_origins),
            show_contact_profile: false,
            profile_public_key: String::new(),
            profile_display_name: String::new(),
            show_room_editor: false,
            room_editor_id: String::new(),
            room_editor_kind: "group".to_string(),
            room_editor_title: String::new(),
            room_editor_avatar: String::new(),
            room_editor_role: String::new(),
            room_editor_muted: false,
            room_editor_pinned: false,
            room_editor_status: String::new(),
            messages: Vec::new(),
            contacts: HashMap::new(),
            rooms: Vec::new(),
            selected_room_id: String::new(),
            pinned_message_ids: HashSet::new(),
            outbox_count: 0,
            outbox_preview: Vec::new(),
            tray_icon: None,
            realtime_tasks: Vec::new(),
            logs: vec!["Messk native client booted.".to_string(), store_log],
        };
        app.install_tray_icon(creation_context.egui_ctx.clone());
        app.try_load_stored_identity();
        if app.settings.auto_connect && app.identity.is_some() {
            app.connect_realtime();
        }
        app
    }

    fn install_tray_icon(&mut self, ctx: egui::Context) {
        if self.tray_icon.is_some() {
            return;
        }
        match build_tray_icon(ctx, self.tx.clone()) {
            Ok(tray_icon) => {
                self.tray_icon = Some(tray_icon);
                self.logs.push("tray icon ready".to_string());
            }
            Err(error) => self.logs.push(format!("tray icon unavailable: {error}")),
        }
    }

    fn drain_events(&mut self, ctx: &egui::Context) {
        while let Ok(event) = self.rx.try_recv() {
            match event {
                UiEvent::HealthOk(status) => {
                    self.health_status = status.status;
                    self.logs.push(format!("health ok: {}", status.raw));
                }
                UiEvent::HealthErr(error) => {
                    self.health_status = "error".to_string();
                    self.logs.push(format!("health error: {error}"));
                }
                UiEvent::RealtimeErr(error) => {
                    self.realtime_status = "offline".to_string();
                    self.logs.push(format!("ws error: {error}"));
                }
                UiEvent::RealtimeEvent(event) => self.handle_realtime_event(event),
                UiEvent::DirectOk(result) => {
                    let ack = if result.acknowledged {
                        "server ack"
                    } else {
                        "sent, ack timeout"
                    };
                    let prekey = if result.used_prekey {
                        "prekey"
                    } else {
                        "no prekey fallback"
                    };
                    self.logs
                        .push(format!("direct message {}: {ack}, {prekey}", result.msg_id));
                    self.set_message_status(
                        &result.msg_id,
                        if result.acknowledged {
                            "sent"
                        } else {
                            "pending"
                        },
                    );
                    self.refresh_account_stats();
                }
                UiEvent::DirectErr { msg_id, error } => {
                    self.logs.push(format!("direct send error: {error}"));
                    self.set_message_status(&msg_id, "waiting retry");
                    self.refresh_account_stats();
                }
                UiEvent::DirectFileOk {
                    result,
                    recipient_public_key,
                    plaintext,
                    file_name,
                } => {
                    let status = if result.acknowledged {
                        "sent"
                    } else {
                        "pending"
                    };
                    self.upsert_chat_line(ChatLine {
                        peer_public_key: recipient_public_key,
                        msg_id: result.msg_id.clone(),
                        text: plaintext,
                        incoming: false,
                        status: status.to_string(),
                        created_at_ms: app_now_ms(),
                        reactions: BTreeMap::new(),
                    });
                    self.logs.push(format!("file sent: {file_name}"));
                    if file_name.starts_with("voice message") {
                        self.voice_status = "voice sent".to_string();
                    }
                    self.refresh_account_stats();
                }
                UiEvent::DirectFileErr {
                    msg_id,
                    recipient_public_key,
                    plaintext,
                    error,
                } => {
                    self.logs.push(format!("file send error: {error}"));
                    if plaintext
                        .as_ref()
                        .is_some_and(|value| voice_message_payload(value).is_some())
                    {
                        self.voice_status = format!("voice send error: {error}");
                    }
                    if let Some(plaintext) = plaintext {
                        self.upsert_chat_line(ChatLine {
                            peer_public_key: recipient_public_key,
                            msg_id,
                            text: plaintext,
                            incoming: false,
                            status: "waiting_retry".to_string(),
                            created_at_ms: app_now_ms(),
                            reactions: BTreeMap::new(),
                        });
                    }
                    self.refresh_account_stats();
                }
                UiEvent::FileDownloadOk { path } => {
                    self.logs.push(format!("file saved: {}", path.display()));
                }
                UiEvent::FileDownloadErr { error } => {
                    self.logs.push(format!("file download error: {error}"));
                }
                UiEvent::VoicePlaybackReady {
                    msg_id,
                    path,
                    duration_seconds,
                } => match playback::VoicePlayback::start(msg_id.clone(), path, duration_seconds) {
                    Ok(player) => {
                        self.voice_playback = Some(player);
                        self.voice_status = "voice playing".to_string();
                    }
                    Err(error) => {
                        self.voice_status = format!("voice playback failed: {error}");
                        self.logs.push(self.voice_status.clone());
                    }
                },
                UiEvent::VoicePlaybackErr { msg_id, error } => {
                    self.voice_status =
                        format!("voice download failed {}: {error}", short_key(&msg_id));
                    self.logs.push(self.voice_status.clone());
                }
                UiEvent::CallSignalOk {
                    kind,
                    peer_public_key,
                    acknowledged,
                } => {
                    let ack = if acknowledged { "acknowledged" } else { "sent" };
                    self.logs
                        .push(format!("{kind} {ack} for {}", short_key(&peer_public_key)));
                }
                UiEvent::CallSignalErr {
                    kind,
                    peer_public_key,
                    error,
                } => {
                    self.logs.push(format!(
                        "{kind} failed for {}: {error}",
                        short_key(&peer_public_key)
                    ));
                    self.call_status = format!("Call signaling failed: {error}");
                    self.pending_call = None;
                    if let Some(call) = &mut self.active_call {
                        call.fail();
                    }
                }
                UiEvent::DirectControlOk {
                    target_msg_id,
                    action,
                    acknowledged,
                } => {
                    let ack = if acknowledged {
                        "server ack"
                    } else {
                        "ack timeout"
                    };
                    self.logs
                        .push(format!("{action} {}: {ack}", short_key(&target_msg_id)));
                    self.refresh_account_stats();
                }
                UiEvent::DirectControlErr {
                    target_msg_id,
                    action,
                    error,
                } => {
                    self.logs.push(format!(
                        "{action} {} failed: {error}",
                        short_key(&target_msg_id)
                    ));
                    self.refresh_account_stats();
                }
                UiEvent::TrayShow => {
                    ctx.send_viewport_cmd(egui::ViewportCommand::Visible(true));
                    ctx.send_viewport_cmd(egui::ViewportCommand::Minimized(false));
                    ctx.send_viewport_cmd(egui::ViewportCommand::Focus);
                    self.logs.push("window restored from tray".to_string());
                }
                UiEvent::TrayHide => {
                    ctx.send_viewport_cmd(egui::ViewportCommand::Visible(false));
                    self.logs.push("window hidden to tray".to_string());
                }
                UiEvent::TrayQuit => {
                    self.settings.tray_mode = false;
                    ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                }
                UiEvent::DirectoryResolved {
                    result,
                    display_name,
                } => {
                    let resolved_name = first_non_empty(&[
                        display_name.trim(),
                        result.nickname.trim(),
                        &format!("@{}", result.username),
                    ]);
                    self.logs.push(format!(
                        "directory resolved @{} -> {}",
                        result.username,
                        short_key(&result.pub_key)
                    ));
                    if !result.avatar.trim().is_empty() {
                        self.logs
                            .push("directory profile has avatar metadata".to_string());
                    }
                    self.open_direct_chat(result.pub_key, resolved_name);
                }
                UiEvent::DirectoryResolveErr(error) => {
                    self.new_chat_status = error.clone();
                    self.logs.push(format!("directory resolve error: {error}"));
                }
                UiEvent::ProfileLoaded(profile) => {
                    let profile_pub_key = profile.pub_key.clone();
                    self.profile_status = "profile loaded".to_string();
                    self.profile_nickname = profile.nickname;
                    self.profile_username = profile.username.unwrap_or_default();
                    self.profile_avatar = profile.avatar;
                    if let (Some(store), Some(identity)) = (&self.store, &self.identity)
                        && profile_pub_key == identity.public_key
                        && let Ok(local_profile) = self.current_profile()
                        && let Err(error) =
                            store.save_own_profile(&identity.public_key, &local_profile)
                    {
                        self.logs.push(format!("profile cache error: {error}"));
                    }
                    self.logs.push("profile loaded from server".to_string());
                }
                UiEvent::ProfileLoadErr(error) => {
                    self.profile_status = format!("profile load skipped: {error}");
                    self.logs.push(format!("profile load error: {error}"));
                }
                UiEvent::ProfileSaved(profile) => {
                    self.profile_status = "profile saved".to_string();
                    self.profile_nickname = profile.nickname;
                    self.profile_username = profile.username.unwrap_or_default();
                    self.profile_avatar = profile.avatar;
                    self.logs.push("profile saved".to_string());
                }
                UiEvent::ProfileSaveErr(error) => {
                    self.profile_status = format!("profile save failed: {error}");
                    self.logs.push(format!("profile save error: {error}"));
                }
                UiEvent::OutboxFlushed => {
                    self.refresh_account_stats();
                    self.logs.push("manual outbox retry finished".to_string());
                }
            }
        }
        self.refresh_voice_playback_status();
    }

    fn handle_tray_close_request(&mut self, ctx: &egui::Context) {
        let close_requested = ctx.input(|input| input.viewport().close_requested());
        if !close_requested || !self.settings.tray_mode || self.tray_icon.is_none() {
            return;
        }
        ctx.send_viewport_cmd(egui::ViewportCommand::CancelClose);
        ctx.send_viewport_cmd(egui::ViewportCommand::Visible(false));
        self.logs
            .push("close intercepted; running in tray".to_string());
    }

    fn refresh_voice_playback_status(&mut self) {
        let finished = self
            .voice_playback
            .as_ref()
            .is_some_and(|player| player.is_finished());
        if finished {
            self.voice_playback = None;
            self.voice_status = "voice playback finished".to_string();
            return;
        }
        let Some(player) = self.voice_playback.as_ref() else {
            return;
        };
        if let Some(duration) = player.duration_seconds() {
            let position = player.position_seconds();
            self.voice_status = format!(
                "voice {} {:02}:{:02}/{:02}:{:02}",
                if player.is_paused() {
                    "paused"
                } else {
                    "playing"
                },
                position / 60,
                position % 60,
                duration / 60,
                duration % 60
            );
        }
    }

    fn check_health(&mut self) {
        self.health_status = "checking".to_string();
        let origins = self.transport_origins();
        let tx = self.tx.clone();
        self.runtime.spawn(async move {
            let event = match net::fetch_health_with_fallback(origins).await {
                Ok(status) => UiEvent::HealthOk(status),
                Err(error) => UiEvent::HealthErr(error.to_string()),
            };
            let _ = tx.send(event);
        });
    }

    fn connect_realtime(&mut self) {
        if matches!(self.realtime_status.as_str(), "connecting" | "listening") {
            self.logs.push("realtime is already active".to_string());
            return;
        }
        let Some(identity) = self.identity.clone() else {
            self.logs
                .push("create or import identity first".to_string());
            return;
        };
        let Some(store) = self.store.clone() else {
            self.logs.push("local store is unavailable".to_string());
            return;
        };
        self.realtime_status = "connecting".to_string();
        let origins = self.transport_origins();
        let tx = self.tx.clone();
        let (net_tx, mut net_rx) = tokio::sync::mpsc::unbounded_channel();
        let bridge_tx = tx.clone();
        let bridge_handle = self.runtime.spawn(async move {
            while let Some(event) = net_rx.recv().await {
                let _ = bridge_tx.send(UiEvent::RealtimeEvent(event));
            }
        });
        let realtime_handle = self.runtime.spawn(async move {
            if let Err(error) =
                net::run_realtime_with_fallback(origins, identity, store, net_tx).await
            {
                let _ = tx.send(UiEvent::RealtimeErr(error.to_string()));
            }
        });
        self.realtime_tasks.push(bridge_handle);
        self.realtime_tasks.push(realtime_handle);
    }

    fn retry_outbox_now(&mut self) {
        let Some(identity) = self.identity.clone() else {
            self.logs
                .push("create or import identity before retrying".to_string());
            return;
        };
        let Some(store) = self.store.clone() else {
            self.logs.push("local store is unavailable".to_string());
            return;
        };
        if self.outbox_count == 0 {
            self.logs.push("outbox is empty".to_string());
            return;
        }

        self.logs.push(format!(
            "manual retry for {} queued messages",
            self.outbox_count
        ));
        let origins = self.transport_origins();
        let tx_events = self.tx.clone();
        let tx_done = self.tx.clone();
        let (net_tx, mut net_rx) = tokio::sync::mpsc::unbounded_channel();
        self.runtime.spawn(async move {
            while let Some(event) = net_rx.recv().await {
                let _ = tx_events.send(UiEvent::RealtimeEvent(event));
            }
        });
        self.runtime.spawn(async move {
            net::flush_outbox_once_with_fallback(origins, identity, store, net_tx).await;
            let _ = tx_done.send(UiEvent::OutboxFlushed);
        });
    }

    fn generate_identity(&mut self) -> bool {
        match crypto::generate_identity() {
            Ok(identity) => {
                self.seed_input = identity.seed_phrase.expose().to_string();
                self.seed_confirmation_input.clear();
                self.seed_confirmed = false;
                if self.profile_nickname.trim().is_empty() {
                    self.profile_nickname = format!("User {}", short_key(&identity.public_key));
                }
                self.pending_identity = Some(identity);
                self.profile_status = "confirm seed phrase before login".to_string();
                self.logs
                    .push("new seed generated; confirmation required".to_string());
                true
            }
            Err(error) => {
                self.logs.push(format!("identity error: {error}"));
                false
            }
        }
    }

    fn seed_confirmation_matches(&self) -> bool {
        let seed = normalize_seed_phrase(&self.seed_input);
        !seed.is_empty() && seed == normalize_seed_phrase(&self.seed_confirmation_input)
    }

    fn confirm_generated_identity(&mut self) -> bool {
        let Some(identity) = self.pending_identity.clone() else {
            self.profile_status = "generate a seed phrase first".to_string();
            return false;
        };
        if !self.seed_confirmed {
            self.profile_status = "save the seed phrase before continuing".to_string();
            return false;
        }
        if !self.seed_confirmation_matches() {
            self.profile_status = "seed confirmation does not match".to_string();
            return false;
        }
        let profile = match self.current_profile() {
            Ok(profile) => profile,
            Err(error) => {
                self.profile_status = profile_error_text(error).to_string();
                self.logs.push(format!("profile validation: {:?}", error));
                return false;
            }
        };

        if self.identity.is_some() {
            self.stop_realtime();
        }
        self.persist_identity(&identity);
        if let Some(store) = &self.store
            && let Err(error) = store.save_own_profile(&identity.public_key, &profile)
        {
            self.logs.push(format!("profile cache error: {error}"));
        }
        self.load_messages_for_identity(&identity.public_key);
        self.load_contacts_for_identity(&identity.public_key);
        self.load_rooms_for_identity(&identity.public_key);
        self.identity = Some(identity);
        self.pending_identity = None;
        self.seed_confirmation_input.clear();
        self.seed_confirmed = false;
        self.profile_status = "profile ready".to_string();
        self.logs.push("new identity confirmed locally".to_string());
        self.refresh_account_stats();
        true
    }

    fn cancel_pending_identity(&mut self) {
        self.pending_identity = None;
        self.seed_confirmation_input.clear();
        self.seed_confirmed = false;
        if self.identity.is_none() {
            self.seed_input.clear();
        }
        self.profile_status.clear();
        self.logs.push("pending identity cancelled".to_string());
    }

    fn import_identity(&mut self) -> bool {
        match crypto::identity_from_seed_phrase(&self.seed_input) {
            Ok(identity) => {
                self.logs
                    .push("identity imported from seed phrase".to_string());
                self.pending_identity = None;
                self.seed_confirmation_input.clear();
                self.seed_confirmed = false;
                self.persist_identity(&identity);
                self.load_messages_for_identity(&identity.public_key);
                self.load_contacts_for_identity(&identity.public_key);
                self.load_rooms_for_identity(&identity.public_key);
                self.load_profile_for_identity(&identity.public_key);
                self.identity = Some(identity);
                if self.profile_nickname.trim().is_empty() {
                    self.profile_status = "loading remote profile...".to_string();
                    self.fetch_remote_profile();
                }
                self.refresh_account_stats();
                true
            }
            Err(error) => {
                self.logs.push(format!("seed import error: {error}"));
                false
            }
        }
    }

    fn current_profile(&self) -> Result<profile::UserProfile, profile::ProfileValidationError> {
        profile::UserProfile::new(
            &self.profile_nickname,
            Some(self.profile_username.as_str()),
            &self.profile_avatar,
        )
    }

    fn save_profile_now(&mut self) {
        let (Some(identity), Some(store)) = (self.identity.clone(), self.store.clone()) else {
            self.logs
                .push("create or restore identity before saving profile".to_string());
            return;
        };
        let profile = match self.current_profile() {
            Ok(profile) => profile,
            Err(error) => {
                self.profile_status = profile_error_text(error).to_string();
                self.logs.push(format!("profile validation: {:?}", error));
                return;
            }
        };
        if let Err(error) = store.save_own_profile(&identity.public_key, &profile) {
            self.logs.push(format!("profile cache error: {error}"));
        }
        let origins = self.transport_origins();
        let tx = self.tx.clone();
        self.profile_status = "saving profile...".to_string();
        self.runtime.spawn(async move {
            let event =
                match net::save_profile_with_fallback(origins, identity, profile.clone()).await {
                    Ok(()) => UiEvent::ProfileSaved(profile),
                    Err(error) => UiEvent::ProfileSaveErr(error.to_string()),
                };
            let _ = tx.send(event);
        });
    }

    fn fetch_remote_profile(&mut self) {
        let Some(identity) = self.identity.clone() else {
            return;
        };
        let origins = self.transport_origins();
        let public_key = identity.public_key.clone();
        let tx = self.tx.clone();
        self.profile_status = "loading remote profile...".to_string();
        self.runtime.spawn(async move {
            let event = match net::fetch_profile_with_fallback(origins, identity, public_key).await
            {
                Ok(profile) => UiEvent::ProfileLoaded(profile),
                Err(error) => UiEvent::ProfileLoadErr(error.to_string()),
            };
            let _ = tx.send(event);
        });
    }

    fn sync_profile_after_auth(&mut self) {
        if self.profile_nickname.trim().is_empty() {
            self.fetch_remote_profile();
        } else {
            self.save_profile_now();
        }
    }

    fn send_direct_message(&mut self) {
        let Some(identity) = self.identity.clone() else {
            self.logs
                .push("create or import identity before sending".to_string());
            return;
        };
        let Some(store) = self.store.clone() else {
            self.logs.push("local store is unavailable".to_string());
            return;
        };
        let recipient = self.recipient_public_key.trim().to_string();
        if recipient.is_empty() {
            self.logs.push("recipient public key is empty".to_string());
            return;
        }
        let plaintext = self.composer_text.trim().to_string();
        if plaintext.is_empty() {
            return;
        }
        if let Some(edit) = self.edit_draft.clone() {
            self.send_direct_edit(identity, store, recipient, edit.msg_id, plaintext);
            return;
        }
        let wire_plaintext = build_outgoing_payload(&plaintext, self.reply_draft.as_ref());

        self.logs.push(format!(
            "sending direct message to {}",
            short_key(&recipient)
        ));
        let msg_id = Uuid::new_v4().to_string();
        self.upsert_chat_line(ChatLine {
            peer_public_key: recipient.clone(),
            msg_id: msg_id.clone(),
            text: wire_plaintext.clone(),
            incoming: false,
            status: "pending".to_string(),
            created_at_ms: app_now_ms(),
            reactions: BTreeMap::new(),
        });
        self.composer_text.clear();
        self.reply_draft = None;
        let origins = self.transport_origins();
        let tx = self.tx.clone();
        self.runtime.spawn(async move {
            let event_msg_id = msg_id.clone();
            let event = match net::send_direct_message_once_with_fallback(
                origins,
                identity,
                store,
                recipient,
                wire_plaintext,
                Some(msg_id),
            )
            .await
            {
                Ok(result) => UiEvent::DirectOk(result),
                Err(error) => UiEvent::DirectErr {
                    msg_id: event_msg_id,
                    error: error.to_string(),
                },
            };
            let _ = tx.send(event);
        });
    }

    fn send_direct_edit(
        &mut self,
        identity: crypto::Identity,
        store: storage::LocalStore,
        recipient: String,
        target_msg_id: String,
        plaintext: String,
    ) {
        let Some(existing) = self
            .messages
            .iter_mut()
            .find(|message| message.msg_id == target_msg_id)
        else {
            self.logs
                .push("edited message is no longer available".to_string());
            self.edit_draft = None;
            self.composer_text.clear();
            return;
        };
        let previous = existing.text.clone();
        existing.text = plaintext.clone();
        existing.status = "editing".to_string();
        if let Err(error) =
            store.update_message_text(&identity.public_key, &target_msg_id, &plaintext)
        {
            self.logs.push(format!("message edit store error: {error}"));
        }
        self.composer_text.clear();
        self.edit_draft = None;
        self.reply_draft = None;
        self.logs
            .push(format!("editing message {}", short_key(&target_msg_id)));

        let origins = self.transport_origins();
        let tx = self.tx.clone();
        self.runtime.spawn(async move {
            let action = "edit".to_string();
            let event = match net::send_direct_edit_once_with_fallback(
                origins,
                identity,
                store,
                recipient,
                target_msg_id.clone(),
                plaintext,
            )
            .await
            {
                Ok(result) => UiEvent::DirectControlOk {
                    target_msg_id,
                    action,
                    acknowledged: result.acknowledged,
                },
                Err(error) => UiEvent::DirectControlErr {
                    target_msg_id,
                    action,
                    error: format!("{error}; previous text was {}", trim_line(&previous, 48)),
                },
            };
            let _ = tx.send(event);
        });
    }

    fn pick_and_send_file(&mut self) {
        if self.recipient_public_key.trim().is_empty() {
            self.logs
                .push("open a direct chat before attaching files".to_string());
            return;
        }
        let Some(path) = rfd::FileDialog::new()
            .set_title("Attach encrypted file")
            .pick_file()
        else {
            return;
        };
        self.send_file_message(path);
    }

    fn pick_and_send_voice(&mut self) {
        if self.recipient_public_key.trim().is_empty() {
            self.logs
                .push("open a direct chat before sending voice".to_string());
            return;
        }
        let Some(path) = rfd::FileDialog::new()
            .set_title("Attach encrypted voice message")
            .add_filter("Voice", media::VOICE_EXTENSIONS)
            .pick_file()
        else {
            return;
        };
        self.send_voice_message(path, 0, false);
    }

    fn start_voice_recording(&mut self) {
        if self.voice_recorder.is_some() {
            return;
        }
        if self.identity.is_none() {
            self.logs
                .push("create or import identity before recording voice".to_string());
            return;
        }
        if self.recipient_public_key.trim().is_empty() {
            self.logs
                .push("open a direct chat before recording voice".to_string());
            return;
        }

        match voice::VoiceRecorder::start() {
            Ok(recorder) => {
                self.voice_status = format!("recording via {}", recorder.device_name());
                self.logs.push("voice recording started".to_string());
                self.voice_recorder = Some(recorder);
            }
            Err(error) => {
                self.voice_status = format!("voice recorder error: {error}");
                self.logs.push(self.voice_status.clone());
            }
        }
    }

    fn stop_voice_recording_and_send(&mut self) {
        let Some(recorder) = self.voice_recorder.take() else {
            return;
        };
        match recorder.stop() {
            Ok(recorded) => {
                self.voice_status = format!("sending {}s voice message", recorded.duration_seconds);
                self.send_voice_message(recorded.path, recorded.duration_seconds, true);
            }
            Err(error) => {
                self.voice_status = format!("voice recording failed: {error}");
                self.logs.push(self.voice_status.clone());
            }
        }
    }

    fn cancel_voice_recording(&mut self) {
        let Some(recorder) = self.voice_recorder.take() else {
            return;
        };
        recorder.cancel();
        self.voice_status = "voice recording discarded".to_string();
        self.logs.push(self.voice_status.clone());
    }

    fn handle_file_drops(&mut self, ctx: &egui::Context) {
        let dropped_paths = ctx.input(|input| {
            input
                .raw
                .dropped_files
                .iter()
                .filter_map(|file| file.path.clone())
                .collect::<Vec<_>>()
        });
        if dropped_paths.is_empty() {
            return;
        }
        if self.identity.is_none() {
            self.logs
                .push("create or import identity before dropping files".to_string());
            return;
        }
        if self.recipient_public_key.trim().is_empty() {
            self.logs
                .push("open a direct chat before dropping files".to_string());
            return;
        }

        for path in dropped_paths {
            self.send_file_message(path);
        }
    }

    fn send_file_message(&mut self, path: PathBuf) {
        let (Some(identity), Some(store)) = (self.identity.clone(), self.store.clone()) else {
            self.logs
                .push("create or import identity before sending files".to_string());
            return;
        };
        let recipient = self.recipient_public_key.trim().to_string();
        if recipient.is_empty() {
            self.logs.push("recipient public key is empty".to_string());
            return;
        }
        let msg_id = Uuid::new_v4().to_string();
        let origins = self.transport_origins();
        let tx = self.tx.clone();
        self.logs
            .push(format!("uploading file: {}", path.display()));
        self.runtime.spawn(async move {
            let event = match net::upload_direct_file_with_fallback(
                origins.clone(),
                identity.clone(),
                recipient.clone(),
                path,
            )
            .await
            {
                Ok(upload) => {
                    let plaintext = upload.plaintext_json.clone();
                    match net::send_direct_message_once_with_fallback(
                        origins,
                        identity,
                        store,
                        recipient.clone(),
                        plaintext.clone(),
                        Some(msg_id.clone()),
                    )
                    .await
                    {
                        Ok(result) => UiEvent::DirectFileOk {
                            result,
                            recipient_public_key: recipient,
                            plaintext,
                            file_name: upload.payload.name,
                        },
                        Err(error) => UiEvent::DirectFileErr {
                            msg_id,
                            recipient_public_key: recipient,
                            plaintext: Some(plaintext),
                            error: error.to_string(),
                        },
                    }
                }
                Err(error) => UiEvent::DirectFileErr {
                    msg_id,
                    recipient_public_key: recipient,
                    plaintext: None,
                    error: error.to_string(),
                },
            };
            let _ = tx.send(event);
        });
    }

    fn send_voice_message(
        &mut self,
        path: PathBuf,
        duration_seconds: u64,
        delete_after_send: bool,
    ) {
        let (Some(identity), Some(store)) = (self.identity.clone(), self.store.clone()) else {
            self.logs
                .push("create or import identity before sending voice".to_string());
            return;
        };
        let recipient = self.recipient_public_key.trim().to_string();
        if recipient.is_empty() {
            self.logs.push("recipient public key is empty".to_string());
            return;
        }
        let msg_id = Uuid::new_v4().to_string();
        let origins = self.transport_origins();
        let tx = self.tx.clone();
        let cleanup_path = delete_after_send.then(|| path.clone());
        self.logs
            .push(format!("uploading voice message: {}", path.display()));
        self.runtime.spawn(async move {
            let event = match net::upload_direct_voice_with_fallback(
                origins.clone(),
                identity.clone(),
                recipient.clone(),
                path,
                duration_seconds,
            )
            .await
            {
                Ok(upload) => {
                    let plaintext = upload.plaintext_json.clone();
                    let file_name = format!("voice message ({} bytes)", upload.payload.size);
                    match net::send_direct_message_once_with_fallback(
                        origins,
                        identity,
                        store,
                        recipient.clone(),
                        plaintext.clone(),
                        Some(msg_id.clone()),
                    )
                    .await
                    {
                        Ok(result) => UiEvent::DirectFileOk {
                            result,
                            recipient_public_key: recipient,
                            plaintext,
                            file_name,
                        },
                        Err(error) => UiEvent::DirectFileErr {
                            msg_id,
                            recipient_public_key: recipient,
                            plaintext: Some(plaintext),
                            error: error.to_string(),
                        },
                    }
                }
                Err(error) => UiEvent::DirectFileErr {
                    msg_id,
                    recipient_public_key: recipient,
                    plaintext: None,
                    error: error.to_string(),
                },
            };
            if let Some(path) = cleanup_path {
                let _ = std::fs::remove_file(path);
            }
            let _ = tx.send(event);
        });
    }

    fn save_encrypted_file_payload(&mut self, payload: EncryptedFilePayload) {
        let Some(identity) = self.identity.clone() else {
            self.logs
                .push("create or import identity before downloading files".to_string());
            return;
        };
        let default_name = if payload.name.trim().is_empty() {
            "attachment.bin"
        } else {
            payload.name.trim()
        };
        let Some(output_path) = rfd::FileDialog::new()
            .set_title("Save decrypted file")
            .set_file_name(default_name)
            .save_file()
        else {
            return;
        };
        let origins = self.transport_origins();
        let tx = self.tx.clone();
        self.logs
            .push(format!("downloading file: {}", payload.name));
        self.runtime.spawn(async move {
            let event = match net::download_encrypted_file_with_fallback(
                origins,
                identity,
                payload,
                output_path.clone(),
            )
            .await
            {
                Ok(()) => UiEvent::FileDownloadOk { path: output_path },
                Err(error) => UiEvent::FileDownloadErr {
                    error: error.to_string(),
                },
            };
            let _ = tx.send(event);
        });
    }

    fn play_voice_payload(&mut self, msg_id: String, payload: VoiceMessagePayload) {
        if let Some(player) = &self.voice_playback
            && player.msg_id() == msg_id
        {
            player.toggle_pause();
            self.refresh_voice_playback_status();
            return;
        }
        self.stop_voice_playback();

        let Some(identity) = self.identity.clone() else {
            self.logs
                .push("create or import identity before playing voice".to_string());
            return;
        };
        let extension = media::voice_extension_from_mime(&payload.mime_type);
        let output_path = playback::temp_voice_playback_path(&msg_id, extension);
        let origins = self.transport_origins();
        let tx = self.tx.clone();
        let duration_seconds = payload.duration_seconds;
        self.voice_status = "loading voice...".to_string();
        self.runtime.spawn(async move {
            let file_payload = payload.as_encrypted_file();
            let event = match net::download_encrypted_file_with_fallback(
                origins,
                identity,
                file_payload,
                output_path.clone(),
            )
            .await
            {
                Ok(()) => UiEvent::VoicePlaybackReady {
                    msg_id,
                    path: output_path,
                    duration_seconds,
                },
                Err(error) => UiEvent::VoicePlaybackErr {
                    msg_id,
                    error: error.to_string(),
                },
            };
            let _ = tx.send(event);
        });
    }

    fn stop_voice_playback(&mut self) {
        if let Some(player) = self.voice_playback.take() {
            player.stop();
        }
        if self.voice_status.starts_with("voice playing")
            || self.voice_status.starts_with("voice paused")
            || self.voice_status.starts_with("voice playback")
        {
            self.voice_status.clear();
        }
    }

    fn start_native_call_signal(&mut self, media: call::CallMediaKind) {
        let peer = self.recipient_public_key.trim().to_string();
        if peer.is_empty() {
            self.logs
                .push("open a direct chat before starting a call".to_string());
            return;
        }
        let (media_mode, is_video) = match media {
            call::CallMediaKind::Audio => ("audio", false),
            call::CallMediaKind::Video => ("video", true),
            call::CallMediaKind::Screen => ("screen", true),
        };
        let payload = serde_json::json!({
            "isVideo": is_video,
            "isScreenShare": media == call::CallMediaKind::Screen,
            "mediaMode": media_mode,
            "nativeClient": true,
            "client": "messk-windows",
            "supportsMedia": false,
            "mediaEngine": "native_webrtc_pending",
        })
        .to_string();
        self.pending_call = Some(PendingCall {
            peer_public_key: peer.clone(),
            incoming: false,
            media,
        });
        self.active_call = Some(call::CallSession::outgoing(peer.clone(), media));
        self.call_status = format!(
            "Requesting {} with {} - native media engine unavailable",
            call_media_label(media),
            short_key(&peer),
        );
        self.send_call_signal(peer, call::CALL_OFFER, payload);
    }

    fn accept_pending_call(&mut self) {
        let Some(call) = self.pending_call.clone() else {
            return;
        };
        let payload = serde_json::json!({
            "accepted": true,
            "nativeClient": true,
            "client": "messk-windows",
            "supportsMedia": false,
            "reason": "native_media_engine_pending",
        })
        .to_string();
        self.call_status =
            "Call signaling accepted - native media engine is still pending".to_string();
        if let Some(active_call) = &mut self.active_call {
            active_call.accept();
        }
        self.pending_call = None;
        self.send_call_signal(call.peer_public_key, call::CALL_ANSWER, payload);
    }

    fn show_native_screen_share_unavailable(&mut self) {
        self.call_status =
            "Screen sharing media is available in the web app; native Windows capture is not implemented yet."
                .to_string();
    }

    fn reject_or_end_pending_call(&mut self) {
        let Some(call) = self.pending_call.clone() else {
            self.call_status.clear();
            self.active_call = None;
            return;
        };
        let kind = if call.incoming {
            call::CALL_REJECT
        } else {
            call::CALL_END
        };
        let reason = if call.incoming { "declined" } else { "ended" };
        let payload = serde_json::json!({ "reason": reason }).to_string();
        if let Some(active_call) = &mut self.active_call {
            if call.incoming {
                active_call.reject(reason);
            } else {
                active_call.end();
            }
        }
        self.pending_call = None;
        self.call_status.clear();
        self.send_call_signal(call.peer_public_key, kind, payload);
    }

    fn send_call_signal(&mut self, peer_public_key: String, kind: &str, data: String) {
        let Some(identity) = self.identity.clone() else {
            self.logs
                .push("create or import identity before call signaling".to_string());
            return;
        };
        let origins = self.transport_origins();
        let tx = self.tx.clone();
        let kind = kind.to_string();
        self.runtime.spawn(async move {
            let event = match net::send_call_signal_once_with_fallback(
                origins,
                identity,
                peer_public_key.clone(),
                kind.clone(),
                data,
            )
            .await
            {
                Ok(result) => UiEvent::CallSignalOk {
                    kind,
                    peer_public_key,
                    acknowledged: result.acknowledged,
                },
                Err(error) => UiEvent::CallSignalErr {
                    kind,
                    peer_public_key,
                    error: error.to_string(),
                },
            };
            let _ = tx.send(event);
        });
    }

    fn handle_call_signal(&mut self, kind: String, sender_public_key: String, data: String) {
        let parsed = serde_json::from_str::<serde_json::Value>(&data).unwrap_or_default();
        let is_video = parsed
            .get("isVideo")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let media = match parsed.get("mediaMode").and_then(|value| value.as_str()) {
            Some("screen") => call::CallMediaKind::Screen,
            Some("video") => call::CallMediaKind::Video,
            _ if is_video => call::CallMediaKind::Video,
            _ => call::CallMediaKind::Audio,
        };
        match kind.as_str() {
            call::CALL_OFFER => {
                self.pending_call = Some(PendingCall {
                    peer_public_key: sender_public_key.clone(),
                    incoming: true,
                    media,
                });
                self.active_call = Some(call::CallSession::incoming(
                    sender_public_key.clone(),
                    media,
                ));
                self.call_status = format!(
                    "Incoming {} from {} - open the web app for media",
                    call_media_label(media),
                    short_key(&sender_public_key)
                );
                self.logs.push(format!(
                    "incoming {} signal from {}",
                    call_media_label(media),
                    short_key(&sender_public_key)
                ));
            }
            call::CALL_ANSWER => {
                if let Some(active_call) = &mut self.active_call {
                    active_call.answer_received();
                }
                self.pending_call = None;
                self.call_status =
                    "Peer answered signaling - native media engine is still pending".to_string();
            }
            call::CALL_REJECT => {
                self.pending_call = None;
                let reason = parsed
                    .get("reason")
                    .and_then(|value| value.as_str())
                    .unwrap_or("declined");
                if let Some(active_call) = &mut self.active_call {
                    active_call.reject(reason);
                }
                self.call_status = format!("Call {reason}");
            }
            call::CALL_END => {
                self.pending_call = None;
                if let Some(active_call) = &mut self.active_call {
                    active_call.end();
                }
                self.call_status = "Call ended".to_string();
            }
            call::CALL_ICE => {
                self.logs.push(format!(
                    "ignored ICE candidate from {} until native media engine is enabled",
                    short_key(&sender_public_key)
                ));
            }
            _ => {}
        }
    }

    fn handle_realtime_event(&mut self, event: net::RealtimeEvent) {
        match event {
            net::RealtimeEvent::Authenticated(session) => {
                let _session_ready = !session.session_token.trim().is_empty();
                self.realtime_status = "listening".to_string();
                self.logs.push("ws listening".to_string());
                self.sync_profile_after_auth();
            }
            net::RealtimeEvent::Info(message) => {
                self.logs.push(format!("ws: {message}"));
                self.refresh_account_stats();
            }
            net::RealtimeEvent::IncomingDirect {
                msg_id,
                peer_public_key,
                sender_public_key,
                plaintext,
                recovered,
            } => {
                self.logs.push(format!(
                    "incoming direct {} from {}",
                    msg_id,
                    short_key(&sender_public_key)
                ));
                if !recovered && self.settings.desktop_notifications {
                    self.notify_incoming_message(&peer_public_key, &plaintext);
                }
                self.upsert_chat_line(ChatLine {
                    peer_public_key,
                    msg_id,
                    text: plaintext,
                    incoming: true,
                    status: "delivered".to_string(),
                    created_at_ms: app_now_ms(),
                    reactions: BTreeMap::new(),
                });
                self.select_first_chat_if_needed();
                self.refresh_account_stats();
            }
            net::RealtimeEvent::MessageStatus { msg_id, status } => {
                self.logs
                    .push(format!("message {}: {status}", short_key(&msg_id)));
                self.set_message_status(&msg_id, &status);
                self.refresh_account_stats();
            }
            net::RealtimeEvent::DirectEdited {
                msg_id,
                peer_public_key,
                plaintext,
            } => {
                self.logs
                    .push(format!("message edited {}", short_key(&msg_id)));
                self.set_message_text(&msg_id, &plaintext);
                self.ensure_peer_contact(&peer_public_key);
            }
            net::RealtimeEvent::DirectDeleted {
                msg_id,
                peer_public_key,
            } => {
                self.logs
                    .push(format!("message deleted {}", short_key(&msg_id)));
                self.soft_delete_chat_line(&msg_id);
                self.ensure_peer_contact(&peer_public_key);
            }
            net::RealtimeEvent::DirectReaction {
                msg_id,
                peer_public_key,
                actor_public_key,
                reaction,
            } => {
                self.apply_message_reaction(&msg_id, &actor_public_key, reaction);
                self.ensure_peer_contact(&peer_public_key);
            }
            net::RealtimeEvent::DirectPinUpdated {
                msg_id,
                peer_public_key,
                pinned,
            } => {
                if pinned {
                    self.pinned_message_ids.insert(msg_id.clone());
                } else {
                    self.pinned_message_ids.remove(&msg_id);
                }
                self.ensure_peer_contact(&peer_public_key);
            }
            net::RealtimeEvent::DirectDecryptFailed {
                msg_id,
                sender_public_key,
            } => self.logs.push(format!(
                "decrypt failed {} from {}",
                msg_id,
                short_key(&sender_public_key)
            )),
            net::RealtimeEvent::CallSignal {
                kind,
                sender_public_key,
                data,
            } => self.handle_call_signal(kind, sender_public_key, data),
        }
    }

    fn load_messages_for_identity(&mut self, account_public_key: &str) {
        let Some(store) = self.store.clone() else {
            return;
        };
        match store.list_recent_messages(account_public_key, 80) {
            Ok(messages) => {
                self.messages = messages
                    .into_iter()
                    .map(|message| ChatLine {
                        peer_public_key: message.peer_public_key,
                        msg_id: message.msg_id,
                        text: message.text,
                        incoming: message.direction == storage::MessageDirection::Incoming,
                        status: message.status,
                        created_at_ms: message.created_at_ms,
                        reactions: BTreeMap::new(),
                    })
                    .collect();
                self.messages.sort_by_key(|message| message.created_at_ms);
                self.load_reactions_for_identity(account_public_key);
                self.select_first_chat_if_needed();
            }
            Err(error) => self.logs.push(format!("message load error: {error}")),
        }
        match store.list_pinned_message_ids(account_public_key) {
            Ok(ids) => {
                self.pinned_message_ids = ids.into_iter().collect();
            }
            Err(error) => self.logs.push(format!("pin load error: {error}")),
        }
    }

    fn load_reactions_for_identity(&mut self, account_public_key: &str) {
        let Some(store) = self.store.clone() else {
            return;
        };
        let msg_ids: Vec<String> = self
            .messages
            .iter()
            .map(|message| message.msg_id.clone())
            .collect();
        match store.list_reactions_for_messages(account_public_key, &msg_ids) {
            Ok(reactions_by_message) => {
                for message in &mut self.messages {
                    message.reactions.clear();
                    if let Some(reactions) = reactions_by_message.get(&message.msg_id) {
                        for reaction in reactions {
                            message.reactions.insert(
                                reaction.actor_public_key.clone(),
                                reaction.reaction.clone(),
                            );
                        }
                    }
                }
            }
            Err(error) => self.logs.push(format!("reaction load error: {error}")),
        }
    }

    fn select_first_chat_if_needed(&mut self) {
        if !self.recipient_public_key.trim().is_empty() {
            return;
        }
        if let Some(peer) = self
            .messages
            .last()
            .map(|message| message.peer_public_key.clone())
        {
            self.recipient_public_key = peer;
            self.selected_chat = 0;
        }
    }

    fn load_contacts_for_identity(&mut self, account_public_key: &str) {
        let Some(store) = &self.store else {
            self.contacts.clear();
            return;
        };
        match store.list_contacts(account_public_key) {
            Ok(contacts) => {
                self.contacts = contacts
                    .into_iter()
                    .map(|contact| {
                        (
                            contact.peer_public_key,
                            ContactAlias {
                                display_name: contact.display_name,
                                updated_at_ms: contact.updated_at_ms.max(contact.created_at_ms),
                            },
                        )
                    })
                    .collect();
            }
            Err(error) => self.logs.push(format!("contact load error: {error}")),
        }
    }

    fn load_rooms_for_identity(&mut self, account_public_key: &str) {
        let Some(store) = &self.store else {
            self.rooms.clear();
            self.selected_room_id.clear();
            return;
        };
        let mut rooms = Vec::new();
        for kind in ["group", "channel"] {
            match store.list_rooms(account_public_key, kind) {
                Ok(mut loaded) => rooms.append(&mut loaded),
                Err(error) => self.logs.push(format!("{kind} load error: {error}")),
            }
        }
        self.rooms = rooms
            .into_iter()
            .map(|room| RoomSummary {
                room_id: room.room_id,
                kind: room.kind,
                title: room.title,
                avatar: room.avatar,
                role: room.role,
                muted: room.muted,
                pinned: room.pinned,
                created_at_ms: room.created_at_ms,
                updated_at_ms: room.updated_at_ms,
            })
            .collect();
        if let Some(kind) = workspace_kind(self.active_workspace) {
            self.select_first_room_if_needed(kind);
        }
    }

    fn load_profile_for_identity(&mut self, account_public_key: &str) {
        let Some(store) = &self.store else {
            return;
        };
        match store.load_own_profile(account_public_key) {
            Ok(Some(profile)) => {
                self.profile_nickname = profile.nickname;
                self.profile_username = profile.username.unwrap_or_default();
                self.profile_avatar = profile.avatar;
                self.profile_status = format!(
                    "profile cached {}",
                    format_activity_time(profile.updated_at_ms)
                );
            }
            Ok(None) => {}
            Err(error) => self.logs.push(format!("profile load error: {error}")),
        }
    }

    fn save_contact_alias(&mut self, peer_public_key: &str, display_name: &str) {
        let display_name = display_name.trim();
        if peer_public_key.trim().is_empty() || display_name.is_empty() {
            return;
        }
        if let (Some(store), Some(identity)) = (&self.store, &self.identity)
            && let Err(error) =
                store.save_contact(&identity.public_key, peer_public_key, display_name)
        {
            self.logs.push(format!("contact save error: {error}"));
            return;
        }
        self.contacts.insert(
            peer_public_key.to_string(),
            ContactAlias {
                display_name: display_name.to_string(),
                updated_at_ms: app_now_ms(),
            },
        );
    }

    fn open_settings(&mut self) {
        self.settings_draft = self.settings.clone();
        self.settings_draft.backend_origin = self.backend_origin.clone();
        self.settings_fallback_origins_text =
            fallback_origins_to_text(&self.settings_draft.fallback_origins);
        self.show_settings = true;
    }

    fn save_settings(&mut self) {
        self.settings_draft.backend_origin =
            sanitize_backend_origin(&self.settings_draft.backend_origin);
        self.settings_draft.fallback_origins =
            storage::sanitize_backend_origin_list(&self.settings_fallback_origins_text)
                .into_iter()
                .filter(|origin| origin != &self.settings_draft.backend_origin)
                .collect();
        self.settings_draft.font_scale = self.settings_draft.font_scale.clamp(0.9, 1.2);
        if !is_valid_theme(&self.settings_draft.theme) {
            self.settings_draft.theme = "telegram".to_string();
        }
        if !is_valid_density(&self.settings_draft.density) {
            self.settings_draft.density = "comfortable".to_string();
        }
        if self.settings_draft.auto_start != self.settings.auto_start {
            if let Err(error) = autostart::set_enabled(self.settings_draft.auto_start) {
                self.logs.push(format!("auto-start update error: {error}"));
                self.settings_draft.auto_start = self.settings.auto_start;
                return;
            }
            self.logs.push(if self.settings_draft.auto_start {
                "auto-start enabled".to_string()
            } else {
                "auto-start disabled".to_string()
            });
        }

        if let Some(store) = &self.store
            && let Err(error) = store.save_app_settings(&self.settings_draft)
        {
            self.logs.push(format!("settings save error: {error}"));
            return;
        }
        self.settings = self.settings_draft.clone();
        self.backend_origin = self.settings.backend_origin.clone();
        self.settings_fallback_origins_text =
            fallback_origins_to_text(&self.settings.fallback_origins);
        self.logs.push("settings saved".to_string());
        self.show_settings = false;
    }

    fn transport_origins(&self) -> Vec<String> {
        transport::ordered_origins(&self.backend_origin, &self.settings.fallback_origins)
    }

    fn notify_incoming_message(&mut self, peer_public_key: &str, plaintext: &str) {
        let title = self.contact_title(peer_public_key);
        let body = trim_line(&display_message_text(plaintext), 120);
        if body.trim().is_empty() {
            return;
        }
        if let Err(error) = notifier::show_message_notification(&title, &body) {
            self.logs.push(format!("notification error: {error}"));
        }
    }

    fn start_new_chat(&mut self) {
        let query = self.new_chat_public_key.trim().to_string();
        if query.is_empty() {
            self.new_chat_status = "Public key or @username is empty".to_string();
            return;
        }
        let display_name = self.new_chat_name.trim().to_string();
        if looks_like_username_query(&query) {
            self.resolve_new_chat_username(query, display_name);
            return;
        }
        self.open_direct_chat(query, display_name);
    }

    fn resolve_new_chat_username(&mut self, query: String, display_name: String) {
        let Some(identity) = self.identity.clone() else {
            self.new_chat_status = "Create or import identity before username lookup".to_string();
            return;
        };
        let username = query.trim().trim_start_matches('@').to_ascii_lowercase();
        if username.is_empty() {
            self.new_chat_status = "Username is empty".to_string();
            return;
        }

        self.new_chat_status = format!("Resolving @{username}...");
        let origins = self.transport_origins();
        let tx = self.tx.clone();
        self.runtime.spawn(async move {
            let event = match net::resolve_username_with_fallback(origins, identity, username).await
            {
                Ok(result) => UiEvent::DirectoryResolved {
                    result,
                    display_name,
                },
                Err(error) => UiEvent::DirectoryResolveErr(error.to_string()),
            };
            let _ = tx.send(event);
        });
    }

    fn open_direct_chat(&mut self, peer_public_key: String, display_name: String) {
        let peer = peer_public_key.trim().to_string();
        if peer.is_empty() {
            self.new_chat_status = "Public key is empty".to_string();
            return;
        }

        let name = display_name.trim().to_string();
        self.save_contact_alias(&peer, &name);
        self.recipient_public_key = peer;
        self.selected_chat = 0;
        self.composer_text.clear();
        self.reply_draft = None;
        self.edit_draft = None;
        self.chat_search.clear();
        self.message_search.clear();
        self.show_message_search = false;
        self.call_status.clear();
        self.pending_call = None;
        self.active_call = None;
        self.voice_playback = None;
        if let Some(recorder) = self.voice_recorder.take() {
            recorder.cancel();
        }
        self.voice_status.clear();
        self.new_chat_public_key.clear();
        self.new_chat_name.clear();
        self.new_chat_status.clear();
        self.active_workspace = 0;
        self.active_filter = 0;
        self.logs.push("new direct chat opened".to_string());
        self.show_new_chat = false;
    }

    fn switch_workspace(&mut self, workspace: usize) {
        self.active_workspace = workspace.min(2);
        if let Some(kind) = workspace_kind(self.active_workspace) {
            self.select_first_room_if_needed(kind);
            self.reply_draft = None;
            self.edit_draft = None;
            self.message_search.clear();
            self.show_message_search = false;
            self.call_status.clear();
            self.pending_call = None;
            self.active_call = None;
            self.voice_playback = None;
            if let Some(recorder) = self.voice_recorder.take() {
                recorder.cancel();
            }
            self.voice_status.clear();
        }
    }

    fn open_room_editor_for_workspace(&mut self) {
        let Some(kind) = workspace_kind(self.active_workspace) else {
            return;
        };
        self.room_editor_id.clear();
        self.room_editor_kind = kind.to_string();
        self.room_editor_title.clear();
        self.room_editor_avatar.clear();
        self.room_editor_role = default_room_role(kind).to_string();
        self.room_editor_muted = false;
        self.room_editor_pinned = false;
        self.room_editor_status.clear();
        self.show_room_editor = true;
    }

    fn open_room_editor_for_selected(&mut self) {
        let Some(room) = self.selected_room().cloned() else {
            self.open_room_editor_for_workspace();
            return;
        };
        self.room_editor_id = room.room_id;
        self.room_editor_kind = room.kind;
        self.room_editor_title = room.title;
        self.room_editor_avatar = room.avatar;
        self.room_editor_role = room.role;
        self.room_editor_muted = room.muted;
        self.room_editor_pinned = room.pinned;
        self.room_editor_status.clear();
        self.show_room_editor = true;
    }

    fn save_room_editor(&mut self) {
        let Some(account_public_key) = self
            .identity
            .as_ref()
            .map(|identity| identity.public_key.clone())
        else {
            self.room_editor_status = "Identity is missing".to_string();
            return;
        };
        let title = self.room_editor_title.trim().to_string();
        if title.is_empty() {
            self.room_editor_status = "Name is required".to_string();
            return;
        }
        let kind = if matches!(self.room_editor_kind.as_str(), "group" | "channel") {
            self.room_editor_kind.clone()
        } else {
            "group".to_string()
        };
        let existing = self
            .rooms
            .iter()
            .find(|room| room.room_id == self.room_editor_id)
            .cloned();
        let now = app_now_ms();
        let room_id = if self.room_editor_id.trim().is_empty() {
            format!("{kind}-{}", Uuid::new_v4())
        } else {
            self.room_editor_id.trim().to_string()
        };
        let role = self.room_editor_role.trim().to_string();
        let role = if role.is_empty() {
            default_room_role(&kind).to_string()
        } else {
            role
        };
        let room = storage::StoredRoom {
            room_id: room_id.clone(),
            kind: kind.clone(),
            title: title.clone(),
            avatar: self.room_editor_avatar.trim().to_string(),
            role,
            muted: self.room_editor_muted,
            pinned: self.room_editor_pinned,
            created_at_ms: existing
                .as_ref()
                .map(|room| room.created_at_ms)
                .unwrap_or(now),
            updated_at_ms: now,
        };
        if let Some(store) = &self.store
            && let Err(error) = store.save_room(&account_public_key, &room)
        {
            self.room_editor_status = format!("Save failed: {error}");
            return;
        }
        let summary = RoomSummary {
            room_id: room.room_id,
            kind: room.kind,
            title: room.title,
            avatar: room.avatar,
            role: room.role,
            muted: room.muted,
            pinned: room.pinned,
            created_at_ms: room.created_at_ms,
            updated_at_ms: room.updated_at_ms,
        };
        if let Some(existing) = self
            .rooms
            .iter_mut()
            .find(|room| room.room_id == summary.room_id)
        {
            *existing = summary;
        } else {
            self.rooms.push(summary);
        }
        self.selected_room_id = room_id;
        self.sort_rooms();
        self.show_room_editor = false;
        self.room_editor_status.clear();
        self.logs.push(format!("{} saved", room_kind_label(&kind)));
    }

    fn toggle_selected_room_mute(&mut self) {
        let Some(room) = self.selected_room().cloned() else {
            return;
        };
        let muted = !room.muted;
        if let (Some(store), Some(identity)) = (&self.store, &self.identity)
            && let Err(error) = store.set_room_muted(&identity.public_key, &room.room_id, muted)
        {
            self.logs.push(format!("room mute error: {error}"));
            return;
        }
        if let Some(existing) = self
            .rooms
            .iter_mut()
            .find(|existing| existing.room_id == room.room_id)
        {
            existing.muted = muted;
            existing.updated_at_ms = app_now_ms();
        }
        self.logs.push(if muted {
            "room muted".to_string()
        } else {
            "room unmuted".to_string()
        });
    }

    fn toggle_selected_room_pin(&mut self) {
        let Some(room) = self.selected_room().cloned() else {
            return;
        };
        let pinned = !room.pinned;
        if let (Some(store), Some(identity)) = (&self.store, &self.identity)
            && let Err(error) = store.set_room_pinned(&identity.public_key, &room.room_id, pinned)
        {
            self.logs.push(format!("room pin error: {error}"));
            return;
        }
        if let Some(existing) = self
            .rooms
            .iter_mut()
            .find(|existing| existing.room_id == room.room_id)
        {
            existing.pinned = pinned;
            existing.updated_at_ms = app_now_ms();
        }
        self.sort_rooms();
        self.logs.push(if pinned {
            "room pinned".to_string()
        } else {
            "room unpinned".to_string()
        });
    }

    fn delete_selected_room(&mut self) {
        let Some(room) = self.selected_room().cloned() else {
            return;
        };
        if let (Some(store), Some(identity)) = (&self.store, &self.identity)
            && let Err(error) = store.delete_room(&identity.public_key, &room.room_id)
        {
            self.logs.push(format!("room delete error: {error}"));
            return;
        }
        self.rooms
            .retain(|existing| existing.room_id != room.room_id);
        self.selected_room_id.clear();
        self.select_first_room_if_needed(&room.kind);
        self.logs
            .push(format!("{} removed", room_kind_label(&room.kind)));
    }

    fn selected_room(&self) -> Option<&RoomSummary> {
        let kind = workspace_kind(self.active_workspace)?;
        self.rooms
            .iter()
            .find(|room| room.kind == kind && room.room_id == self.selected_room_id)
    }

    fn select_first_room_if_needed(&mut self, kind: &str) {
        if self
            .rooms
            .iter()
            .any(|room| room.kind == kind && room.room_id == self.selected_room_id)
        {
            return;
        }
        self.selected_room_id = self
            .rooms
            .iter()
            .filter(|room| room.kind == kind)
            .max_by_key(|room| {
                (
                    room.pinned,
                    room.updated_at_ms,
                    std::cmp::Reverse(room.title.to_ascii_lowercase()),
                )
            })
            .map(|room| room.room_id.clone())
            .unwrap_or_default();
    }

    fn sort_rooms(&mut self) {
        self.rooms.sort_by(|left, right| {
            right
                .pinned
                .cmp(&left.pinned)
                .then(right.updated_at_ms.cmp(&left.updated_at_ms))
                .then(left.title.to_lowercase().cmp(&right.title.to_lowercase()))
        });
    }

    fn try_load_stored_identity(&mut self) {
        let Some(store) = &self.store else {
            return;
        };
        let Some(stored) = (match store.load_last_identity_blob() {
            Ok(stored) => stored,
            Err(error) => {
                self.logs
                    .push(format!("identity vault read error: {error}"));
                return;
            }
        }) else {
            return;
        };

        let seed_bytes = match vault::unprotect_secret(&stored.protected_seed_phrase) {
            Ok(seed_bytes) => seed_bytes,
            Err(error) => {
                self.logs.push(format!("identity unlock error: {error}"));
                return;
            }
        };
        let seed_phrase = match String::from_utf8(seed_bytes) {
            Ok(seed_phrase) => seed_phrase,
            Err(error) => {
                self.logs
                    .push(format!("identity vault UTF-8 error: {error}"));
                return;
            }
        };
        match crypto::identity_from_seed_phrase(&seed_phrase) {
            Ok(identity) => {
                self.logs.push(format!(
                    "stored identity unlocked: {}",
                    short_key(&stored.account_public_key)
                ));
                self.pending_identity = None;
                self.seed_confirmation_input.clear();
                self.seed_confirmed = false;
                self.load_messages_for_identity(&identity.public_key);
                self.load_contacts_for_identity(&identity.public_key);
                self.load_rooms_for_identity(&identity.public_key);
                self.load_profile_for_identity(&identity.public_key);
                self.identity = Some(identity);
                self.refresh_account_stats();
            }
            Err(error) => self.logs.push(format!("stored identity invalid: {error}")),
        }
    }

    fn persist_identity(&mut self, identity: &crypto::Identity) {
        let Some(store) = &self.store else {
            return;
        };
        match vault::protect_secret(identity.seed_phrase.expose().as_bytes())
            .and_then(|protected| store.save_identity_blob(&identity.public_key, &protected))
        {
            Ok(()) => self
                .logs
                .push("identity stored in Windows vault".to_string()),
            Err(error) => self
                .logs
                .push(format!("identity vault save error: {error}")),
        }
    }

    fn forget_local_identity(&mut self) {
        self.stop_realtime();
        if let (Some(store), Some(identity)) = (&self.store, &self.identity)
            && let Err(error) = store.forget_identity(&identity.public_key)
        {
            self.logs.push(format!("identity forget error: {error}"));
            return;
        }
        self.identity = None;
        self.pending_identity = None;
        self.seed_input.clear();
        self.seed_confirmation_input.clear();
        self.seed_confirmed = false;
        self.profile_nickname.clear();
        self.profile_username.clear();
        self.profile_avatar.clear();
        self.profile_status.clear();
        self.messages.clear();
        self.contacts.clear();
        self.rooms.clear();
        self.selected_room_id.clear();
        self.pinned_message_ids.clear();
        self.reply_draft = None;
        self.edit_draft = None;
        self.new_chat_name.clear();
        self.new_chat_public_key.clear();
        self.new_chat_status.clear();
        self.message_search.clear();
        self.show_message_search = false;
        self.call_status.clear();
        self.pending_call = None;
        self.active_call = None;
        self.voice_playback = None;
        if let Some(recorder) = self.voice_recorder.take() {
            recorder.cancel();
        }
        self.voice_status.clear();
        self.show_new_chat = false;
        self.show_contact_profile = false;
        self.show_room_editor = false;
        self.profile_public_key.clear();
        self.profile_display_name.clear();
        self.outbox_count = 0;
        self.outbox_preview.clear();
        self.logs.push("local identity forgotten".to_string());
    }

    fn panic_reset_local_data(&mut self) {
        self.stop_realtime();
        if let (Some(store), Some(identity)) = (&self.store, &self.identity) {
            match store.delete_account_data(&identity.public_key) {
                Ok(()) => self.logs.push("local account data wiped".to_string()),
                Err(error) => {
                    self.logs.push(format!("local wipe error: {error}"));
                    return;
                }
            }
        }
        self.identity = None;
        self.pending_identity = None;
        self.seed_input.clear();
        self.seed_confirmation_input.clear();
        self.seed_confirmed = false;
        self.profile_nickname.clear();
        self.profile_username.clear();
        self.profile_avatar.clear();
        self.profile_status.clear();
        self.messages.clear();
        self.contacts.clear();
        self.rooms.clear();
        self.selected_room_id.clear();
        self.pinned_message_ids.clear();
        self.reply_draft = None;
        self.edit_draft = None;
        self.new_chat_name.clear();
        self.new_chat_public_key.clear();
        self.new_chat_status.clear();
        self.message_search.clear();
        self.show_message_search = false;
        self.call_status.clear();
        self.pending_call = None;
        self.active_call = None;
        self.voice_playback = None;
        if let Some(recorder) = self.voice_recorder.take() {
            recorder.cancel();
        }
        self.voice_status.clear();
        self.show_new_chat = false;
        self.show_contact_profile = false;
        self.show_room_editor = false;
        self.profile_public_key.clear();
        self.profile_display_name.clear();
        self.outbox_count = 0;
        self.outbox_preview.clear();
        self.realtime_status = "offline".to_string();
    }

    fn stop_realtime(&mut self) {
        if self.realtime_tasks.is_empty() {
            self.realtime_status = "offline".to_string();
            return;
        }
        for task in self.realtime_tasks.drain(..) {
            task.abort();
        }
        self.realtime_status = "offline".to_string();
        self.logs.push("realtime stopped".to_string());
    }

    fn refresh_account_stats(&mut self) {
        let (Some(store), Some(identity)) = (&self.store, &self.identity) else {
            self.outbox_count = 0;
            self.outbox_preview.clear();
            return;
        };
        self.outbox_count = store.outbox_count(&identity.public_key).unwrap_or_default();
        self.outbox_preview = store
            .list_outbox_preview(&identity.public_key, 5)
            .unwrap_or_default();
    }

    fn set_message_status(&mut self, msg_id: &str, status: &str) {
        if let Some(message) = self
            .messages
            .iter_mut()
            .find(|message| message.msg_id == msg_id)
        {
            message.status = status.to_string();
        }
    }

    fn set_message_text(&mut self, msg_id: &str, text: &str) {
        if let Some(message) = self
            .messages
            .iter_mut()
            .find(|message| message.msg_id == msg_id)
        {
            message.text = text.to_string();
            if message.status == "deleted" {
                message.status = "delivered".to_string();
            }
        }
    }

    fn soft_delete_chat_line(&mut self, msg_id: &str) {
        if let Some(message) = self
            .messages
            .iter_mut()
            .find(|message| message.msg_id == msg_id)
        {
            message.text = deleted_message_payload().to_string();
            message.status = "deleted".to_string();
            message.reactions.clear();
        }
        self.pinned_message_ids.remove(msg_id);
        if self
            .reply_draft
            .as_ref()
            .is_some_and(|reply| reply.msg_id == msg_id)
        {
            self.reply_draft = None;
        }
        if self
            .edit_draft
            .as_ref()
            .is_some_and(|edit| edit.msg_id == msg_id)
        {
            self.edit_draft = None;
            self.composer_text.clear();
        }
    }

    fn apply_message_reaction(
        &mut self,
        msg_id: &str,
        actor_public_key: &str,
        reaction: Option<String>,
    ) {
        if let Some(message) = self
            .messages
            .iter_mut()
            .find(|message| message.msg_id == msg_id)
        {
            if let Some(reaction) = reaction {
                message
                    .reactions
                    .insert(actor_public_key.to_string(), reaction);
            } else {
                message.reactions.remove(actor_public_key);
            }
        }
    }

    fn ensure_peer_contact(&mut self, peer_public_key: &str) {
        if peer_public_key.trim().is_empty() || self.contacts.contains_key(peer_public_key) {
            return;
        }
        self.contacts.insert(
            peer_public_key.to_string(),
            ContactAlias {
                display_name: short_key(peer_public_key),
                updated_at_ms: app_now_ms(),
            },
        );
    }

    fn upsert_chat_line(&mut self, line: ChatLine) {
        if let Some(existing) = self
            .messages
            .iter_mut()
            .find(|message| message.msg_id == line.msg_id)
        {
            existing.peer_public_key = line.peer_public_key;
            existing.text = line.text;
            existing.incoming = line.incoming;
            existing.status = line.status;
            existing.created_at_ms = line.created_at_ms;
            if !line.reactions.is_empty() {
                existing.reactions = line.reactions;
            }
        } else {
            self.messages.push(line);
        }
        self.messages.sort_by_key(|message| message.created_at_ms);
    }

    fn open_active_contact_profile(&mut self) {
        let peer = self.recipient_public_key.trim().to_string();
        if peer.is_empty() {
            self.show_new_chat = true;
            return;
        }

        self.profile_display_name = self
            .contacts
            .get(&peer)
            .map(|contact| contact.display_name.clone())
            .unwrap_or_default();
        self.profile_public_key = peer;
        self.show_contact_profile = true;
    }

    fn chat_message_count(&self, peer_public_key: &str) -> usize {
        self.messages
            .iter()
            .filter(|message| message.peer_public_key == peer_public_key)
            .count()
    }

    fn last_message_for_peer(&self, peer_public_key: &str) -> Option<&ChatLine> {
        self.messages
            .iter()
            .rev()
            .find(|message| message.peer_public_key == peer_public_key)
    }

    fn start_reply_to_message(&mut self, msg_id: &str) {
        let Some(message) = self
            .messages
            .iter()
            .find(|message| message.msg_id == msg_id)
            .cloned()
        else {
            return;
        };
        self.reply_draft = Some(ReplyDraft {
            msg_id: message.msg_id,
            preview: display_message_text(&message.text),
        });
        self.edit_draft = None;
        self.composer_text.clear();
    }

    fn start_edit_message(&mut self, msg_id: &str) {
        let Some(message) = self
            .messages
            .iter()
            .find(|message| message.msg_id == msg_id && !message.incoming)
            .cloned()
        else {
            return;
        };
        if message.status == "deleted" {
            return;
        }
        let original = display_message_text(&message.text);
        self.edit_draft = Some(EditDraft {
            msg_id: message.msg_id,
            original: original.clone(),
        });
        self.reply_draft = None;
        self.composer_text = original;
    }

    fn delete_local_message(&mut self, msg_id: &str) {
        let Some(identity) = &self.identity else {
            return;
        };
        if let Some(store) = &self.store
            && let Err(error) = store.delete_message(&identity.public_key, msg_id)
        {
            self.logs.push(format!("message delete error: {error}"));
            return;
        }
        self.messages.retain(|message| message.msg_id != msg_id);
        self.pinned_message_ids.remove(msg_id);
        if self
            .reply_draft
            .as_ref()
            .is_some_and(|reply| reply.msg_id == msg_id)
        {
            self.reply_draft = None;
        }
        if self
            .edit_draft
            .as_ref()
            .is_some_and(|edit| edit.msg_id == msg_id)
        {
            self.edit_draft = None;
            self.composer_text.clear();
        }
        self.refresh_account_stats();
        self.logs.push("message deleted locally".to_string());
    }

    fn delete_message_for_chat(&mut self, msg_id: &str) {
        let (Some(identity), Some(store)) = (self.identity.clone(), self.store.clone()) else {
            return;
        };
        let Some(peer) = self.message_peer(msg_id) else {
            return;
        };
        if let Err(error) = store.soft_delete_message(&identity.public_key, msg_id) {
            self.logs.push(format!("message delete error: {error}"));
            return;
        }
        self.soft_delete_chat_line(msg_id);
        self.logs
            .push(format!("deleting message {}", short_key(msg_id)));
        self.spawn_direct_delete(identity, peer, msg_id.to_string());
    }

    fn pin_message(&mut self, msg_id: &str) {
        let Some(identity) = &self.identity else {
            return;
        };
        if let Some(store) = &self.store
            && let Err(error) = store.pin_message(&identity.public_key, msg_id)
        {
            self.logs.push(format!("message pin error: {error}"));
            return;
        }
        self.pinned_message_ids.insert(msg_id.to_string());
        self.logs.push("message pinned".to_string());
        if let Some(peer) = self.message_peer(msg_id)
            && let Some(identity) = self.identity.clone()
        {
            self.spawn_direct_pin(identity, peer, msg_id.to_string(), true);
        }
    }

    fn unpin_message(&mut self, msg_id: &str) {
        let Some(identity) = &self.identity else {
            return;
        };
        if let Some(store) = &self.store
            && let Err(error) = store.unpin_message(&identity.public_key, msg_id)
        {
            self.logs.push(format!("message unpin error: {error}"));
            return;
        }
        self.pinned_message_ids.remove(msg_id);
        self.logs.push("message unpinned".to_string());
        if let Some(peer) = self.message_peer(msg_id)
            && let Some(identity) = self.identity.clone()
        {
            self.spawn_direct_pin(identity, peer, msg_id.to_string(), false);
        }
    }

    fn react_to_message(&mut self, msg_id: &str, reaction: Option<String>) {
        let (Some(identity), Some(store)) = (self.identity.clone(), self.store.clone()) else {
            return;
        };
        let Some(peer) = self.message_peer(msg_id) else {
            return;
        };
        if let Err(error) = store.set_message_reaction(
            &identity.public_key,
            msg_id,
            &identity.public_key,
            reaction.as_deref(),
        ) {
            self.logs.push(format!("reaction store error: {error}"));
            return;
        }
        self.apply_message_reaction(msg_id, &identity.public_key, reaction.clone());
        self.spawn_direct_reaction(identity, peer, msg_id.to_string(), reaction);
    }

    fn message_peer(&self, msg_id: &str) -> Option<String> {
        self.messages
            .iter()
            .find(|message| message.msg_id == msg_id)
            .map(|message| message.peer_public_key.clone())
    }

    fn spawn_direct_delete(
        &mut self,
        identity: crypto::Identity,
        peer: String,
        target_msg_id: String,
    ) {
        let origins = self.transport_origins();
        let tx = self.tx.clone();
        self.runtime.spawn(async move {
            let action = "delete".to_string();
            let event = match net::send_direct_delete_once_with_fallback(
                origins,
                identity,
                peer,
                target_msg_id.clone(),
            )
            .await
            {
                Ok(result) => UiEvent::DirectControlOk {
                    target_msg_id,
                    action,
                    acknowledged: result.acknowledged,
                },
                Err(error) => UiEvent::DirectControlErr {
                    target_msg_id,
                    action,
                    error: error.to_string(),
                },
            };
            let _ = tx.send(event);
        });
    }

    fn spawn_direct_reaction(
        &mut self,
        identity: crypto::Identity,
        peer: String,
        target_msg_id: String,
        reaction: Option<String>,
    ) {
        let origins = self.transport_origins();
        let tx = self.tx.clone();
        self.runtime.spawn(async move {
            let action = "reaction".to_string();
            let event = match net::send_direct_reaction_once_with_fallback(
                origins,
                identity,
                peer,
                target_msg_id.clone(),
                reaction,
            )
            .await
            {
                Ok(result) => UiEvent::DirectControlOk {
                    target_msg_id,
                    action,
                    acknowledged: result.acknowledged,
                },
                Err(error) => UiEvent::DirectControlErr {
                    target_msg_id,
                    action,
                    error: error.to_string(),
                },
            };
            let _ = tx.send(event);
        });
    }

    fn spawn_direct_pin(
        &mut self,
        identity: crypto::Identity,
        peer: String,
        target_msg_id: String,
        pinned: bool,
    ) {
        let origins = self.transport_origins();
        let tx = self.tx.clone();
        self.runtime.spawn(async move {
            let action = if pinned { "pin" } else { "unpin" }.to_string();
            let event = match net::send_direct_pin_once_with_fallback(
                origins,
                identity,
                peer,
                target_msg_id.clone(),
                pinned,
            )
            .await
            {
                Ok(result) => UiEvent::DirectControlOk {
                    target_msg_id,
                    action,
                    acknowledged: result.acknowledged,
                },
                Err(error) => UiEvent::DirectControlErr {
                    target_msg_id,
                    action,
                    error: error.to_string(),
                },
            };
            let _ = tx.send(event);
        });
    }

    fn handle_message_action(&mut self, ctx: &egui::Context, action: MessageAction) {
        match action {
            MessageAction::Reply(msg_id) => self.start_reply_to_message(&msg_id),
            MessageAction::Edit(msg_id) => self.start_edit_message(&msg_id),
            MessageAction::Pin(msg_id) => self.pin_message(&msg_id),
            MessageAction::Unpin(msg_id) => self.unpin_message(&msg_id),
            MessageAction::React { msg_id, reaction } => self.react_to_message(&msg_id, reaction),
            MessageAction::Copy(text) => {
                ctx.copy_text(text);
                self.logs.push("message copied".to_string());
            }
            MessageAction::SaveFile(payload) => self.save_encrypted_file_payload(payload),
            MessageAction::PlayVoice { msg_id, payload } => {
                self.play_voice_payload(msg_id, payload)
            }
            MessageAction::Delete(msg_id) => self.delete_message_for_chat(&msg_id),
            MessageAction::DeleteLocal(msg_id) => self.delete_local_message(&msg_id),
        }
    }

    fn active_pinned_message(&self) -> Option<&ChatLine> {
        let peer = self.recipient_public_key.trim();
        if peer.is_empty() {
            return None;
        }
        self.messages.iter().rev().find(|message| {
            message.peer_public_key == peer && self.pinned_message_ids.contains(&message.msg_id)
        })
    }
}

impl eframe::App for MesskApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        self.drain_events(ui.ctx());
        self.handle_tray_close_request(ui.ctx());
        self.handle_file_drops(ui.ctx());
        ui.ctx()
            .request_repaint_after(std::time::Duration::from_millis(250));
        apply_visuals(ui.ctx(), &self.settings);
        ui.ctx()
            .send_viewport_cmd(egui::ViewportCommand::Title(config::APP_NAME.to_string()));

        egui::CentralPanel::default()
            .frame(egui::Frame::new().fill(COL_BG))
            .show_inside(ui, |ui| {
                if self.identity.is_none() {
                    self.identity_launcher(ui);
                    return;
                }
                ui.spacing_mut().item_spacing = egui::vec2(0.0, 0.0);
                let available = ui.available_size();
                let chat_width = (available.x - SIDEBAR_WIDTH).max(520.0);
                ui.horizontal(|ui| {
                    ui.allocate_ui_with_layout(
                        egui::vec2(SIDEBAR_WIDTH, available.y),
                        egui::Layout::top_down(egui::Align::Min),
                        |ui| self.sidebar(ui),
                    );
                    ui.allocate_ui_with_layout(
                        egui::vec2(chat_width, available.y),
                        egui::Layout::top_down(egui::Align::Min),
                        |ui| {
                            if self.active_workspace == 0 {
                                self.chat_panel(ui);
                            } else {
                                self.room_panel(ui);
                            }
                        },
                    );
                });
            });
        self.new_chat_window(ui.ctx());
        self.room_editor_window(ui.ctx());
        self.contact_profile_window(ui.ctx());
        self.settings_window(ui.ctx());
    }
}

impl MesskApp {
    fn identity_launcher(&mut self, ui: &mut egui::Ui) {
        let available = ui.available_size();
        ui.set_min_height(available.y);
        ui.vertical_centered(|ui| {
            ui.add_space((available.y * 0.16).clamp(48.0, 132.0));
            egui::Frame::new()
                .fill(COL_PANEL)
                .stroke(egui::Stroke::new(1.0, COL_LINE_STRONG))
                .corner_radius(egui::CornerRadius::same(10))
                .inner_margin(egui::Margin::symmetric(28, 24))
                .show(ui, |ui| {
                    ui.set_width(520.0);
                    ui.horizontal(|ui| {
                        avatar_box(ui, config::APP_NAME, 52.0);
                        ui.add_space(14.0);
                        ui.vertical(|ui| {
                            ui.label(
                                egui::RichText::new(config::APP_NAME)
                                    .size(24.0)
                                    .strong()
                                    .color(COL_TEXT),
                            );
                            ui.horizontal(|ui| {
                                connection_chip(ui, &self.realtime_status);
                                status_pill(
                                    ui,
                                    "store",
                                    if self.store.is_some() {
                                        "ready"
                                    } else {
                                        "error"
                                    },
                                    if self.store.is_some() {
                                        COL_OK
                                    } else {
                                        COL_DANGER
                                    },
                                );
                            });
                        });
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if icon_button(ui, "Set").clicked() {
                                self.open_settings();
                            }
                        });
                    });

                    ui.add_space(22.0);
                    ui.label(
                        egui::RichText::new("Create account")
                            .size(13.0)
                            .strong()
                            .color(COL_MUTED),
                    );
                    ui.add_space(8.0);
                    ui.horizontal(|ui| {
                        ui.add_sized(
                            [252.0, 36.0],
                            egui::TextEdit::singleline(&mut self.profile_nickname)
                                .hint_text("Nickname"),
                        );
                        ui.add_sized(
                            [252.0, 36.0],
                            egui::TextEdit::singleline(&mut self.profile_username)
                                .hint_text("@username"),
                        );
                    });
                    ui.add_space(8.0);
                    if ui
                        .add_sized(
                            [520.0, 42.0],
                            primary_button_widget("Generate new identity"),
                        )
                        .clicked()
                    {
                        self.generate_identity();
                    }
                    if self.pending_identity.is_some() {
                        ui.add_space(10.0);
                        let mut generated_seed = self.seed_input.clone();
                        ui.add_sized(
                            [520.0, 64.0],
                            egui::TextEdit::multiline(&mut generated_seed)
                                .desired_rows(2)
                                .interactive(false),
                        );
                        ui.add_space(8.0);
                        ui.add_sized(
                            [520.0, 64.0],
                            egui::TextEdit::multiline(&mut self.seed_confirmation_input)
                                .desired_rows(2)
                                .hint_text("Repeat seed phrase"),
                        );
                        ui.add_space(8.0);
                        ui.checkbox(&mut self.seed_confirmed, "I saved the seed phrase");
                        ui.add_space(8.0);
                        let can_confirm = self.seed_confirmed && self.seed_confirmation_matches();
                        ui.horizontal(|ui| {
                            if ui
                                .add_enabled(can_confirm, primary_button_widget("Confirm & enter"))
                                .clicked()
                                && self.confirm_generated_identity()
                            {
                                self.connect_realtime();
                            }
                            if ui
                                .add_sized([120.0, 38.0], neutral_button_widget("Cancel"))
                                .clicked()
                            {
                                self.cancel_pending_identity();
                            }
                            ui.label(
                                egui::RichText::new(&self.profile_status)
                                    .size(11.0)
                                    .color(COL_MUTED),
                            );
                        });
                    }

                    if self.pending_identity.is_none() {
                        ui.add_space(22.0);
                        ui.label(
                            egui::RichText::new("Restore account")
                                .size(13.0)
                                .strong()
                                .color(COL_MUTED),
                        );
                        ui.add_space(8.0);
                        ui.add_sized(
                            [520.0, 84.0],
                            egui::TextEdit::multiline(&mut self.seed_input)
                                .desired_rows(3)
                                .hint_text("12-word seed phrase"),
                        );
                        ui.add_space(10.0);
                        ui.horizontal(|ui| {
                            if ui
                                .add_sized([160.0, 38.0], neutral_button_widget("Restore"))
                                .clicked()
                                && self.import_identity()
                            {
                                self.connect_realtime();
                            }
                            if ui
                                .add_sized([160.0, 38.0], neutral_button_widget("Check backend"))
                                .clicked()
                            {
                                self.check_health();
                            }
                            status_pill(
                                ui,
                                "api",
                                &self.health_status,
                                status_color(&self.health_status),
                            );
                        });
                    }

                    ui.add_space(18.0);
                    ui.label(
                        egui::RichText::new(&self.backend_origin)
                            .size(11.0)
                            .monospace()
                            .color(COL_MUTED),
                    );
                });

            ui.add_space(12.0);
            for line in self.logs.iter().rev().take(3).rev() {
                ui.label(
                    egui::RichText::new(line)
                        .size(11.0)
                        .monospace()
                        .color(COL_MUTED),
                );
            }
        });
    }

    fn settings_window(&mut self, ctx: &egui::Context) {
        if !self.show_settings {
            return;
        }

        let mut open = self.show_settings;
        let mut save = false;
        let mut reset = false;
        let mut cancel = false;
        let mut create_identity = false;
        let mut confirm_identity = false;
        let mut cancel_pending_identity = false;
        let mut restore_identity = false;
        let mut forget_identity = false;
        let mut panic_reset = false;
        let mut save_profile = false;
        let mut fetch_profile = false;

        egui::Window::new("Settings")
            .collapsible(false)
            .resizable(false)
            .anchor(egui::Align2::CENTER_CENTER, egui::vec2(0.0, 0.0))
            .open(&mut open)
            .show(ctx, |ui| {
                ui.set_width(440.0);
                ui.label(
                    egui::RichText::new("Interface")
                        .size(18.0)
                        .strong()
                        .color(COL_TEXT),
                );
                ui.add_space(12.0);
                ui.label(egui::RichText::new("Theme").size(12.0).color(COL_MUTED));
                ui.horizontal(|ui| {
                    settings_choice(ui, &mut self.settings_draft.theme, "telegram", "Telegram");
                    settings_choice(ui, &mut self.settings_draft.theme, "graphite", "Graphite");
                    settings_choice(ui, &mut self.settings_draft.theme, "midnight", "Midnight");
                });
                ui.add_space(12.0);
                ui.label(egui::RichText::new("Density").size(12.0).color(COL_MUTED));
                ui.horizontal(|ui| {
                    settings_choice(
                        ui,
                        &mut self.settings_draft.density,
                        "comfortable",
                        "Comfort",
                    );
                    settings_choice(ui, &mut self.settings_draft.density, "compact", "Compact");
                });
                ui.add_space(12.0);
                ui.add(
                    egui::Slider::new(&mut self.settings_draft.font_scale, 0.9..=1.2)
                        .text("Font")
                        .step_by(0.01),
                );
                ui.add_space(8.0);
                ui.checkbox(&mut self.settings_draft.auto_connect, "Connect on launch");
                ui.add_enabled(
                    autostart::is_supported(),
                    egui::Checkbox::new(
                        &mut self.settings_draft.auto_start,
                        "Run at Windows startup",
                    ),
                );
                ui.checkbox(
                    &mut self.settings_draft.tray_mode,
                    "Keep running in tray on close",
                );
                ui.checkbox(
                    &mut self.settings_draft.desktop_notifications,
                    "Desktop notifications",
                );
                ui.add_space(16.0);
                ui.label(
                    egui::RichText::new("Backend origin")
                        .size(12.0)
                        .color(COL_MUTED),
                );
                ui.add_sized(
                    [440.0, 36.0],
                    egui::TextEdit::singleline(&mut self.settings_draft.backend_origin)
                        .hint_text(config::DEFAULT_BACKEND_ORIGIN),
                );
                ui.add_space(10.0);
                ui.label(
                    egui::RichText::new("Fallback origins")
                        .size(12.0)
                        .color(COL_MUTED),
                );
                ui.add_sized(
                    [440.0, 72.0],
                    egui::TextEdit::multiline(&mut self.settings_fallback_origins_text)
                        .desired_rows(3)
                        .hint_text("https://relay-one.example\nhttps://relay-two.example"),
                );
                ui.add_space(18.0);
                ui.separator();
                ui.add_space(14.0);
                ui.label(
                    egui::RichText::new("Account")
                        .size(18.0)
                        .strong()
                        .color(COL_TEXT),
                );
                ui.add_space(8.0);
                ui.horizontal(|ui| {
                    status_pill(
                        ui,
                        "identity",
                        if self.identity.is_some() {
                            "ready"
                        } else {
                            "missing"
                        },
                        if self.identity.is_some() {
                            COL_OK
                        } else {
                            COL_WARN
                        },
                    );
                    status_pill(
                        ui,
                        "ws",
                        &self.realtime_status,
                        status_color(&self.realtime_status),
                    );
                });
                ui.add_space(10.0);
                if self.pending_identity.is_none() {
                    ui.add_sized(
                        [440.0, 64.0],
                        egui::TextEdit::multiline(&mut self.seed_input)
                            .desired_rows(2)
                            .hint_text("12-word seed phrase"),
                    );
                }
                ui.add_space(10.0);
                ui.horizontal(|ui| {
                    if ui
                        .add_sized([104.0, 34.0], primary_button_widget("Create"))
                        .clicked()
                    {
                        create_identity = true;
                    }
                    if ui
                        .add_enabled(
                            self.pending_identity.is_none(),
                            neutral_button_widget("Restore"),
                        )
                        .clicked()
                    {
                        restore_identity = true;
                    }
                    if ui
                        .add_sized([104.0, 34.0], neutral_button_widget("Logout"))
                        .clicked()
                    {
                        forget_identity = true;
                    }
                    if ui
                        .add_sized([104.0, 34.0], danger_button_widget("Panic"))
                        .clicked()
                    {
                        panic_reset = true;
                    }
                });
                if self.pending_identity.is_some() {
                    ui.add_space(10.0);
                    let mut generated_seed = self.seed_input.clone();
                    ui.add_sized(
                        [440.0, 64.0],
                        egui::TextEdit::multiline(&mut generated_seed)
                            .desired_rows(2)
                            .interactive(false),
                    );
                    ui.add_space(8.0);
                    ui.add_sized(
                        [440.0, 64.0],
                        egui::TextEdit::multiline(&mut self.seed_confirmation_input)
                            .desired_rows(2)
                            .hint_text("Repeat seed phrase"),
                    );
                    ui.add_space(8.0);
                    ui.checkbox(&mut self.seed_confirmed, "I saved the seed phrase");
                    let can_confirm = self.seed_confirmed && self.seed_confirmation_matches();
                    ui.add_space(8.0);
                    ui.horizontal(|ui| {
                        if ui
                            .add_enabled(can_confirm, primary_button_widget("Confirm account"))
                            .clicked()
                        {
                            confirm_identity = true;
                        }
                        if ui
                            .add_sized([104.0, 34.0], neutral_button_widget("Cancel"))
                            .clicked()
                        {
                            cancel_pending_identity = true;
                        }
                    });
                }
                ui.add_space(18.0);
                ui.separator();
                ui.add_space(14.0);
                ui.label(
                    egui::RichText::new("Profile")
                        .size(18.0)
                        .strong()
                        .color(COL_TEXT),
                );
                ui.add_space(8.0);
                ui.horizontal(|ui| {
                    avatar_box(
                        ui,
                        first_non_empty(&[
                            self.profile_nickname.as_str(),
                            self.profile_username.as_str(),
                            "M",
                        ])
                        .as_str(),
                        42.0,
                    );
                    ui.add_space(10.0);
                    ui.vertical(|ui| {
                        ui.add_sized(
                            [380.0, 34.0],
                            egui::TextEdit::singleline(&mut self.profile_nickname)
                                .hint_text("Nickname"),
                        );
                        ui.add_space(6.0);
                        ui.add_sized(
                            [380.0, 34.0],
                            egui::TextEdit::singleline(&mut self.profile_username)
                                .hint_text("@username"),
                        );
                    });
                });
                ui.add_space(8.0);
                ui.add_sized(
                    [440.0, 56.0],
                    egui::TextEdit::multiline(&mut self.profile_avatar)
                        .desired_rows(2)
                        .hint_text("Avatar data URL or empty"),
                );
                ui.add_space(8.0);
                ui.horizontal(|ui| {
                    if ui
                        .add_sized([126.0, 34.0], primary_button_widget("Save profile"))
                        .clicked()
                    {
                        save_profile = true;
                    }
                    if ui
                        .add_sized([126.0, 34.0], neutral_button_widget("Load remote"))
                        .clicked()
                    {
                        fetch_profile = true;
                    }
                    ui.label(
                        egui::RichText::new(first_non_empty(&[
                            self.profile_status.as_str(),
                            "local",
                        ]))
                        .size(11.0)
                        .color(COL_MUTED),
                    );
                });
                ui.add_space(16.0);
                ui.horizontal(|ui| {
                    if ui
                        .add_sized([96.0, 38.0], primary_button_widget("Save"))
                        .clicked()
                    {
                        save = true;
                    }
                    if ui
                        .add_sized([96.0, 38.0], neutral_button_widget("Reset"))
                        .clicked()
                    {
                        reset = true;
                    }
                    if ui
                        .add_sized([96.0, 38.0], neutral_button_widget("Cancel"))
                        .clicked()
                    {
                        cancel = true;
                    }
                });
            });

        if reset {
            self.settings_draft = storage::StoredAppSettings::default();
        }
        if cancel {
            open = false;
        }
        if save {
            self.save_settings();
            open = self.show_settings;
        }
        if create_identity {
            self.generate_identity();
        }
        if confirm_identity && self.confirm_generated_identity() {
            self.connect_realtime();
            open = false;
        }
        if cancel_pending_identity {
            self.cancel_pending_identity();
        }
        if restore_identity && self.import_identity() {
            self.connect_realtime();
            open = false;
        }
        if save_profile {
            self.save_profile_now();
        }
        if fetch_profile {
            self.fetch_remote_profile();
        }
        if forget_identity {
            self.forget_local_identity();
            open = false;
        }
        if panic_reset {
            self.panic_reset_local_data();
            open = false;
        }
        self.show_settings = open;
    }

    fn new_chat_window(&mut self, ctx: &egui::Context) {
        if !self.show_new_chat {
            return;
        }

        let mut open = self.show_new_chat;
        let mut start_chat = false;
        let mut cancel = false;

        egui::Window::new("New chat")
            .collapsible(false)
            .resizable(false)
            .anchor(egui::Align2::CENTER_CENTER, egui::vec2(0.0, 0.0))
            .open(&mut open)
            .show(ctx, |ui| {
                ui.set_width(420.0);
                ui.label(
                    egui::RichText::new("Start a private encrypted chat")
                        .size(18.0)
                        .strong()
                        .color(COL_TEXT),
                );
                ui.add_space(4.0);
                ui.label(
                    egui::RichText::new(
                        "Use a public key or @username. Names stay local unless loaded from the directory.",
                    )
                    .size(12.0)
                    .color(COL_MUTED),
                );
                ui.add_space(14.0);
                ui.label(
                    egui::RichText::new("Display name")
                        .size(12.0)
                        .color(COL_MUTED),
                );
                ui.add_sized(
                    [420.0, 36.0],
                    egui::TextEdit::singleline(&mut self.new_chat_name).hint_text("Alice"),
                );
                ui.add_space(10.0);
                ui.label(
                    egui::RichText::new("Public key or @username")
                        .size(12.0)
                        .color(COL_MUTED),
                );
                ui.add_sized(
                    [420.0, 36.0],
                    egui::TextEdit::singleline(&mut self.new_chat_public_key)
                        .hint_text("@alice or Base64 public key"),
                );
                if !self.new_chat_status.trim().is_empty() {
                    ui.add_space(6.0);
                    ui.label(
                        egui::RichText::new(&self.new_chat_status)
                            .size(12.0)
                            .color(if self.new_chat_status.starts_with("Resolving") {
                                COL_ACCENT
                            } else {
                                COL_WARN
                            }),
                    );
                }
                ui.add_space(16.0);
                ui.horizontal(|ui| {
                    if ui
                        .add_sized([120.0, 38.0], primary_button_widget("Start chat"))
                        .clicked()
                    {
                        start_chat = true;
                    }
                    if ui
                        .add_sized([92.0, 38.0], neutral_button_widget("Cancel"))
                        .clicked()
                    {
                        cancel = true;
                    }
                });
            });

        if cancel {
            open = false;
        }
        if start_chat {
            self.start_new_chat();
            open = self.show_new_chat;
        }

        self.show_new_chat = open;
    }

    fn room_editor_window(&mut self, ctx: &egui::Context) {
        if !self.show_room_editor {
            return;
        }

        let mut open = self.show_room_editor;
        let mut save = false;
        let mut cancel = false;
        let is_edit = !self.room_editor_id.trim().is_empty();
        let title = if is_edit { "Edit room" } else { "New room" };

        egui::Window::new(title)
            .collapsible(false)
            .resizable(false)
            .anchor(egui::Align2::CENTER_CENTER, egui::vec2(0.0, 0.0))
            .open(&mut open)
            .show(ctx, |ui| {
                ui.set_width(420.0);
                if is_edit {
                    status_pill(
                        ui,
                        "type",
                        room_kind_label(&self.room_editor_kind),
                        COL_ACCENT,
                    );
                } else {
                    ui.horizontal(|ui| {
                        settings_choice(ui, &mut self.room_editor_kind, "group", "Group");
                        settings_choice(ui, &mut self.room_editor_kind, "channel", "Channel");
                    });
                }
                ui.add_space(12.0);
                ui.label(egui::RichText::new("Name").size(12.0).color(COL_MUTED));
                ui.add_sized(
                    [420.0, 36.0],
                    egui::TextEdit::singleline(&mut self.room_editor_title)
                        .hint_text(room_name_hint(&self.room_editor_kind)),
                );
                ui.add_space(10.0);
                ui.label(egui::RichText::new("Role").size(12.0).color(COL_MUTED));
                ui.add_sized(
                    [420.0, 36.0],
                    egui::TextEdit::singleline(&mut self.room_editor_role)
                        .hint_text(default_room_role(&self.room_editor_kind)),
                );
                ui.add_space(10.0);
                ui.label(egui::RichText::new("Avatar").size(12.0).color(COL_MUTED));
                ui.add_sized(
                    [420.0, 56.0],
                    egui::TextEdit::multiline(&mut self.room_editor_avatar)
                        .desired_rows(2)
                        .hint_text("Avatar data URL or empty"),
                );
                ui.add_space(8.0);
                ui.horizontal(|ui| {
                    ui.checkbox(&mut self.room_editor_pinned, "Pinned");
                    ui.checkbox(&mut self.room_editor_muted, "Muted");
                });
                if !self.room_editor_status.trim().is_empty() {
                    ui.add_space(8.0);
                    ui.label(
                        egui::RichText::new(&self.room_editor_status)
                            .size(12.0)
                            .color(COL_WARN),
                    );
                }
                ui.add_space(16.0);
                ui.horizontal(|ui| {
                    if ui
                        .add_sized([120.0, 38.0], primary_button_widget("Save"))
                        .clicked()
                    {
                        save = true;
                    }
                    if ui
                        .add_sized([92.0, 38.0], neutral_button_widget("Cancel"))
                        .clicked()
                    {
                        cancel = true;
                    }
                });
            });

        if cancel {
            open = false;
        }
        if save {
            self.save_room_editor();
            open = self.show_room_editor;
        }
        self.show_room_editor = open;
    }

    fn contact_profile_window(&mut self, ctx: &egui::Context) {
        if !self.show_contact_profile {
            return;
        }

        let peer = self.profile_public_key.clone();
        if peer.trim().is_empty() {
            self.show_contact_profile = false;
            return;
        }

        let title = self.contact_title(&peer);
        let message_count = self.chat_message_count(&peer);
        let last_status = self
            .last_message_for_peer(&peer)
            .map(|message| clean_status(&message.status).to_string())
            .unwrap_or_else(|| "ready".to_string());
        let last_activity = self
            .last_message_for_peer(&peer)
            .map(|message| format_activity_time(message.created_at_ms))
            .unwrap_or_else(|| "new".to_string());
        let mut open = self.show_contact_profile;
        let mut save = false;
        let mut copy_key = false;
        let mut close = false;

        egui::Window::new("Contact")
            .collapsible(false)
            .resizable(false)
            .anchor(egui::Align2::CENTER_CENTER, egui::vec2(0.0, 0.0))
            .open(&mut open)
            .show(ctx, |ui| {
                ui.set_width(420.0);
                ui.horizontal(|ui| {
                    avatar_box(ui, &title, 58.0);
                    ui.add_space(14.0);
                    ui.vertical(|ui| {
                        ui.label(
                            egui::RichText::new(&title)
                                .size(20.0)
                                .strong()
                                .color(COL_TEXT),
                        );
                        ui.add_space(2.0);
                        ui.label(
                            egui::RichText::new(format!("{message_count} messages"))
                                .size(12.0)
                                .color(COL_MUTED),
                        );
                    });
                });
                ui.add_space(18.0);
                ui.label(
                    egui::RichText::new("Display name")
                        .size(12.0)
                        .color(COL_MUTED),
                );
                ui.add_sized(
                    [420.0, 36.0],
                    egui::TextEdit::singleline(&mut self.profile_display_name)
                        .hint_text(short_key(&peer)),
                );
                ui.add_space(12.0);
                ui.horizontal(|ui| {
                    status_pill(ui, "status", &last_status, status_color(&last_status));
                    status_pill(ui, "last", &last_activity, COL_MUTED);
                });
                ui.add_space(12.0);
                ui.label(
                    egui::RichText::new("Public key")
                        .size(12.0)
                        .color(COL_MUTED),
                );
                let mut key_preview = peer.clone();
                ui.add_sized(
                    [420.0, 54.0],
                    egui::TextEdit::multiline(&mut key_preview)
                        .desired_rows(2)
                        .interactive(false),
                );
                ui.add_space(16.0);
                ui.horizontal(|ui| {
                    if ui
                        .add_sized([104.0, 36.0], primary_button_widget("Save"))
                        .clicked()
                    {
                        save = true;
                    }
                    if ui
                        .add_sized([104.0, 36.0], neutral_button_widget("Copy key"))
                        .clicked()
                    {
                        copy_key = true;
                    }
                    if ui
                        .add_sized([90.0, 36.0], neutral_button_widget("Close"))
                        .clicked()
                    {
                        close = true;
                    }
                });
            });

        if save {
            let name = self.profile_display_name.trim().to_string();
            if name.is_empty() {
                self.logs.push("contact name is empty".to_string());
            } else {
                self.save_contact_alias(&peer, &name);
                self.logs
                    .push(format!("contact saved: {}", short_key(&peer)));
                open = false;
            }
        }
        if copy_key {
            ctx.copy_text(peer);
            self.logs.push("contact key copied".to_string());
        }
        if close {
            open = false;
        }
        self.show_contact_profile = open;
    }

    fn sidebar(&mut self, ui: &mut egui::Ui) {
        egui::Frame::new().fill(COL_SIDE).show(ui, |ui| {
            ui.set_width(SIDEBAR_WIDTH);
            ui.set_min_width(SIDEBAR_WIDTH);
            ui.set_max_width(SIDEBAR_WIDTH);
            ui.set_min_height(ui.available_height());

            egui::Frame::new()
                .fill(COL_SIDE)
                .inner_margin(egui::Margin::symmetric(24, 20))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        avatar_box(ui, config::APP_NAME, 40.0);
                        ui.add_space(12.0);
                        ui.vertical(|ui| {
                            ui.label(
                                egui::RichText::new(config::APP_NAME)
                                    .size(22.0)
                                    .strong()
                                    .color(COL_TEXT),
                            );
                            ui.horizontal(|ui| {
                                connection_chip(ui, &self.realtime_status);
                                ui.label(
                                    egui::RichText::new(format!(
                                        "Windows v{}",
                                        config::APP_VERSION
                                    ))
                                    .size(10.0)
                                    .color(COL_MUTED),
                                );
                            });
                        });
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if icon_button(ui, "Exit").clicked() {
                                self.forget_local_identity();
                            }
                            if icon_button(ui, "Set").clicked() {
                                self.open_settings();
                            }
                            if icon_button(ui, "New").clicked() {
                                self.new_chat_name.clear();
                                self.new_chat_public_key.clear();
                                self.reply_draft = None;
                                self.message_search.clear();
                                self.show_message_search = false;
                                self.show_new_chat = true;
                            }
                        });
                    });
                });

            egui::Frame::new()
                .fill(COL_SIDE)
                .inner_margin(egui::Margin::symmetric(24, 0))
                .show(ui, |ui| {
                    egui::Frame::new()
                        .fill(COL_PANEL)
                        .stroke(egui::Stroke::new(1.0, COL_LINE))
                        .corner_radius(egui::CornerRadius::same(8))
                        .inner_margin(egui::Margin::same(14))
                        .show(ui, |ui| {
                            ui.set_width(340.0);
                            ui.set_max_width(340.0);
                            ui.horizontal(|ui| {
                                avatar_box(ui, self.identity_initial().as_str(), 48.0);
                                ui.add_space(12.0);
                                ui.vertical(|ui| {
                                    ui.add_space(2.0);
                                    ui.label(
                                        egui::RichText::new(self.identity_name())
                                            .size(15.0)
                                            .strong()
                                            .color(COL_TEXT),
                                    );
                                    ui.label(
                                        egui::RichText::new(self.identity_short_key())
                                            .monospace()
                                            .size(10.0)
                                            .color(COL_MUTED),
                                    );
                                });
                                ui.with_layout(
                                    egui::Layout::right_to_left(egui::Align::Center),
                                    |ui| {
                                        if icon_button(ui, "Key").clicked() {
                                            self.logs.push(self.identity_short_key());
                                        }
                                    },
                                );
                            });
                            ui.add_space(12.0);
                            ui.horizontal(|ui| {
                                if ui
                                    .add_sized([100.0, 32.0], primary_button_widget("Create"))
                                    .clicked()
                                {
                                    self.generate_identity();
                                    self.open_settings();
                                }
                                if ui
                                    .add_sized([100.0, 32.0], neutral_button_widget("Connect"))
                                    .clicked()
                                {
                                    self.connect_realtime();
                                }
                                status_pill(
                                    ui,
                                    "ws",
                                    &self.realtime_status,
                                    status_color(&self.realtime_status),
                                );
                            });
                        });
                    ui.add_space(8.0);
                    egui::CollapsingHeader::new("Identity setup")
                        .default_open(false)
                        .show(ui, |ui| {
                            ui.add(
                                egui::TextEdit::multiline(&mut self.seed_input)
                                    .desired_width(340.0)
                                    .desired_rows(2)
                                    .hint_text("12-word seed phrase"),
                            );
                            ui.add_space(8.0);
                            ui.horizontal(|ui| {
                                if ui
                                    .add_enabled(
                                        self.pending_identity.is_none(),
                                        neutral_button_widget("Import seed"),
                                    )
                                    .clicked()
                                    && self.import_identity()
                                {
                                    self.connect_realtime();
                                }
                                if neutral_button(ui, "Disconnect").clicked() {
                                    self.stop_realtime();
                                }
                                if danger_button(ui, "Panic").clicked() {
                                    self.panic_reset_local_data();
                                }
                            });
                        });
                });

            if self.outbox_count > 0 {
                ui.add_space(12.0);
                ui.horizontal(|ui| {
                    ui.add_space(24.0);
                    egui::Frame::new()
                        .fill(egui::Color32::from_rgb(43, 36, 24))
                        .stroke(egui::Stroke::new(1.0, COL_WARN))
                        .corner_radius(egui::CornerRadius::same(8))
                        .inner_margin(egui::Margin::symmetric(14, 10))
                        .show(ui, |ui| {
                            ui.set_width(314.0);
                            ui.horizontal(|ui| {
                                status_dot(ui, COL_WARN);
                                ui.add_space(6.0);
                                ui.label(
                                    egui::RichText::new(format!(
                                        "{} waiting delivery",
                                        self.outbox_count
                                    ))
                                    .size(12.0)
                                    .strong()
                                    .color(COL_TEXT),
                                );
                                ui.with_layout(
                                    egui::Layout::right_to_left(egui::Align::Center),
                                    |ui| {
                                        if ui
                                            .add_sized([68.0, 28.0], neutral_button_widget("Retry"))
                                            .clicked()
                                        {
                                            self.retry_outbox_now();
                                        }
                                    },
                                );
                            });
                            if !self.outbox_preview.is_empty() {
                                ui.add_space(10.0);
                                for queued in self.outbox_preview.iter().take(3) {
                                    outbox_queue_row(
                                        ui,
                                        &self.contact_title(&queued.recipient_public_key),
                                        queued,
                                    );
                                    ui.add_space(6.0);
                                }
                            }
                        });
                });
            }

            ui.add_space(18.0);
            egui::Frame::new()
                .fill(COL_SIDE)
                .inner_margin(egui::Margin::symmetric(24, 0))
                .show(ui, |ui| {
                    ui.spacing_mut().item_spacing.x = 0.0;
                    ui.horizontal(|ui| {
                        if workspace_tab(ui, self.active_workspace == 0, "Chats").clicked() {
                            self.switch_workspace(0);
                        }
                        if workspace_tab(ui, self.active_workspace == 1, "Groups").clicked() {
                            self.switch_workspace(1);
                        }
                        if workspace_tab(ui, self.active_workspace == 2, "Channels").clicked() {
                            self.switch_workspace(2);
                        }
                    });
                });

            ui.add_space(12.0);
            let search_hint = workspace_search_hint(self.active_workspace);
            let (filter_one, filter_two, filter_three) =
                workspace_filter_labels(self.active_workspace);
            egui::Frame::new()
                .fill(COL_SIDE)
                .inner_margin(egui::Margin::symmetric(24, 0))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.add_sized(
                            [292.0, 38.0],
                            egui::TextEdit::singleline(&mut self.chat_search)
                                .hint_text(search_hint),
                        );
                        ui.add_space(8.0);
                        if ui
                            .add_sized([38.0, 38.0], primary_button_widget("+"))
                            .clicked()
                        {
                            if self.active_workspace == 0 {
                                self.new_chat_public_key = self.chat_search.trim().to_string();
                                self.new_chat_name.clear();
                                self.show_new_chat = true;
                            } else {
                                self.open_room_editor_for_workspace();
                            }
                        }
                    });
                    ui.add_space(12.0);
                    ui.horizontal(|ui| {
                        filter_chip(ui, self.active_filter == 0, filter_one)
                            .clicked()
                            .then(|| self.active_filter = 0);
                        filter_chip(ui, self.active_filter == 1, filter_two)
                            .clicked()
                            .then(|| self.active_filter = 1);
                        filter_chip(ui, self.active_filter == 2, filter_three)
                            .clicked()
                            .then(|| self.active_filter = 2);
                    });
                });

            ui.add_space(12.0);
            let summaries = self.filtered_chat_summaries();
            let active_room_kind = workspace_kind(self.active_workspace);
            let room_summaries = active_room_kind
                .map(|kind| self.filtered_room_summaries(kind))
                .unwrap_or_default();
            let list_height = (ui.available_height() - 132.0).max(180.0);
            let list_top = ui.cursor().top();
            ui.allocate_ui_with_layout(
                egui::vec2(SIDEBAR_WIDTH, list_height),
                egui::Layout::top_down(egui::Align::Min),
                |ui| {
                    ui.set_min_height(list_height);
                    egui::ScrollArea::vertical()
                        .id_salt("chat-list")
                        .max_height(list_height)
                        .show(ui, |ui| {
                            if let Some(kind) = active_room_kind {
                                if room_summaries.is_empty() {
                                    if chat_row(
                                        ui,
                                        false,
                                        room_empty_title(kind),
                                        room_empty_subtitle(kind),
                                        "new",
                                        0,
                                    )
                                    .clicked()
                                    {
                                        self.open_room_editor_for_workspace();
                                    }
                                } else {
                                    for room in &room_summaries {
                                        if chat_row(
                                            ui,
                                            self.selected_room_id == room.room_id,
                                            &room.title,
                                            &room_row_subtitle(room),
                                            &room_row_status(room),
                                            room.updated_at_ms,
                                        )
                                        .clicked()
                                        {
                                            self.selected_room_id = room.room_id.clone();
                                        }
                                    }
                                }
                            } else if summaries.is_empty() {
                                chat_row(
                                    ui,
                                    self.selected_chat == 0,
                                    "Protocol Test",
                                    "Paste a peer key and send",
                                    "ready",
                                    0,
                                )
                                .clicked()
                                .then(|| {
                                    self.selected_chat = 0;
                                    self.reply_draft = None;
                                    self.message_search.clear();
                                    self.show_message_search = false;
                                    self.call_status.clear();
                                    self.pending_call = None;
                                    self.active_call = None;
                                    self.voice_playback = None;
                                    if let Some(recorder) = self.voice_recorder.take() {
                                        recorder.cancel();
                                    }
                                    self.voice_status.clear();
                                });
                            } else {
                                for (index, summary) in summaries.iter().enumerate() {
                                    if chat_row(
                                        ui,
                                        self.recipient_public_key == summary.peer_public_key,
                                        &summary.title,
                                        &summary.subtitle,
                                        &summary.status,
                                        summary.last_activity_ms,
                                    )
                                    .clicked()
                                    {
                                        self.selected_chat = index;
                                        self.recipient_public_key = summary.peer_public_key.clone();
                                        self.reply_draft = None;
                                        self.message_search.clear();
                                        self.show_message_search = false;
                                        self.call_status.clear();
                                        self.pending_call = None;
                                        self.active_call = None;
                                        self.voice_playback = None;
                                        if let Some(recorder) = self.voice_recorder.take() {
                                            recorder.cancel();
                                        }
                                        self.voice_status.clear();
                                    }
                                }
                            }
                        });
                },
            );
            let used_list_height = ui.cursor().top() - list_top;
            if used_list_height < list_height {
                ui.add_space(list_height - used_list_height);
            }

            egui::Frame::new()
                .fill(COL_SIDE)
                .inner_margin(egui::Margin::symmetric(24, 16))
                .show(ui, |ui| {
                    ui.separator();
                    ui.add_space(12.0);
                    let realtime_label = match self.realtime_status.as_str() {
                        "listening" => "Online",
                        "connecting" => "Wait",
                        _ => "Off",
                    };
                    let metric_count = if active_room_kind.is_some() {
                        room_summaries.len()
                    } else {
                        summaries.len()
                    };
                    let metric_label = if let Some(kind) = active_room_kind {
                        room_plural_metric_label(kind)
                    } else {
                        "Chats"
                    };
                    ui.columns(3, |columns| {
                        metric_box(&mut columns[0], metric_count.to_string(), metric_label);
                        metric_box(&mut columns[1], self.outbox_count.to_string(), "Queued");
                        metric_box(&mut columns[2], realtime_label.to_string(), "Status");
                    });
                    ui.add_space(12.0);
                    ui.collapsing("Advanced", |ui| {
                        ui.add(
                            egui::TextEdit::singleline(&mut self.backend_origin)
                                .desired_width(330.0)
                                .hint_text("https://messk.online"),
                        );
                        ui.add_space(8.0);
                        ui.horizontal(|ui| {
                            if primary_button(ui, "Check backend").clicked() {
                                self.check_health();
                            }
                            status_pill(
                                ui,
                                "health",
                                &self.health_status,
                                status_color(&self.health_status),
                            );
                        });
                        ui.add_space(8.0);
                        for line in self.logs.iter().rev().take(6).rev() {
                            ui.label(
                                egui::RichText::new(line)
                                    .monospace()
                                    .size(10.0)
                                    .color(COL_MUTED),
                            );
                        }
                    });
                });
        });
    }

    fn chat_panel(&mut self, ui: &mut egui::Ui) {
        egui::Frame::new().fill(COL_CHAT).show(ui, |ui| {
            let width = ui.available_width().max(520.0);
            let height = ui.available_height();
            ui.set_width(width);
            ui.set_min_width(width);
            ui.set_max_width(width);
            ui.set_min_height(height);

            const HEADER_HEIGHT: f32 = 64.0;
            const RECIPIENT_HEIGHT: f32 = 48.0;
            const SEARCH_HEIGHT: f32 = 46.0;
            const PINNED_HEIGHT: f32 = 44.0;
            const CALL_NOTICE_HEIGHT: f32 = 42.0;
            const DELIVERY_NOTICE_HEIGHT: f32 = 42.0;
            const COMPOSER_HEIGHT: f32 = 72.0;
            const REPLY_HEIGHT: f32 = 48.0;
            const VOICE_NOTICE_HEIGHT: f32 = 34.0;
            let has_active_chat = !self.recipient_public_key.trim().is_empty();
            let recipient_height = if has_active_chat {
                0.0
            } else {
                RECIPIENT_HEIGHT
            };
            let notice_height = if self.outbox_count > 0 {
                DELIVERY_NOTICE_HEIGHT
            } else {
                0.0
            };
            let search_height = if has_active_chat && self.show_message_search {
                SEARCH_HEIGHT
            } else {
                0.0
            };
            let pinned_banner = self
                .active_pinned_message()
                .map(|message| (message.msg_id.clone(), display_message_text(&message.text)));
            let pinned_height = if pinned_banner.is_some() {
                PINNED_HEIGHT
            } else {
                0.0
            };
            let call_notice_height = if self.call_status.trim().is_empty() {
                0.0
            } else {
                CALL_NOTICE_HEIGHT
            };
            let composer_height = COMPOSER_HEIGHT
                + if self.reply_draft.is_some() || self.edit_draft.is_some() {
                    REPLY_HEIGHT
                } else {
                    0.0
                }
                + if self.voice_recorder.is_some() {
                    VOICE_NOTICE_HEIGHT
                } else {
                    0.0
                };
            let message_height = (height
                - HEADER_HEIGHT
                - recipient_height
                - search_height
                - pinned_height
                - call_notice_height
                - notice_height
                - composer_height)
                .max(260.0);

            ui.allocate_ui_with_layout(
                egui::vec2(width, HEADER_HEIGHT),
                egui::Layout::top_down(egui::Align::Min),
                |ui| {
                    egui::Frame::new()
                        .fill(COL_TOP)
                        .stroke(egui::Stroke::new(1.0, COL_LINE))
                        .inner_margin(egui::Margin::symmetric(20, 10))
                        .show(ui, |ui| {
                            ui.set_width((width - 40.0).max(480.0));
                            let title = self.active_chat_title();
                            let subtitle = self.active_chat_subtitle();
                            ui.horizontal(|ui| {
                                avatar_box(ui, title.as_str(), 40.0);
                                ui.add_space(12.0);
                                ui.vertical(|ui| {
                                    ui.label(
                                        egui::RichText::new(title)
                                            .size(17.0)
                                            .strong()
                                            .color(COL_TEXT),
                                    );
                                    ui.label(
                                        egui::RichText::new(subtitle).size(11.0).color(COL_MUTED),
                                    );
                                });
                                ui.with_layout(
                                    egui::Layout::right_to_left(egui::Align::Center),
                                    |ui| {
                                        ui.add_space(10.0);
                                        if icon_button(ui, "Info").clicked() {
                                            self.open_active_contact_profile();
                                        }
                                        if has_active_chat && icon_button(ui, "Find").clicked() {
                                            self.show_message_search = !self.show_message_search;
                                            if !self.show_message_search {
                                                self.message_search.clear();
                                            }
                                        }
                                        if has_active_chat && icon_button(ui, "Mute").clicked() {
                                            self.logs.push("chat muted locally".to_string());
                                        }
                                        if has_active_chat && icon_button(ui, "Safe").clicked() {
                                            self.logs.push(format!(
                                                "safety number: {}",
                                                short_key(&self.recipient_public_key)
                                            ));
                                        }
                                        if has_active_chat && icon_button(ui, "Vid").clicked() {
                                            self.start_native_call_signal(
                                                call::CallMediaKind::Video,
                                            );
                                        }
                                        if has_active_chat && icon_button(ui, "Call").clicked() {
                                            self.start_native_call_signal(
                                                call::CallMediaKind::Audio,
                                            );
                                        }
                                        if has_active_chat && icon_button(ui, "Share").clicked() {
                                            self.show_native_screen_share_unavailable();
                                        }
                                        if self.outbox_count > 0
                                            && icon_button(ui, "Retry").clicked()
                                        {
                                            self.retry_outbox_now();
                                        }
                                    },
                                );
                            });
                        });
                },
            );

            if !has_active_chat {
                ui.allocate_ui_with_layout(
                    egui::vec2(width, RECIPIENT_HEIGHT),
                    egui::Layout::top_down(egui::Align::Min),
                    |ui| {
                        egui::Frame::new()
                            .fill(COL_PANEL)
                            .stroke(egui::Stroke::new(1.0, COL_LINE))
                            .corner_radius(egui::CornerRadius::same(0))
                            .inner_margin(egui::Margin::symmetric(18, 8))
                            .show(ui, |ui| {
                                ui.set_width((width - 36.0).max(480.0));
                                ui.horizontal(|ui| {
                                    ui.label(
                                        egui::RichText::new("To")
                                            .size(12.0)
                                            .strong()
                                            .color(COL_MUTED),
                                    );
                                    ui.add_space(8.0);
                                    let recipient_width = (ui.available_width() - 90.0).max(220.0);
                                    ui.add_sized(
                                        [recipient_width, 30.0],
                                        egui::TextEdit::singleline(&mut self.recipient_public_key)
                                            .hint_text("Paste recipient public key"),
                                    );
                                    ui.add_space(8.0);
                                    ui.label(
                                        egui::RichText::new("waiting")
                                            .size(12.0)
                                            .strong()
                                            .color(COL_WARN),
                                    );
                                });
                            });
                    },
                );
            }

            if has_active_chat && self.show_message_search {
                ui.allocate_ui_with_layout(
                    egui::vec2(width, SEARCH_HEIGHT),
                    egui::Layout::top_down(egui::Align::Min),
                    |ui| {
                        egui::Frame::new()
                            .fill(COL_PANEL)
                            .stroke(egui::Stroke::new(1.0, COL_LINE))
                            .corner_radius(egui::CornerRadius::same(0))
                            .inner_margin(egui::Margin::symmetric(24, 7))
                            .show(ui, |ui| {
                                ui.set_width((width - 48.0).max(480.0));
                                ui.horizontal(|ui| {
                                    let result_count = self
                                        .messages
                                        .iter()
                                        .filter(|message| {
                                            message.peer_public_key == self.recipient_public_key
                                                && message_matches_query(
                                                    message,
                                                    &self.message_search,
                                                )
                                        })
                                        .count();
                                    let search_width = (ui.available_width() - 126.0).max(220.0);
                                    ui.add_sized(
                                        [search_width, 30.0],
                                        egui::TextEdit::singleline(&mut self.message_search)
                                            .hint_text("Search in chat"),
                                    );
                                    ui.label(
                                        egui::RichText::new(result_count.to_string())
                                            .size(12.0)
                                            .strong()
                                            .color(COL_MUTED),
                                    );
                                    if ui
                                        .add_sized([64.0, 30.0], neutral_button_widget("Clear"))
                                        .clicked()
                                    {
                                        self.message_search.clear();
                                    }
                                });
                            });
                    },
                );
            }

            if !self.call_status.trim().is_empty() {
                ui.allocate_ui_with_layout(
                    egui::vec2(width, CALL_NOTICE_HEIGHT),
                    egui::Layout::top_down(egui::Align::Min),
                    |ui| {
                        egui::Frame::new()
                            .fill(COL_PANEL)
                            .stroke(egui::Stroke::new(1.0, COL_LINE))
                            .corner_radius(egui::CornerRadius::same(0))
                            .inner_margin(egui::Margin::symmetric(24, 7))
                            .show(ui, |ui| {
                                ui.set_width((width - 48.0).max(480.0));
                                ui.horizontal(|ui| {
                                    status_dot(ui, COL_ACCENT);
                                    ui.add_space(8.0);
                                    ui.label(
                                        egui::RichText::new(&self.call_status)
                                            .size(12.0)
                                            .strong()
                                            .color(COL_TEXT),
                                    );
                                    if let Some(active_call) = &self.active_call {
                                        ui.add_space(8.0);
                                        status_pill(
                                            ui,
                                            "state",
                                            call_state_label(active_call.state),
                                            status_color(call_state_label(active_call.state)),
                                        );
                                        status_pill(
                                            ui,
                                            "media",
                                            call_media_label(active_call.media),
                                            COL_MUTED,
                                        );
                                    }
                                    ui.with_layout(
                                        egui::Layout::right_to_left(egui::Align::Center),
                                        |ui| {
                                            if let Some(call) = self.pending_call.clone() {
                                                let secondary_label =
                                                    if call.incoming { "Reject" } else { "End" };
                                                if ui
                                                    .add_sized(
                                                        [72.0, 28.0],
                                                        neutral_button_widget(secondary_label),
                                                    )
                                                    .clicked()
                                                {
                                                    self.reject_or_end_pending_call();
                                                }
                                                ui.add_space(8.0);
                                                if call.incoming
                                                    && ui
                                                        .add_sized(
                                                            [76.0, 28.0],
                                                            primary_button_widget("Accept"),
                                                        )
                                                        .clicked()
                                                {
                                                    self.accept_pending_call();
                                                }
                                                ui.add_space(8.0);
                                                ui.label(
                                                    egui::RichText::new(call_media_label(
                                                        call.media,
                                                    ))
                                                    .size(11.0)
                                                    .strong()
                                                    .color(COL_MUTED),
                                                );
                                            } else {
                                                if ui
                                                    .add_sized(
                                                        [72.0, 28.0],
                                                        neutral_button_widget("Close"),
                                                    )
                                                    .clicked()
                                                {
                                                    self.call_status.clear();
                                                    self.pending_call = None;
                                                    self.active_call = None;
                                                    self.voice_playback = None;
                                                }
                                                if let Some(active_call) = &mut self.active_call {
                                                    ui.add_space(8.0);
                                                    let mute_label = if active_call.muted {
                                                        "Unmute"
                                                    } else {
                                                        "Mute"
                                                    };
                                                    if ui
                                                        .add_sized(
                                                            [76.0, 28.0],
                                                            neutral_button_widget(mute_label),
                                                        )
                                                        .clicked()
                                                    {
                                                        active_call.toggle_mute();
                                                    }
                                                    if active_call.media
                                                        == call::CallMediaKind::Video
                                                        && ui
                                                            .add_sized(
                                                                [76.0, 28.0],
                                                                neutral_button_widget(
                                                                    if active_call.camera_enabled {
                                                                        "Cam off"
                                                                    } else {
                                                                        "Cam on"
                                                                    },
                                                                ),
                                                            )
                                                            .clicked()
                                                    {
                                                        active_call.toggle_camera();
                                                    }
                                                }
                                            }
                                        },
                                    );
                                });
                            });
                    },
                );
            }

            if let Some((pinned_id, pinned_text)) = pinned_banner {
                ui.allocate_ui_with_layout(
                    egui::vec2(width, PINNED_HEIGHT),
                    egui::Layout::top_down(egui::Align::Min),
                    |ui| {
                        egui::Frame::new()
                            .fill(COL_PANEL)
                            .stroke(egui::Stroke::new(1.0, COL_LINE))
                            .corner_radius(egui::CornerRadius::same(0))
                            .inner_margin(egui::Margin::symmetric(24, 7))
                            .show(ui, |ui| {
                                ui.set_width((width - 48.0).max(480.0));
                                ui.horizontal(|ui| {
                                    let (rect, _response) = ui.allocate_exact_size(
                                        egui::vec2(3.0, 28.0),
                                        egui::Sense::hover(),
                                    );
                                    ui.painter().rect_filled(rect, 2.0, COL_ACCENT);
                                    ui.add_space(8.0);
                                    ui.vertical(|ui| {
                                        ui.label(
                                            egui::RichText::new("Pinned")
                                                .size(10.0)
                                                .strong()
                                                .color(COL_ACCENT),
                                        );
                                        ui.label(
                                            egui::RichText::new(trim_line(&pinned_text, 96))
                                                .size(12.0)
                                                .color(COL_MUTED),
                                        );
                                    });
                                    ui.with_layout(
                                        egui::Layout::right_to_left(egui::Align::Center),
                                        |ui| {
                                            if ui
                                                .add_sized(
                                                    [72.0, 28.0],
                                                    neutral_button_widget("Unpin"),
                                                )
                                                .clicked()
                                            {
                                                self.unpin_message(&pinned_id);
                                            }
                                        },
                                    );
                                });
                            });
                    },
                );
            }

            if self.outbox_count > 0 {
                ui.allocate_ui_with_layout(
                    egui::vec2(width, DELIVERY_NOTICE_HEIGHT),
                    egui::Layout::top_down(egui::Align::Min),
                    |ui| {
                        egui::Frame::new()
                            .fill(egui::Color32::from_rgb(34, 33, 27))
                            .stroke(egui::Stroke::new(1.0, COL_WARN))
                            .corner_radius(egui::CornerRadius::same(0))
                            .inner_margin(egui::Margin::symmetric(24, 7))
                            .show(ui, |ui| {
                                ui.set_width((width - 48.0).max(480.0));
                                ui.horizontal(|ui| {
                                    status_dot(ui, COL_WARN);
                                    ui.add_space(8.0);
                                    ui.label(
                                        egui::RichText::new(format!(
                                            "{} messages waiting delivery",
                                            self.outbox_count
                                        ))
                                        .size(12.0)
                                        .strong()
                                        .color(COL_TEXT),
                                    );
                                    ui.with_layout(
                                        egui::Layout::right_to_left(egui::Align::Center),
                                        |ui| {
                                            if ui
                                                .add_sized(
                                                    [96.0, 28.0],
                                                    neutral_button_widget("Retry now"),
                                                )
                                                .clicked()
                                            {
                                                self.retry_outbox_now();
                                            }
                                        },
                                    );
                                });
                            });
                    },
                );
            }

            ui.allocate_ui_with_layout(
                egui::vec2(width, message_height),
                egui::Layout::top_down(egui::Align::Min),
                |ui| {
                    let active_messages: Vec<ChatLine> =
                        if self.recipient_public_key.trim().is_empty() {
                            Vec::new()
                        } else {
                            self.messages
                                .iter()
                                .filter(|message| {
                                    message.peer_public_key == self.recipient_public_key
                                        && message_matches_query(message, &self.message_search)
                                })
                                .cloned()
                                .collect()
                        };
                    let search_has_query = !self.message_search.trim().is_empty();
                    let mut pending_action = None;
                    egui::Frame::new()
                        .fill(COL_CHAT)
                        .inner_margin(egui::Margin::symmetric(22, 0))
                        .show(ui, |ui| {
                            ui.set_width((width - 44.0).max(468.0));
                            ui.set_min_height(message_height);
                            egui::ScrollArea::vertical()
                                .id_salt("message-list")
                                .max_height(message_height)
                                .stick_to_bottom(true)
                                .show(ui, |ui| {
                                    ui.add_space(16.0);
                                    if active_messages.is_empty() {
                                        if search_has_query {
                                            empty_search_state(ui, message_height);
                                        } else {
                                            empty_state(ui, message_height);
                                        }
                                    }

                                    for message in &active_messages {
                                        let is_pinned =
                                            self.pinned_message_ids.contains(&message.msg_id);
                                        if let Some(action) = message_bubble(
                                            ui,
                                            message,
                                            is_pinned,
                                            self.voice_playback.as_ref(),
                                        ) {
                                            pending_action = Some(action);
                                        }
                                    }
                                    ui.add_space(18.0);
                                });
                        });
                    if let Some(action) = pending_action {
                        self.handle_message_action(ui.ctx(), action);
                    }
                },
            );

            ui.allocate_ui_with_layout(
                egui::vec2(width, composer_height),
                egui::Layout::top_down(egui::Align::Min),
                |ui| {
                    egui::Frame::new()
                        .fill(COL_TOP)
                        .stroke(egui::Stroke::new(1.0, COL_LINE))
                        .inner_margin(egui::Margin::symmetric(20, 11))
                        .show(ui, |ui| {
                            ui.set_width((width - 40.0).max(480.0));
                            if let Some(edit) = &self.edit_draft {
                                let preview = trim_line(&edit.original, 92);
                                let mut cancel_edit = false;
                                egui::Frame::new()
                                    .fill(COL_PANEL_SOFT)
                                    .stroke(egui::Stroke::new(1.0, COL_LINE))
                                    .corner_radius(egui::CornerRadius::same(7))
                                    .inner_margin(egui::Margin::symmetric(10, 6))
                                    .show(ui, |ui| {
                                        ui.set_width((width - 68.0).max(460.0));
                                        ui.horizontal(|ui| {
                                            ui.vertical(|ui| {
                                                ui.label(
                                                    egui::RichText::new("Edit message")
                                                        .size(10.0)
                                                        .strong()
                                                        .color(COL_ACCENT),
                                                );
                                                ui.label(
                                                    egui::RichText::new(preview)
                                                        .size(12.0)
                                                        .color(COL_MUTED),
                                                );
                                            });
                                            ui.with_layout(
                                                egui::Layout::right_to_left(egui::Align::Center),
                                                |ui| {
                                                    if icon_button(ui, "X").clicked() {
                                                        cancel_edit = true;
                                                    }
                                                },
                                            );
                                        });
                                    });
                                if cancel_edit {
                                    self.edit_draft = None;
                                    self.composer_text.clear();
                                }
                                ui.add_space(8.0);
                            } else if let Some(reply) = &self.reply_draft {
                                let preview = trim_line(&reply.preview, 92);
                                let mut cancel_reply = false;
                                egui::Frame::new()
                                    .fill(COL_PANEL_SOFT)
                                    .stroke(egui::Stroke::new(1.0, COL_LINE))
                                    .corner_radius(egui::CornerRadius::same(7))
                                    .inner_margin(egui::Margin::symmetric(10, 6))
                                    .show(ui, |ui| {
                                        ui.set_width((width - 68.0).max(460.0));
                                        ui.horizontal(|ui| {
                                            ui.vertical(|ui| {
                                                ui.label(
                                                    egui::RichText::new("Reply")
                                                        .size(10.0)
                                                        .strong()
                                                        .color(COL_ACCENT),
                                                );
                                                ui.label(
                                                    egui::RichText::new(preview)
                                                        .size(12.0)
                                                        .color(COL_MUTED),
                                                );
                                            });
                                            ui.with_layout(
                                                egui::Layout::right_to_left(egui::Align::Center),
                                                |ui| {
                                                    if icon_button(ui, "X").clicked() {
                                                        cancel_reply = true;
                                                    }
                                                },
                                            );
                                        });
                                    });
                                if cancel_reply {
                                    self.reply_draft = None;
                                }
                                ui.add_space(8.0);
                            }
                            if let Some(recorder) = &self.voice_recorder {
                                let seconds = recorder.elapsed_seconds();
                                egui::Frame::new()
                                    .fill(COL_PANEL_SOFT)
                                    .stroke(egui::Stroke::new(1.0, COL_LINE))
                                    .corner_radius(egui::CornerRadius::same(7))
                                    .inner_margin(egui::Margin::symmetric(10, 5))
                                    .show(ui, |ui| {
                                        ui.set_width((width - 68.0).max(460.0));
                                        ui.horizontal(|ui| {
                                            status_dot(ui, COL_DANGER);
                                            ui.label(
                                                egui::RichText::new(format!(
                                                    "Recording voice {:02}:{:02}",
                                                    seconds / 60,
                                                    seconds % 60
                                                ))
                                                .size(12.0)
                                                .strong()
                                                .color(COL_TEXT),
                                            );
                                            ui.label(
                                                egui::RichText::new(trim_line(
                                                    &self.voice_status,
                                                    64,
                                                ))
                                                .size(11.0)
                                                .color(COL_MUTED),
                                            );
                                        });
                                    });
                                ui.add_space(7.0);
                            }
                            let composer_width = (ui.available_width() - 220.0).max(220.0);
                            ui.horizontal(|ui| {
                                if icon_button(ui, "File")
                                    .on_hover_text("Send encrypted file")
                                    .clicked()
                                {
                                    self.pick_and_send_file();
                                }
                                if self.voice_recorder.is_some() {
                                    if icon_button(ui, "Stop")
                                        .on_hover_text("Stop recording and send")
                                        .clicked()
                                    {
                                        self.stop_voice_recording_and_send();
                                    }
                                    if icon_button(ui, "Drop")
                                        .on_hover_text("Discard recording")
                                        .clicked()
                                    {
                                        self.cancel_voice_recording();
                                    }
                                } else {
                                    if icon_button(ui, "Mic")
                                        .on_hover_text("Record encrypted voice message")
                                        .clicked()
                                    {
                                        self.start_voice_recording();
                                    }
                                    if icon_button(ui, "Aud")
                                        .on_hover_text("Attach recorded audio file")
                                        .clicked()
                                    {
                                        self.pick_and_send_voice();
                                    }
                                }
                                let composer_response = ui.add_sized(
                                    [composer_width, 42.0],
                                    egui::TextEdit::singleline(&mut self.composer_text)
                                        .hint_text("Message..."),
                                );
                                ui.add_space(8.0);
                                let enter_send = composer_response.has_focus()
                                    && ui.input(|input| input.key_pressed(egui::Key::Enter));
                                let send_label = if self.edit_draft.is_some() {
                                    "Save"
                                } else {
                                    "Send"
                                };
                                let send_clicked = ui
                                    .add_sized([64.0, 42.0], primary_button_widget(send_label))
                                    .clicked();
                                if enter_send || send_clicked {
                                    self.send_direct_message();
                                }
                            });
                        });
                },
            );
        });
    }

    fn room_panel(&mut self, ui: &mut egui::Ui) {
        let kind = workspace_kind(self.active_workspace).unwrap_or("group");
        let selected = self.selected_room().cloned();
        let width = ui.available_width().max(520.0);
        let height = ui.available_height();
        let mut create_room = false;
        let mut edit_room = false;
        let mut toggle_pin = false;
        let mut toggle_mute = false;
        let mut delete_room = false;

        egui::Frame::new().fill(COL_CHAT).show(ui, |ui| {
            ui.set_width(width);
            ui.set_min_width(width);
            ui.set_max_width(width);
            ui.set_min_height(height);

            egui::Frame::new()
                .fill(COL_TOP)
                .stroke(egui::Stroke::new(1.0, COL_LINE))
                .inner_margin(egui::Margin::symmetric(20, 10))
                .show(ui, |ui| {
                    ui.set_width((width - 40.0).max(480.0));
                    let title = selected
                        .as_ref()
                        .map(|room| room.title.as_str())
                        .unwrap_or_else(|| room_plural_label(kind));
                    let subtitle = selected
                        .as_ref()
                        .map(room_panel_subtitle)
                        .unwrap_or_else(|| format!("{} workspace", room_kind_label(kind)));
                    ui.horizontal(|ui| {
                        avatar_box(ui, title, 40.0);
                        ui.add_space(12.0);
                        ui.vertical(|ui| {
                            ui.label(
                                egui::RichText::new(title)
                                    .size(17.0)
                                    .strong()
                                    .color(COL_TEXT),
                            );
                            ui.label(egui::RichText::new(subtitle).size(11.0).color(COL_MUTED));
                        });
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if icon_button(ui, "New").clicked() {
                                create_room = true;
                            }
                            if selected.is_some() && icon_button(ui, "Edit").clicked() {
                                edit_room = true;
                            }
                            if let Some(room) = &selected {
                                if icon_button(ui, if room.pinned { "Unpin" } else { "Pin" })
                                    .clicked()
                                {
                                    toggle_pin = true;
                                }
                                if icon_button(ui, if room.muted { "Unmute" } else { "Mute" })
                                    .clicked()
                                {
                                    toggle_mute = true;
                                }
                            }
                        });
                    });
                });

            egui::Frame::new()
                .fill(COL_CHAT)
                .inner_margin(egui::Margin::symmetric(28, 24))
                .show(ui, |ui| {
                    ui.set_width((width - 56.0).max(480.0));
                    ui.set_min_height((height - 88.0).max(360.0));
                    if let Some(room) = &selected {
                        ui.horizontal(|ui| {
                            status_pill(ui, "type", room_kind_label(&room.kind), COL_ACCENT);
                            status_pill(ui, "role", &room.role, COL_MUTED);
                            status_pill(
                                ui,
                                "state",
                                &room_row_status(room),
                                status_color(&room_row_status(room)),
                            );
                        });
                        ui.add_space(20.0);
                        egui::Frame::new()
                            .fill(COL_PANEL)
                            .stroke(egui::Stroke::new(1.0, COL_LINE))
                            .corner_radius(egui::CornerRadius::same(8))
                            .inner_margin(egui::Margin::symmetric(18, 16))
                            .show(ui, |ui| {
                                ui.set_width((width - 92.0).max(440.0));
                                ui.horizontal(|ui| {
                                    avatar_box(ui, &room.title, 54.0);
                                    ui.add_space(14.0);
                                    ui.vertical(|ui| {
                                        ui.label(
                                            egui::RichText::new(&room.title)
                                                .size(21.0)
                                                .strong()
                                                .color(COL_TEXT),
                                        );
                                        ui.add_space(4.0);
                                        ui.label(
                                            egui::RichText::new(format!(
                                                "Updated {}",
                                                format_activity_time(room.updated_at_ms)
                                            ))
                                            .size(12.0)
                                            .color(COL_MUTED),
                                        );
                                    });
                                });
                                ui.add_space(16.0);
                                ui.columns(4, |columns| {
                                    detail_box(
                                        &mut columns[0],
                                        "ID",
                                        trim_line(&short_key(&room.room_id), 16),
                                    );
                                    detail_box(
                                        &mut columns[1],
                                        "Created",
                                        format_activity_time(room.created_at_ms),
                                    );
                                    detail_box(
                                        &mut columns[2],
                                        "Pinned",
                                        if room.pinned { "yes" } else { "no" }.to_string(),
                                    );
                                    detail_box(
                                        &mut columns[3],
                                        "Muted",
                                        if room.muted { "yes" } else { "no" }.to_string(),
                                    );
                                });
                                ui.add_space(18.0);
                                ui.horizontal(|ui| {
                                    if ui
                                        .add_sized([112.0, 36.0], primary_button_widget("Edit"))
                                        .clicked()
                                    {
                                        edit_room = true;
                                    }
                                    if ui
                                        .add_sized(
                                            [112.0, 36.0],
                                            neutral_button_widget(if room.pinned {
                                                "Unpin"
                                            } else {
                                                "Pin"
                                            }),
                                        )
                                        .clicked()
                                    {
                                        toggle_pin = true;
                                    }
                                    if ui
                                        .add_sized(
                                            [112.0, 36.0],
                                            neutral_button_widget(if room.muted {
                                                "Unmute"
                                            } else {
                                                "Mute"
                                            }),
                                        )
                                        .clicked()
                                    {
                                        toggle_mute = true;
                                    }
                                    if ui
                                        .add_sized([112.0, 36.0], danger_button_widget("Delete"))
                                        .clicked()
                                    {
                                        delete_room = true;
                                    }
                                });
                            });
                    } else {
                        ui.vertical_centered(|ui| {
                            ui.add_space(((height - 88.0) * 0.25).clamp(60.0, 140.0));
                            avatar_box(ui, room_plural_label(kind), 54.0);
                            ui.add_space(14.0);
                            ui.label(
                                egui::RichText::new(room_empty_panel_title(kind))
                                    .size(22.0)
                                    .strong()
                                    .color(COL_TEXT),
                            );
                            ui.add_space(10.0);
                            if ui
                                .add_sized([184.0, 40.0], primary_button_widget("Create"))
                                .clicked()
                            {
                                create_room = true;
                            }
                        });
                    }
                });
        });

        if create_room {
            self.open_room_editor_for_workspace();
        }
        if edit_room {
            self.open_room_editor_for_selected();
        }
        if toggle_pin {
            self.toggle_selected_room_pin();
        }
        if toggle_mute {
            self.toggle_selected_room_mute();
        }
        if delete_room {
            self.delete_selected_room();
        }
    }

    fn chat_summaries(&self) -> Vec<ChatSummary> {
        let mut summaries: Vec<ChatSummary> = Vec::new();
        for message in &self.messages {
            let peer = message.peer_public_key.clone();
            if let Some(existing) = summaries
                .iter_mut()
                .find(|summary| summary.peer_public_key == peer)
            {
                existing.title = self.contact_title(&peer);
                existing.subtitle = display_message_text(&message.text);
                existing.status = message.status.clone();
                existing.last_activity_ms = message.created_at_ms;
            } else {
                summaries.push(ChatSummary {
                    peer_public_key: peer.clone(),
                    title: self.contact_title(&peer),
                    subtitle: display_message_text(&message.text),
                    status: message.status.clone(),
                    last_activity_ms: message.created_at_ms,
                });
            }
        }
        for (peer, alias) in &self.contacts {
            if summaries
                .iter()
                .any(|summary| summary.peer_public_key == *peer)
            {
                continue;
            }
            summaries.push(ChatSummary {
                peer_public_key: peer.clone(),
                title: if alias.display_name.trim().is_empty() {
                    short_key(peer)
                } else {
                    alias.display_name.clone()
                },
                subtitle: "No messages yet".to_string(),
                status: "ready".to_string(),
                last_activity_ms: alias.updated_at_ms,
            });
        }
        summaries.sort_by_key(|summary| std::cmp::Reverse(summary.last_activity_ms));
        summaries
    }

    fn filtered_chat_summaries(&self) -> Vec<ChatSummary> {
        let search = self.chat_search.trim().to_lowercase();
        self.chat_summaries()
            .into_iter()
            .filter(|summary| {
                if self.active_filter == 1
                    && !matches!(
                        summary.status.as_str(),
                        "pending" | "waiting_retry" | "waiting retry"
                    )
                {
                    return false;
                }
                search.is_empty()
                    || summary.title.to_lowercase().contains(&search)
                    || summary.subtitle.to_lowercase().contains(&search)
                    || summary.peer_public_key.to_lowercase().contains(&search)
            })
            .collect()
    }

    fn filtered_room_summaries(&self, kind: &str) -> Vec<RoomSummary> {
        let search = self.chat_search.trim().to_lowercase();
        let mut rooms: Vec<RoomSummary> = self
            .rooms
            .iter()
            .filter(|room| room.kind == kind)
            .filter(|room| {
                if self.active_filter == 1 && !room.muted {
                    return false;
                }
                if self.active_filter == 2 && !room.pinned {
                    return false;
                }
                search.is_empty()
                    || room.title.to_lowercase().contains(&search)
                    || room.role.to_lowercase().contains(&search)
                    || room.room_id.to_lowercase().contains(&search)
            })
            .cloned()
            .collect();
        rooms.sort_by(|left, right| {
            right
                .pinned
                .cmp(&left.pinned)
                .then(right.updated_at_ms.cmp(&left.updated_at_ms))
                .then(left.title.to_lowercase().cmp(&right.title.to_lowercase()))
        });
        rooms
    }

    fn identity_name(&self) -> String {
        if self.identity.is_some() {
            "Anonymous".to_string()
        } else {
            "No identity".to_string()
        }
    }

    fn identity_initial(&self) -> String {
        if self.identity.is_some() {
            "A".to_string()
        } else {
            "?".to_string()
        }
    }

    fn identity_short_key(&self) -> String {
        self.identity
            .as_ref()
            .map(|identity| short_key(&identity.public_key))
            .unwrap_or_else(|| "Generate or import seed".to_string())
    }

    fn contact_title(&self, peer_public_key: &str) -> String {
        self.contacts
            .get(peer_public_key)
            .map(|alias| alias.display_name.trim())
            .filter(|name| !name.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| short_key(peer_public_key))
    }

    fn active_chat_title(&self) -> String {
        if self.recipient_public_key.trim().is_empty() {
            "New encrypted chat".to_string()
        } else {
            self.contact_title(&self.recipient_public_key)
        }
    }

    fn active_chat_subtitle(&self) -> String {
        if self.recipient_public_key.trim().is_empty() {
            "Start a new encrypted chat".to_string()
        } else {
            let count = self.chat_message_count(&self.recipient_public_key);
            let status = self
                .last_message_for_peer(&self.recipient_public_key)
                .map(|message| clean_status(&message.status).to_string())
                .unwrap_or_else(|| "ready".to_string());
            format!("{count} messages - {status}")
        }
    }
}

#[derive(Debug, Clone)]
struct ChatSummary {
    peer_public_key: String,
    title: String,
    subtitle: String,
    status: String,
    last_activity_ms: i64,
}

#[derive(Debug, Clone)]
enum MessageAction {
    Reply(String),
    Edit(String),
    Pin(String),
    Unpin(String),
    React {
        msg_id: String,
        reaction: Option<String>,
    },
    Copy(String),
    SaveFile(EncryptedFilePayload),
    PlayVoice {
        msg_id: String,
        payload: VoiceMessagePayload,
    },
    Delete(String),
    DeleteLocal(String),
}

const TRAY_SHOW_ID: &str = "messk.tray.show";
const TRAY_HIDE_ID: &str = "messk.tray.hide";
const TRAY_QUIT_ID: &str = "messk.tray.quit";
const COL_BG: egui::Color32 = egui::Color32::from_rgb(14, 22, 33);
const COL_SIDE: egui::Color32 = egui::Color32::from_rgb(23, 33, 43);
const COL_TOP: egui::Color32 = egui::Color32::from_rgb(23, 33, 43);
const COL_CHAT: egui::Color32 = egui::Color32::from_rgb(14, 22, 33);
const COL_PANEL: egui::Color32 = egui::Color32::from_rgb(23, 33, 43);
const COL_PANEL_SOFT: egui::Color32 = egui::Color32::from_rgb(27, 39, 51);
const COL_PANEL_HOVER: egui::Color32 = egui::Color32::from_rgb(32, 46, 60);
const COL_ACTIVE: egui::Color32 = egui::Color32::from_rgb(34, 52, 71);
const COL_INPUT: egui::Color32 = egui::Color32::from_rgb(17, 28, 39);
const COL_BUBBLE_IN: egui::Color32 = egui::Color32::from_rgb(24, 37, 51);
const COL_BUBBLE_OUT: egui::Color32 = egui::Color32::from_rgb(43, 82, 120);
const COL_BUBBLE_OUT_BORDER: egui::Color32 = egui::Color32::from_rgb(53, 98, 141);
const COL_BUBBLE_OUT_META: egui::Color32 = egui::Color32::from_rgb(199, 220, 235);
const COL_ACCENT: egui::Color32 = egui::Color32::from_rgb(42, 171, 238);
const COL_DANGER: egui::Color32 = egui::Color32::from_rgb(224, 92, 92);
const COL_WARN: egui::Color32 = egui::Color32::from_rgb(221, 166, 77);
const COL_OK: egui::Color32 = egui::Color32::from_rgb(83, 184, 128);
const COL_TEXT: egui::Color32 = egui::Color32::from_rgb(231, 237, 243);
const COL_MUTED: egui::Color32 = egui::Color32::from_rgb(143, 161, 179);
const COL_LINE: egui::Color32 = egui::Color32::from_rgb(38, 50, 65);
const COL_LINE_STRONG: egui::Color32 = egui::Color32::from_rgb(49, 65, 83);
const SIDEBAR_WIDTH: f32 = 390.0;

fn build_tray_icon(
    ctx: egui::Context,
    tx: mpsc::Sender<UiEvent>,
) -> Result<tray_icon::TrayIcon, String> {
    use tray_icon::{
        Icon, MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent,
        menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem},
    };

    let show_item = MenuItem::with_id(TRAY_SHOW_ID, "Show Messk", true, None);
    let hide_item = MenuItem::with_id(TRAY_HIDE_ID, "Hide to tray", true, None);
    let quit_item = MenuItem::with_id(TRAY_QUIT_ID, "Quit", true, None);
    let separator = PredefinedMenuItem::separator();
    let menu = Menu::with_items(&[&show_item, &hide_item, &separator, &quit_item])
        .map_err(|error| error.to_string())?;

    let icon_data = crate::app_icon::messk_icon();
    let icon = Icon::from_rgba(icon_data.rgba, icon_data.width, icon_data.height)
        .map_err(|error| error.to_string())?;

    let menu_tx = tx.clone();
    let menu_ctx = ctx.clone();
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        let event = if event.id == TRAY_SHOW_ID {
            UiEvent::TrayShow
        } else if event.id == TRAY_HIDE_ID {
            UiEvent::TrayHide
        } else if event.id == TRAY_QUIT_ID {
            UiEvent::TrayQuit
        } else {
            return;
        };
        let _ = menu_tx.send(event);
        menu_ctx.request_repaint();
    }));

    let tray_tx = tx;
    let tray_ctx = ctx;
    TrayIconEvent::set_event_handler(Some(move |event: TrayIconEvent| {
        let should_show = matches!(
            event,
            TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } | TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
        );
        if should_show {
            let _ = tray_tx.send(UiEvent::TrayShow);
            tray_ctx.request_repaint();
        }
    }));

    TrayIconBuilder::new()
        .with_tooltip(format!("Messk v{}", config::APP_VERSION))
        .with_menu(Box::new(menu))
        .with_menu_on_left_click(false)
        .with_icon(icon)
        .build()
        .map_err(|error| error.to_string())
}

fn apply_visuals(ctx: &egui::Context, settings: &storage::StoredAppSettings) {
    let mut visuals = egui::Visuals::dark();
    let (panel, soft, hover, input) = match settings.theme.as_str() {
        "graphite" => (
            egui::Color32::from_rgb(26, 28, 32),
            egui::Color32::from_rgb(34, 37, 42),
            egui::Color32::from_rgb(45, 49, 55),
            egui::Color32::from_rgb(18, 20, 23),
        ),
        "midnight" => (
            egui::Color32::from_rgb(18, 24, 38),
            egui::Color32::from_rgb(24, 32, 50),
            egui::Color32::from_rgb(32, 43, 65),
            egui::Color32::from_rgb(12, 17, 28),
        ),
        _ => (COL_PANEL, COL_PANEL_SOFT, COL_PANEL_HOVER, COL_INPUT),
    };
    let font_scale = settings.font_scale.clamp(0.9, 1.2);
    let compact = settings.density == "compact";
    visuals.override_text_color = Some(COL_TEXT);
    visuals.panel_fill = COL_BG;
    visuals.extreme_bg_color = input;
    visuals.faint_bg_color = soft;
    visuals.widgets.noninteractive.bg_fill = panel;
    visuals.widgets.noninteractive.corner_radius = egui::CornerRadius::same(8);
    visuals.widgets.inactive.bg_fill = input;
    visuals.widgets.inactive.bg_stroke = egui::Stroke::new(1.0, COL_LINE);
    visuals.widgets.inactive.corner_radius = egui::CornerRadius::same(6);
    visuals.widgets.hovered.bg_fill = hover;
    visuals.widgets.hovered.bg_stroke = egui::Stroke::new(1.0, COL_LINE_STRONG);
    visuals.widgets.hovered.corner_radius = egui::CornerRadius::same(6);
    visuals.widgets.active.bg_fill = COL_ACCENT;
    visuals.widgets.active.corner_radius = egui::CornerRadius::same(6);
    visuals.selection.bg_fill = COL_ACCENT;
    ctx.set_visuals(visuals);

    ctx.global_style_mut(|style| {
        style.spacing.item_spacing = if compact {
            egui::vec2(6.0, 4.0)
        } else {
            egui::vec2(8.0, 6.0)
        };
        style.spacing.button_padding = if compact {
            egui::vec2(10.0, 6.0)
        } else {
            egui::vec2(12.0, 8.0)
        };
        style.spacing.interact_size = if compact {
            egui::vec2(36.0, 30.0)
        } else {
            egui::vec2(40.0, 34.0)
        };
        style.text_styles.insert(
            egui::TextStyle::Heading,
            egui::FontId::proportional(22.0 * font_scale),
        );
        style.text_styles.insert(
            egui::TextStyle::Body,
            egui::FontId::proportional(14.0 * font_scale),
        );
        style.text_styles.insert(
            egui::TextStyle::Button,
            egui::FontId::proportional(13.0 * font_scale),
        );
        style.text_styles.insert(
            egui::TextStyle::Small,
            egui::FontId::proportional(11.0 * font_scale),
        );
    });
}

fn status_color(status: &str) -> egui::Color32 {
    match status {
        "ok" | "ready" | "listening" | "sent" | "delivered" | "read" | "active" | "pinned" => {
            COL_OK
        }
        "checking" | "connecting" | "pending" | "waiting" | "waiting_retry" | "waiting retry"
        | "editing" | "muted" => COL_WARN,
        "error" | "offline" | "failed" | "deleted" => COL_DANGER,
        _ => COL_MUTED,
    }
}

fn avatar_box(ui: &mut egui::Ui, seed: &str, size: f32) {
    let letter = seed
        .chars()
        .find(|character| character.is_ascii_alphanumeric())
        .unwrap_or('M')
        .to_ascii_uppercase();
    let font_size = if size >= 46.0 { 18.0 } else { 16.0 };
    let (rect, _response) = ui.allocate_exact_size(egui::vec2(size, size), egui::Sense::hover());
    ui.painter().rect_filled(rect, 8.0, COL_ACCENT);
    ui.painter().rect_stroke(
        rect,
        8.0,
        egui::Stroke::new(1.0, egui::Color32::from_rgb(70, 188, 242)),
        egui::StrokeKind::Inside,
    );
    ui.painter().text(
        rect.center(),
        egui::Align2::CENTER_CENTER,
        letter.to_string(),
        egui::FontId::proportional(font_size),
        egui::Color32::WHITE,
    );
}

fn connection_chip(ui: &mut egui::Ui, status: &str) {
    let color = status_color(status);
    egui::Frame::new()
        .fill(COL_PANEL_SOFT)
        .stroke(egui::Stroke::new(1.0, COL_LINE))
        .corner_radius(egui::CornerRadius::same(6))
        .inner_margin(egui::Margin::symmetric(8, 3))
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                status_dot(ui, color);
                ui.label(
                    egui::RichText::new(status)
                        .size(11.0)
                        .strong()
                        .color(COL_TEXT),
                );
            });
        });
}

fn status_dot(ui: &mut egui::Ui, color: egui::Color32) {
    let (rect, _response) = ui.allocate_exact_size(egui::vec2(7.0, 7.0), egui::Sense::hover());
    ui.painter().circle_filled(rect.center(), 3.5, color);
}

fn icon_button(ui: &mut egui::Ui, text: &str) -> egui::Response {
    ui.add_sized(
        [44.0, 32.0],
        egui::Button::new(
            egui::RichText::new(text)
                .size(11.0)
                .strong()
                .color(COL_MUTED),
        )
        .fill(COL_PANEL_SOFT)
        .stroke(egui::Stroke::new(1.0, COL_LINE))
        .corner_radius(egui::CornerRadius::same(6)),
    )
}

fn workspace_kind(workspace: usize) -> Option<&'static str> {
    match workspace {
        1 => Some("group"),
        2 => Some("channel"),
        _ => None,
    }
}

fn workspace_search_hint(workspace: usize) -> &'static str {
    match workspace_kind(workspace) {
        Some("group") => "Search groups, roles and IDs...",
        Some("channel") => "Search channels, roles and IDs...",
        _ => "Search chats, keys and drafts...",
    }
}

fn workspace_filter_labels(workspace: usize) -> (&'static str, &'static str, &'static str) {
    match workspace_kind(workspace) {
        Some(_) => ("All", "Muted", "Pinned"),
        None => ("Inbox", "Unread", "Archived"),
    }
}

fn room_kind_label(kind: &str) -> &'static str {
    match kind {
        "channel" => "channel",
        _ => "group",
    }
}

fn room_plural_label(kind: &str) -> &'static str {
    match kind {
        "channel" => "Channels",
        _ => "Groups",
    }
}

fn room_plural_metric_label(kind: &str) -> &'static str {
    match kind {
        "channel" => "Channels",
        _ => "Groups",
    }
}

fn default_room_role(kind: &str) -> &'static str {
    match kind {
        "channel" => "admin",
        _ => "owner",
    }
}

fn room_name_hint(kind: &str) -> &'static str {
    match kind {
        "channel" => "Announcements",
        _ => "Core team",
    }
}

fn room_empty_title(kind: &str) -> &'static str {
    match kind {
        "channel" => "Create channel",
        _ => "Create group",
    }
}

fn room_empty_subtitle(_kind: &str) -> &'static str {
    "Name, role, pin and mute state"
}

fn room_empty_panel_title(kind: &str) -> &'static str {
    match kind {
        "channel" => "No channel selected",
        _ => "No group selected",
    }
}

fn room_row_status(room: &RoomSummary) -> String {
    if room.pinned {
        "pinned".to_string()
    } else if room.muted {
        "muted".to_string()
    } else {
        "active".to_string()
    }
}

fn room_row_subtitle(room: &RoomSummary) -> String {
    format!(
        "{} - {}",
        room.role,
        format_activity_time(room.updated_at_ms)
    )
}

fn room_panel_subtitle(room: &RoomSummary) -> String {
    format!(
        "{} - created {}",
        room.role,
        format_activity_time(room.created_at_ms)
    )
}

fn settings_choice(
    ui: &mut egui::Ui,
    current: &mut String,
    value: &str,
    label: &str,
) -> egui::Response {
    let selected = current == value;
    let response = ui.add_sized(
        [112.0, 36.0],
        egui::Button::new(
            egui::RichText::new(label)
                .size(13.0)
                .strong()
                .color(if selected { COL_TEXT } else { COL_MUTED }),
        )
        .fill(if selected { COL_ACTIVE } else { COL_PANEL_SOFT })
        .stroke(egui::Stroke::new(1.0, COL_LINE))
        .corner_radius(egui::CornerRadius::same(7)),
    );
    if response.clicked() {
        *current = value.to_string();
    }
    response
}

fn workspace_tab(ui: &mut egui::Ui, selected: bool, label: &str) -> egui::Response {
    let fill = if selected { COL_ACTIVE } else { COL_PANEL_SOFT };
    let text = if selected { COL_TEXT } else { COL_MUTED };
    ui.add_sized(
        [112.0, 42.0],
        egui::Button::new(egui::RichText::new(label).size(16.0).strong().color(text))
            .fill(fill)
            .stroke(egui::Stroke::new(1.0, COL_LINE))
            .corner_radius(egui::CornerRadius::same(7)),
    )
}

fn filter_chip(ui: &mut egui::Ui, selected: bool, label: &str) -> egui::Response {
    let fill = if selected { COL_ACTIVE } else { COL_PANEL_SOFT };
    let text = if selected { COL_TEXT } else { COL_MUTED };
    ui.add_sized(
        [108.0, 40.0],
        egui::Button::new(egui::RichText::new(label).size(14.0).strong().color(text))
            .fill(fill)
            .stroke(egui::Stroke::new(1.0, COL_LINE))
            .corner_radius(egui::CornerRadius::same(7)),
    )
}

fn metric_box(ui: &mut egui::Ui, value: String, label: &str) {
    egui::Frame::new()
        .fill(COL_PANEL_SOFT)
        .stroke(egui::Stroke::new(1.0, COL_LINE))
        .corner_radius(egui::CornerRadius::same(6))
        .inner_margin(egui::Margin::symmetric(8, 10))
        .show(ui, |ui| {
            ui.set_width(92.0);
            ui.vertical_centered(|ui| {
                ui.label(
                    egui::RichText::new(value)
                        .size(18.0)
                        .strong()
                        .color(COL_TEXT),
                );
                ui.add_space(2.0);
                ui.label(egui::RichText::new(label).size(10.0).color(COL_MUTED));
            });
        });
}

fn detail_box(ui: &mut egui::Ui, label: &str, value: String) {
    egui::Frame::new()
        .fill(COL_PANEL_SOFT)
        .stroke(egui::Stroke::new(1.0, COL_LINE))
        .corner_radius(egui::CornerRadius::same(6))
        .inner_margin(egui::Margin::symmetric(10, 10))
        .show(ui, |ui| {
            ui.set_width(110.0);
            ui.label(
                egui::RichText::new(label)
                    .size(10.0)
                    .strong()
                    .color(COL_MUTED),
            );
            ui.add_space(4.0);
            ui.label(
                egui::RichText::new(value)
                    .size(13.0)
                    .strong()
                    .color(COL_TEXT),
            );
        });
}

fn outbox_queue_row(ui: &mut egui::Ui, title: &str, message: &storage::OutboxMessage) {
    egui::Frame::new()
        .fill(COL_PANEL_SOFT)
        .stroke(egui::Stroke::new(1.0, COL_LINE))
        .corner_radius(egui::CornerRadius::same(7))
        .inner_margin(egui::Margin::symmetric(10, 8))
        .show(ui, |ui| {
            ui.set_width(292.0);
            ui.horizontal(|ui| {
                ui.label(
                    egui::RichText::new(trim_line(title, 24))
                        .size(12.0)
                        .strong()
                        .color(COL_TEXT),
                );
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.label(
                        egui::RichText::new(format_retry_due(message.next_retry_at_ms))
                            .size(10.0)
                            .color(if message.next_retry_at_ms <= app_now_ms() {
                                COL_OK
                            } else {
                                COL_WARN
                            }),
                    );
                });
            });
            ui.add_space(3.0);
            ui.label(
                egui::RichText::new(trim_line(&display_message_text(&message.plaintext), 42))
                    .size(11.0)
                    .color(COL_MUTED),
            );
            ui.add_space(4.0);
            ui.horizontal(|ui| {
                ui.label(
                    egui::RichText::new(format!("attempts {}", message.attempts))
                        .size(10.0)
                        .color(COL_MUTED),
                );
                ui.add_space(8.0);
                ui.label(
                    egui::RichText::new(format!(
                        "queued {}",
                        format_activity_time(message.created_at_ms)
                    ))
                    .size(10.0)
                    .color(COL_MUTED),
                );
                if message.attempts > 0 {
                    ui.add_space(8.0);
                    ui.label(
                        egui::RichText::new(format!(
                            "last try {}",
                            format_activity_time(message.updated_at_ms)
                        ))
                        .size(10.0)
                        .color(COL_MUTED),
                    );
                }
                if let Some(error) = &message.last_error {
                    ui.add_space(8.0);
                    ui.label(
                        egui::RichText::new(trim_line(error, 28))
                            .size(10.0)
                            .color(COL_WARN),
                    );
                }
            });
        });
}

fn primary_button(ui: &mut egui::Ui, text: &str) -> egui::Response {
    ui.add(primary_button_widget(text))
}

fn primary_button_widget(text: &str) -> egui::Button<'_> {
    egui::Button::new(
        egui::RichText::new(text)
            .strong()
            .color(egui::Color32::WHITE),
    )
    .fill(COL_ACCENT)
    .stroke(egui::Stroke::NONE)
    .corner_radius(egui::CornerRadius::same(9))
}

fn neutral_button(ui: &mut egui::Ui, text: &str) -> egui::Response {
    ui.add(neutral_button_widget(text))
}

fn neutral_button_widget(text: &str) -> egui::Button<'_> {
    egui::Button::new(egui::RichText::new(text).color(COL_TEXT))
        .fill(COL_PANEL_SOFT)
        .stroke(egui::Stroke::new(1.0, COL_LINE))
        .corner_radius(egui::CornerRadius::same(9))
}

fn danger_button(ui: &mut egui::Ui, text: &str) -> egui::Response {
    ui.add(danger_button_widget(text))
}

fn danger_button_widget(text: &str) -> egui::Button<'_> {
    egui::Button::new(egui::RichText::new(text).color(COL_TEXT))
        .fill(egui::Color32::from_rgb(79, 42, 48))
        .stroke(egui::Stroke::new(1.0, egui::Color32::from_rgb(112, 56, 64)))
        .corner_radius(egui::CornerRadius::same(6))
}

fn status_pill(ui: &mut egui::Ui, label: &str, value: &str, color: egui::Color32) {
    egui::Frame::new()
        .fill(COL_PANEL_SOFT)
        .stroke(egui::Stroke::new(1.0, color))
        .corner_radius(egui::CornerRadius::same(10))
        .inner_margin(egui::Margin::symmetric(8, 4))
        .show(ui, |ui| {
            ui.label(
                egui::RichText::new(format!("{label}: {value}"))
                    .size(11.0)
                    .color(COL_TEXT),
            );
        });
}

fn chat_row(
    ui: &mut egui::Ui,
    selected: bool,
    title: &str,
    subtitle: &str,
    status: &str,
    last_activity_ms: i64,
) -> egui::Response {
    ui.horizontal(|ui| {
        ui.add_space(14.0);
        let fill = if selected { COL_ACTIVE } else { COL_SIDE };
        let stroke = if selected {
            egui::Stroke::new(1.0, COL_LINE)
        } else {
            egui::Stroke::new(1.0, egui::Color32::TRANSPARENT)
        };
        let row = egui::Frame::new()
            .fill(fill)
            .stroke(stroke)
            .corner_radius(egui::CornerRadius::same(9))
            .inner_margin(egui::Margin::symmetric(12, 10))
            .show(ui, |ui| {
                ui.set_width(SIDEBAR_WIDTH - 52.0);
                ui.horizontal(|ui| {
                    avatar_box(ui, title, 42.0);
                    ui.add_space(11.0);
                    ui.vertical(|ui| {
                        ui.set_width(232.0);
                        ui.horizontal(|ui| {
                            ui.set_width(232.0);
                            ui.label(
                                egui::RichText::new(title)
                                    .size(14.0)
                                    .strong()
                                    .color(COL_TEXT),
                            );
                            ui.with_layout(
                                egui::Layout::right_to_left(egui::Align::Center),
                                |ui| {
                                    ui.label(
                                        egui::RichText::new(format_activity_time(last_activity_ms))
                                            .size(10.0)
                                            .color(COL_MUTED),
                                    );
                                },
                            );
                        });
                        ui.label(
                            egui::RichText::new(trim_line(subtitle, 36))
                                .size(11.0)
                                .color(COL_MUTED),
                        );
                    });
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.label(
                            egui::RichText::new(clean_status(status))
                                .size(10.0)
                                .color(status_color(status)),
                        );
                    });
                });
            });
        if selected {
            let rect = row.response.rect;
            let strip = egui::Rect::from_min_max(
                rect.left_top(),
                egui::pos2(rect.left() + 4.0, rect.bottom()),
            );
            ui.painter().rect_filled(strip, 4.0, COL_ACCENT);
        }
        row.response
    })
    .inner
}

fn empty_state(ui: &mut egui::Ui, available_height: f32) {
    ui.vertical_centered(|ui| {
        ui.add_space((available_height * 0.26).clamp(70.0, 150.0));
        avatar_box(ui, "M", 54.0);
        ui.add_space(14.0);
        ui.label(
            egui::RichText::new("No messages yet")
                .size(22.0)
                .strong()
                .color(COL_TEXT),
        );
        ui.add_space(8.0);
        ui.label(
            egui::RichText::new("Pick a recipient and send the first encrypted message.")
                .size(13.0)
                .color(COL_MUTED),
        );
    });
}

fn empty_search_state(ui: &mut egui::Ui, available_height: f32) {
    ui.vertical_centered(|ui| {
        ui.add_space((available_height * 0.28).clamp(76.0, 160.0));
        ui.label(
            egui::RichText::new("No matches")
                .size(20.0)
                .strong()
                .color(COL_TEXT),
        );
        ui.add_space(6.0);
        ui.label(
            egui::RichText::new("Try another phrase")
                .size(13.0)
                .color(COL_MUTED),
        );
    });
}

fn message_bubble(
    ui: &mut egui::Ui,
    message: &ChatLine,
    is_pinned: bool,
    voice_playback: Option<&playback::VoicePlayback>,
) -> Option<MessageAction> {
    let payload = message_payload_preview(&message.text)
        .filter(|payload| payload.kind != MessagePayloadKind::Text);
    let text = display_message_text(&message.text);
    let is_deleted = message.status == "deleted" || is_deleted_message_payload(&message.text);
    let reply_preview = message_reply_preview(&message.text);
    let max_width = (ui.available_width() * 0.74).clamp(220.0, 640.0);
    let estimated_width = if matches!(
        payload.as_ref().map(|payload| &payload.kind),
        Some(MessagePayloadKind::Voice)
    ) {
        332.0
    } else {
        (text.chars().count() as f32 * 7.2 + 46.0).clamp(92.0, max_width)
    };
    let bubble_width = if text.chars().count() > 68 {
        max_width
    } else {
        estimated_width
    };
    let fill = if message.incoming {
        COL_BUBBLE_IN
    } else {
        COL_BUBBLE_OUT
    };
    let stroke = if message.incoming {
        COL_LINE
    } else {
        COL_BUBBLE_OUT_BORDER
    };
    let mut action = None;

    ui.horizontal(|ui| {
        if !message.incoming {
            let spacer = (ui.available_width() - bubble_width - 4.0).max(0.0);
            ui.add_space(spacer);
        }
        let response = egui::Frame::new()
            .fill(fill)
            .stroke(egui::Stroke::new(1.0, stroke))
            .corner_radius(egui::CornerRadius::same(12))
            .inner_margin(egui::Margin::symmetric(11, 8))
            .show(ui, |ui| {
                ui.set_width(bubble_width);
                if is_pinned {
                    ui.label(egui::RichText::new("Pinned").size(10.0).strong().color(
                        if message.incoming {
                            COL_ACCENT
                        } else {
                            egui::Color32::from_rgb(202, 230, 247)
                        },
                    ));
                    ui.add_space(4.0);
                }
                if let Some(reply_preview) = &reply_preview {
                    ui.horizontal(|ui| {
                        let (rect, _response) =
                            ui.allocate_exact_size(egui::vec2(3.0, 28.0), egui::Sense::hover());
                        ui.painter().rect_filled(rect, 2.0, COL_ACCENT);
                        ui.add_space(6.0);
                        ui.vertical(|ui| {
                            ui.label(egui::RichText::new("Reply").size(10.0).strong().color(
                                if message.incoming {
                                    COL_ACCENT
                                } else {
                                    egui::Color32::from_rgb(202, 230, 247)
                                },
                            ));
                            ui.label(
                                egui::RichText::new(trim_line(reply_preview, 52))
                                    .size(11.0)
                                    .color(if message.incoming {
                                        COL_MUTED
                                    } else {
                                        COL_BUBBLE_OUT_META
                                    }),
                            );
                        });
                    });
                    ui.add_space(6.0);
                }
                if let Some(voice_payload) = voice_message_payload(&message.text) {
                    if voice_payload_ui(
                        ui,
                        message,
                        &voice_payload,
                        payload.as_ref(),
                        voice_playback,
                    ) {
                        action = Some(MessageAction::PlayVoice {
                            msg_id: message.msg_id.clone(),
                            payload: voice_payload,
                        });
                    }
                } else if let Some(file_payload) = encrypted_file_payload(&message.text) {
                    if encrypted_file_payload_ui(
                        ui,
                        &file_payload,
                        payload.as_ref(),
                        message.incoming,
                    ) {
                        action = Some(MessageAction::SaveFile(file_payload));
                    }
                } else if let Some(payload) = &payload {
                    payload_preview_ui(ui, payload, message.incoming);
                } else {
                    ui.add(
                        egui::Label::new(egui::RichText::new(text).size(14.0).color(
                            if is_deleted {
                                COL_MUTED
                            } else if message.incoming {
                                COL_TEXT
                            } else {
                                egui::Color32::WHITE
                            },
                        ))
                        .wrap()
                        .selectable(true),
                    );
                }
                if let Some(summary) = reaction_summary(&message.reactions) {
                    ui.add_space(6.0);
                    egui::Frame::new()
                        .fill(if message.incoming {
                            COL_PANEL_SOFT
                        } else {
                            egui::Color32::from_rgb(36, 74, 111)
                        })
                        .corner_radius(egui::CornerRadius::same(12))
                        .inner_margin(egui::Margin::symmetric(8, 3))
                        .show(ui, |ui| {
                            ui.label(
                                egui::RichText::new(summary)
                                    .size(11.0)
                                    .strong()
                                    .color(egui::Color32::WHITE),
                            );
                        });
                }
                if !message.status.trim().is_empty() {
                    ui.add_space(3.0);
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.label(egui::RichText::new(message_meta(message)).size(10.0).color(
                            if message.incoming {
                                COL_MUTED
                            } else {
                                COL_BUBBLE_OUT_META
                            },
                        ));
                    });
                }
            })
            .response;
        response.context_menu(|ui| {
            if !is_deleted {
                if ui.button("Reply").clicked() {
                    action = Some(MessageAction::Reply(message.msg_id.clone()));
                    ui.close();
                }
                if !message.incoming && ui.button("Edit").clicked() {
                    action = Some(MessageAction::Edit(message.msg_id.clone()));
                    ui.close();
                }
                if is_pinned {
                    if ui.button("Unpin").clicked() {
                        action = Some(MessageAction::Unpin(message.msg_id.clone()));
                        ui.close();
                    }
                } else if ui.button("Pin").clicked() {
                    action = Some(MessageAction::Pin(message.msg_id.clone()));
                    ui.close();
                }
                ui.separator();
                if ui.button("React +1").clicked() {
                    action = Some(MessageAction::React {
                        msg_id: message.msg_id.clone(),
                        reaction: Some("+1".to_string()),
                    });
                    ui.close();
                }
                if ui.button("React heart").clicked() {
                    action = Some(MessageAction::React {
                        msg_id: message.msg_id.clone(),
                        reaction: Some("heart".to_string()),
                    });
                    ui.close();
                }
                if ui.button("Clear reaction").clicked() {
                    action = Some(MessageAction::React {
                        msg_id: message.msg_id.clone(),
                        reaction: None,
                    });
                    ui.close();
                }
            }
            ui.separator();
            if let Some(voice_payload) = voice_message_payload(&message.text)
                && ui.button("Play voice").clicked()
            {
                action = Some(MessageAction::PlayVoice {
                    msg_id: message.msg_id.clone(),
                    payload: voice_payload,
                });
                ui.close();
            }
            if let Some(voice_payload) = voice_message_payload(&message.text)
                && ui.button("Save voice").clicked()
            {
                action = Some(MessageAction::SaveFile(voice_payload.as_encrypted_file()));
                ui.close();
            }
            if let Some(file_payload) = encrypted_file_payload(&message.text)
                && ui.button("Save file").clicked()
            {
                action = Some(MessageAction::SaveFile(file_payload));
                ui.close();
            }
            if ui.button("Copy").clicked() {
                action = Some(MessageAction::Copy(display_message_text(&message.text)));
                ui.close();
            }
            if ui.button("Delete").clicked() {
                action = Some(MessageAction::Delete(message.msg_id.clone()));
                ui.close();
            }
            if ui.button("Delete local only").clicked() {
                action = Some(MessageAction::DeleteLocal(message.msg_id.clone()));
                ui.close();
            }
        });
    });
    ui.add_space(8.0);
    action
}

fn voice_payload_ui(
    ui: &mut egui::Ui,
    message: &ChatLine,
    voice: &VoiceMessagePayload,
    preview: Option<&MessagePayloadPreview>,
    playback: Option<&playback::VoicePlayback>,
) -> bool {
    let incoming = message.incoming;
    let text_color = if incoming {
        COL_TEXT
    } else {
        egui::Color32::WHITE
    };
    let muted_color = if incoming {
        COL_MUTED
    } else {
        COL_BUBBLE_OUT_META
    };
    let panel_fill = if incoming { COL_PANEL_SOFT } else { COL_ACTIVE };
    let active = playback.is_some_and(|player| player.msg_id() == message.msg_id);
    let paused = playback
        .filter(|player| player.msg_id() == message.msg_id)
        .is_some_and(|player| player.is_paused());
    let progress = playback
        .filter(|player| player.msg_id() == message.msg_id)
        .map(|player| player.progress())
        .unwrap_or(0.0);
    let button_label = if active && !paused {
        "Pause"
    } else if active {
        "Resume"
    } else {
        "Play"
    };
    let title = preview
        .map(|payload| payload.title.as_str())
        .unwrap_or("Voice message");
    let detail = preview
        .map(|payload| payload.detail.clone())
        .unwrap_or_else(|| voice_detail(voice));
    let mut clicked = false;

    ui.horizontal(|ui| {
        clicked = ui
            .add(
                egui::Button::new(
                    egui::RichText::new(button_label)
                        .size(11.0)
                        .strong()
                        .color(egui::Color32::WHITE),
                )
                .fill(if active { COL_OK } else { panel_fill })
                .stroke(egui::Stroke::NONE)
                .corner_radius(egui::CornerRadius::same(14))
                .min_size(egui::vec2(58.0, 30.0)),
            )
            .on_hover_text("Play or pause voice message")
            .clicked();
        ui.add_space(8.0);
        ui.vertical(|ui| {
            ui.horizontal(|ui| {
                waveform_preview(
                    ui,
                    if incoming {
                        COL_ACCENT
                    } else {
                        COL_BUBBLE_OUT_META
                    },
                );
                ui.add_space(8.0);
                ui.vertical(|ui| {
                    ui.label(
                        egui::RichText::new(title)
                            .size(13.0)
                            .strong()
                            .color(text_color),
                    );
                    ui.label(egui::RichText::new(detail).size(10.0).color(muted_color));
                });
            });
            if active {
                ui.add_space(4.0);
                ui.add(
                    egui::ProgressBar::new(progress)
                        .desired_width(198.0)
                        .show_percentage(),
                );
            }
        });
    });

    clicked
}

fn payload_preview_ui(ui: &mut egui::Ui, payload: &MessagePayloadPreview, incoming: bool) {
    let text_color = if incoming {
        COL_TEXT
    } else {
        egui::Color32::WHITE
    };
    let muted_color = if incoming {
        COL_MUTED
    } else {
        COL_BUBBLE_OUT_META
    };

    match payload.kind {
        MessagePayloadKind::Voice => {
            ui.horizontal(|ui| {
                egui::Frame::new()
                    .fill(if incoming { COL_PANEL_SOFT } else { COL_ACTIVE })
                    .corner_radius(egui::CornerRadius::same(18))
                    .inner_margin(egui::Margin::symmetric(10, 7))
                    .show(ui, |ui| {
                        ui.label(
                            egui::RichText::new("Play")
                                .size(12.0)
                                .strong()
                                .color(egui::Color32::WHITE),
                        );
                    });
                ui.add_space(8.0);
                waveform_preview(
                    ui,
                    if incoming {
                        COL_ACCENT
                    } else {
                        COL_BUBBLE_OUT_META
                    },
                );
                ui.add_space(8.0);
                ui.vertical(|ui| {
                    ui.label(
                        egui::RichText::new(&payload.title)
                            .size(13.0)
                            .strong()
                            .color(text_color),
                    );
                    ui.label(
                        egui::RichText::new(&payload.detail)
                            .size(10.0)
                            .color(muted_color),
                    );
                });
            });
        }
        MessagePayloadKind::Text
        | MessagePayloadKind::Attachment
        | MessagePayloadKind::Call
        | MessagePayloadKind::Deleted => {
            ui.vertical(|ui| {
                ui.label(
                    egui::RichText::new(&payload.title)
                        .size(14.0)
                        .strong()
                        .color(text_color),
                );
                if !payload.detail.trim().is_empty() {
                    ui.add_space(3.0);
                    ui.label(
                        egui::RichText::new(&payload.detail)
                            .size(11.0)
                            .color(muted_color),
                    );
                }
            });
        }
    }
}

fn encrypted_file_payload_ui(
    ui: &mut egui::Ui,
    file: &EncryptedFilePayload,
    preview: Option<&MessagePayloadPreview>,
    incoming: bool,
) -> bool {
    let text_color = if incoming {
        COL_TEXT
    } else {
        egui::Color32::WHITE
    };
    let muted_color = if incoming {
        COL_MUTED
    } else {
        COL_BUBBLE_OUT_META
    };
    let panel_fill = if incoming { COL_PANEL_SOFT } else { COL_ACTIVE };
    let title = preview
        .map(|payload| payload.title.as_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(file.name.as_str());
    let detail = attachment_detail_from_file(file, preview);
    let mut save_clicked = false;

    ui.horizontal(|ui| {
        egui::Frame::new()
            .fill(panel_fill)
            .corner_radius(egui::CornerRadius::same(14))
            .inner_margin(egui::Margin::symmetric(10, 8))
            .show(ui, |ui| {
                ui.label(
                    egui::RichText::new(file_kind_label(file))
                        .size(11.0)
                        .strong()
                        .color(egui::Color32::WHITE),
                );
            });
        ui.add_space(8.0);
        ui.vertical(|ui| {
            ui.label(
                egui::RichText::new(trim_line(title, 42))
                    .size(13.0)
                    .strong()
                    .color(text_color),
            );
            ui.add_space(2.0);
            ui.label(egui::RichText::new(detail).size(10.0).color(muted_color));
        });
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            save_clicked = ui
                .add(
                    egui::Button::new(
                        egui::RichText::new("Save")
                            .size(11.0)
                            .strong()
                            .color(egui::Color32::WHITE),
                    )
                    .fill(if incoming {
                        COL_ACCENT
                    } else {
                        egui::Color32::from_rgb(39, 120, 178)
                    })
                    .stroke(egui::Stroke::NONE)
                    .corner_radius(egui::CornerRadius::same(10))
                    .min_size(egui::vec2(54.0, 28.0)),
                )
                .clicked();
        });
    });

    save_clicked
}

fn attachment_detail_from_file(
    file: &EncryptedFilePayload,
    preview: Option<&MessagePayloadPreview>,
) -> String {
    let mut parts = Vec::new();
    if !file.mime_type.trim().is_empty() {
        parts.push(file.mime_type.trim().to_string());
    }
    if file.size > 0 {
        parts.push(format_attachment_size(file.size));
    }
    if parts.is_empty() {
        preview
            .map(|payload| payload.detail.clone())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "encrypted file".to_string())
    } else {
        parts.join(" - ")
    }
}

fn voice_detail(voice: &VoiceMessagePayload) -> String {
    let mut parts = Vec::new();
    if voice.duration_seconds > 0 {
        parts.push(format_mm_ss(voice.duration_seconds));
    }
    if !voice.mime_type.trim().is_empty() {
        parts.push(voice.mime_type.trim().to_string());
    }
    if voice.size > 0 {
        parts.push(format_attachment_size(voice.size));
    }
    if parts.is_empty() {
        "download ready".to_string()
    } else {
        parts.join(" - ")
    }
}

fn file_kind_label(file: &EncryptedFilePayload) -> &'static str {
    let mime = file.mime_type.to_ascii_lowercase();
    if mime.starts_with("image/") {
        "IMG"
    } else if mime.starts_with("video/") {
        "VID"
    } else if mime.starts_with("audio/") {
        "AUD"
    } else {
        "FILE"
    }
}

fn format_mm_ss(seconds: u64) -> String {
    format!("{:02}:{:02}", seconds / 60, seconds % 60)
}

fn format_attachment_size(bytes: u64) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / 1024.0 / 1024.0)
    } else if bytes >= 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{bytes} B")
    }
}

fn waveform_preview(ui: &mut egui::Ui, color: egui::Color32) {
    let (rect, _response) = ui.allocate_exact_size(egui::vec2(96.0, 28.0), egui::Sense::hover());
    let painter = ui.painter();
    let heights = [
        8.0, 16.0, 11.0, 22.0, 14.0, 19.0, 9.0, 24.0, 13.0, 17.0, 10.0, 20.0,
    ];
    for (index, height) in heights.iter().enumerate() {
        let x = rect.left() + 4.0 + index as f32 * 7.4;
        let y1 = rect.center().y - height / 2.0;
        let y2 = rect.center().y + height / 2.0;
        painter.line_segment(
            [egui::pos2(x, y1), egui::pos2(x, y2)],
            egui::Stroke::new(2.4, color),
        );
    }
}

fn message_matches_query(message: &ChatLine, query: &str) -> bool {
    let query = query.trim().to_lowercase();
    query.is_empty()
        || display_message_text(&message.text)
            .to_lowercase()
            .contains(&query)
}

fn build_outgoing_payload(text: &str, reply: Option<&ReplyDraft>) -> String {
    let Some(reply) = reply else {
        return text.to_string();
    };
    serde_json::json!({
        "type": "text",
        "text": text,
        "reply_to": {
            "msg_id": reply.msg_id,
            "text": trim_line(&reply.preview, 180),
        }
    })
    .to_string()
}

fn message_reply_preview(raw: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(raw.trim()).ok()?;
    let reply = value.get("reply_to").or_else(|| value.get("reply"))?;
    reply
        .get("text")
        .and_then(|value| value.as_str())
        .or_else(|| reply.get("preview").and_then(|value| value.as_str()))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn deleted_message_payload() -> &'static str {
    r#"{"type":"deleted","text":"Message deleted"}"#
}

fn reaction_summary(reactions: &BTreeMap<String, String>) -> Option<String> {
    if reactions.is_empty() {
        return None;
    }
    let mut counts = BTreeMap::<String, usize>::new();
    for reaction in reactions.values() {
        *counts
            .entry(reaction_display(reaction).to_string())
            .or_default() += 1;
    }
    Some(
        counts
            .into_iter()
            .map(|(reaction, count)| {
                if count > 1 {
                    format!("{reaction} {count}")
                } else {
                    reaction
                }
            })
            .collect::<Vec<_>>()
            .join("  "),
    )
}

fn reaction_display(reaction: &str) -> &str {
    match reaction {
        "+1" => "+1",
        "heart" => "heart",
        other => other,
    }
}

fn message_meta(message: &ChatLine) -> String {
    let time = format_activity_time(message.created_at_ms);
    if message.incoming {
        return time;
    }
    format!("{time} - {}", clean_status(&message.status))
}

fn format_activity_time(timestamp_ms: i64) -> String {
    if timestamp_ms <= 0 {
        return String::new();
    }
    let elapsed_ms = app_now_ms().saturating_sub(timestamp_ms).max(0);
    let minute_ms = 60_000;
    let hour_ms = 60 * minute_ms;
    let day_ms = 24 * hour_ms;

    if elapsed_ms < minute_ms {
        "now".to_string()
    } else if elapsed_ms < hour_ms {
        format!("{}m", elapsed_ms / minute_ms)
    } else if elapsed_ms < day_ms {
        format!("{}h", elapsed_ms / hour_ms)
    } else {
        format!("{}d", elapsed_ms / day_ms)
    }
}

fn format_retry_due(timestamp_ms: i64) -> String {
    let remaining_ms = timestamp_ms.saturating_sub(app_now_ms());
    if remaining_ms == 0 {
        return "ready".to_string();
    }
    if remaining_ms < 60_000 {
        return format!("retry in {}s", (remaining_ms + 999) / 1000);
    }
    format!("retry in {}m", (remaining_ms + 59_999) / 60_000)
}

fn app_now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

fn first_non_empty(values: &[&str]) -> String {
    values
        .iter()
        .map(|value| value.trim())
        .find(|value| !value.is_empty())
        .unwrap_or_default()
        .to_string()
}

fn looks_like_username_query(value: &str) -> bool {
    let value = value.trim();
    if value.is_empty() {
        return false;
    }
    if value.starts_with('@') {
        return is_valid_username(value.trim_start_matches('@'));
    }
    !value.ends_with('=')
        && value.len() <= 32
        && !value
            .chars()
            .any(|character| matches!(character, ' ' | '+' | '/' | '\\'))
        && is_valid_username(value)
}

fn sanitize_backend_origin(value: &str) -> String {
    transport::normalize_origin(value).unwrap_or_else(|| config::DEFAULT_BACKEND_ORIGIN.to_string())
}

fn fallback_origins_to_text(origins: &[String]) -> String {
    origins.join("\n")
}

fn is_valid_theme(value: &str) -> bool {
    matches!(value, "telegram" | "graphite" | "midnight")
}

fn is_valid_density(value: &str) -> bool {
    matches!(value, "compact" | "comfortable")
}

fn profile_error_text(error: profile::ProfileValidationError) -> &'static str {
    match error {
        profile::ProfileValidationError::NicknameTooLong => "Nickname is too long",
        profile::ProfileValidationError::UsernameTooShort => {
            "Username must be at least 5 characters"
        }
        profile::ProfileValidationError::UsernameTooLong => "Username is too long",
        profile::ProfileValidationError::UsernameInvalidCharacter => {
            "Username can only contain letters, numbers, and underscores"
        }
        profile::ProfileValidationError::AvatarTooLarge => "Avatar data is too large",
    }
}

fn normalize_seed_phrase(value: &str) -> String {
    value
        .split_whitespace()
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>()
        .join(" ")
}

fn call_media_label(media: call::CallMediaKind) -> &'static str {
    match media {
        call::CallMediaKind::Audio => "voice",
        call::CallMediaKind::Video => "video",
        call::CallMediaKind::Screen => "screen share",
    }
}

fn call_state_label(state: call::CallState) -> &'static str {
    match state {
        call::CallState::Idle => "idle",
        call::CallState::Incoming => "incoming",
        call::CallState::Outgoing => "outgoing",
        call::CallState::Connecting => "connecting",
        call::CallState::Active => "active",
        call::CallState::Busy => "busy",
        call::CallState::Declined => "declined",
        call::CallState::Missed => "missed",
        call::CallState::Timeout => "timeout",
        call::CallState::Failed => "failed",
        call::CallState::Disconnected => "disconnected",
        call::CallState::Ended => "ended",
    }
}

fn is_valid_username(value: &str) -> bool {
    profile::sanitize_username(Some(value)).is_ok_and(|username| username.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_message_text_unwraps_web_payload() {
        assert_eq!(display_message_text(r#"{"type":"text","text":"ky"}"#), "ky");
    }

    #[test]
    fn display_message_text_keeps_plain_text() {
        assert_eq!(display_message_text("hello"), "hello");
    }

    #[test]
    fn display_message_text_summarizes_voice_payload() {
        assert_eq!(
            display_message_text(
                r#"{"type":"voice","url":"https://messk.online/download/a.webm","duration":62}"#
            ),
            "Voice message - 01:02 - download ready"
        );
    }

    #[test]
    fn display_message_text_summarizes_attachment_payload() {
        assert_eq!(
            display_message_text(
                r#"{"type":"file","filename":"photo.png","mime":"image/png","size":2048}"#
            ),
            "photo.png - image/png - 2.0 KB"
        );
    }

    #[test]
    fn display_message_text_summarizes_call_payload() {
        assert_eq!(
            display_message_text(r#"{"type":"video_call","status":"missed"}"#),
            "Video call - Missed"
        );
    }

    #[test]
    fn message_search_matches_unwrapped_payload_case_insensitively() {
        let message = ChatLine {
            peer_public_key: "peer".to_string(),
            msg_id: "1".to_string(),
            text: r#"{"type":"text","text":"Secret Phrase"}"#.to_string(),
            incoming: true,
            status: "delivered".to_string(),
            created_at_ms: 0,
            reactions: BTreeMap::new(),
        };

        assert!(message_matches_query(&message, "secret"));
        assert!(message_matches_query(&message, " PHRASE "));
        assert!(!message_matches_query(&message, "missing"));
    }

    #[test]
    fn reply_payload_keeps_plain_text_displayable() {
        let payload = build_outgoing_payload(
            "answer",
            Some(&ReplyDraft {
                msg_id: "m1".to_string(),
                preview: "original question".to_string(),
            }),
        );

        assert_eq!(display_message_text(&payload), "answer");
        assert_eq!(
            message_reply_preview(&payload).as_deref(),
            Some("original question")
        );
    }

    #[test]
    fn username_lookup_detection_prefers_handles_over_keys() {
        assert!(looks_like_username_query("@alice_01"));
        assert!(looks_like_username_query("alice_01"));
        assert!(!looks_like_username_query("abcd+efgh/ijkl="));
        assert!(!looks_like_username_query("abc"));
    }

    #[test]
    fn seed_confirmation_normalizes_spacing_and_case() {
        assert_eq!(
            normalize_seed_phrase("  Alpha   BRAVO\ncharlie  "),
            "alpha bravo charlie"
        );
    }
}
