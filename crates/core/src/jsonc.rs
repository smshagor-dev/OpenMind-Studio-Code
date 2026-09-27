//! JSON with comments (the format of VS Code's `launch.json` and `tasks.json`): `//` and `/* */` comments and
//! trailing commas are removed so an ordinary JSON parser can read the text. Strings are copied untouched, so a
//! `//` inside a string (a URL) stays. Line breaks inside comments are kept, so a parser's line numbers still match
//! the original file.

/// The text with comments blanked out and trailing commas (before `}` or `]`) removed.
pub fn strip(text: &str) -> String {
    let without_comments = strip_comments(text);
    strip_trailing_commas(&without_comments)
}

fn strip_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;
    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match (c, chars.peek()) {
            ('"', _) => {
                in_string = true;
                out.push(c);
            }
            ('/', Some('/')) => {
                for next in chars.by_ref() {
                    if next == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            ('/', Some('*')) => {
                chars.next();
                let mut previous = '\0';
                for next in chars.by_ref() {
                    if next == '\n' {
                        out.push('\n');
                    }
                    if previous == '*' && next == '/' {
                        break;
                    }
                    previous = next;
                }
            }
            _ => out.push(c),
        }
    }
    out
}

fn strip_trailing_commas(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut in_string = false;
    let mut escaped = false;
    for (index, &c) in chars.iter().enumerate() {
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        if c == '"' {
            in_string = true;
        }
        if c == ',' {
            let next = chars[index + 1..].iter().find(|n| !n.is_whitespace());
            if matches!(next, Some('}' | ']')) {
                continue;
            }
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comments_and_trailing_commas_go_and_strings_stay() {
        let text = "{\n  // a comment\n  \"url\": \"http://x//y\", /* block\n comment */\n  \"list\": [1, 2,],\n}\n";
        let clean = strip(text);
        assert_eq!(clean.lines().count(), text.lines().count());
        assert!(clean.contains("\"http://x//y\""));
        assert!(!clean.contains("comment"));
        assert!(clean.contains("[1, 2]"));
        assert!(!clean.contains(",\n}"));
    }

    #[test]
    fn escaped_quotes_and_commas_inside_strings_are_kept() {
        let clean = strip(r#"{"a": "say \"hi\", ]", "b": [ "x", ]}"#);
        assert_eq!(clean, r#"{"a": "say \"hi\", ]", "b": [ "x" ]}"#);
    }
}
