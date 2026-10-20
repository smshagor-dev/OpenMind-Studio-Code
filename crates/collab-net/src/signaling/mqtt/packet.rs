//! The few MQTT 3.1.1 packets signaling needs (CONNECT, CONNACK, SUBSCRIBE, SUBACK, PUBLISH at QoS 0, PINGREQ,
//! PINGRESP, DISCONNECT), encoded and decoded by hand: a full client library would bring its own WebSocket and TLS
//! stack, while this rides the signaling WebSocket code (proxy tunnel, Windows' certificate store) as it is.

/// Largest packet accepted from a broker (an encrypted signal is far smaller; anything bigger is not ours).
pub const MAX_PACKET_BYTES: usize = 96 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Packet {
    ConnAck {
        code: u8,
    },
    SubAck {
        id: u16,
        granted: Vec<u8>,
    },
    Publish {
        topic: String,
        payload: Vec<u8>,
    },
    PingResp,
    /// A packet signaling doesn't use (UNSUBACK, a stray PUBACK ...): ignored.
    Other(u8),
}

fn push_len(out: &mut Vec<u8>, mut len: usize) {
    loop {
        let mut byte = (len % 128) as u8;
        len /= 128;
        if len > 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if len == 0 {
            break;
        }
    }
}

fn push_str(out: &mut Vec<u8>, text: &str) {
    let len = u16::try_from(text.len()).unwrap_or(u16::MAX);
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(&text.as_bytes()[..usize::from(len)]);
}

fn frame(kind: u8, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + 5);
    out.push(kind);
    push_len(&mut out, body.len());
    out.extend_from_slice(body);
    out
}

/// CONNECT with a clean session, no will and no login.
pub fn connect(client_id: &str, keep_alive_secs: u16) -> Vec<u8> {
    let mut body = Vec::new();
    push_str(&mut body, "MQTT");
    body.push(4); // protocol level 3.1.1
    body.push(0x02); // clean session
    body.extend_from_slice(&keep_alive_secs.to_be_bytes());
    push_str(&mut body, client_id);
    frame(0x10, &body)
}

/// SUBSCRIBE to one topic at QoS 0.
pub fn subscribe(id: u16, topic: &str) -> Vec<u8> {
    let mut body = id.to_be_bytes().to_vec();
    push_str(&mut body, topic);
    body.push(0);
    frame(0x82, &body)
}

/// PUBLISH at QoS 0, not retained.
pub fn publish(topic: &str, payload: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(topic.len() + payload.len() + 2);
    push_str(&mut body, topic);
    body.extend_from_slice(payload);
    frame(0x30, &body)
}

pub fn ping() -> Vec<u8> {
    vec![0xC0, 0x00]
}

pub fn disconnect() -> Vec<u8> {
    vec![0xE0, 0x00]
}

/// Takes one whole packet off the front of `buffer`. `Ok(None)`: more bytes are needed.
pub fn take(buffer: &mut Vec<u8>) -> Result<Option<Packet>, String> {
    let Some(&first) = buffer.first() else {
        return Ok(None);
    };
    let mut len = 0usize;
    let mut header = 1;
    loop {
        let Some(&byte) = buffer.get(header) else {
            return Ok(None);
        };
        len += usize::from(byte & 0x7F) << (7 * (header - 1));
        header += 1;
        if byte & 0x80 == 0 {
            break;
        }
        if header > 4 {
            return Err("a malformed MQTT length".into());
        }
    }
    if len > MAX_PACKET_BYTES {
        return Err("an MQTT packet larger than signaling allows".into());
    }
    if buffer.len() < header + len {
        return Ok(None);
    }
    let body: Vec<u8> = buffer.drain(..header + len).skip(header).collect();
    parse(first, &body).map(Some)
}

fn two(body: &[u8], at: usize) -> Result<u16, String> {
    match body.get(at..at + 2) {
        Some(&[high, low]) => Ok(u16::from_be_bytes([high, low])),
        _ => Err("a truncated MQTT packet".into()),
    }
}

fn parse(first: u8, body: &[u8]) -> Result<Packet, String> {
    match first >> 4 {
        2 => Ok(Packet::ConnAck {
            code: *body.get(1).ok_or("a truncated MQTT packet")?,
        }),
        9 => Ok(Packet::SubAck {
            id: two(body, 0)?,
            granted: body.get(2..).unwrap_or_default().to_vec(),
        }),
        3 => {
            let qos = (first >> 1) & 0x03;
            let len = usize::from(two(body, 0)?);
            let topic = body.get(2..2 + len).ok_or("a truncated MQTT packet")?;
            let topic = String::from_utf8(topic.to_vec())
                .map_err(|_| "a topic that isn't UTF-8".to_string())?;
            let start = 2 + len + if qos > 0 { 2 } else { 0 };
            let payload = body.get(start..).ok_or("a truncated MQTT packet")?.to_vec();
            Ok(Packet::Publish { topic, payload })
        }
        13 => Ok(Packet::PingResp),
        other => Ok(Packet::Other(other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_publish_round_trips_through_the_buffer_even_when_split() {
        let bytes = publish("a/b", &[7u8; 300]);
        let mut buffer = bytes[..3].to_vec();
        assert_eq!(take(&mut buffer), Ok(None));
        buffer.extend_from_slice(&bytes[3..]);
        buffer.extend_from_slice(&ping());
        assert_eq!(
            take(&mut buffer),
            Ok(Some(Packet::Publish {
                topic: "a/b".into(),
                payload: vec![7u8; 300]
            }))
        );
        assert_eq!(take(&mut buffer), Ok(Some(Packet::Other(12))));
        assert!(buffer.is_empty());
    }

    #[test]
    fn broker_answers_are_read() {
        let mut buffer = vec![
            0x20, 0x02, 0x00, 0x05, 0x90, 0x03, 0x00, 0x07, 0x80, 0xD0, 0x00,
        ];
        assert_eq!(take(&mut buffer), Ok(Some(Packet::ConnAck { code: 5 })));
        assert_eq!(
            take(&mut buffer),
            Ok(Some(Packet::SubAck {
                id: 7,
                granted: vec![0x80]
            }))
        );
        assert_eq!(take(&mut buffer), Ok(Some(Packet::PingResp)));
    }

    #[test]
    fn a_qos1_publish_skips_its_packet_id_and_oversized_packets_are_refused() {
        let mut buffer = vec![0x32, 0x08, 0x00, 0x01, b't', 0x00, 0x09, b'h', b'i', b'!'];
        assert_eq!(
            take(&mut buffer),
            Ok(Some(Packet::Publish {
                topic: "t".into(),
                payload: b"hi!".to_vec()
            }))
        );
        let mut huge = vec![0x30, 0xFF, 0xFF, 0x7F];
        assert!(take(&mut huge).is_err());
    }

    #[test]
    fn connect_and_subscribe_have_the_documented_layout() {
        let packet = connect("om-1", 30);
        assert_eq!(&packet[..2], &[0x10, 16]);
        assert_eq!(&packet[2..8], b"\x00\x04MQTT");
        assert_eq!(&packet[8..12], &[4, 0x02, 0, 30]);
        assert_eq!(subscribe(1, "x"), vec![0x82, 6, 0, 1, 0, 1, b'x', 0]);
    }
}
