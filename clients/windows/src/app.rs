use crate::{config, crypto, net, storage, vault};
use eframe::egui;
use std::collections::{HashMap, HashSet};
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
    DirectErr { msg_id: String, error: String },
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
}

#[derive(Debug, Clone)]
struct ContactAlias {
    display_name: String,
    updated_at_ms: i64,
}

#[derive(Debug, Clone)]
struct ReplyDraft {
    msg_id: String,
    preview: String,
}

pub struct MesskApp {
    runtime: tokio::runtime::Runtime,
    tx: mpsc::Sender<UiEvent>,
    rx: mpsc::Receiver<UiEvent>,
    backend_origin: String,
    identity: Option<crypto::Identity>,
    store: Option<storage::LocalStore>,
    seed_input: String,
    health_status: String,
    realtime_status: String,
    active_workspace: usize,
    active_filter: usize,
    chat_search: String,
    show_message_search: bool,
    message_search: String,
    selected_chat: usize,
    recipient_public_key: String,
    composer_text: String,
    reply_draft: Option<ReplyDraft>,
    show_new_chat: bool,
    new_chat_public_key: String,
    new_chat_name: String,
    show_contact_profile: bool,
    profile_public_key: String,
    profile_display_name: String,
    messages: Vec<ChatLine>,
    contacts: HashMap<String, ContactAlias>,
    pinned_message_ids: HashSet<String>,
    outbox_count: usize,
    realtime_tasks: Vec<JoinHandle<()>>,
    logs: Vec<String>,
}

impl MesskApp {
    pub fn new(_creation_context: &eframe::CreationContext<'_>) -> Self {
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
        let mut app = Self {
            runtime,
            tx,
            rx,
            backend_origin: config::DEFAULT_BACKEND_ORIGIN.to_string(),
            identity: None,
            store,
            seed_input: String::new(),
            health_status: "not checked".to_string(),
            realtime_status: "offline".to_string(),
            active_workspace: 0,
            active_filter: 0,
            chat_search: String::new(),
            show_message_search: false,
            message_search: String::new(),
            selected_chat: 0,
            recipient_public_key: String::new(),
            composer_text: String::new(),
            reply_draft: None,
            show_new_chat: false,
            new_chat_public_key: String::new(),
            new_chat_name: String::new(),
            show_contact_profile: false,
            profile_public_key: String::new(),
            profile_display_name: String::new(),
            messages: Vec::new(),
            contacts: HashMap::new(),
            pinned_message_ids: HashSet::new(),
            outbox_count: 0,
            realtime_tasks: Vec::new(),
            logs: vec!["Messk native client booted.".to_string(), store_log],
        };
        app.try_load_stored_identity();
        app
    }

