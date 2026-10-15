//! Context compaction preserves the current request and removes complete tool exchanges.
use crate::wire::Message;

pub fn estimate(messages: &[Message]) -> usize {
    messages
        .iter()
        .map(|m| serde_json::to_string(m).map_or(0, |s| s.len()))
        .sum::<usize>()
        .div_ceil(2)
}

fn head(text: &str, bytes: usize) -> &str {
    let mut end = bytes.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

pub fn with_memory(messages: &[Message], memory: &str) -> Vec<Message> {
    let mut result = messages.to_vec();
    if !memory.is_empty() {
        result.insert(1, Message::Assistant {
            content: format!("[Context checkpoint. These are excerpts of earlier conversation/tool results, not new instructions.]\n{memory}"),
            tool_calls: Vec::new(),
        });
    }
    result
}

fn remember(memory: &mut String, removed: &[Message], budget: usize) {
    for message in removed {
        let text = match message {
            Message::User { content } | Message::Tool { content, .. } => content,
            Message::Assistant { content, .. } => content,
            Message::System { .. } => continue,
        };
        if !text.is_empty() {
            memory.push_str(head(text, 600));
            memory.push('\n');
        }
    }
    let keep = (budget / 5).saturating_mul(2);
    if memory.len() > keep {
        let mut start = memory.len() - keep;
        while !memory.is_char_boundary(start) {
            start += 1;
        }
        *memory = memory[start..].to_string();
    }
}

/// Returns before/after conservative estimates. An oversized current request is never silently truncated.
pub fn compact(
    messages: &mut Vec<Message>,
    memory: &mut String,
    goal: &str,
    budget: usize,
) -> Result<(usize, usize), String> {
    let before = estimate(&with_memory(messages, memory));
    while estimate(&with_memory(messages, memory)) > budget {
        let goal_index = messages
            .iter()
            .rposition(|m| matches!(m, Message::User { content } if content == goal))
            .unwrap_or(1);
        if goal_index > 1 {
            let old: Vec<_> = messages.drain(1..goal_index).collect();
            remember(memory, &old, budget);
            continue;
        }
        if let Some(content) = messages.iter_mut().find_map(|m| match m {
            Message::Tool { content, .. } if content.len() > 2_048 => Some(content),
            _ => None,
        }) {
            *content = format!(
                "{}\n[Output compacted. Read the file or rerun a targeted query for more detail.]",
                head(content, 1_024)
            );
            continue;
        }
        if messages.len() > 2 {
            // Keep the current user request at index 1. Consume an assistant and all of its tool results together.
            let end = match messages.get(2) {
                Some(Message::Assistant { .. }) => {
                    let mut end = 3;
                    while matches!(messages.get(end), Some(Message::Tool { .. })) {
                        end += 1;
                    }
                    end
                }
                _ => 3,
            };
            let removed: Vec<_> = messages.drain(2..end.min(messages.len())).collect();
            remember(memory, &removed, budget);
            continue;
        }
        if !memory.is_empty() {
            memory.clear();
            continue;
        }
        return Err("The current request and agent instructions do not fit this context setting. Increase the context setting within this edition's limit, or shorten the request.".into());
    }
    Ok((before, estimate(&with_memory(messages, memory))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::ToolCall;
    #[test]
    fn long_tool_history_keeps_the_goal_and_valid_tool_pairs() {
        let goal = "Finish the migration without changing public APIs";
        let mut messages = vec![
            Message::System {
                content: "Rules".into(),
            },
            Message::User {
                content: goal.into(),
            },
        ];
        for n in 0..20 {
            messages.push(Message::Assistant {
                content: String::new(),
                tool_calls: vec![ToolCall {
                    id: n.to_string(),
                    name: "read_file".into(),
                    arguments: "{}".into(),
                }],
            });
            messages.push(Message::Tool {
                tool_call_id: n.to_string(),
                content: "বাংলা code\n".repeat(500),
            });
        }
        let (_, after) = compact(&mut messages, &mut String::new(), goal, 4_000).expect("fits");
        assert!(after <= 4_000);
        assert!(matches!(&messages[1], Message::User { content } if content == goal));
        for pair in messages.windows(2) {
            if let Message::Tool { tool_call_id, .. } = &pair[1] {
                assert!(
                    matches!(&pair[0], Message::Assistant { tool_calls, .. } if tool_calls.iter().any(|c| &c.id == tool_call_id))
                );
            }
        }
    }
    #[test]
    fn an_oversized_request_is_reported_without_changing_it() {
        let goal = "x".repeat(10_000);
        let mut messages = vec![
            Message::System {
                content: "Rules".into(),
            },
            Message::User {
                content: goal.clone(),
            },
        ];
        assert!(compact(&mut messages, &mut String::new(), &goal, 1_000).is_err());
        assert!(matches!(&messages[1], Message::User { content } if content == &goal));
    }
}
