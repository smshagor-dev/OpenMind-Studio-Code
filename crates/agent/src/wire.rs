//! The OpenAI-compatible chat format with tools, as pure functions: the request body, and a stream reader that
//! rebuilds tool calls from their pieces. llama.cpp's server speaks it (Nemotron's native tool calls come back as
//! `tool_calls`), and so does any OpenAI-compatible provider.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// One message of the conversation as the model sees it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "lowercase")]
pub enum Message {
    System {
        content: String,
    },
    User {
        content: String,
    },
    Assistant {
        #[serde(default)]
        content: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        tool_calls: Vec<ToolCall>,
    },
    Tool {
        tool_call_id: String,
        content: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// The arguments as the model wrote them (JSON text, possibly invalid).
    pub arguments: String,
}

/// The tool call in the shape the API expects inside an assistant message.
fn wire_call(call: &ToolCall) -> Value {
    json!({
        "id": call.id,
        "type": "function",
        "function": {"name": call.name, "arguments": call.arguments},
    })
}

fn wire_message(message: &Message) -> Value {
    match message {
        Message::System { content } => json!({"role": "system", "content": content}),
        Message::User { content } => json!({"role": "user", "content": content}),
        Message::Assistant {
            content,
            tool_calls,
        } => {
            let mut value = json!({"role": "assistant", "content": content});
            if !tool_calls.is_empty() {
                value["tool_calls"] = Value::Array(tool_calls.iter().map(wire_call).collect());
            }
            value
        }
        Message::Tool {
            tool_call_id,
            content,
        } => json!({"role": "tool", "tool_call_id": tool_call_id, "content": content}),
    }
}

/// The streamed chat request body.
pub fn request_body(model: &str, messages: &[Message], tools: &Value, max_tokens: u32) -> Value {
    let mut body = json!({
        "model": model,
        "messages": messages.iter().map(wire_message).collect::<Vec<_>>(),
        "tools": tools,
        "tool_choice": "auto",
        "stream": true,
        "stream_options": {"include_usage": true},
        "temperature": 0.6,
    });
    if max_tokens != 0 {
        body["max_tokens"] = json!(max_tokens);
    }
    body
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
}

/// What one line of the stream added.
#[derive(Debug, Clone, PartialEq)]
pub enum Delta {
    Text(String),
    Reasoning(String),
    /// A tool call started (its name is known).
    ToolStarted {
        index: usize,
        name: String,
    },
    Usage(Usage),
    Done,
    Error(String),
    Nothing,
}

#[derive(Debug, Default, Clone)]
struct PartialCall {
    id: String,
    name: String,
    arguments: String,
}

/// Collects a streamed answer: its text, thinking, tool calls and why it stopped.
#[derive(Debug, Default, Clone)]
pub struct StreamState {
    pub text: String,
    pub reasoning: String,
    calls: Vec<PartialCall>,
    pub finish_reason: Option<String>,
    pub usage: Option<Usage>,
}

impl StreamState {
    /// Reads one `data:` line. Returns what changed, for the panel to show as it arrives.
    pub fn feed(&mut self, line: &str) -> Vec<Delta> {
        let Some(data) = line.trim().strip_prefix("data:") else {
            return vec![Delta::Nothing];
        };
        let data = data.trim();
        if data == "[DONE]" {
            return vec![Delta::Done];
        }
        let Ok(value) = serde_json::from_str::<Value>(data) else {
            return vec![Delta::Nothing];
        };
        if let Some(message) = value.pointer("/error/message").and_then(Value::as_str) {
            return vec![Delta::Error(message.to_string())];
        }
        let mut out = Vec::new();
        if let Some(usage) = value.get("usage").filter(|u| !u.is_null()) {
            let usage = Usage {
                prompt_tokens: usage["prompt_tokens"].as_u64().unwrap_or(0),
                completion_tokens: usage["completion_tokens"].as_u64().unwrap_or(0),
            };
            self.usage = Some(usage.clone());
            out.push(Delta::Usage(usage));
        }
        let Some(choice) = value.pointer("/choices/0") else {
            return out;
        };
        let delta = &choice["delta"];
        if let Some(text) = delta["reasoning_content"]
            .as_str()
            .filter(|t| !t.is_empty())
        {
            self.reasoning.push_str(text);
            out.push(Delta::Reasoning(text.to_string()));
        }
        if let Some(text) = delta["content"].as_str().filter(|t| !t.is_empty()) {
            self.text.push_str(text);
            out.push(Delta::Text(text.to_string()));
        }
        if let Some(calls) = delta["tool_calls"].as_array() {
            for call in calls {
                if let Some(started) = self.feed_call(call) {
                    out.push(started);
                }
            }
        }
        if let Some(reason) = choice["finish_reason"].as_str() {
            self.finish_reason = Some(reason.to_string());
        }
        out
    }