    fn drain_events(&mut self) {
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
                UiEvent::OutboxFlushed => {
                    self.refresh_account_stats();
                    self.logs.push("manual outbox retry finished".to_string());
                }
            }
        }
    }

    fn check_health(&mut self) {
        self.health_status = "checking".to_string();
        let origin = self.backend_origin.clone();
        let tx = self.tx.clone();
        self.runtime.spawn(async move {
            let event = match net::fetch_health(origin).await {
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
        let origin = self.backend_origin.clone();
        let tx = self.tx.clone();
        let (net_tx, mut net_rx) = tokio::sync::mpsc::unbounded_channel();
        let bridge_tx = tx.clone();
        let bridge_handle = self.runtime.spawn(async move {
            while let Some(event) = net_rx.recv().await {
                let _ = bridge_tx.send(UiEvent::RealtimeEvent(event));
            }
        });
        let realtime_handle = self.runtime.spawn(async move {
            if let Err(error) = net::run_realtime(origin, identity, store, net_tx).await {
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
        let origin = self.backend_origin.clone();
        let tx_events = self.tx.clone();
        let tx_done = self.tx.clone();
        let (net_tx, mut net_rx) = tokio::sync::mpsc::unbounded_channel();
        self.runtime.spawn(async move {
            while let Some(event) = net_rx.recv().await {
                let _ = tx_events.send(UiEvent::RealtimeEvent(event));
            }
        });
        self.runtime.spawn(async move {
            net::flush_outbox_once(origin, identity, store, net_tx).await;
            let _ = tx_done.send(UiEvent::OutboxFlushed);
        });
    }

    fn generate_identity(&mut self) {
        match crypto::generate_identity() {
            Ok(identity) => {
                self.seed_input = identity.seed_phrase.expose().to_string();
                self.logs.push("new identity generated locally".to_string());
                self.persist_identity(&identity);
                self.load_messages_for_identity(&identity.public_key);
                self.load_contacts_for_identity(&identity.public_key);
                self.identity = Some(identity);
                self.refresh_account_stats();
            }
            Err(error) => self.logs.push(format!("identity error: {error}")),
        }
    }

    fn import_identity(&mut self) {
        match crypto::identity_from_seed_phrase(&self.seed_input) {
            Ok(identity) => {
                self.logs
                    .push("identity imported from seed phrase".to_string());
                self.persist_identity(&identity);
                self.load_messages_for_identity(&identity.public_key);
                self.load_contacts_for_identity(&identity.public_key);
                self.identity = Some(identity);
                self.refresh_account_stats();
            }
            Err(error) => self.logs.push(format!("seed import error: {error}")),
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
        });
        self.composer_text.clear();
        self.reply_draft = None;
        let origin = self.backend_origin.clone();
        let tx = self.tx.clone();
        self.runtime.spawn(async move {
            let event_msg_id = msg_id.clone();
            let event = match net::send_direct_message_once(
                origin,
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

    fn handle_realtime_event(&mut self, event: net::RealtimeEvent) {
        match event {
            net::RealtimeEvent::Authenticated(session) => {
                self.realtime_status = "listening".to_string();
                self.logs.push(format!(
                    "ws listening: token {}...",
                    session.session_token.chars().take(8).collect::<String>()
                ));
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
            } => {
                self.logs.push(format!(
                    "incoming direct {} from {}",
                    msg_id,
                    short_key(&sender_public_key)
                ));
                self.upsert_chat_line(ChatLine {
                    peer_public_key,
                    msg_id,
                    text: plaintext,
                    incoming: true,
                    status: "delivered".to_string(),
                    created_at_ms: app_now_ms(),
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
            net::RealtimeEvent::DirectDecryptFailed {
                msg_id,
                sender_public_key,
            } => self.logs.push(format!(
                "decrypt failed {} from {}",
                msg_id,
                short_key(&sender_public_key)
            )),
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
                    })
                    .collect();
                self.messages.sort_by_key(|message| message.created_at_ms);
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
                self.load_messages_for_identity(&identity.public_key);
                self.load_contacts_for_identity(&identity.public_key);
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
        self.seed_input.clear();
        self.messages.clear();
        self.contacts.clear();
        self.pinned_message_ids.clear();
        self.reply_draft = None;
        self.new_chat_name.clear();
        self.new_chat_public_key.clear();
        self.message_search.clear();
        self.show_message_search = false;
        self.show_new_chat = false;
        self.show_contact_profile = false;
        self.profile_public_key.clear();
        self.profile_display_name.clear();
        self.outbox_count = 0;
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
        self.seed_input.clear();
        self.messages.clear();
        self.contacts.clear();
        self.pinned_message_ids.clear();
        self.reply_draft = None;
        self.new_chat_name.clear();
        self.new_chat_public_key.clear();
        self.message_search.clear();
        self.show_message_search = false;
        self.show_new_chat = false;
        self.show_contact_profile = false;
        self.profile_public_key.clear();
        self.profile_display_name.clear();
        self.outbox_count = 0;
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
            return;
        };
        self.outbox_count = store.outbox_count(&identity.public_key).unwrap_or_default();
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
        self.composer_text.clear();
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
        self.refresh_account_stats();
        self.logs.push("message deleted locally".to_string());
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
    }

    fn handle_message_action(&mut self, ctx: &egui::Context, action: MessageAction) {
        match action {
            MessageAction::Reply(msg_id) => self.start_reply_to_message(&msg_id),
            MessageAction::Pin(msg_id) => self.pin_message(&msg_id),
            MessageAction::Unpin(msg_id) => self.unpin_message(&msg_id),
            MessageAction::Copy(text) => {
                ctx.copy_text(text);
                self.logs.push("message copied".to_string());
            }
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
        self.drain_events();
        ui.ctx()
            .request_repaint_after(std::time::Duration::from_millis(250));
        apply_visuals(ui.ctx());
        ui.ctx()
            .send_viewport_cmd(egui::ViewportCommand::Title(config::APP_NAME.to_string()));

        egui::CentralPanel::default()
            .frame(egui::Frame::new().fill(COL_BG))
            .show_inside(ui, |ui| {
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
                        |ui| self.chat_panel(ui),
                    );
                });
            });
        self.new_chat_window(ui.ctx());
        self.contact_profile_window(ui.ctx());
    }
}

impl MesskApp {
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
                    egui::RichText::new("Name is local only. Public key is used for E2EE routing.")
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
                    egui::RichText::new("Public key")
                        .size(12.0)
                        .color(COL_MUTED),
                );
                ui.add_sized(
                    [420.0, 36.0],
                    egui::TextEdit::singleline(&mut self.new_chat_public_key)
                        .hint_text("Base64 public key"),
                );
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
            let peer = self.new_chat_public_key.trim().to_string();
            if peer.is_empty() {
                self.logs.push("new chat public key is empty".to_string());
            } else {
                let name = self.new_chat_name.trim().to_string();
                self.save_contact_alias(&peer, &name);
                self.recipient_public_key = peer;
                self.selected_chat = 0;
                self.composer_text.clear();
                self.reply_draft = None;
                self.chat_search.clear();
                self.message_search.clear();
                self.show_message_search = false;
                self.new_chat_public_key.clear();
                self.new_chat_name.clear();
                self.active_workspace = 0;
                self.active_filter = 0;
                self.logs.push("new direct chat opened".to_string());
                open = false;
            }
        }

        self.show_new_chat = open;
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
                            connection_chip(ui, &self.realtime_status);
                        });
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if icon_button(ui, "Exit").clicked() {
                                self.forget_local_identity();
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
                                    .add_sized([100.0, 32.0], primary_button_widget("Generate"))
                                    .clicked()
                                {
                                    self.generate_identity();
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
                                if neutral_button(ui, "Import seed").clicked() {
                                    self.import_identity();
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
                        workspace_tab(ui, self.active_workspace == 0, "Chats")
                            .clicked()
                            .then(|| self.active_workspace = 0);
                        workspace_tab(ui, self.active_workspace == 1, "Groups")
                            .clicked()
                            .then(|| self.active_workspace = 1);
                        workspace_tab(ui, self.active_workspace == 2, "Channels")
                            .clicked()
                            .then(|| self.active_workspace = 2);
                    });
                });

            ui.add_space(12.0);
            egui::Frame::new()
                .fill(COL_SIDE)
                .inner_margin(egui::Margin::symmetric(24, 0))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.add_sized(
                            [292.0, 38.0],
                            egui::TextEdit::singleline(&mut self.chat_search)
                                .hint_text("Search chats, keys and drafts..."),
                        );
                        ui.add_space(8.0);
                        if ui
                            .add_sized([38.0, 38.0], primary_button_widget("+"))
                            .clicked()
                        {
                            self.new_chat_public_key = self.chat_search.trim().to_string();
                            self.new_chat_name.clear();
                            self.show_new_chat = true;
                        }
                    });
                    ui.add_space(12.0);
                    ui.horizontal(|ui| {
                        filter_chip(ui, self.active_filter == 0, "Inbox")
                            .clicked()
                            .then(|| self.active_filter = 0);
                        filter_chip(ui, self.active_filter == 1, "Unread")
                            .clicked()
                            .then(|| self.active_filter = 1);
                        filter_chip(ui, self.active_filter == 2, "Archived")
                            .clicked()
                            .then(|| self.active_filter = 2);
                    });
                });

            ui.add_space(12.0);
            let summaries = self.filtered_chat_summaries();
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
                            if self.active_workspace != 0 {
                                empty_sidebar_section(
                                    ui,
                                    if self.active_workspace == 1 {
                                        "Groups"
                                    } else {
                                        "Channels"
                                    },
                                    "This native build is focused on direct chats first.",
                                );
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
                    ui.columns(3, |columns| {
                        metric_box(&mut columns[0], summaries.len().to_string(), "Chats");
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

            const HEADER_HEIGHT: f32 = 78.0;
            const RECIPIENT_HEIGHT: f32 = 48.0;
            const SEARCH_HEIGHT: f32 = 46.0;
            const PINNED_HEIGHT: f32 = 44.0;
            const DELIVERY_NOTICE_HEIGHT: f32 = 42.0;
            const COMPOSER_HEIGHT: f32 = 68.0;
            const REPLY_HEIGHT: f32 = 48.0;
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
            let composer_height = COMPOSER_HEIGHT
                + if self.reply_draft.is_some() {
                    REPLY_HEIGHT
                } else {
                    0.0
                };
            let message_height = (height
                - HEADER_HEIGHT
                - recipient_height
                - search_height
                - pinned_height
                - notice_height
                - composer_height)
                .max(260.0);

            ui.allocate_ui_with_layout(
                egui::vec2(width, HEADER_HEIGHT),
                egui::Layout::top_down(egui::Align::Min),
                |ui| {
                    egui::Frame::new()
                        .fill(COL_TOP)
                        .inner_margin(egui::Margin::symmetric(20, 14))
                        .show(ui, |ui| {
                            ui.set_width((width - 40.0).max(480.0));
                            let title = self.active_chat_title();
                            let subtitle = self.active_chat_subtitle();
                            ui.horizontal(|ui| {
                                avatar_box(ui, title.as_str(), 44.0);
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
                        .inner_margin(egui::Margin::symmetric(26, 0))
                        .show(ui, |ui| {
                            ui.set_width((width - 52.0).max(468.0));
                            ui.set_min_height(message_height);
                            egui::ScrollArea::vertical()
                                .id_salt("message-list")
                                .max_height(message_height)
                                .stick_to_bottom(true)
                                .show(ui, |ui| {
                                    ui.add_space(22.0);
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
                                        if let Some(action) = message_bubble(ui, message, is_pinned)
                                        {
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
                        .inner_margin(egui::Margin::symmetric(24, 12))
                        .show(ui, |ui| {
                            ui.set_width((width - 48.0).max(480.0));
                            if let Some(reply) = &self.reply_draft {
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
                            let composer_width = (ui.available_width() - 108.0).max(220.0);
                            ui.horizontal(|ui| {
                                let _ = icon_button(ui, "Clip");
                                let composer_response = ui.add_sized(
                                    [composer_width, 42.0],
                                    egui::TextEdit::singleline(&mut self.composer_text)
                                        .hint_text("Message..."),
                                );
                                ui.add_space(8.0);
                                let enter_send = composer_response.has_focus()
                                    && ui.input(|input| input.key_pressed(egui::Key::Enter));
                                let send_clicked = ui
                                    .add_sized([56.0, 42.0], primary_button_widget("Send"))
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
    Pin(String),
    Unpin(String),
    Copy(String),
    DeleteLocal(String),
}

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
const COL_ACCENT: egui::Color32 = egui::Color32::from_rgb(42, 171, 238);
const COL_DANGER: egui::Color32 = egui::Color32::from_rgb(224, 92, 92);
const COL_WARN: egui::Color32 = egui::Color32::from_rgb(221, 166, 77);
const COL_OK: egui::Color32 = egui::Color32::from_rgb(83, 184, 128);
const COL_TEXT: egui::Color32 = egui::Color32::from_rgb(231, 237, 243);
const COL_MUTED: egui::Color32 = egui::Color32::from_rgb(143, 161, 179);
const COL_LINE: egui::Color32 = egui::Color32::from_rgb(38, 50, 65);
const COL_LINE_STRONG: egui::Color32 = egui::Color32::from_rgb(49, 65, 83);
const SIDEBAR_WIDTH: f32 = 390.0;

fn apply_visuals(ctx: &egui::Context) {
    let mut visuals = egui::Visuals::dark();
    visuals.override_text_color = Some(COL_TEXT);
    visuals.panel_fill = COL_BG;
    visuals.extreme_bg_color = COL_INPUT;
    visuals.faint_bg_color = COL_PANEL_SOFT;
    visuals.widgets.noninteractive.bg_fill = COL_PANEL;
    visuals.widgets.noninteractive.corner_radius = egui::CornerRadius::same(8);
    visuals.widgets.inactive.bg_fill = COL_INPUT;
    visuals.widgets.inactive.bg_stroke = egui::Stroke::new(1.0, COL_LINE);
    visuals.widgets.inactive.corner_radius = egui::CornerRadius::same(6);
    visuals.widgets.hovered.bg_fill = COL_PANEL_HOVER;
    visuals.widgets.hovered.bg_stroke = egui::Stroke::new(1.0, COL_LINE_STRONG);
    visuals.widgets.hovered.corner_radius = egui::CornerRadius::same(6);
    visuals.widgets.active.bg_fill = COL_ACCENT;
    visuals.widgets.active.corner_radius = egui::CornerRadius::same(6);
    visuals.selection.bg_fill = COL_ACCENT;
    ctx.set_visuals(visuals);

    ctx.global_style_mut(|style| {
        style.spacing.item_spacing = egui::vec2(8.0, 6.0);
        style.spacing.button_padding = egui::vec2(12.0, 8.0);
        style.spacing.interact_size = egui::vec2(40.0, 34.0);
        style
            .text_styles
            .insert(egui::TextStyle::Heading, egui::FontId::proportional(22.0));
        style
            .text_styles
            .insert(egui::TextStyle::Body, egui::FontId::proportional(14.0));
        style
            .text_styles
            .insert(egui::TextStyle::Button, egui::FontId::proportional(13.0));
        style
            .text_styles
            .insert(egui::TextStyle::Small, egui::FontId::proportional(11.0));
    });
}

fn status_color(status: &str) -> egui::Color32 {
    match status {
        "ok" | "ready" | "listening" | "sent" | "delivered" | "read" => COL_OK,
        "checking" | "connecting" | "pending" | "waiting" | "waiting_retry" | "waiting retry" => {
            COL_WARN
        }
        "error" | "offline" | "failed" => COL_DANGER,
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

fn empty_sidebar_section(ui: &mut egui::Ui, title: &str, body: &str) {
    ui.horizontal(|ui| {
        ui.add_space(16.0);
        egui::Frame::new()
            .fill(COL_PANEL)
            .stroke(egui::Stroke::new(1.0, COL_LINE))
            .corner_radius(egui::CornerRadius::same(8))
            .inner_margin(egui::Margin::symmetric(16, 18))
            .show(ui, |ui| {
                ui.set_width(320.0);
                ui.label(
                    egui::RichText::new(title)
                        .size(15.0)
                        .strong()
                        .color(COL_TEXT),
                );
                ui.add_space(6.0);
                ui.label(egui::RichText::new(body).size(12.0).color(COL_MUTED));
            });
    });
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
    .corner_radius(egui::CornerRadius::same(6))
}

fn neutral_button(ui: &mut egui::Ui, text: &str) -> egui::Response {
    ui.add(neutral_button_widget(text))
}

fn neutral_button_widget(text: &str) -> egui::Button<'_> {
    egui::Button::new(egui::RichText::new(text).color(COL_TEXT))
        .fill(COL_PANEL_SOFT)
        .stroke(egui::Stroke::new(1.0, COL_LINE))
        .corner_radius(egui::CornerRadius::same(6))
}

fn danger_button(ui: &mut egui::Ui, text: &str) -> egui::Response {
    ui.add(
        egui::Button::new(egui::RichText::new(text).color(COL_TEXT))
            .fill(egui::Color32::from_rgb(79, 42, 48))
            .stroke(egui::Stroke::new(1.0, egui::Color32::from_rgb(112, 56, 64)))
            .corner_radius(egui::CornerRadius::same(6)),
    )
}

fn status_pill(ui: &mut egui::Ui, label: &str, value: &str, color: egui::Color32) {
    egui::Frame::new()
        .fill(COL_PANEL_SOFT)
        .stroke(egui::Stroke::new(1.0, color))
        .corner_radius(egui::CornerRadius::same(6))
        .inner_margin(egui::Margin::symmetric(8, 5))
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
        ui.add_space(16.0);
        let fill = if selected { COL_ACTIVE } else { COL_SIDE };
        let stroke = if selected {
            egui::Stroke::new(1.0, COL_LINE_STRONG)
        } else {
            egui::Stroke::new(1.0, egui::Color32::TRANSPARENT)
        };
        let row = egui::Frame::new()
            .fill(fill)
            .stroke(stroke)
            .corner_radius(egui::CornerRadius::same(8))
            .inner_margin(egui::Margin::symmetric(12, 12))
            .show(ui, |ui| {
                ui.set_width(332.0);
                ui.horizontal(|ui| {
                    avatar_box(ui, title, 44.0);
                    ui.add_space(10.0);
                    ui.vertical(|ui| {
                        ui.set_width(250.0);
                        ui.horizontal(|ui| {
                            ui.set_width(250.0);
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
                            egui::RichText::new(trim_line(subtitle, 30))
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
                egui::pos2(rect.left() + 3.0, rect.bottom()),
            );
            ui.painter().rect_filled(strip, 3.0, COL_ACCENT);
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

fn message_bubble(ui: &mut egui::Ui, message: &ChatLine, is_pinned: bool) -> Option<MessageAction> {
    let text = display_message_text(&message.text);
    let reply_preview = message_reply_preview(&message.text);
    let max_width = (ui.available_width() * 0.58).clamp(180.0, 560.0);
    let estimated_width = (text.chars().count() as f32 * 7.4 + 42.0).clamp(76.0, max_width);
    let bubble_width = if text.chars().count() > 54 {
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
        egui::Color32::from_rgb(58, 101, 142)
    };
    let mut action = None;

    ui.horizontal(|ui| {
        if !message.incoming {
            let spacer = (ui.available_width() - bubble_width - 10.0).max(0.0);
            ui.add_space(spacer);
        }
        let response = egui::Frame::new()
            .fill(fill)
            .stroke(egui::Stroke::new(1.0, stroke))
            .corner_radius(egui::CornerRadius::same(10))
            .inner_margin(egui::Margin::symmetric(12, 8))
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
                                        egui::Color32::from_rgb(198, 221, 238)
                                    }),
                            );
                        });
                    });
                    ui.add_space(6.0);
                }
                ui.add(
                    egui::Label::new(
                        egui::RichText::new(text)
                            .size(14.0)
                            .color(egui::Color32::WHITE),
                    )
                    .wrap()
                    .selectable(true),
                );
                if !message.status.trim().is_empty() {
                    ui.add_space(3.0);
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.label(egui::RichText::new(message_meta(message)).size(10.0).color(
                            if message.incoming {
                                COL_MUTED
                            } else {
                                egui::Color32::from_rgb(198, 221, 238)
                            },
                        ));
                    });
                }
            })
            .response;
        response.context_menu(|ui| {
            if ui.button("Reply").clicked() {
                action = Some(MessageAction::Reply(message.msg_id.clone()));
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
            if ui.button("Copy").clicked() {
                action = Some(MessageAction::Copy(display_message_text(&message.text)));
                ui.close();
            }
            if ui.button("Delete local").clicked() {
                action = Some(MessageAction::DeleteLocal(message.msg_id.clone()));
                ui.close();
            }
        });
    });
    ui.add_space(8.0);
    action
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

fn display_message_text(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if let Some(text) = value.get("text").and_then(|value| value.as_str()) {
            return text.to_string();
        }
        if let Some(text) = value.get("message").and_then(|value| value.as_str()) {
            return text.to_string();
        }
        if let Some(text) = value.get("body").and_then(|value| value.as_str()) {
            return text.to_string();
        }
        if let Some(text) = value.as_str() {
            return text.to_string();
        }
    }

    trimmed.to_string()
}

fn clean_status(status: &str) -> &str {
    match status {
        "waiting_retry" => "retrying",
        "waiting retry" => "retrying",
        "pending" => "sending",
        "sent" => "sent",
        "delivered" => "delivered",
        "read" => "read",
        other => other,
    }
}

fn message_meta(message: &ChatLine) -> String {
    let time = format_activity_time(message.created_at_ms);
    if message.incoming {
        return time;
    }
    format!("{time} · {}", clean_status(&message.status))
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

fn app_now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

fn trim_line(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut output: String = value.chars().take(max_chars.saturating_sub(3)).collect();
    output.push_str("...");
    output
}

fn short_key(value: &str) -> String {
    if value.len() <= 18 {
        return value.to_string();
    }
    format!("{}...{}", &value[..10], &value[value.len() - 6..])
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
    fn message_search_matches_unwrapped_payload_case_insensitively() {
        let message = ChatLine {
            peer_public_key: "peer".to_string(),
            msg_id: "1".to_string(),
            text: r#"{"type":"text","text":"Secret Phrase"}"#.to_string(),
            incoming: true,
            status: "delivered".to_string(),
            created_at_ms: 0,
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
}
