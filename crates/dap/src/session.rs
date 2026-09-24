//! One DAP conversation with a debug adapter over a pair of byte streams (stdio or a TCP
//! socket — it knows nothing about processes, so tests drive it with pipes). It numbers
//! requests, matches each response to the caller waiting for it, hands events to a listener
//! and answers the adapter's own requests (`startDebugging`, `runInTerminal`).

use std::collections::HashMap;
use std::io::{BufReader, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::Value;

use crate::error::DapError;
use crate::wire::{
    classify, read_frame, request_message, response_message, write_message, Incoming,
};

pub trait SessionEvents: Send + Sync + 'static {
    fn event(&self, name: &str, body: &Value);
    /// The adapter asks us to do something; `Err` is sent back as a failed response.
    fn reverse_request(&self, command: &str, arguments: &Value) -> Result<Value, String>;
    /// The adapter's output ended: it exited or the connection dropped.
    fn closed(&self);
}

type Reply = Result<Value, DapError>;
type Pending = Mutex<HashMap<i64, Sender<Reply>>>;
type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

/// A request that has been sent and whose response is still to come.
pub struct PendingResponse {
    receiver: Receiver<Reply>,
}

impl PendingResponse {
    pub fn wait(self, timeout: Duration) -> Result<Value, DapError> {
        match self.receiver.recv_timeout(timeout) {
            Ok(reply) => reply,
            Err(mpsc::RecvTimeoutError::Timeout) => Err(DapError::Timeout),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(DapError::Closed),
        }
    }
}

pub struct Session {
    writer: SharedWriter,
    pending: Arc<Pending>,
    seq: Arc<AtomicI64>,
    alive: Arc<AtomicBool>,
}

impl Session {
    pub fn start<R, W>(reader: R, writer: W, events: Arc<dyn SessionEvents>) -> Arc<Session>
    where
        R: Read + Send + 'static,
        W: Write + Send + 'static,
    {
        let writer: SharedWriter = Arc::new(Mutex::new(Box::new(writer)));
        let session = Arc::new(Session {
            writer: Arc::clone(&writer),
            pending: Arc::new(Mutex::new(HashMap::new())),
            seq: Arc::new(AtomicI64::new(1)),
            alive: Arc::new(AtomicBool::new(true)),
        });
        let pending = Arc::clone(&session.pending);
        let seq = Arc::clone(&session.seq);
        let alive = Arc::clone(&session.alive);
        thread::spawn(move || {
            read_loop(reader, &writer, &pending, &seq, events.as_ref());
            alive.store(false, Ordering::SeqCst);
            // Dropping the senders wakes every waiting caller with "closed".
            if let Ok(mut pending) = pending.lock() {
                pending.clear();
            }
            events.closed();
        });
        session
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    fn send_raw(&self, message: &Value) -> Result<(), DapError> {
        let mut writer = self.writer.lock().map_err(|_| DapError::Closed)?;
        write_message(&mut *writer, message).map_err(|_| DapError::Closed)
    }

    /// Sends a request without waiting (a `launch` response only arrives after `configurationDone`).
    pub fn send(&self, command: &str, arguments: &Value) -> Result<PendingResponse, DapError> {
        if !self.is_alive() {
            return Err(DapError::Closed);
        }
        let seq = self.seq.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = mpsc::channel();
        self.pending
            .lock()
            .map_err(|_| DapError::Closed)?
            .insert(seq, sender);
        if let Err(err) = self.send_raw(&request_message(seq, command, arguments)) {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&seq);
            }
            return Err(err);
        }
        Ok(PendingResponse { receiver })
    }

    pub fn request(
        &self,
        command: &str,
        arguments: &Value,
        timeout: Duration,
    ) -> Result<Value, DapError> {
        self.send(command, arguments)?.wait(timeout)
    }
}

