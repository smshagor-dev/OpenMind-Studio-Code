//! What crosses the connection to a TURN server, frame by frame.
//!
//! - [`StreamFramer`]: on TCP and TLS, TURN messages and ChannelData frames share one byte stream, and RFC 8656 §12.5
//!   requires ChannelData there to be **padded to a multiple of 4 bytes**. `turn-client-proto` 0.7.3 neither pads what
//!   it sends nor skips the padding of what it receives, so any packet whose length isn't a multiple of 4 (most DTLS
//!   and SCTP packets) desynchronized the stream after the first one. The framer splits the stream into whole frames
//!   and strips the padding before the protocol sees them; [`pad_for_stream`] pads outgoing ChannelData. UDP needs
//!   neither (a datagram is one frame).
//! - [`ServerWatch`]: remembers the server's newest STUN error code, only to say *why* something failed (the library
//!   reports "allocation failed" without it). Nothing here changes what the protocol does.

use turn_client_proto::types::stun::attribute::ErrorCode;
use turn_client_proto::types::stun::message::{Message, MessageClass};

/// The largest frame a stream may carry (STUN and ChannelData lengths are 16-bit), padding included.
const MAX_FRAME: usize = 20 + 65_535;
/// How much of an incomplete frame is kept while waiting for the rest.
const MAX_BUFFERED: usize = 2 * MAX_FRAME;

fn is_channel_data(frame: &[u8]) -> bool {
    frame.first().is_some_and(|b| b >> 6 == 1)
}

/// Pads a ChannelData frame to a multiple of 4 bytes (TCP and TLS); STUN messages are already aligned.
pub(crate) fn pad_for_stream(mut frame: Vec<u8>) -> Vec<u8> {
    if is_channel_data(&frame) {
        frame.resize(frame.len().div_ceil(4) * 4, 0);
    }
    frame
}

/// Splits a TURN byte stream into whole frames; ChannelData comes out without its padding.
#[derive(Debug, Default)]
pub(crate) struct StreamFramer {
    buffer: Vec<u8>,
}

/// The stream carried something that isn't TURN; it can't be followed any more.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct NotTurn;

impl StreamFramer {
    pub(crate) fn push(&mut self, data: &[u8]) -> Result<Vec<Vec<u8>>, NotTurn> {
        self.buffer.extend_from_slice(data);
        let mut frames = Vec::new();
        while self.buffer.len() >= 4 {
            let declared = usize::from(u16::from_be_bytes([self.buffer[2], self.buffer[3]]));
            let (useful, total) = match self.buffer[0] >> 6 {
                0 => (20 + declared, 20 + declared),
                1 => (4 + declared, 4 + declared.div_ceil(4) * 4),
                _ => return Err(NotTurn),
            };
            if self.buffer.len() < total {
                break;
            }
            let frame: Vec<u8> = self.buffer.drain(..total).take(useful).collect();
            frames.push(frame);
        }
        if self.buffer.len() > MAX_BUFFERED {
            return Err(NotTurn);
        }
        Ok(frames)
    }
}

#[derive(Debug, Default)]
pub(crate) struct ServerWatch {
    /// Bytes received from the server at all (none: it never answered).
    pub(crate) received: usize,
    /// The newest STUN error code in an error response.
    pub(crate) last_error: Option<u16>,
    /// Transactions the server answered with 401. The first 401 is the normal challenge (it carries the realm and
    /// nonce); a 401 to a second transaction answers a request that already carried the credentials.
    unauthorized: std::collections::HashSet<u128>,
    /// A final error code: the protocol library would only give up at its own timeout, so the allocation stops here.
    pub(crate) decisive: Option<u16>,
}

impl ServerWatch {
    /// Notes one whole frame from the server.
    pub(crate) fn observe(&mut self, frame: &[u8]) {
        self.received += frame.len();
        let Some((code, transaction)) = error_code(frame) else {
            return;
        };
        self.last_error = Some(code);
        match code {
            // Retried by the protocol itself (the challenge, a stale nonce, a rejected integrity algorithm).
            401 => {
                self.unauthorized.insert(transaction);
                if self.unauthorized.len() > 1 {
                    self.decisive = Some(code);
                }
            }
            438 | 300 => {}
            _ => self.decisive = Some(code),
        }
    }
}

fn error_code(frame: &[u8]) -> Option<(u16, u128)> {
    let message = Message::from_bytes(frame).ok()?;
    if !message.has_class(MessageClass::Error) {
        return None;
    }
    let code = message.attribute::<ErrorCode>().ok()?.code();
    Some((code, u128::from(message.transaction_id())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use turn_client_proto::types::stun::message::{MessageWriteVec, BINDING};
    use turn_client_proto::types::stun::prelude::*;

    fn error_response(code: u16) -> Vec<u8> {
        let request = Message::builder_request(BINDING, MessageWriteVec::new()).finish();
        let request = Message::from_bytes(&request).expect("request");
        let mut response = Message::builder_error(&request, MessageWriteVec::new());
        let error = ErrorCode::builder(code).build().expect("code");
        response.add_attribute(&error).expect("attribute");
        response.finish()
    }

    #[test]
    fn channel_data_is_padded_on_the_way_out_and_unpadded_on_the_way_in() {
        let sent = pad_for_stream(vec![0x40, 0x00, 0x00, 0x03, 1, 2, 3]);
        assert_eq!(sent, vec![0x40, 0x00, 0x00, 0x03, 1, 2, 3, 0]);
        let stun = error_response(401);
        assert_eq!(
            pad_for_stream(stun.clone()),
            stun,
            "STUN is already aligned"
        );

        let mut stream = sent.clone();
        stream.extend(&stun);
        stream.extend(pad_for_stream(vec![0x40, 0x01, 0x00, 0x05, 9, 9, 9, 9, 9]));
        let mut framer = StreamFramer::default();
        let mut frames = Vec::new();
        // Arbitrary chunk boundaries, as TCP delivers them.
        for chunk in stream.chunks(5) {
            frames.extend(framer.push(chunk).expect("TURN"));
        }
        assert_eq!(frames.len(), 3);
        assert_eq!(frames[0], vec![0x40, 0x00, 0x00, 0x03, 1, 2, 3]);
        assert_eq!(frames[1], stun);
        assert_eq!(frames[2], vec![0x40, 0x01, 0x00, 0x05, 9, 9, 9, 9, 9]);
    }

    #[test]
    fn error_codes_are_noted_and_garbage_is_refused() {
        let mut watch = ServerWatch::default();
        watch.observe(&error_response(401));
        assert_eq!(
            (watch.last_error, watch.decisive),
            (Some(401), None),
            "the challenge"
        );
        watch.observe(&error_response(401));
        assert_eq!(
            watch.decisive,
            Some(401),
            "a 401 to the authenticated request"
        );
        let mut watch = ServerWatch::default();
        watch.observe(&error_response(441));
        assert_eq!((watch.last_error, watch.decisive), (Some(441), Some(441)));
        watch.observe(&[0x40, 0, 0, 0]);
        assert_eq!(watch.last_error, Some(441), "ChannelData isn't an error");
        assert_eq!(StreamFramer::default().push(&[0xff; 8]), Err(NotTurn));
    }
}
