use anyhow::Result;
use crossterm::event::{KeyCode, KeyModifiers};
use ratatui::{
    layout::{Constraint, Layout},
    Frame,
};
use tokio::sync::mpsc;

mod action;
mod app;
mod components;
mod config;
mod event;
mod terminal;

use action::Action;
use app::App;
use components::input_box::InputBox;
use components::login::LoginView;
use event::{Event, EventHandler};

/// Holds the mutable UI component state that lives alongside the App.
struct UiComponents {
    input_box: InputBox,
    login_view: LoginView,
    scroll_offset: usize,
}

impl UiComponents {
    fn new(server_url: &str) -> Self {
        Self {
            input_box: InputBox::new(),
            login_view: LoginView::new(server_url),
            scroll_offset: 0,
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    // ── Tracing ────────────────────────────────────────────────
    let data_dir = config::data_dir()?;
    std::fs::create_dir_all(&data_dir)?;

    let file_appender = tracing_appender::rolling::never(&data_dir, "meza.log");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

    tracing_subscriber::fmt()
        .with_writer(non_blocking)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_ansi(false)
        .init();

    tracing::info!("meza-tui starting");

    // ── Config ─────────────────────────────────────────────────
    let config = config::load()?;
    let server_url = config.server.url.clone();

    // ── Terminal ───────────────────────────────────────────────
    terminal::install_panic_handler();
    let mut tui = terminal::enter()?;

    // ── App + Components + Async action channel ────────────────
    let mut app = App::new();
    let mut ui = UiComponents::new(&server_url);
    let mut events = EventHandler::new();

    // Channel for async tasks (login, gateway events) to send actions back.
    let (async_tx, mut async_rx) = mpsc::channel::<Action>(64);

    // Initial draw.
    tui.draw(|f| draw(f, &app, &ui))?;

    loop {
        if app.should_quit {
            break;
        }

        // Select between terminal events and async action results.
        let action = tokio::select! {
            ev = events.next() => {
                match ev {
                    Ok(ev) => map_event(ev, &app, &mut ui),
                    Err(_) => Action::Quit,
                }
            }
            Some(action) = async_rx.recv() => action,
        };

        // Handle Login action specially — spawn async task.
        if let Action::Login { ref email, ref password } = action {
            let tx = async_tx.clone();
            let url = server_url.clone();
            let email = email.clone();
            let password = password.clone();

            tracing::info!("login: starting for {email}");
            ui.login_view.loading = true;
            ui.login_view.error_msg = None;
            tui.draw(|f| draw(f, &app, &ui))?;

            tokio::spawn(async move {
                let result = do_login(&url, &email, &password).await;
                match result {
                    Ok(action) => { let _ = tx.send(action).await; }
                    Err(e) => { let _ = tx.send(Action::LoginFailed(e)).await; }
                }
            });
            continue;
        }

        // Handle LoginFailed — update login view error.
        if let Action::LoginFailed(ref msg) = action {
            ui.login_view.loading = false;
            ui.login_view.error_msg = Some(msg.clone());
        }

        // Handle LoginSuccess — clear login view.
        if let Action::LoginSuccess { .. } = action {
            ui.login_view.loading = false;
        }

        app.update(action);

        if app.ui.needs_redraw {
            ui.input_box.set_mode(app.ui.input_mode);
            tui.draw(|f| draw(f, &app, &ui))?;
            app.ui.needs_redraw = false;
        }
    }

    // ── Shutdown ──────────────────────────────────────────────
    events.stop();
    terminal::exit()?;
    tracing::info!("meza-tui exited cleanly");

    Ok(())
}

/// Perform the full login sequence asynchronously.
async fn do_login(server_url: &str, email: &str, password: &str) -> Result<Action, String> {
    use meza_client::connect::ConnectClient;
    use meza_client::crypto::kdf;

    let client = ConnectClient::new(server_url.to_string());

    // 1. Get salt
    tracing::info!("login: fetching salt for {email}");
    let salt = client
        .get_salt(email)
        .await
        .map_err(|e| format!("Failed to get salt: {e}"))?;

    tracing::info!("login: salt received ({} bytes), deriving keys...", salt.len());

    // 2. Derive keys (CPU-intensive — run on blocking thread)
    let password_bytes = password.as_bytes().to_vec();
    let salt_clone = salt.clone();
    let (master_key, auth_key) = tokio::task::spawn_blocking(move || {
        kdf::derive_keys(&password_bytes, &salt_clone)
    })
    .await
    .map_err(|e| format!("Key derivation task failed: {e}"))?
    .map_err(|e| format!("Key derivation failed: {e}"))?;

    tracing::info!("login: keys derived, calling Login RPC");

    // 3. Login
    let resp = client
        .login(email, auth_key.as_ref())
        .await
        .map_err(|e| format!("Login failed: {e}"))?;

    let user_id = resp
        .user
        .as_ref()
        .map(|u| u.id.clone())
        .unwrap_or_default();

    tracing::info!("login: success, user_id={user_id}");

    // 4. Register public key if we have a key bundle to decrypt
    // (For now, just complete the login — full E2EE bootstrap comes next)
    let _ = master_key; // Will be used for identity decryption

    Ok(Action::LoginSuccess {
        user_id,
        access_token: resp.access_token,
        refresh_token: resp.refresh_token,
    })
}

/// Map a raw terminal event into an `Action`.
fn map_event(event: Event, app: &App, ui: &mut UiComponents) -> Action {
    match event {
        Event::Tick => Action::Tick,
        Event::Resize(w, h) => Action::Resize(w, h),
        Event::Key(key) => {
            // If not authenticated, send keys to login view.
            if !app.auth.is_authenticated {
                match ui.login_view.handle_key_event(key) {
                    Ok(Some(action)) => return action,
                    Ok(None) => return Action::Render,
                    Err(e) => return Action::Error(e.to_string()),
                }
            }

            match app.ui.input_mode {
                app::InputMode::Normal => match key.code {
                    KeyCode::Char('q') => Action::Quit,
                    KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                        Action::Quit
                    }
                    KeyCode::Char('i') => Action::FocusInput,
                    KeyCode::Char('k') | KeyCode::Up => {
                        ui.scroll_offset = ui.scroll_offset.saturating_add(1);
                        Action::ScrollUp
                    }
                    KeyCode::Char('j') | KeyCode::Down => {
                        ui.scroll_offset = ui.scroll_offset.saturating_sub(1);
                        Action::ScrollDown
                    }
                    KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                        ui.scroll_offset = ui.scroll_offset.saturating_add(10);
                        Action::ScrollHalfUp
                    }
                    KeyCode::Char('d') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                        ui.scroll_offset = ui.scroll_offset.saturating_sub(10);
                        Action::ScrollHalfDown
                    }
                    KeyCode::Char('g') => {
                        ui.scroll_offset = usize::MAX;
                        Action::ScrollTop
                    }
                    KeyCode::Char('G') => {
                        ui.scroll_offset = 0;
                        Action::ScrollBottom
                    }
                    _ => Action::None,
                },
                app::InputMode::Insert => match ui.input_box.handle_key_event(key) {
                    Ok(Some(action)) => action,
                    Ok(None) => Action::Render,
                    Err(e) => Action::Error(e.to_string()),
                },
            }
        }
    }
}