    fn feed_call(&mut self, call: &Value) -> Option<Delta> {
        let index = call["index"].as_u64().unwrap_or(self.calls.len() as u64) as usize;
        if index > 63 {
            return None;
        }
        while self.calls.len() <= index {
            self.calls.push(PartialCall::default());
        }
        let slot = &mut self.calls[index];
        if let Some(id) = call["id"].as_str() {
            slot.id = id.to_string();
        }
        let mut started = None;
        if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
            if slot.name.is_empty() && !name.is_empty() {
                started = Some(Delta::ToolStarted {
                    index,
                    name: name.to_string(),
                });
            }
            slot.name.push_str(name);
        }
        if let Some(args) = call.pointer("/function/arguments").and_then(Value::as_str) {
            slot.arguments.push_str(args);
        }
        started
    }

    /// The finished tool calls, each with an id (one is made up when the server sent none).
    pub fn tool_calls(&self, turn: usize) -> Vec<ToolCall> {
        self.calls
            .iter()
            .enumerate()
            .filter(|(_, c)| !c.name.is_empty())
            .map(|(i, c)| ToolCall {
                id: if c.id.is_empty() {
                    format!("call_{turn}_{i}")
                } else {
                    c.id.clone()
                },
                name: c.name.clone(),
                arguments: if c.arguments.trim().is_empty() {
                    "{}".into()
                } else {
                    c.arguments.clone()
                },
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_calls_are_rebuilt_from_their_pieces() {
        let mut state = StreamState::default();
        let lines = [
            r#"data: {"choices":[{"index":0,"delta":{"role":"assistant","content":null}}]}"#,
            r#"data: {"choices":[{"index":0,"delta":{"reasoning_content":"I need"}}]}"#,
            r#"data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"abc","type":"function","function":{"name":"edit_file","arguments":"{"}}]}}]}"#,
            r#"data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"path\":\"src/main.py\"}"}}]}}]}"#,
            r#"data: {"choices":[{"finish_reason":"tool_calls","index":0,"delta":{}}]}"#,
            r#"data: {"choices":[],"usage":{"prompt_tokens":427,"completion_tokens":60}}"#,
            "data: [DONE]",
        ];
        let mut deltas = Vec::new();
        for line in lines {
            deltas.extend(state.feed(line));
        }
        assert!(deltas.contains(&Delta::Reasoning("I need".into())));
        assert!(deltas.contains(&Delta::ToolStarted {
            index: 0,
            name: "edit_file".into()
        }));
        assert_eq!(deltas.last(), Some(&Delta::Done));
        assert_eq!(state.finish_reason.as_deref(), Some("tool_calls"));
        assert_eq!(state.usage.as_ref().map(|u| u.prompt_tokens), Some(427));
        assert_eq!(
            state.tool_calls(1),
            vec![ToolCall {
                id: "abc".into(),
                name: "edit_file".into(),
                arguments: r#"{"path":"src/main.py"}"#.into()
            }]
        );
    }

    #[test]
    fn text_answers_and_errors_are_read() {
        let mut state = StreamState::default();
        state.feed(r#"data: {"choices":[{"delta":{"content":"Hello"}}]}"#);
        state.feed(r#"data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}"#);
        assert_eq!(state.text, "Hello world");
        assert!(state.tool_calls(0).is_empty());
        let error = state.feed(r#"data: {"error":{"message":"context is full"}}"#);
        assert_eq!(error, vec![Delta::Error("context is full".into())]);
        assert_eq!(state.feed(": keep-alive"), vec![Delta::Nothing]);
    }

    #[test]
    fn a_call_without_an_id_gets_one() {
        let mut state = StreamState::default();
        state.feed(
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"list_dir"}}]}}]}"#,
        );
        let calls = state.tool_calls(3);
        assert_eq!(calls[0].id, "call_3_0");
        assert_eq!(calls[0].arguments, "{}");
    }

    #[test]
    fn automatic_output_does_not_send_a_zero_or_fixed_max_tokens_field() {
        let prompt = "বাংলা".repeat(100_000);
        let body = request_body(
            "m",
            &[Message::User { content: prompt.clone() }],
            &json!([]),
            0,
        );
        assert!(body.get("max_tokens").is_none());
        assert_eq!(body["messages"][0]["content"], prompt);
        assert_eq!(
            request_body("m", &[], &json!([]), 100_000)["max_tokens"],
            100_000
        );
    }

    #[test]
    fn the_request_carries_tools_and_the_whole_conversation() {
        let messages = vec![
            Message::System {
                content: "sys".into(),
            },
            Message::User {
                content: "fix it".into(),
            },
            Message::Assistant {
                content: String::new(),
                tool_calls: vec![ToolCall {
                    id: "c1".into(),
                    name: "read_file".into(),
                    arguments: "{}".into(),
                }],
            },
            Message::Tool {
                tool_call_id: "c1".into(),
                content: "text".into(),
            },
        ];
        let body = request_body("m", &messages, &json!([{"type": "function"}]), 4096);
        assert_eq!(body["stream"], true);
        assert_eq!(
            body["messages"][2]["tool_calls"][0]["function"]["name"],
            "read_file"
        );
        assert_eq!(body["messages"][3]["role"], "tool");
        assert_eq!(body["messages"][3]["tool_call_id"], "c1");
        assert_eq!(body["tools"][0]["type"], "function");
    }
}

