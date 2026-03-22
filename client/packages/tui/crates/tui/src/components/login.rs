use anyhow::Result;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Frame,
};

use crate::action::Action;

/// Which field is currently focused in the login form.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum LoginField {
    #[default]
    ServerUrl,
    Email,
    Password,
}

/// Login form component.
pub struct LoginView {
    pub server_url: String,
    pub email: String,
    pub password: String,
    pub error_msg: Option<String>,
    pub loading: bool,
    pub active_field: LoginField,
}

impl LoginView {
    pub fn new(default_server_url: &str) -> Self {
        Self {
            server_url: default_server_url.to_string(),
            email: String::new(),
            password: String::new(),
            error_msg: None,
            loading: false,
            active_field: LoginField::Email,
        }
    }

    /// Handle key events for the login form. Returns an optional Action.
    pub fn handle_key_event(&mut self, key: KeyEvent) -> Result<Option<Action>> {
        if self.loading {
            // Only allow Ctrl-C while loading.
            if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
                return Ok(Some(Action::Quit));
            }
            return Ok(None);
        }

        match key.code {
            KeyCode::Tab | KeyCode::Down => {
                self.active_field = match self.active_field {
                    LoginField::ServerUrl => LoginField::Email,
                    LoginField::Email => LoginField::Password,
                    LoginField::Password => LoginField::ServerUrl,
                };
                Ok(None)
            }
            KeyCode::BackTab | KeyCode::Up => {
                self.active_field = match self.active_field {
                    LoginField::ServerUrl => LoginField::Password,
                    LoginField::Email => LoginField::ServerUrl,
                    LoginField::Password => LoginField::Email,
                };
                Ok(None)
            }
            KeyCode::Enter => {
                if self.active_field == LoginField::Password
                    || self.active_field == LoginField::Email
                {
                    // If on email, move to password. If on password, submit.
                    if self.active_field == LoginField::Email {
                        self.active_field = LoginField::Password;
                        return Ok(None);
                    }

                    let email = self.email.trim().to_string();
                    let password = std::mem::take(&mut self.password);

                    if email.is_empty() || password.is_empty() {
                        self.error_msg = Some("Email and password are required".to_string());
                        return Ok(None);
                    }

                    self.loading = true;
                    self.error_msg = None;
                    Ok(Some(Action::Login { email, password }))
                } else {
                    // On server URL, tab to email.
                    self.active_field = LoginField::Email;
                    Ok(None)
                }
            }
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                Ok(Some(Action::Quit))
            }
            KeyCode::Char(c) => {
                self.active_field_text_mut().push(c);
                Ok(None)
            }
            KeyCode::Backspace => {
                self.active_field_text_mut().pop();
                Ok(None)
            }
            KeyCode::Esc => Ok(Some(Action::Quit)),
            _ => Ok(None),
        }
    }

    fn active_field_text_mut(&mut self) -> &mut String {
        match self.active_field {
            LoginField::ServerUrl => &mut self.server_url,
            LoginField::Email => &mut self.email,
            LoginField::Password => &mut self.password,
        }
    }

    /// Render the login view centered in the given area.
    pub fn draw(&self, frame: &mut Frame, area: Rect) {
        // Center a box of ~40 wide, ~14 tall.
        let box_width = 50u16.min(area.width.saturating_sub(4));
        let box_height = 16u16.min(area.height.saturating_sub(2));

        let vert = Layout::vertical([
            Constraint::Fill(1),
            Constraint::Length(box_height),
            Constraint::Fill(1),
        ])
        .split(area);

        let horiz = Layout::horizontal([
            Constraint::Fill(1),
            Constraint::Length(box_width),
            Constraint::Fill(1),
        ])
        .split(vert[1]);

        let form_area = horiz[1];

        let block = Block::default()
            .title(" Login to Meza ")
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Cyan));

        let inner = block.inner(form_area);
        frame.render_widget(block, form_area);

        // Layout inside the form.
        let rows = Layout::vertical([
            Constraint::Length(2), // Server URL
            Constraint::Length(1), // spacer
            Constraint::Length(2), // Email
            Constraint::Length(1), // spacer
            Constraint::Length(2), // Password
            Constraint::Length(1), // spacer
            Constraint::Length(1), // Error or loading
            Constraint::Length(1), // spacer
            Constraint::Length(1), // Hint
            Constraint::Fill(1),  // rest
        ])
        .split(inner);

        // Server URL (displayed prominently but editable).
        Self::draw_field(
            frame,
            rows[0],
            "Server",
            &self.server_url,
            false,
            self.active_field == LoginField::ServerUrl,
        );

        // Email
        Self::draw_field(
            frame,
            rows[2],
            "Email",
            &self.email,
            false,
            self.active_field == LoginField::Email,
        );

        // Password (show dots)
        let dots = "*".repeat(self.password.len());
        Self::draw_field(
            frame,
            rows[4],
            "Password",
            &dots,
            false,
            self.active_field == LoginField::Password,
        );

        // Error or loading.
        if self.loading {
            let loading = Paragraph::new(Line::from(Span::styled(
                "Deriving keys...",
                Style::default()
                    .fg(Color::Yellow)
                    .add_modifier(Modifier::BOLD),
            )));
            frame.render_widget(loading, rows[6]);
        } else if let Some(ref err) = self.error_msg {
            let error = Paragraph::new(Line::from(Span::styled(
                err.clone(),
                Style::default().fg(Color::Red),
            )));
            frame.render_widget(error, rows[6]);
        }

        // Hint
        let hint = Paragraph::new(Line::from(Span::styled(
            "Tab: next field | Enter: submit | Esc: quit",
            Style::default().fg(Color::DarkGray),
        )));
        frame.render_widget(hint, rows[8]);
    }

    fn draw_field(
        frame: &mut Frame,
        area: Rect,
        label: &str,
        value: &str,
        _is_secret: bool,
        is_active: bool,
    ) {
        // Split into label line and value line.
        let rows = Layout::vertical([Constraint::Length(1), Constraint::Length(1)]).split(area);

        let label_style = if is_active {
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(Color::Gray)
        };

        let label_line = Paragraph::new(Line::from(Span::styled(
            format!("  {label}:"),
            label_style,
        )));
        frame.render_widget(label_line, rows[0]);

        let cursor = if is_active { "_" } else { "" };
        let value_style = if is_active {
            Style::default().fg(Color::White)
        } else {
            Style::default().fg(Color::Gray)
        };

        let value_line = Paragraph::new(Line::from(Span::styled(
            format!("  {value}{cursor}"),
            value_style,
        )));
        frame.render_widget(value_line, rows[1]);
    }
}
