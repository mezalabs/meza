use std::io::{self, Stderr};

use anyhow::Result;
use crossterm::{
    execute,
    terminal::{self, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::backend::CrosstermBackend;

pub type Tui = ratatui::Terminal<CrosstermBackend<Stderr>>;

/// Enter raw mode, switch to the alternate screen, and return a `Terminal`.
pub fn enter() -> Result<Tui> {
    terminal::enable_raw_mode()?;
    execute!(io::stderr(), EnterAlternateScreen)?;

    let backend = CrosstermBackend::new(io::stderr());
    let terminal = ratatui::Terminal::new(backend)?;

    Ok(terminal)
}

/// Leave the alternate screen and disable raw mode.
pub fn exit() -> Result<()> {
    execute!(io::stderr(), LeaveAlternateScreen)?;
    terminal::disable_raw_mode()?;
    Ok(())
}

/// Install a panic hook that restores the terminal before printing the panic.
pub fn install_panic_handler() {
    let original_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        // Best-effort restore; ignore errors.
        let _ = exit();
        original_hook(panic_info);
    }));
}
