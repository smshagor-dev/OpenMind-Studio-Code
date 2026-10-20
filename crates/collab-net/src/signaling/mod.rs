//! The signaling client: one WebSocket to the relay per [`SignalingConnector::connect`]. Messages go out through a
//! bounded queue and arrive as [`SignalingEvent`]s; a dropped link ends with `Closed`, which the session layer
//! answers with a reconnect (it never touches established peer connections).

pub mod mqtt;
pub mod multi;
pub mod route;

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use openmind_collab_signal::proto::MAX_MESSAGE_BYTES;
use openmind_collab_signal::{ClientMessage, RelayMessage};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

use crate::error::NetError;
use crate::transport::{
    BoxFuture, SignalingConnector, SignalingEvent, SignalingLink, SignalingTransport,
};

enum Outgoing {
    Message(ClientMessage),
    Close,
}

struct WsLink {
    out: mpsc::Sender<Outgoing>,
}

impl SignalingTransport for WsLink {
    fn send(&self, message: ClientMessage) -> Result<(), NetError> {
        self.out
            .try_send(Outgoing::Message(message))
            .map_err(|_| NetError::Closed)
    }

    fn close(&self) {
        let _ = self.out.try_send(Outgoing::Close);
    }
}

/// Connects to a relay at a `ws://`/`wss://` address.
pub struct WsSignaling {
    url: String,
    proxy: Option<openmind_network::http::HttpProxy>,
    timeout: Duration,
}

impl WsSignaling {
    /// Uses the proxy OpenMind's own requests use (read now; a later proxy change applies to the next connector).
    pub fn new(url: &str) -> Self {
        Self {
            url: url.to_string(),
            proxy: openmind_network::http::current(),
            timeout: Duration::from_secs(15),
        }
    }

    /// Connects directly, whatever proxy is in force (tests, loopback relays).
    pub fn direct(url: &str) -> Self {
        Self {
            url: url.to_string(),
            proxy: None,
            timeout: Duration::from_secs(15),
        }
    }

    /// How long opening the connection (TCP, proxy, TLS, WebSocket) may take.
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }
}

impl SignalingConnector for WsSignaling {
    fn connect(&self) -> BoxFuture<'_, Result<SignalingLink, NetError>> {
        Box::pin(async move {
            let stream = route::open(&self.url, self.proxy.clone(), self.timeout).await?;
            let request = self
                .url
                .as_str()
                .into_client_request()
                .map_err(|e| NetError::Config(e.to_string()))?;
            let mut config = WebSocketConfig::default();
            config.max_message_size = Some(MAX_MESSAGE_BYTES);
            config.max_frame_size = Some(MAX_MESSAGE_BYTES);
            let (socket, _) =
                tokio_tungstenite::client_async_with_config(request, stream, Some(config))
                    .await
                    .map_err(|e| NetError::Signaling(e.to_string()))?;
            let (mut sink, mut source) = socket.split();
            let (out, mut outgoing) = mpsc::channel::<Outgoing>(256);
            let (events, receiver) = mpsc::channel::<SignalingEvent>(256);
            tokio::spawn(async move {
                while let Some(item) = outgoing.recv().await {
                    let sent = match item {
                        Outgoing::Message(message) => {
                            sink.send(Message::text(message.encode())).await
                        }
                        Outgoing::Close => break,
                    };
                    if sent.is_err() {
                        break;
                    }
                }
                let _ = sink.close().await;
            });
            tokio::spawn(async move {
                let reason = loop {
                    match source.next().await {
                        Some(Ok(Message::Text(text))) => {
                            match RelayMessage::decode(text.as_str()) {
                                Ok(message) => {
                                    if events.send(SignalingEvent::Message(message)).await.is_err()
                                    {
                                        break "nobody is listening".to_string();
                                    }
                                }
                                Err(_) => tracing::info!(
                                    "ignored a malformed message from the signaling relay"
                                ),
                            }
                        }
                        Some(Ok(Message::Close(_))) | None => {
                            break "the relay closed the connection".to_string()
                        }
                        Some(Ok(_)) => {}
                        Some(Err(err)) => break err.to_string(),
                    }
                };
                let _ = events.send(SignalingEvent::Closed { reason }).await;
            });
            Ok((
                Arc::new(WsLink { out }) as Arc<dyn SignalingTransport>,
                receiver,
            ))
        })
    }
}