/// Render the full UI.
fn draw(frame: &mut Frame, app: &App, ui: &UiComponents) {
    let area = frame.area();

    // If not authenticated, show the login view.
    if !app.auth.is_authenticated {
        ui.login_view.draw(frame, area);
        return;
    }

    // Authenticated layout:
    let chunks = Layout::vertical([
        Constraint::Length(1),  // channel bar
        Constraint::Fill(1),   // chat view
        Constraint::Length(3),  // input box
        Constraint::Length(1),  // status bar
    ])
    .split(area);

    components::channel_bar::ChannelBar::draw(
        frame,
        chunks[0],
        &app.channels.channels,
        app.channels.active_channel_idx,
        &app.channels.unread,
    );

    let max_scroll = app.messages.active_buffer.len();
    let scroll = ui.scroll_offset.min(max_scroll);
    components::chat_view::ChatView::draw(
        frame,
        chunks[1],
        &app.messages.active_buffer,
        scroll,
    );

    ui.input_box.draw(frame, chunks[2]);

    let server_name = app
        .servers
        .active_server_idx
        .and_then(|i| app.servers.servers.get(i))
        .map(|s| s.as_str())
        .unwrap_or("");
    let channel_name = app
        .channels
        .active_channel_idx
        .and_then(|i| app.channels.channels.get(i))
        .map(|s| s.as_str())
        .unwrap_or("");
    let total_unread: u32 = app.channels.unread.values().sum();

    components::status_bar::StatusBar::draw(
        frame,
        chunks[3],
        server_name,
        channel_name,
        app.gateway.connected,
        true,
        total_unread,
    );
}
