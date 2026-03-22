use anyhow::Result;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::{
    layout::Rect,
    style::{Color, Style},
    widgets::{Block, Borders},
    Frame,
};
use ratatui_textarea::TextArea;

use crate::action::Action;
use crate::app::InputMode;

/// Single-line text input component wrapping `ratatui_textarea::TextArea`.
pub struct InputBox {
    textarea: TextArea<'static>,
}

impl InputBox {
    pub fn new() -> Self {
        let mut textarea = TextArea::default();
        // Single-line: no line numbers, no word wrap needed beyond one line.
        textarea.set_cursor_line_style(Style::default());
        textarea.set_block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::DarkGray))
                .title(" [NORMAL] "),
        );
        Self { textarea }
    }

    /// Update the visual style to reflect the current input mode.
    pub fn set_mode(&mut self, mode: InputMode) {
        let (title, border_color) = match mode {
            InputMode::Normal => (" [NORMAL] ", Color::DarkGray),
            InputMode::Insert => (" [INSERT] ", Color::Cyan),
        };
        self.textarea.set_block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(border_color))
                .title(title),
        );
    }

    /// Handle a key event while in insert mode. Returns an optional Action.
    pub fn handle_key_event(&mut self, key: KeyEvent) -> Result<Option<Action>> {
        match key.code {
            KeyCode::Enter => {
                // Extract the current line content.
                let text: String = self.textarea.lines().join("");
                let trimmed = text.trim().to_string();

                // Clear the textarea.
                self.textarea.select_all();
                self.textarea.cut();

                if trimmed.is_empty() {
                    return Ok(None);
                }

                // Check for slash commands.
                if trimmed == "/quit" {
                    return Ok(Some(Action::Quit));
                }
                if trimmed == "/logout" {
                    // For now, treat logout as quit. Will be wired up later.
                    return Ok(Some(Action::Quit));
                }

                Ok(Some(Action::SendMessage(trimmed)))
            }
            KeyCode::Esc => Ok(Some(Action::UnfocusInput)),
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                Ok(Some(Action::Quit))
            }
            _ => {
                self.textarea.input(key);
                Ok(None)
            }
        }
    }

    /// Render the input box into the given area.
    pub fn draw(&self, frame: &mut Frame, area: Rect) {
        frame.render_widget(&self.textarea, area);
    }
}
