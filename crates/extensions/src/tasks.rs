//! `contributes.taskDefinitions`: the task types an extension's task provider serves (Milestone 18). The tasks
//! themselves come from the running extension (`tasks.registerTaskProvider`); this is only what the manifest declares.

use serde::Serialize;
use serde_json::Value;

/// A `contributes.taskDefinitions` entry.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDefinitionContribution {
    #[serde(rename = "type")]
    pub kind: String,
    /// Properties a task of this type must set.
    pub required: Vec<String>,
}

/// The entries of `contributes.taskDefinitions` that name a type; anything else is skipped.
pub fn parse(contributes: &Value) -> Vec<TaskDefinitionContribution> {
    contributes
        .get("taskDefinitions")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|entry| {
            let kind = entry.get("type").and_then(Value::as_str)?.trim();
            (!kind.is_empty()).then(|| TaskDefinitionContribution {
                kind: kind.to_string(),
                required: entry
                    .get("required")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_types_and_required_properties_and_skips_entries_without_a_type() {
        let parsed = parse(&json!({
            "taskDefinitions": [
                {"type": "npmx", "required": ["script", 3]},
                {"type": "  "},
                {"required": ["x"]},
                {"type": "plain"}
            ]
        }));
        assert_eq!(
            parsed,
            [
                TaskDefinitionContribution {
                    kind: "npmx".into(),
                    required: vec!["script".into()]
                },
                TaskDefinitionContribution {
                    kind: "plain".into(),
                    required: vec![]
                },
            ]
        );
        assert!(parse(&json!({})).is_empty());
    }
}
