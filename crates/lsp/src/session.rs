//! One JSON-RPC conversation with a language server over a pair of byte
//! streams. It knows nothing about processes (so tests drive it with pipes):
//! it numbers requests, matches replies to the caller waiting for them, hands
//! notifications to a listener, and answers the server's own requests so the
//! server never stalls waiting for us.

use std::collections::HashMap;
use std::io::{BufReader, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

use crate::error::LspError;
use crate::jsonrpc::{
    self, classify, error_response, notification_message, read_frame, request_message,
    response_message, Incoming, ResponseError,
};
use crate::protocol::reply_to_server_request;

/// What the session tells its owner about.
pub trait SessionEvents: Send + Sync + 'static {
    /// A notification from the server (`textDocument/publishDiagnostics`, `window/logMessage`, ...).
    fn notification(&self, method: &str, params: &Value);
    /// The server's output ended: it exited or crashed.
    fn closed(&self);
}

/// Where the server thinks the workspace is (needed to answer its requests).
#[derive(Debug, Clone)]
pub struct Workspace {
    pub root_uri: String,
    pub root_name: String,
}

type Pending = Mutex<HashMap<i64, Sender<Result<Value, ResponseError>>>>;
type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

pub struct Session {
    writer: SharedWriter,
    pending: Arc<Pending>,
    next_id: AtomicI64,
    alive: Arc<AtomicBool>,
}