fn read_loop<R: Read>(
    reader: R,
    writer: &SharedWriter,
    pending: &Pending,
    seq: &AtomicI64,
    events: &dyn SessionEvents,
) {
    let mut reader = BufReader::new(reader);
    loop {
        let message = match read_frame(&mut reader) {
            Ok(Some(message)) => message,
            Ok(None) => return,
            Err(err) => {
                tracing::warn!(%err, "debug adapter stream broke");
                return;
            }
        };
        match classify(&message) {
            Ok(Incoming::Response {
                request_seq,
                success,
                command,
                message,
                body,
            }) => {
                let waiting = pending
                    .lock()
                    .ok()
                    .and_then(|mut map| map.remove(&request_seq));
                if let Some(sender) = waiting {
                    let reply = if success {
                        Ok(body)
                    } else {
                        Err(DapError::Adapter(
                            message.unwrap_or_else(|| format!("{command} failed")),
                        ))
                    };
                    let _ = sender.send(reply);
                }
            }
            Ok(Incoming::Event { event, body }) => events.event(&event, &body),
            Ok(Incoming::Request {
                seq: request_seq,
                command,
                arguments,
            }) => {
                let result = events.reverse_request(&command, &arguments);
                let answer = response_message(
                    seq.fetch_add(1, Ordering::SeqCst),
                    request_seq,
                    &command,
                    result,
                );
                if let Ok(mut writer) = writer.lock() {
                    let _ = write_message(&mut *writer, &answer);
                }
            }
            Err(err) => tracing::warn!(%err, "ignored a malformed debug adapter message"),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::{pipe, BufReader as StdBufReader};
    use std::sync::atomic::AtomicUsize;

    use serde_json::json;

    use super::*;
    use crate::wire::write_message as write;

    #[derive(Default)]
    struct Recorder {
        events: Mutex<Vec<(String, Value)>>,
        reverse: Mutex<Vec<String>>,
        closed: AtomicUsize,
    }

    impl SessionEvents for Recorder {
        fn event(&self, name: &str, body: &Value) {
            if let Ok(mut events) = self.events.lock() {
                events.push((name.into(), body.clone()));
            }
        }
        fn reverse_request(&self, command: &str, _arguments: &Value) -> Result<Value, String> {
            if let Ok(mut reverse) = self.reverse.lock() {
                reverse.push(command.into());
            }
            if command == "startDebugging" {
                Ok(json!({}))
            } else {
                Err("not supported".into())
            }
        }
        fn closed(&self) {
            self.closed.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn rig<F>(script: F) -> (Arc<Session>, Arc<Recorder>)
    where
        F: FnOnce(StdBufReader<std::io::PipeReader>, std::io::PipeWriter) + Send + 'static,
    {
        let (server_in, client_out) = pipe().expect("pipe");
        let (client_in, server_out) = pipe().expect("pipe");
        thread::spawn(move || script(StdBufReader::new(server_in), server_out));
        let events = Arc::new(Recorder::default());
        (
            Session::start(client_in, client_out, events.clone()),
            events,
        )
    }

    fn next(reader: &mut StdBufReader<std::io::PipeReader>) -> Option<Value> {
        read_frame(reader).ok().flatten()
    }

    #[test]
    fn a_request_gets_its_own_response_with_the_sequence_number() {
        let (session, _) = rig(|mut reader, mut writer| {
            while let Some(message) = next(&mut reader) {
                let reply = response_message(
                    100,
                    message["seq"].as_i64().unwrap_or(0),
                    message["command"].as_str().unwrap_or(""),
                    Ok(json!({ "echo": message["command"] })),
                );
                let _ = write(&mut writer, &reply);
            }
        });
        let a = session
            .request("threads", &json!({}), Duration::from_secs(5))
            .expect("a");
        let b = session
            .request("stackTrace", &json!({}), Duration::from_secs(5))
            .expect("b");
        assert_eq!(a["echo"], "threads");
        assert_eq!(b["echo"], "stackTrace");
    }

    #[test]
    fn a_failed_response_is_the_adapters_message() {
        let (session, _) = rig(|mut reader, mut writer| {
            while let Some(message) = next(&mut reader) {
                let reply = response_message(
                    1,
                    message["seq"].as_i64().unwrap_or(0),
                    "evaluate",
                    Err("name 'zz' is not defined".into()),
                );
                let _ = write(&mut writer, &reply);
            }
        });
        let err = session
            .request("evaluate", &json!({}), Duration::from_secs(5))
            .expect_err("failed");
        assert!(matches!(err, DapError::Adapter(text) if text.contains("zz")));
    }

    #[test]
    fn a_launch_can_be_sent_and_its_response_collected_later() {
        let (session, events) = rig(|mut reader, mut writer| {
            let launch = next(&mut reader).expect("launch");
            let _ = write(
                &mut writer,
                &json!({ "seq": 1, "type": "event", "event": "initialized" }),
            );
            let done = next(&mut reader).expect("configurationDone");
            let _ = write(
                &mut writer,
                &response_message(
                    2,
                    done["seq"].as_i64().unwrap_or(0),
                    "configurationDone",
                    Ok(json!({})),
                ),
            );
            let _ = write(
                &mut writer,
                &response_message(
                    3,
                    launch["seq"].as_i64().unwrap_or(0),
                    "launch",
                    Ok(json!({})),
                ),
            );
            while next(&mut reader).is_some() {}
        });
        let launch = session
            .send("launch", &json!({ "program": "C:/My Site/a.py" }))
            .expect("send");
        session
            .request("configurationDone", &json!({}), Duration::from_secs(5))
            .expect("configured");
        launch.wait(Duration::from_secs(5)).expect("launched");
        let events = events.events.lock().expect("events");
        assert_eq!(events[0].0, "initialized");
    }

    #[test]
    fn events_are_forwarded_and_reverse_requests_are_answered() {
        let (answer_tx, answer_rx) = mpsc::channel();
        let (session, events) = rig(move |mut reader, mut writer| {
            let _ = write(
                &mut writer,
                &json!({ "seq": 1, "type": "event", "event": "stopped", "body": { "reason": "breakpoint", "threadId": 1 } }),
            );
            for (seq, command) in [(7, "startDebugging"), (8, "runInTerminal")] {
                let _ = write(
                    &mut writer,
                    &json!({ "seq": seq, "type": "request", "command": command, "arguments": {} }),
                );
                let _ = answer_tx.send(next(&mut reader).expect("answer"));
            }
            while next(&mut reader).is_some() {}
        });
        let started = answer_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("first");
        assert_eq!(started["success"], true);
        assert_eq!(started["request_seq"], 7);
        let refused = answer_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("second");
        assert_eq!(refused["success"], false);
        assert_eq!(refused["message"], "not supported");
        let events = events.events.lock().expect("events");
        assert_eq!(events[0].1["reason"], "breakpoint");
        assert_eq!(events[0].1["threadId"], 1);
        drop(session);
    }

    #[test]
    fn a_silent_adapter_times_out() {
        let (session, _) = rig(|mut reader, _writer| while next(&mut reader).is_some() {});
        let err = session
            .request("continue", &json!({}), Duration::from_millis(100))
            .expect_err("timeout");
        assert!(matches!(err, DapError::Timeout));
    }

    #[test]
    fn when_the_adapter_goes_away_waiting_callers_fail_and_the_owner_is_told() {
        let (session, events) = rig(|mut reader, writer| {
            let _ = next(&mut reader);
            drop(writer);
        });
        let err = session
            .request("next", &json!({}), Duration::from_secs(5))
            .expect_err("closed");
        assert!(matches!(err, DapError::Closed));
        thread::sleep(Duration::from_millis(100));
        assert_eq!(events.closed.load(Ordering::SeqCst), 1);
        assert!(!session.is_alive());
        assert!(matches!(
            session.send("x", &json!({})),
            Err(DapError::Closed)
        ));
    }
}
