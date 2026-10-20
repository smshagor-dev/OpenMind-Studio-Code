//! Signaling through a public MQTT broker, so a Room Code is all two computers need: no signaling server of
//! OpenMind's, no address typed in, no port opened on either computer (both only connect out — Windows Firewall has
//! nothing to ask about). [`MqttSignaling`] speaks the relay's own messages to the session layer ([`room::Room`] does
//! the hub's part); [`public_brokers`] registers an Owner on every built-in broker at once and lets a participant take
//! the first Owner that answers, so one broker being down or blocked doesn't stop a room.
//!
//! The WebSocket goes the way the relay's does (`route::open`: the proxy OpenMind uses, Windows' certificates).

pub mod packet;
mod room;

use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use openmind_collab_signal::{ClientMessage, Slot};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{HeaderValue, SEC_WEBSOCKET_PROTOCOL};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use self::packet::Packet;
use self::room::{Action, Room};
use super::multi::{MultiSignaling, Route};
use super::route::{self, Io};
use crate::error::NetError;
use crate::state::ConnectionRoute;
use crate::transport::{
    BoxFuture, SignalingConnector, SignalingEvent, SignalingLink, SignalingTransport,
};

/// The built-in brokers (MQTT over WebSocket + TLS). Free public services: no account, no promise of uptime — which is
/// why every one is used at once.
pub const PUBLIC_BROKERS: &[&str] = &[
    "wss://broker.emqx.io:8084/mqtt",
    "wss://broker.hivemq.com:8884/mqtt",
    "wss://test.mosquitto.org:8081/mqtt",
];

const KEEP_ALIVE: Duration = Duration::from_secs(30);
const PING_EVERY: Duration = Duration::from_secs(20);

/// Every built-in broker, one route each (to combine with other routes in a [`MultiSignaling`]).
pub fn public_broker_routes() -> Vec<Route> {
    PUBLIC_BROKERS
        .iter()
        .map(|url| Route {
            route: ConnectionRoute::InternetRelay,
            connector: Arc::new(MqttSignaling::new(url)) as Arc<dyn SignalingConnector>,
            lookup: None,
        })
        .collect()
}

/// Every built-in broker as one signaling link.
pub fn public_brokers() -> MultiSignaling {
    MultiSignaling::new(public_broker_routes())
}

enum Outgoing {
    Message(ClientMessage),
    Close,
}

struct MqttLink {
    out: mpsc::Sender<Outgoing>,
}

impl SignalingTransport for MqttLink {
    fn send(&self, message: ClientMessage) -> Result<(), NetError> {
        self.out
            .try_send(Outgoing::Message(message))
            .map_err(|_| NetError::Closed)
    }

    fn close(&self) {
        let _ = self.out.try_send(Outgoing::Close);
    }
}

/// Connects to one MQTT broker at a `wss://` (or `ws://` on this computer) address.
pub struct MqttSignaling {
    url: String,
    proxy: Option<openmind_network::http::HttpProxy>,
    timeout: Duration,
}

impl MqttSignaling {
    /// Uses the proxy OpenMind's own requests use.
    pub fn new(url: &str) -> Self {
        Self {
            url: url.to_string(),
            proxy: openmind_network::http::current(),
            timeout: Duration::from_secs(10),
        }
    }

    /// Connects directly, whatever proxy is in force (tests).
    pub fn direct(url: &str) -> Self {
        Self {
            url: url.to_string(),
            proxy: None,
            timeout: Duration::from_secs(10),
        }
    }
}

type Sink = SplitSink<WebSocketStream<Box<dyn Io>>, Message>;
type Source = SplitStream<WebSocketStream<Box<dyn Io>>>;

fn broker_error(err: impl std::fmt::Display) -> NetError {
    NetError::Signaling(format!("the MQTT broker: {err}"))
}

async fn open_socket(
    url: &str,
    proxy: Option<openmind_network::http::HttpProxy>,
    timeout: Duration,
) -> Result<(Sink, Source), NetError> {
    let stream = route::open(url, proxy, timeout).await?;
    let mut request = url
        .into_client_request()
        .map_err(|e| NetError::Config(e.to_string()))?;
    request
        .headers_mut()
        .insert(SEC_WEBSOCKET_PROTOCOL, HeaderValue::from_static("mqtt"));
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(packet::MAX_PACKET_BYTES);
    config.max_frame_size = Some(packet::MAX_PACKET_BYTES);
    let (socket, _) = tokio::time::timeout(
        timeout,
        tokio_tungstenite::client_async_with_config(request, stream, Some(config)),
    )
    .await
    .map_err(|_| NetError::Timeout("connecting to the signaling relay"))?
    .map_err(broker_error)?;
    Ok(socket.split())
}

/// The next whole MQTT packet (`None`: the broker closed the connection).
async fn next_packet(
    source: &mut Source,
    buffer: &mut Vec<u8>,
) -> Result<Option<Packet>, NetError> {
    loop {
        if let Some(packet) = packet::take(buffer).map_err(broker_error)? {
            return Ok(Some(packet));
        }
        match source.next().await {
            Some(Ok(Message::Binary(data))) => buffer.extend_from_slice(&data),
            Some(Ok(Message::Close(_))) | None => return Ok(None),
            Some(Ok(_)) => {}
            Some(Err(err)) => return Err(broker_error(err)),
        }
    }
}