impl Session {
    /// Starts reading `reader` on a worker thread.
    pub fn start<R, W>(
        reader: R,
        writer: W,
        workspace: Workspace,
        events: Arc<dyn SessionEvents>,
    ) -> Arc<Session>
    where
        R: Read + Send + 'static,
        W: Write + Send + 'static,
    {
        let writer: SharedWriter = Arc::new(Mutex::new(Box::new(writer)));
        let session = Arc::new(Session {
            writer: Arc::clone(&writer),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicI64::new(1),
            alive: Arc::new(AtomicBool::new(true)),
        });
        let pending = Arc::clone(&session.pending);
        let alive = Arc::clone(&session.alive);
        thread::spawn(move || {
            read_loop(reader, &writer, &pending, &workspace, events.as_ref());
            alive.store(false, Ordering::SeqCst);
            // Dropping the senders wakes every waiting request with "closed".
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

    fn send(&self, message: &Value) -> Result<(), LspError> {
        let mut writer = self.writer.lock().map_err(|_| LspError::Closed)?;
        jsonrpc::write_message(&mut *writer, message).map_err(|_| LspError::Closed)
    }

    pub fn notify(&self, method: &str, params: &Value) -> Result<(), LspError> {
        if !self.is_alive() {
            return Err(LspError::Closed);
        }
        self.send(&notification_message(method, params))
    }

    /// Sends a request and waits for its answer. On timeout the server is told
    /// to cancel it.
    pub fn request(
        &self,
        method: &str,
        params: &Value,
        timeout: Duration,
    ) -> Result<Value, LspError> {
        if !self.is_alive() {
            return Err(LspError::Closed);
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = mpsc::channel();
        self.pending
            .lock()
            .map_err(|_| LspError::Closed)?
            .insert(id, sender);
        if let Err(err) = self.send(&request_message(id, method, params)) {
            self.forget(id);
            return Err(err);
        }
        match receiver.recv_timeout(timeout) {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(LspError::Server(error.message)),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.forget(id);
                let _ = self.notify("$/cancelRequest", &json!({ "id": id }));
                Err(LspError::Timeout)
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(LspError::Closed),
        }
    }

    fn forget(&self, id: i64) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&id);
        }
    }

    /// The polite goodbye: `shutdown`, then `exit`. Errors are ignored — the
    /// caller kills the process afterwards either way.
    pub fn shutdown(&self, timeout: Duration) {
        let _ = self.request("shutdown", &Value::Null, timeout);
        let _ = self.notify("exit", &Value::Null);
    }
}

fn read_loop<R: Read>(
    reader: R,
    writer: &SharedWriter,
    pending: &Pending,
    workspace: &Workspace,
    events: &dyn SessionEvents,
) {
    let mut reader = BufReader::new(reader);
    loop {
        let message = match read_frame(&mut reader) {
            Ok(Some(message)) => message,
            Ok(None) => return,
            Err(err) => {
                tracing::warn!(%err, "language server stream broke");
                return;
            }
        };
        match classify(message) {
            Ok(Incoming::Response { id, result }) => {
                let waiting = pending.lock().ok().and_then(|mut map| map.remove(&id));
                if let Some(sender) = waiting {
                    let _ = sender.send(result);
                }
            }
            Ok(Incoming::Request { id, method, params }) => {
                let answer = match reply_to_server_request(
                    &method,
                    &params,
                    &workspace.root_uri,
                    &workspace.root_name,
                ) {
                    Ok(result) => response_message(&id, result),
                    Err((code, text)) => error_response(&id, code, &text),
                };
                if let Ok(mut writer) = writer.lock() {
                    let _ = jsonrpc::write_message(&mut *writer, &answer);
                }
            }
            Ok(Incoming::Notification { method, params }) => events.notification(&method, &params),
            Err(err) => tracing::warn!(%err, "ignored a malformed language server message"),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::{pipe, BufReader};
    use std::sync::atomic::AtomicUsize;

    use super::*;

    #[derive(Default)]
    struct Recorder {
        notes: Mutex<Vec<(String, Value)>>,
        closed: AtomicUsize,
    }

    impl SessionEvents for Recorder {
        fn notification(&self, method: &str, params: &Value) {
            if let Ok(mut notes) = self.notes.lock() {
                notes.push((method.to_string(), params.clone()));
            }
        }
        fn closed(&self) {
            self.closed.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// A session wired to a scripted "server" running on its own thread.
    fn rig<F>(script: F) -> (Arc<Session>, Arc<Recorder>)
    where
        F: FnOnce(BufReader<std::io::PipeReader>, std::io::PipeWriter) + Send + 'static,
    {
        let (server_in_reader, client_writer) = pipe().expect("pipe");
        let (client_reader, server_out_writer) = pipe().expect("pipe");
        thread::spawn(move || script(BufReader::new(server_in_reader), server_out_writer));
        let events = Arc::new(Recorder::default());
        let session = Session::start(
            client_reader,
            client_writer,
            Workspace {
                root_uri: "file:///C:/My%20Site".into(),
                root_name: "My Site".into(),
            },
            events.clone(),
        );
        (session, events)
    }

    fn read_request(reader: &mut BufReader<std::io::PipeReader>) -> Option<Value> {
        read_frame(reader).ok().flatten()
    }

    #[test]
    fn a_request_gets_the_answer_with_its_own_id() {
        let (session, _) = rig(|mut reader, mut writer| {
            while let Some(message) = read_request(&mut reader) {
                if let Some(id) = message.get("id") {
                    let reply = response_message(id, json!({ "echo": message["method"] }));
                    let _ = jsonrpc::write_message(&mut writer, &reply);
                }
            }
        });
        let one = session
            .request("a/one", &Value::Null, Duration::from_secs(5))
            .expect("one");
        let two = session
            .request("a/two", &Value::Null, Duration::from_secs(5))
            .expect("two");
        assert_eq!(one["echo"], "a/one");
        assert_eq!(two["echo"], "a/two");
    }

    #[test]
    fn replies_that_arrive_out_of_order_reach_the_right_caller() {
        let (session, _) = rig(|mut reader, mut writer| {
            let first = read_request(&mut reader).expect("first");
            let second = read_request(&mut reader).expect("second");
            // Answer the second request before the first.
            for message in [second, first] {
                let reply = response_message(&message["id"], json!(message["method"].clone()));
                let _ = jsonrpc::write_message(&mut writer, &reply);
            }
            while read_request(&mut reader).is_some() {}
        });
        let other = Arc::clone(&session);
        let handle = thread::spawn(move || {
            other
                .request("x/first", &Value::Null, Duration::from_secs(5))
                .expect("first")
        });
        // Make sure the first request is on the wire before the second is sent.
        thread::sleep(Duration::from_millis(100));
        let second = session
            .request("x/second", &Value::Null, Duration::from_secs(5))
            .expect("second");
        assert_eq!(second, json!("x/second"));
        assert_eq!(handle.join().expect("thread"), json!("x/first"));
    }

    #[test]
    fn a_server_error_becomes_an_error_with_its_message() {
        let (session, _) = rig(|mut reader, mut writer| {
            while let Some(message) = read_request(&mut reader) {
                if let Some(id) = message.get("id") {
                    let _ = jsonrpc::write_message(
                        &mut writer,
                        &error_response(id, -32603, "nothing to rename"),
                    );
                }
            }
        });
        let err = session
            .request("textDocument/rename", &Value::Null, Duration::from_secs(5))
            .expect_err("error");
        assert!(matches!(err, LspError::Server(text) if text == "nothing to rename"));
    }

    #[test]
    fn a_silent_server_times_out_and_is_told_to_cancel() {
        let (cancelled_tx, cancelled_rx) = mpsc::channel();
        let (session, _) = rig(move |mut reader, _writer| {
            while let Some(message) = read_request(&mut reader) {
                if message["method"] == "$/cancelRequest" {
                    let _ = cancelled_tx.send(message["params"]["id"].clone());
                }
            }
        });
        let err = session
            .request("slow", &Value::Null, Duration::from_millis(100))
            .expect_err("timeout");
        assert!(matches!(err, LspError::Timeout));
        let id = cancelled_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("cancel");
        assert_eq!(id, json!(1));
    }

    #[test]
    fn notifications_are_forwarded_and_server_requests_are_answered() {
        let (answer_tx, answer_rx) = mpsc::channel();
        let (session, events) = rig(move |mut reader, mut writer| {
            let _ = jsonrpc::write_message(
                &mut writer,
                &notification_message("window/logMessage", &json!({ "message": "hi" })),
            );
            let ask = request_message(
                105,
                "workspace/configuration",
                &json!({ "items": [{}, {}, {}] }),
            );
            let _ = jsonrpc::write_message(&mut writer, &ask);
            let answer = read_request(&mut reader).expect("answer");
            let _ = answer_tx.send(answer);
            while read_request(&mut reader).is_some() {}
        });
        let answer = answer_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("reply");
        assert_eq!(answer["id"], 105);
        assert_eq!(answer["result"], json!([null, null, null]));
        thread::sleep(Duration::from_millis(50));
        let notes = events.notes.lock().expect("notes");
        assert_eq!(notes[0].0, "window/logMessage");
        drop(session);
    }

    #[test]
    fn when_the_server_goes_away_waiting_requests_fail_and_the_owner_is_told() {
        let (session, events) = rig(|mut reader, writer| {
            let _ = read_request(&mut reader);
            drop(writer); // the "process" dies without answering
        });
        let err = session
            .request("anything", &Value::Null, Duration::from_secs(5))
            .expect_err("closed");
        assert!(matches!(err, LspError::Closed));
        thread::sleep(Duration::from_millis(100));
        assert_eq!(events.closed.load(Ordering::SeqCst), 1);
        assert!(!session.is_alive());
        assert!(matches!(
            session.notify("x", &Value::Null),
            Err(LspError::Closed)
        ));
    }
}
