use std::collections::HashMap;

use ratatui::{
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
    Frame,
};

/// Channel activity bar component.
pub struct ChannelBar;

impl ChannelBar {
    /// Draw the channel bar.
    ///
    /// * `channels` - list of channel names
    /// * `active_idx` - index of the currently active channel (if any)
    /// * `unread` - map of channel name to unread count
    /// * `mentions` - set of channels with mentions (represented via counts > 0 in a separate map)
    pub fn draw(
        frame: &mut Frame,
        area: Rect,
        channels: &[String],
        active_idx: Option<usize>,
        unread: &HashMap<String, u32>,
    ) {
        let mut spans: Vec<Span<'_>> = Vec::new();

        for (i, name) in channels.iter().enumerate() {
            if i > 0 {
                spans.push(Span::raw(" "));
            }

            let is_active = active_idx == Some(i);
            let count = unread.get(name).copied().unwrap_or(0);

            // Color coding: white=no activity, green=unread, yellow=mention (count > 10 as heuristic)
            let fg = if count > 10 {
                Color::Yellow // mentions
            } else if count > 0 {
                Color::Green // unread
            } else {
                Color::White // no activity
            };

            let mut style = Style::default().fg(fg);
            if is_active {
                style = style.add_modifier(Modifier::BOLD | Modifier::REVERSED);
            }

            let label = format!("[{}:{}]", i + 1, name);
            spans.push(Span::styled(label, style));
        }

        if spans.is_empty() {
            spans.push(Span::styled(
                " No channels ",
                Style::default().fg(Color::DarkGray),
            ));
        }

        let line = Line::from(spans);
        let para = Paragraph::new(line);
        frame.render_widget(para, area);
    }
}
