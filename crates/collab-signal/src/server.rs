//! The relay's network side: a WebSocket server (plain `ws://`; put it behind a TLS-terminating reverse proxy for
//! `wss://` in production) that feeds every connection's messages into the [`Hub`]. Per connection: messages over
//! the size limit are refused by the WebSocket layer, binary or malformed messages count as strikes, and a
//! connection over its rate is closed. Signal contents are never logged (an SDP holds addresses).

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

use crate::hub::{Hub, HubCounts, RelayConfig};
use crate::proto::{ClientMessage, ErrorCode, RelayMessage, Slot, MAX_MESSAGE_BYTES};

type SharedHub = Arc<Mutex<Hub>>;

fn with_hub<R>(hub: &SharedHub, f: impl FnOnce(&mut Hub) -> R) -> Option<R> {
    hub.lock().ok().map(|mut hub| f(&mut hub))
}

/// Where a relay's connections come from.
#[derive(Clone)]
pub struct RemoteLookup(SharedHub);

impl RemoteLookup {
    pub fn remote_of(&self, slot: &Slot) -> Option<SocketAddr> {
        with_hub(&self.0, |hub| hub.remote_of(slot)).flatten()
    }
}

/// A running relay.
pub struct Relay {
    addr: SocketAddr,
    hub: SharedHub,
    stop: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
    /// Becomes `true` when the accepting task has ended for any reason (stopped, panicked, cancelled).
    ended: watch::Receiver<bool>,
}

/// Marks the accepting task as ended when it is dropped: on a normal return, an unwinding panic or cancellation.
struct EndedGuard(watch::Sender<bool>);

impl Drop for EndedGuard {
    fn drop(&mut self) {
        self.0.send_replace(true);
    }
}

impl Relay {
    /// Starts listening on `listen` (port 0 picks a free one).
    pub async fn start(listen: SocketAddr, config: RelayConfig) -> std::io::Result<Relay> {
        let listener = TcpListener::bind(listen).await?;
        let addr = listener.local_addr()?;
        let hub: SharedHub = Arc::new(Mutex::new(Hub::new(config)));
        let (stop, stopped) = oneshot::channel();
        let (ended_tx, ended) = watch::channel(false);
        let guard = EndedGuard(ended_tx);
        let task_hub = hub.clone();
        let task = tokio::spawn(async move {
            let _guard = guard;
            run(listener, task_hub, stopped).await;
        });
        tracing::info!(%addr, "collaboration signaling relay listening");
        Ok(Relay {
            addr,
            hub,
            stop: Some(stop),
            task,
            ended,
        })
    }

    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// Answers where this relay's connections come from (an Owner hosting on an embedded relay binds each
    /// participant's peer connection to the interface facing that address). Stays valid after the relay stops.
    pub fn lookup(&self) -> RemoteLookup {
        RemoteLookup(self.hub.clone())
    }

    pub fn counts(&self) -> HubCounts {
        with_hub(&self.hub, |hub| hub.counts()).unwrap_or_default()
    }

    /// Whether the relay still accepts connections.
    pub fn is_running(&self) -> bool {
        !*self.ended.borrow()
    }

    /// Resolves once the relay no longer accepts connections — after [`Self::stop`], or unexpectedly (a panic in
    /// the accepting task). A process hosting a relay watches this so it never stays alive without listening.
    pub async fn ended(&self) {
        let mut ended = self.ended.clone();
        let _ = ended.wait_for(|ended| *ended).await;
    }

    /// Stops accepting and drops every connection (forgetting everything: there is nothing to save).
    pub async fn stop(mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        let _ = (&mut self.task).await;
    }
}

