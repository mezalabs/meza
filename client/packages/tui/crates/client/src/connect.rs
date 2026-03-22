// Connect protocol client - implements HTTP POST + protobuf
// Will be fully implemented in Phase 2

use crate::error::MezaError;

pub struct ConnectClient {
    _http: reqwest::Client,
    _base_url: String,
}

impl ConnectClient {
    pub fn new(base_url: String) -> Self {
        Self {
            _http: reqwest::Client::new(),
            _base_url: base_url,
        }
    }

    /// Make a unary RPC call using the Connect protocol.
    pub async fn call<Req, Resp>(
        &self,
        _service: &str,
        _method: &str,
        _req: &Req,
        _token: Option<&str>,
    ) -> Result<Resp, MezaError>
    where
        Req: prost::Message,
        Resp: prost::Message + Default,
    {
        todo!("Phase 2: implement Connect protocol call")
    }
}
