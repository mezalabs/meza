use anyhow::Result;
use crossterm::event::{KeyCode, KeyModifiers};
use ratatui::{
    layout::{Constraint, Layout},
    Frame,
};

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

    // ── Terminal ───────────────────────────────────────────────
    terminal::install_panic_handler();
    let mut tui = terminal::enter()?;

    // ── App + Components + Event loop ─────────────────────────
    let mut app = App::new();
    let mut ui = UiComponents::new(&config.server.url);
    let mut events = EventHandler::new();

    // Initial draw.
    tui.draw(|f| draw(f, &app, &ui))?;

    while !app.should_quit {
        let ev = events.next().await?;
        let action = map_event(ev, &app, &mut ui);
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
                        ui.scroll_offset = usize::MAX; // will be clamped during draw
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
    // Top: ChannelBar (1 line)
    // Middle: ChatView (fills space)
    // Bottom-1: InputBox (3 lines)
    // Bottom-2: StatusBar (1 line)
    let chunks = Layout::vertical([
        Constraint::Length(1),  // channel bar
        Constraint::Fill(1),   // chat view
        Constraint::Length(3),  // input box
        Constraint::Length(1),  // status bar
    ])
    .split(area);

    // Channel bar
    components::channel_bar::ChannelBar::draw(
        frame,
        chunks[0],
        &app.channels.channels,
        app.channels.active_channel_idx,
        &app.channels.unread,
    );

    // Chat view
    // Clamp scroll_offset to valid range.
    let max_scroll = app.messages.active_buffer.len();
    let scroll = ui.scroll_offset.min(max_scroll);
    components::chat_view::ChatView::draw(
        frame,
        chunks[1],
        &app.messages.active_buffer,
        scroll,
    );

    // Input box
    ui.input_box.draw(frame, chunks[2]);

    // Status bar
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
        true, // E2EE indicator always shown for now
        total_unread,
    );
}