async fn run(listener: TcpListener, hub: SharedHub, mut stopped: oneshot::Receiver<()>) {
    let mut connections = tokio::task::JoinSet::new();
    let mut sweep = tokio::time::interval(Duration::from_secs(1));
    loop {
        tokio::select! {
            _ = &mut stopped => break,
            _ = sweep.tick() => {
                if let Some(expired) = with_hub(&hub, |hub| hub.sweep(Instant::now())) {
                    if expired > 0 {
                        tracing::info!(expired, "signaling topics expired");
                    }
                }
            }
            accepted = listener.accept() => match accepted {
                Ok((stream, remote)) => { connections.spawn(serve(stream, remote, hub.clone())); }
                Err(err) => {
                    // A failing accept (out of handles or buffers) is retried shortly instead of spinning.
                    tracing::warn!(%err, "a signaling connection couldn't be accepted");
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            },
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
    connections.shutdown().await;
}

async fn serve(stream: TcpStream, remote: SocketAddr, hub: SharedHub) {
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(MAX_MESSAGE_BYTES);
    config.max_frame_size = Some(MAX_MESSAGE_BYTES);
    let Ok(socket) = tokio_tungstenite::accept_async_with_config(stream, Some(config)).await else {
        return;
    };
    let (mut sink, mut source) = socket.split();
    let (out, mut outbox) = mpsc::channel::<RelayMessage>(256);
    let Some(Some(slot)) = with_hub(&hub, |hub| hub.connect_from(out.clone(), Some(remote))) else {
        let refusal = RelayMessage::Error {
            code: ErrorCode::RelayFull,
        }
        .encode();
        let _ = sink.send(Message::text(refusal)).await;
        return;
    };
    let writer = tokio::spawn(async move {
        while let Some(message) = outbox.recv().await {
            if sink.send(Message::text(message.encode())).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });
    read_loop(&mut source, &hub, &slot, &out).await;
    with_hub(&hub, |hub| hub.disconnect(&slot));
    drop(out);
    let _ = writer.await;
}

async fn read_loop<S>(
    source: &mut S,
    hub: &SharedHub,
    slot: &Slot,
    out: &mpsc::Sender<RelayMessage>,
) where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    let Some((rate, strikes_allowed)) = with_hub(hub, |hub| {
        (
            hub.config().max_messages_per_second,
            hub.config().max_strikes,
        )
    }) else {
        return;
    };
    let (mut window, mut count, mut strikes) = (Instant::now(), 0u32, 0u32);
    while let Some(Ok(message)) = source.next().await {
        if window.elapsed() >= Duration::from_secs(1) {
            (window, count) = (Instant::now(), 0);
        }
        count += 1;
        if count > rate {
            let _ = out.try_send(RelayMessage::Error {
                code: ErrorCode::RateLimited,
            });
            break;
        }
        let parsed = match message {
            Message::Text(text) => ClientMessage::decode(text.as_str()),
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) => continue,
            _ => Err(ErrorCode::Malformed),
        };
        match parsed {
            Ok(message) => {
                with_hub(hub, |hub| hub.handle(slot, message, Instant::now()));
            }
            Err(code) => {
                strikes += 1;
                let _ = out.try_send(RelayMessage::Error { code });
                if strikes >= strikes_allowed {
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    impl Relay {
        /// Kills the accepting task as a crash would (tests only).
        fn crash(&self) {
            self.task.abort();
        }
    }

    async fn listening(addr: SocketAddr) -> bool {
        TcpStream::connect(addr).await.is_ok()
    }

    #[tokio::test]
    async fn a_relay_that_stops_accepting_says_so() {
        let relay = Relay::start("127.0.0.1:0".parse().expect("addr"), RelayConfig::default())
            .await
            .expect("relay");
        let addr = relay.addr();
        assert!(listening(addr).await);
        let pending = tokio::time::timeout(Duration::from_millis(200), relay.ended()).await;
        assert!(pending.is_err(), "a running relay hasn't ended");
        relay.crash();
        tokio::time::timeout(Duration::from_secs(2), relay.ended())
            .await
            .expect("a crashed accepting task is reported");
        assert!(!listening(addr).await, "and nothing listens any more");

        let stopped = Relay::start("127.0.0.1:0".parse().expect("addr"), RelayConfig::default())
            .await
            .expect("relay");
        let ended = stopped.ended.clone();
        stopped.stop().await;
        assert!(*ended.borrow());
    }

    #[tokio::test]
    async fn the_guard_also_fires_when_the_task_panics() {
        let (tx, mut rx) = watch::channel(false);
        let guard = EndedGuard(tx);
        let task = tokio::spawn(async move {
            let _guard = guard;
            panic!("a bug in the accepting loop");
        });
        assert!(task.await.is_err());
        rx.wait_for(|ended| *ended).await.expect("ended");
    }
}
