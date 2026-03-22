// Connect protocol client - implements HTTP POST + protobuf

use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, warn};

use crate::error::MezaError;
use crate::proto::{
    GetSaltRequest, GetSaltResponse, LoginRequest, LoginResponse, LogoutRequest, LogoutResponse,
    RefreshTokenRequest, RefreshTokenResponse, RegisterPublicKeyRequest,
    RegisterPublicKeyResponse,
};

/// JSON shape returned by Connect protocol on error responses.
#[derive(serde::Deserialize)]
struct ConnectError {
    code: String,
    #[serde(default)]
    message: String,
}

pub struct ConnectClient {
    http: reqwest::Client,
    base_url: String,
    token: Arc<RwLock<Option<String>>>,
    refresh_token: Arc<RwLock<Option<String>>>,
    /// Guards concurrent token-refresh attempts so only one runs at a time.
    refresh_mutex: tokio::sync::Mutex<()>,
}

impl ConnectClient {
    pub fn new(base_url: String) -> Self {
        let insecure = std::env::var("MEZA_INSECURE")
            .map(|v| v == "1")
            .unwrap_or(false);

        let http = if insecure {
            reqwest::Client::builder()
                .danger_accept_invalid_certs(true)
                .build()
                .expect("failed to build insecure reqwest client")
        } else {
            reqwest::Client::builder()
                .https_only(true)
                .build()
                .expect("failed to build reqwest client")
        };

        Self {
            http,
            base_url,
            token: Arc::new(RwLock::new(None)),
            refresh_token: Arc::new(RwLock::new(None)),
            refresh_mutex: tokio::sync::Mutex::new(()),
        }
    }

    /// Set both access and refresh tokens.
    pub async fn set_tokens(&self, access: String, refresh: String) {
        *self.token.write().await = Some(access);
        *self.refresh_token.write().await = Some(refresh);
    }

    /// Clear both tokens (used on logout).
    pub async fn clear_tokens(&self) {
        *self.token.write().await = None;
        *self.refresh_token.write().await = None;
    }

    /// Make a unary RPC call using the Connect protocol.
    ///
    /// Automatically attaches the bearer token if present, and retries once on
    /// `Unauthenticated` after attempting a token refresh.
    pub async fn call<Req, Resp>(
        &self,
        service: &str,
        method: &str,
        req: &Req,
    ) -> Result<Resp, MezaError>
    where
        Req: prost::Message,
        Resp: prost::Message + Default,
    {
        match self.call_inner::<Req, Resp>(service, method, req).await {
            Ok(resp) => Ok(resp),
            Err(MezaError::Unauthenticated) => {
                // Attempt token refresh and retry once.
                if self.refresh_token_rpc().await? {
                    debug!("token refreshed, retrying {service}/{method}");
                    self.call_inner(service, method, req).await
                } else {
                    Err(MezaError::Unauthenticated)
                }
            }
            Err(e) => Err(e),
        }
    }

    /// Inner call that does a single HTTP POST without retry logic.
    async fn call_inner<Req, Resp>(
        &self,
        service: &str,
        method: &str,
        req: &Req,
    ) -> Result<Resp, MezaError>
    where
        Req: prost::Message,
        Resp: prost::Message + Default,
    {
        let url = format!("{}/{}/{}", self.base_url, service, method);
        let body = prost::Message::encode_to_vec(req);

        let mut builder = self
            .http
            .post(&url)
            .header("Content-Type", "application/proto")
            .header("Connect-Protocol-Version", "1")
            .body(body);

        // Attach bearer token if available.
        if let Some(ref tok) = *self.token.read().await {
            builder = builder.header("Authorization", format!("Bearer {tok}"));
        }

        let resp = builder.send().await?;
        let status = resp.status();

        if status.is_success() {
            let bytes = resp.bytes().await?;
            let decoded = Resp::decode(bytes)?;
            Ok(decoded)
        } else {
            // Try to parse Connect JSON error body.
            let bytes = resp.bytes().await?;
            let err: ConnectError = serde_json::from_slice(&bytes).unwrap_or(ConnectError {
                code: "internal".to_owned(),
                message: format!("HTTP {status}"),
            });
            Err(MezaError::from_connect_error(&err.code, err.message))
        }
    }

    // ─── Auth helper methods ────────────────────────────────────────────

    /// Fetch the salt for a given identifier (email or username).
    pub async fn get_salt(&self, identifier: &str) -> Result<Vec<u8>, MezaError> {
        let req = GetSaltRequest {
            identifier: identifier.to_owned(),
        };
        let resp: GetSaltResponse =
            self.call("meza.v1.AuthService", "GetSalt", &req).await?;
        Ok(resp.salt)
    }

    /// Log in with identifier + auth_key, returning the raw `LoginResponse`.
    ///
    /// This also stores the returned tokens automatically.
    pub async fn login(
        &self,
        identifier: &str,
        auth_key: &[u8],
    ) -> Result<LoginResponse, MezaError> {
        let req = LoginRequest {
            identifier: identifier.to_owned(),
            auth_key: auth_key.to_vec(),
        };
        // Use call_inner to avoid auto-refresh loop on login itself.
        let resp: LoginResponse =
            self.call_inner("meza.v1.AuthService", "Login", &req).await?;
        self.set_tokens(resp.access_token.clone(), resp.refresh_token.clone())
            .await;
        Ok(resp)
    }

    /// Attempt to refresh the access token. Returns `true` if successful.
    ///
    /// Uses a mutex to deduplicate concurrent refresh attempts.
    pub async fn refresh_token_rpc(&self) -> Result<bool, MezaError> {
        let _guard = self.refresh_mutex.lock().await;

        let rt = self.refresh_token.read().await.clone();
        let Some(rt) = rt else {
            warn!("no refresh token available");
            return Ok(false);
        };

        let req = RefreshTokenRequest {
            refresh_token: rt,
        };

        match self
            .call_inner::<RefreshTokenRequest, RefreshTokenResponse>(
                "meza.v1.AuthService",
                "RefreshToken",
                &req,
            )
            .await
        {
            Ok(resp) => {
                self.set_tokens(resp.access_token, resp.refresh_token)
                    .await;
                debug!("access token refreshed");
                Ok(true)
            }
            Err(e) => {
                warn!("token refresh failed: {e}");
                self.clear_tokens().await;
                Ok(false)
            }
        }
    }

    /// Register a signing public key for the current user.
    pub async fn register_public_key(&self, key: &[u8]) -> Result<(), MezaError> {
        let req = RegisterPublicKeyRequest {
            signing_public_key: key.to_vec(),
        };
        let _resp: RegisterPublicKeyResponse = self
            .call("meza.v1.KeyService", "RegisterPublicKey", &req)
            .await?;
        Ok(())
    }

    /// Log out, clearing tokens.
    pub async fn logout_rpc(&self) -> Result<(), MezaError> {
        let req = LogoutRequest {};
        let _resp: LogoutResponse =
            self.call("meza.v1.AuthService", "Logout", &req).await?;
        self.clear_tokens().await;
        Ok(())
    }
}
