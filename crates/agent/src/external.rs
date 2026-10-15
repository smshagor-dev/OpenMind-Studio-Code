//! Optional host tools retain the same approval, cancellation and transcript lifecycle as file tools.
use crate::policy::Policy;
use crate::tools::{Outcome, ToolKind};
use crate::wire::{Message, ToolCall};
use crate::{AgentEvent, AgentHost, Decision, PermissionRequest};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone)]
pub struct ExternalTool {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    pub kind: ToolKind,
    pub read_only: bool,
}
impl ExternalTool {
    pub fn schema(&self) -> Value {
        serde_json::json!({"type":"function","function":{"name":self.name,"description":self.description,"parameters":self.parameters}})
    }
}

pub fn run(
    call: &ToolCall,
    tool: &ExternalTool,
    policy: &mut Policy,
    host: &dyn AgentHost,
    cancel: &AtomicBool,
    messages: &mut Vec<Message>,
) -> Option<(String, Option<String>)> {
    host.emit(AgentEvent::ToolStart {
        id: call.id.clone(),
        name: call.name.clone(),
        kind: tool.kind,
        title: call.name.clone(),
        target: call.arguments.chars().take(600).collect(),
    });
    let mut ending = None;
    let result = if cancel.load(Ordering::Relaxed) {
        Outcome::failed("Cancelled")
    } else if policy.must_ask(tool.kind, &format!("{}:{}", call.name, call.arguments)) {
        let answer = host.ask(
            PermissionRequest {
                id: call.id.clone(),
                kind: tool.kind,
                title: call.name.clone(),
                target: call.arguments.clone(),
                diff: None,
            },
            cancel,
        );
        if matches!(answer, Decision::Deny { .. }) || cancel.load(Ordering::Relaxed) {
            ending = Some((
                if cancel.load(Ordering::Relaxed) {
                    "cancelled"
                } else {
                    "rejected"
                }
                .into(),
                None,
            ));
            Outcome::failed("The user declined this external operation. Do not retry it.")
        } else {
            policy.remember(
                tool.kind,
                &format!("{}:{}", call.name, call.arguments),
                &answer,
            );
            host.external_call(call, cancel)
        }
    } else {
        host.external_call(call, cancel)
    };
    host.emit(AgentEvent::ToolEnd {
        id: call.id.clone(),
        ok: result.ok,
        summary: result.summary.clone(),
        preview: result.for_model.chars().take(1200).collect(),
        diff: None,
        changed: None,
    });
    messages.push(Message::Tool {
        tool_call_id: call.id.clone(),
        content: result.for_model,
    });
    ending
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Mode;
    use std::sync::Mutex;
    struct Host {
        allowed: bool,
        calls: Mutex<u32>,
        asks: Mutex<u32>,
        events: Mutex<Vec<AgentEvent>>,
    }
    impl AgentHost for Host {
        fn emit(&self, event: AgentEvent) {
            self.events.lock().unwrap().push(event);
        }
        fn ask(&self, _: PermissionRequest, _: &AtomicBool) -> Decision {
            *self.asks.lock().unwrap() += 1;
            if self.allowed {
                Decision::Allow
            } else {
                Decision::Deny { feedback: None }
            }
        }
        fn external_call(&self, _: &ToolCall, _: &AtomicBool) -> Outcome {
            *self.calls.lock().unwrap() += 1;
            Outcome {
                ok: true,
                summary: "found".into(),
                for_model: "untrusted results".into(),
                diff: None,
                change: None,
                todos: None,
            }
        }
    }
    type Exercise = (Host, Option<(String, Option<String>)>, Vec<Message>);
    fn exercise(
        mode: Mode,
        allowed: bool,
        cancelled: bool,
    ) -> Exercise {
        let host = Host {
            allowed,
            calls: Mutex::new(0),
            asks: Mutex::new(0),
            events: Mutex::new(Vec::new()),
        };
        let tool = ExternalTool {
            name: "web_search".into(),
            description: "Search".into(),
            parameters: serde_json::json!({}),
            kind: ToolKind::Command,
            read_only: true,
        };
        let call = ToolCall {
            id: "search1".into(),
            name: tool.name.clone(),
            arguments: "{\"query\":\"docs\"}".into(),
        };
        let mut messages = Vec::new();
        let end = run(
            &call,
            &tool,
            &mut Policy::new(mode),
            &host,
            &AtomicBool::new(cancelled),
            &mut messages,
        );
        (host, end, messages)
    }
    #[test]
    fn permission_denial_prevents_network_dispatch_and_finishes_the_tool() {
        let (host, end, messages) = exercise(Mode::Ask, false, false);
        assert_eq!(*host.calls.lock().unwrap(), 0);
        assert_eq!(*host.asks.lock().unwrap(), 1);
        assert_eq!(end.unwrap().0, "rejected");
        assert_eq!(messages.len(), 1);
        assert!(matches!(
            host.events.lock().unwrap().last(),
            Some(AgentEvent::ToolEnd { ok: false, .. })
        ));
    }
    #[test]
    fn auto_dispatches_and_cancelled_calls_never_dispatch() {
        let (host, end, _) = exercise(Mode::Auto, true, false);
        assert_eq!(*host.calls.lock().unwrap(), 1);
        assert!(end.is_none());
        assert_eq!(*host.asks.lock().unwrap(), 0);
        let (host, _, _) = exercise(Mode::Auto, true, true);
        assert_eq!(*host.calls.lock().unwrap(), 0);
    }
}
