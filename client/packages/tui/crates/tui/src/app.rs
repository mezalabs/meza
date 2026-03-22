use std::collections::{HashMap, VecDeque};

use crate::action::Action;

// ── Sub-state structs ──────────────────────────────────────────────

#[derive(Debug, Default)]
pub struct AuthState {
    pub user_id: Option<String>,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub is_authenticated: bool,
}

#[derive(Debug, Default)]
pub struct ServerState {
    pub servers: Vec<String>,
    pub active_server_idx: Option<usize>,
}

#[derive(Debug, Default)]
pub struct ChannelState {
    pub channels: Vec<String>,
    pub active_channel_idx: Option<usize>,
    pub unread: HashMap<String, u32>,
}

#[derive(Debug, Default)]
pub struct MessageState {
    pub active_buffer: VecDeque<ChatMessage>,
    pub inactive_buffers: HashMap<String, VecDeque<ChatMessage>>,
}

#[derive(Debug, Default)]
pub struct GatewayState {
    pub connected: bool,
    pub session_id: Option<String>,
    pub last_sequence: Option<u64>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum InputMode {
    #[default]
    Normal,
    Insert,
}

#[derive(Debug, Default)]
pub struct UiState {
    pub input_mode: InputMode,
    pub needs_redraw: bool,
}

// ── ChatMessage ────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ChatMessage {
    pub id: String,
    pub channel_id: String,
    pub author_name: String,
    pub content: String,
    pub timestamp: String,
    pub edited: bool,
    pub key_version: u32,
    pub decryption_ok: bool,
    pub signature_ok: bool,
}

// ── App ────────────────────────────────────────────────────────────

#[derive(Debug, Default)]
pub struct App {
    pub should_quit: bool,
    pub auth: AuthState,
    pub servers: ServerState,
    pub channels: ChannelState,
    pub messages: MessageState,
    pub gateway: GatewayState,
    pub ui: UiState,
}

impl App {
    pub fn new() -> Self {
        Self {
            ui: UiState {
                needs_redraw: true,
                ..Default::default()
            },
            ..Default::default()
        }
    }

    /// Elm-style update: apply an action to the state.
    pub fn update(&mut self, action: Action) {
        match action {
            Action::Quit => {
                self.should_quit = true;
            }

            Action::SwitchChannel(name) => {
                if let Some(idx) = self.channels.channels.iter().position(|c| c == &name) {
                    self.channels.active_channel_idx = Some(idx);
                    self.ui.needs_redraw = true;
                }
            }

            Action::SwitchServer(name) => {
                if let Some(idx) = self.servers.servers.iter().position(|s| s == &name) {
                    self.servers.active_server_idx = Some(idx);
                    self.ui.needs_redraw = true;
                }
            }

            Action::SendMessage(_msg) => {
                // Will be wired up when networking is implemented.
            }

            Action::ScrollUp
            | Action::ScrollDown
            | Action::ScrollHalfUp
            | Action::ScrollHalfDown
            | Action::ScrollTop
            | Action::ScrollBottom => {
                // Scroll handling will be implemented with the message list component.
                self.ui.needs_redraw = true;
            }

            Action::FocusInput => {
                self.ui.input_mode = InputMode::Insert;
                self.ui.needs_redraw = true;
            }

            Action::UnfocusInput => {
                self.ui.input_mode = InputMode::Normal;
                self.ui.needs_redraw = true;
            }

            Action::Login { .. } => {
                // Handled async in main.rs — this just marks the UI as loading.
                self.ui.needs_redraw = true;
            }

            Action::LoginSuccess {
                user_id,
                access_token,
                refresh_token,
            } => {
                self.auth.user_id = Some(user_id);
                self.auth.access_token = Some(access_token);
                self.auth.refresh_token = Some(refresh_token);
                self.auth.is_authenticated = true;
                self.ui.needs_redraw = true;
                tracing::info!("login successful, user_id={}", self.auth.user_id.as_deref().unwrap_or("?"));
            }

            Action::LoginFailed(msg) => {
                self.auth.is_authenticated = false;
                tracing::warn!("login failed: {msg}");
                self.ui.needs_redraw = true;
            }

            Action::Tick => {
                // Periodic housekeeping can go here.
            }

            Action::Render => {
                self.ui.needs_redraw = true;
            }

            Action::Resize(_, _) => {
                self.ui.needs_redraw = true;
            }

            Action::NetworkEvent(_data) => {
                // Will be wired up when gateway is implemented.
            }

            Action::Error(msg) => {
                tracing::error!("action error: {msg}");
            }

            Action::None => {}
        }
    }
}
