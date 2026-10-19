//! Tool calls a model wrote as text. Some local models (Nemotron, Qwen) sometimes put a call into their answer in their
//! own template format instead of the structured `tool_calls` the engine's parser produces — the turn then ended with
//! markup on screen and the action never ran. Two formats are recognised: `<function=NAME><parameter=KEY>value
//! </parameter>…</function>` and `<tool_call>{"name": …, "arguments": {…}}</tool_call>`. Only tools offered in that step
//! are accepted; anything else is left as text.

use serde_json::{Map, Value};

use crate::wire::ToolCall;

/// The calls found in `text` and the text without them. `None` when there is none.
pub fn extract(text: &str, turn: usize, offered: &[String]) -> Option<(String, Vec<ToolCall>)> {
    let mut calls = Vec::new();
    let mut rest = String::new();
    let mut cursor = 0;
    while cursor < text.len() {
        let tail = &text[cursor..];
        let next = [tail.find("<function="), tail.find("<tool_call>")]
            .into_iter()
            .flatten()
            .min();
        let Some(at) = next else {
            rest.push_str(tail);
            break;
        };
        rest.push_str(&tail[..at]);
        let block = &tail[at..];
        let parsed = if block.starts_with("<function=") {
            xml_call(block)
        } else {
            json_call(block)
        };
        match parsed {
            Some((name, arguments, used)) if offered.iter().any(|o| o == &name) => {
                calls.push(ToolCall {
                    id: format!("call_{turn}_text_{}", calls.len()),
                    name,
                    arguments: arguments.to_string(),
                });
                cursor += at + used;
            }
            _ => {
                // Not a usable call: keep the marker as text and look further on.
                let marker = if block.starts_with("<function=") {
                    "<function=".len()
                } else {
                    "<tool_call>".len()
                };
                rest.push_str(&block[..marker]);
                cursor += at + marker;
            }
        }
    }
    if calls.is_empty() {
        return None;
    }
    let cleaned = rest
        .replace("<tool_call>", "")
        .replace("</tool_call>", "")
        .trim()
        .to_string();
    Some((cleaned, calls))
}

/// `<function=NAME>` … `<parameter=KEY>VALUE</parameter>` … `</function>` → (name, arguments, bytes used).
fn xml_call(block: &str) -> Option<(String, Value, usize)> {
    let end = block.find("</function>")?;
    let body = &block[..end];
    let name_end = body.find('>')?;
    let name = body["<function=".len()..name_end].trim().to_string();
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return None;
    }
    let mut arguments = Map::new();
    let mut params = &body[name_end + 1..];
    while let Some(start) = params.find("<parameter=") {
        let after = &params[start + "<parameter=".len()..];
        let key_end = after.find('>')?;
        let key = after[..key_end].trim().to_string();
        let value_part = &after[key_end + 1..];
        let value_end = value_part.find("</parameter>").unwrap_or(value_part.len());
        let raw = value_part[..value_end].trim();
        arguments.insert(key, typed(raw));
        params = &value_part[value_end..];
    }
    Some((name, Value::Object(arguments), end + "</function>".len()))
}

/// A parameter's text as JSON: numbers, booleans, arrays and objects keep their type, everything else is a string.
fn typed(raw: &str) -> Value {
    match serde_json::from_str::<Value>(raw) {
        Ok(value @ (Value::Bool(_) | Value::Number(_) | Value::Array(_) | Value::Object(_))) => {
            value
        }
        _ => Value::String(raw.to_string()),
    }
}

/// `<tool_call>{"name": …, "arguments": …}</tool_call>` → (name, arguments, bytes used).
fn json_call(block: &str) -> Option<(String, Value, usize)> {
    let end = block.find("</tool_call>")?;
    let json: Value = serde_json::from_str(block["<tool_call>".len()..end].trim()).ok()?;
    let name = json.get("name")?.as_str()?.to_string();
    let arguments = match json.get("arguments") {
        Some(Value::String(text)) => serde_json::from_str(text).ok()?,
        Some(value @ Value::Object(_)) => value.clone(),
        None => Value::Object(Map::new()),
        Some(_) => return None,
    };
    Some((name, arguments, end + "</tool_call>".len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn offered() -> Vec<String> {
        ["kill_command", "run_command", "read_file"]
            .iter()
            .map(|s| s.to_string())
            .collect()
    }

    #[test]
    fn the_nemotron_style_call_from_the_live_test_becomes_a_real_call() {
        let text =
            "<function=kill_command> <parameter=id> bg-1 </parameter> </function> </tool_call>";
        let (rest, calls) = extract(text, 3, &offered()).expect("a call");
        assert_eq!(rest, "");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "kill_command");
        assert_eq!(calls[0].id, "call_3_text_0");
        let args: Value = serde_json::from_str(&calls[0].arguments).expect("json");
        assert_eq!(args, serde_json::json!({"id": "bg-1"}));
    }

    #[test]
    fn parameters_keep_numbers_and_booleans_and_text_around_calls_stays() {
        let text = "Starting it.\n<function=run_command>\n<parameter=command>\nnode server.js\n</parameter>\n<parameter=run_in_background>\ntrue\n</parameter>\n<parameter=timeout_seconds>30</parameter>\n</function>\nDone.";
        let (rest, calls) = extract(text, 0, &offered()).expect("a call");
        assert_eq!(rest, "Starting it.\n\nDone.");
        let args: Value = serde_json::from_str(&calls[0].arguments).expect("json");
        assert_eq!(
            args,
            serde_json::json!({"command": "node server.js", "run_in_background": true, "timeout_seconds": 30})
        );
    }

    #[test]
    fn json_tool_calls_are_read_too_with_object_or_string_arguments() {
        let text = r#"<tool_call>{"name": "read_file", "arguments": {"path": "a.js"}}</tool_call><tool_call>{"name": "read_file", "arguments": "{\"path\": \"b.js\"}"}</tool_call>"#;
        let (_, calls) = extract(text, 1, &offered()).expect("calls");
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[1].arguments, r#"{"path":"b.js"}"#);
    }

    #[test]
    fn unknown_tools_and_broken_markup_stay_text() {
        assert!(extract(
            "<function=format_disk><parameter=drive>C</parameter></function>",
            0,
            &offered()
        )
        .is_none());
        assert!(extract(
            "Use <function=read_file> like this, but no closing tag",
            0,
            &offered()
        )
        .is_none());
        assert!(extract("<tool_call>not json</tool_call>", 0, &offered()).is_none());
        assert!(extract("A plain answer.", 0, &offered()).is_none());
    }
}
