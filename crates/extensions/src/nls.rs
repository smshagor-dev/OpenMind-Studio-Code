//! `package.nls.json`: the display strings of a manifest. A manifest string that is exactly `%key%`
//! (a command title, a setting description, a view name...) is replaced by the bundle's value for `key`,
//! as VS Code does. Only the English bundle is read; a missing key keeps its placeholder.

use std::collections::BTreeMap;

use serde_json::Value;

/// The bundle's strings. Values are either a string or `{ "message": ..., "comment": ... }`.
pub fn parse_bundle(text: &str) -> BTreeMap<String, String> {
    let Ok(Value::Object(object)) =
        serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}'))
    else {
        return BTreeMap::new();
    };
    object
        .into_iter()
        .filter_map(|(key, value)| {
            let text = match value {
                Value::String(text) => text,
                Value::Object(entry) => entry.get("message")?.as_str()?.to_string(),
                _ => return None,
            };
            Some((key, text))
        })
        .collect()
}

/// Replaces every `%key%` string anywhere in `value` with its bundle text.
pub fn localize(value: &mut Value, bundle: &BTreeMap<String, String>) {
    if bundle.is_empty() {
        return;
    }
    match value {
        Value::String(text) => {
            if let Some(key) = text
                .strip_prefix('%')
                .and_then(|rest| rest.strip_suffix('%'))
                .filter(|key| !key.is_empty())
            {
                if let Some(found) = bundle.get(key) {
                    *text = found.clone();
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|item| localize(item, bundle)),
        Value::Object(object) => object.values_mut().for_each(|item| localize(item, bundle)),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn replaces_whole_placeholders_from_both_value_shapes() {
        let bundle = parse_bundle(
            r#"{ "title": "Project Manager", "save": { "message": "Save Project", "comment": ["x"] }, "bad": 3 }"#,
        );
        assert_eq!(bundle.len(), 2);
        let mut manifest = json!({
            "displayName": "%title%",
            "contributes": {
                "commands": [{ "command": "pm.save", "title": "%save%" }],
                "keep": ["%missing%", "100% sure", "%title% and more"]
            }
        });
        localize(&mut manifest, &bundle);
        assert_eq!(manifest["displayName"], json!("Project Manager"));
        assert_eq!(
            manifest["contributes"]["commands"][0]["title"],
            json!("Save Project")
        );
        assert_eq!(
            manifest["contributes"]["keep"],
            json!(["%missing%", "100% sure", "%title% and more"]),
            "only an exact placeholder with a known key is replaced"
        );
    }

    #[test]
    fn a_broken_bundle_changes_nothing() {
        assert!(parse_bundle("{ not json").is_empty());
        assert!(parse_bundle("[1, 2]").is_empty());
    }
}
