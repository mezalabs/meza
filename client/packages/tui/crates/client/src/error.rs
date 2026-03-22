use std::time::Duration;

/// Typed error hierarchy for the meza-client library.
#[derive(Debug, thiserror::Error)]
pub enum MezaError {
    #[error("unauthenticated")]
    Unauthenticated,

    #[error("rate limited, retry after {retry_after:?}")]
    RateLimited { retry_after: Option<Duration> },

    #[error("not found: {0}")]
    NotFound(String),

    #[error("already exists: {0}")]
    AlreadyExists(String),

    #[error("invalid argument: {0}")]
    InvalidArgument(String),

    #[error("permission denied: {0}")]
    PermissionDenied(String),

    #[error("network: {0}")]
    Network(#[from] reqwest::Error),

    #[error("websocket: {0}")]
    WebSocket(String),

    #[error("protocol: {0}")]
    Protocol(String),

    #[error("crypto: {0}")]
    Crypto(String),

    #[error("internal: {0}")]
    Internal(String),
}

/// Parse a Connect protocol error code string into a MezaError.
impl MezaError {
    pub fn from_connect_error(code: &str, message: String) -> Self {
        match code {
            "unauthenticated" => Self::Unauthenticated,
            "not_found" => Self::NotFound(message),
            "already_exists" => Self::AlreadyExists(message),
            "invalid_argument" => Self::InvalidArgument(message),
            "permission_denied" => Self::PermissionDenied(message),
            "resource_exhausted" => Self::RateLimited { retry_after: None },
            _ => Self::Internal(format!("{code}: {message}")),
        }
    }
}