/// CONNECT, then wait for the broker to accept it.
async fn handshake(
    sink: &mut Sink,
    source: &mut Source,
    timeout: Duration,
) -> Result<Vec<u8>, NetError> {
    let mut id = [0u8; 8];
    getrandom::fill(&mut id).map_err(|e| NetError::Io(e.to_string()))?;
    let keep_alive = u16::try_from(KEEP_ALIVE.as_secs()).unwrap_or(30);
    sink.send(Message::binary(packet::connect(
        &format!("om-{}", hex::encode(id)),
        keep_alive,
    )))
    .await
    .map_err(broker_error)?;
    let mut buffer = Vec::new();
    let accepted = tokio::time::timeout(timeout, async {
        loop {
            match next_packet(source, &mut buffer).await? {
                Some(Packet::ConnAck { code: 0 }) => return Ok(()),
                Some(Packet::ConnAck { code }) => {
                    return Err(broker_error(format!(
                        "refused the connection (code {code})"
                    )))
                }
                Some(_) => {}
                None => return Err(broker_error("closed the connection")),
            }
        }
    });
    accepted
        .await
        .map_err(|_| NetError::Timeout("connecting to the signaling relay"))??;
    Ok(buffer)
}

/// One link's loop: session messages in, broker packets in, timers; ends with `Closed`.
struct Pump {
    sink: Sink,
    room: Room,
    events: mpsc::Sender<SignalingEvent>,
    next_id: u16,
}

impl Pump {
    /// Carries out what the room asked for; `Err` when the broker or the listener is gone.
    async fn act(&mut self, actions: Vec<Action>) -> Result<(), String> {
        for action in actions {
            let bytes = match action {
                Action::Subscribe(topic) => {
                    self.next_id = self.next_id.wrapping_add(1).max(1);
                    packet::subscribe(self.next_id, &topic)
                }
                Action::Publish(topic, payload) => packet::publish(&topic, &payload),
                Action::Event(message) => {
                    self.events
                        .send(SignalingEvent::Message(message))
                        .await
                        .map_err(|_| "nobody is listening".to_string())?;
                    continue;
                }
            };
            self.sink
                .send(Message::binary(bytes))
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    async fn packet(&mut self, packet: Packet) -> Result<(), String> {
        let actions = match packet {
            Packet::SubAck { granted, .. } if granted.iter().any(|g| *g >= 0x80) => {
                return Err("the MQTT broker refused the subscription".into())
            }
            Packet::SubAck { .. } => self.room.subscribed(Instant::now()),
            Packet::Publish { topic, payload } => self.room.inbound(&topic, &payload),
            Packet::ConnAck { .. } | Packet::PingResp | Packet::Other(_) => Vec::new(),
        };
        self.act(actions).await
    }

    async fn run(
        mut self,
        mut source: Source,
        mut buffer: Vec<u8>,
        mut outgoing: mpsc::Receiver<Outgoing>,
    ) {
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        let mut ping = tokio::time::interval(PING_EVERY);
        let reason = loop {
            let step = tokio::select! {
                item = outgoing.recv() => match item {
                    Some(Outgoing::Message(message)) => {
                        let actions = self.room.client(message, Instant::now());
                        self.act(actions).await
                    }
                    Some(Outgoing::Close) | None => {
                        let goodbye = self.room.leave();
                        let _ = self.act(goodbye).await;
                        let _ = self.sink.send(Message::binary(packet::disconnect())).await;
                        let _ = self.sink.close().await;
                        return;
                    }
                },
                packet = next_packet(&mut source, &mut buffer) => match packet {
                    Ok(Some(packet)) => self.packet(packet).await,
                    Ok(None) => Err("the MQTT broker closed the connection".into()),
                    Err(err) => Err(err.to_string()),
                },
                _ = tick.tick() => {
                    let actions = self.room.tick(Instant::now());
                    self.act(actions).await
                }
                _ = ping.tick() => self.sink.send(Message::binary(packet::ping())).await.map_err(|e| e.to_string()),
            };
            if let Err(reason) = step {
                break reason;
            }
        };
        let _ = self.events.send(SignalingEvent::Closed { reason }).await;
    }
}

impl SignalingConnector for MqttSignaling {
    fn connect(&self) -> BoxFuture<'_, Result<SignalingLink, NetError>> {
        Box::pin(async move {
            let (mut sink, mut source) =
                open_socket(&self.url, self.proxy.clone(), self.timeout).await?;
            let buffer = handshake(&mut sink, &mut source, self.timeout).await?;
            let slot = Slot::random().map_err(NetError::Protocol)?;
            let (out, outgoing) = mpsc::channel::<Outgoing>(256);
            let (events, receiver) = mpsc::channel::<SignalingEvent>(256);
            let pump = Pump {
                sink,
                room: Room::new(slot),
                events,
                next_id: 0,
            };
            tokio::spawn(pump.run(source, buffer, outgoing));
            Ok((
                Arc::new(MqttLink { out }) as Arc<dyn SignalingTransport>,
                receiver,
            ))
        })
    }
}
