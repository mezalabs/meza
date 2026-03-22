use ratatui::{
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
    Frame,
};

/// Status bar component (single line, no borders, contrasting background).
pub struct StatusBar;

impl StatusBar {
    /// Draw the status bar.
    ///
    /// * `server_name` - active server name (or empty)
    /// * `channel_name` - active channel name (or empty)
    /// * `connected` - gateway connection state
    /// * `e2ee` - whether E2EE is active
    /// * `total_unread` - total unread message count across all channels
    pub fn draw(
        frame: &mut Frame,
        area: Rect,
        server_name: &str,
        channel_name: &str,
        connected: bool,
        e2ee: bool,
        total_unread: u32,
    ) {
        let width = area.width as usize;

        // Left: server/channel name
        let left = if !server_name.is_empty() && !channel_name.is_empty() {
            format!(" {}#{} ", server_name, channel_name)
        } else if !server_name.is_empty() {
            format!(" {} ", server_name)
        } else {
            " meza ".to_string()
        };

        // Center: connection state
        let (conn_text, conn_color) = if connected {
            ("Connected", Color::Green)
        } else {
            ("Disconnected", Color::Red)
        };

        // Right: E2EE indicator + unread count
        let mut right_parts = Vec::new();
        if e2ee {
            right_parts.push("[E2EE]".to_string());
        }
        if total_unread > 0 {
            right_parts.push(format!("[{}]", total_unread));
        }
        let right = if right_parts.is_empty() {
            String::new()
        } else {
            format!("{} ", right_parts.join(" "))
        };

        // Calculate padding to center the connection text.
        let left_len = left.len();
        let right_len = right.len();
        let conn_len = conn_text.len();
        let total_content = left_len + conn_len + right_len;
        let padding = if width > total_content {
            width - total_content
        } else {
            1
        };
        let left_pad = padding / 2;
        let right_pad = padding - left_pad;

        let bg = Color::DarkGray;
        let base_style = Style::default().bg(bg).fg(Color::White);

        let spans = vec![
            Span::styled(&left, base_style.add_modifier(Modifier::BOLD)),
            Span::styled(" ".repeat(left_pad), base_style),
            Span::styled(conn_text, Style::default().bg(bg).fg(conn_color)),
            Span::styled(" ".repeat(right_pad), base_style),
            Span::styled(&right, base_style),
        ];

        let line = Line::from(spans);
        let para = Paragraph::new(line);
        frame.render_widget(para, area);
    }
}
