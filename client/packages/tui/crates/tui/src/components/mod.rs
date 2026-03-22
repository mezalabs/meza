use anyhow::Result;
use crossterm::event::KeyEvent;
use ratatui::layout::Rect;
use ratatui::Frame;

use crate::action::Action;

pub mod channel_bar;
pub mod chat_view;
pub mod input_box;
pub mod login;
pub mod status_bar;

/// Trait implemented by each UI component (sidebar, message list, input box, etc.).
pub trait Component {
    /// Handle a key event, optionally returning an `Action` to dispatch.
    fn handle_key_event(&mut self, _key: KeyEvent) -> Result<Option<Action>> {
        Ok(None)
    }

    /// React to a dispatched action (Elm-style update).
    fn update(&mut self, _action: &Action) -> Result<()> {
        Ok(())
    }

    /// Render the component into the given frame area.
    fn draw(&self, frame: &mut Frame, area: Rect) -> Result<()>;
}
