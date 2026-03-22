use std::collections::VecDeque;

use ratatui::{
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
    Frame,
};

use crate::app::ChatMessage;

/// Hash a username to one of 8 terminal colors for consistent colorization.
fn username_color(name: &str) -> Color {
    let hash: u32 = name.bytes().fold(0u32, |acc, b| acc.wrapping_mul(31).wrapping_add(b as u32));
    match hash % 8 {
        0 => Color::Red,
        1 => Color::Green,
        2 => Color::Yellow,
        3 => Color::Blue,
        4 => Color::Magenta,
        5 => Color::Cyan,
        6 => Color::White,
        _ => Color::LightGreen,
    }
}

/// Message display component.
pub struct ChatView;

impl ChatView {
    /// Draw the chat message list.
    ///
    /// `messages` is the active message buffer and `scroll_offset` is how many
    /// lines from the bottom the view is scrolled (0 = latest).
    pub fn draw(
        frame: &mut Frame,
        area: Rect,
        messages: &VecDeque<ChatMessage>,
        scroll_offset: usize,
    ) {
        let inner_height = area.height.saturating_sub(2) as usize; // account for borders

        let lines: Vec<Line<'_>> = messages
            .iter()
            .map(|msg| Self::render_message(msg))
            .collect();

        let total = lines.len();
        let scrolled_up = scroll_offset > 0;

        // Build the block, optionally with a "New messages" indicator.
        let mut block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::DarkGray));

        if scrolled_up {
            block = block.title_bottom(Line::from(Span::styled(
                " -- New messages below -- ",
                Style::default()
                    .fg(Color::Yellow)
                    .add_modifier(Modifier::BOLD),
            )));
        }

        // Calculate scroll position: we want to show messages ending at
        // (total - scroll_offset), starting from max(0, end - inner_height).
        let end = total.saturating_sub(scroll_offset);
        let scroll_y = end.saturating_sub(inner_height);

        let para = Paragraph::new(lines)
            .block(block)
            .wrap(Wrap { trim: false })
            .scroll((scroll_y as u16, 0));

        frame.render_widget(para, area);
    }

    fn render_message(msg: &ChatMessage) -> Line<'static> {
        // Extract HH:MM from the timestamp (expected ISO-8601 or "HH:MM..." prefix).
        let time = if msg.timestamp.len() >= 5 {
            // Try to find HH:MM in the timestamp. If it contains 'T', use time part.
            if let Some(t_pos) = msg.timestamp.find('T') {
                let after_t = &msg.timestamp[t_pos + 1..];
                if after_t.len() >= 5 {
                    after_t[..5].to_string()
                } else {
                    msg.timestamp[..5].to_string()
                }
            } else {
                msg.timestamp[..5].to_string()
            }
        } else {
            msg.timestamp.clone()
        };

        // System messages (empty author) are rendered in dim gray.
        if msg.author_name.is_empty() {
            return Line::from(vec![
                Span::styled(
                    format!("[{time}] "),
                    Style::default().fg(Color::DarkGray),
                ),
                Span::styled(
                    msg.content.clone(),
                    Style::default()
                        .fg(Color::DarkGray)
                        .add_modifier(Modifier::DIM),
                ),
            ]);
        }

        let mut spans = Vec::new();

        // Timestamp
        spans.push(Span::styled(
            format!("[{time}] "),
            Style::default().fg(Color::DarkGray),
        ));

        // Username
        let color = username_color(&msg.author_name);
        spans.push(Span::styled(
            format!("<{}> ", msg.author_name),
            Style::default().fg(color).add_modifier(Modifier::BOLD),
        ));

        // Signature failure prefix
        if !msg.signature_ok {
            spans.push(Span::styled(
                "[Unverified] ",
                Style::default()
                    .fg(Color::Red)
                    .add_modifier(Modifier::BOLD),
            ));
        }

        // Message content (or decryption failure)
        if !msg.decryption_ok {
            spans.push(Span::styled(
                "[Unable to decrypt]".to_string(),
                Style::default().fg(Color::Red),
            ));
        } else {
            spans.push(Span::raw(msg.content.clone()));
        }

        // Edited indicator
        if msg.edited {
            spans.push(Span::styled(
                " (edited)",
                Style::default()
                    .fg(Color::DarkGray)
                    .add_modifier(Modifier::ITALIC),
            ));
        }

        Line::from(spans)
    }
}
