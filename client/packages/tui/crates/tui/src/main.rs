use anyhow::Result;
use crossterm::event::{KeyCode, KeyModifiers};
use ratatui::{
    layout::{Constraint, Layout},
    style::{Color, Style},
    text::Text,
    widgets::{Block, Borders, Paragraph},
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
use event::{Event, EventHandler};

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
    let _config = config::load()?;

    // ── Terminal ───────────────────────────────────────────────
    terminal::install_panic_handler();
    let mut tui = terminal::enter()?;

    // ── App + Event loop ──────────────────────────────────────
    let mut app = App::new();
    let mut events = EventHandler::new();

    // Initial draw.
    tui.draw(|f| draw(f, &app))?;

    while !app.should_quit {
        let ev = events.next().await?;
        let action = map_event(ev, &app);
        app.update(action);

        if app.ui.needs_redraw {
            tui.draw(|f| draw(f, &app))?;
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
fn map_event(event: Event, app: &App) -> Action {
    match event {
        Event::Tick => Action::Tick,
        Event::Resize(w, h) => Action::Resize(w, h),
        Event::Key(key) => match app.ui.input_mode {
            app::InputMode::Normal => match key.code {
                KeyCode::Char('q') => Action::Quit,
                KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    Action::Quit
                }
                KeyCode::Char('i') => Action::FocusInput,
                KeyCode::Char('k') | KeyCode::Up => Action::ScrollUp,
                KeyCode::Char('j') | KeyCode::Down => Action::ScrollDown,
                KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    Action::ScrollHalfUp
                }
                KeyCode::Char('d') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    Action::ScrollHalfDown
                }
                KeyCode::Char('g') => Action::ScrollTop,
                KeyCode::Char('G') => Action::ScrollBottom,
                _ => Action::None,
            },
            app::InputMode::Insert => match key.code {
                KeyCode::Esc => Action::UnfocusInput,
                KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    Action::Quit
                }
                _ => Action::None,
            },
        },
    }
}

/// Render a placeholder UI.
fn draw(frame: &mut Frame, app: &App) {
    let area = frame.area();

    let chunks = Layout::vertical([
        Constraint::Min(1),
        Constraint::Length(3),
    ])
    .split(area);

    let mode_str = match app.ui.input_mode {
        app::InputMode::Normal => "NORMAL",
        app::InputMode::Insert => "INSERT",
    };

    let main_block = Block::default()
        .title(" meza-tui v0.1 ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan));

    let main_text = Paragraph::new(Text::raw("press q to quit"))
        .block(main_block)
        .style(Style::default().fg(Color::White));

    frame.render_widget(main_text, chunks[0]);

    let status = Paragraph::new(Text::raw(format!(" [{mode_str}] press i to type, Esc to go back")))
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::DarkGray)),
        )
        .style(Style::default().fg(Color::Gray));

    frame.render_widget(status, chunks[1]);
}
