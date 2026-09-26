//! The built-in JSON / JSONC formatter. It needs no external tool and no language server.
//!
//! It is tolerant the way VS Code's JSON editing is (comments and trailing commas are accepted and kept — that is what
//! `tsconfig.json` and friends contain) but strict about structure: anything that is not a JSON value tree is refused
//! with a message and a line/column, and then nothing is changed. Strings and numbers are copied verbatim, key order is
//! kept, every object member and array element goes on its own line, empty containers stay `{}` / `[]`.

use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{message} (line {line}, column {column})")]
pub struct JsonError {
    pub message: String,
    pub line: usize,
    pub column: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    LBrace,
    RBrace,
    LBracket,
    RBracket,
    Comma,
    Colon,
    Str,
    Literal,
    LineComment,
    BlockComment,
}

#[derive(Debug, Clone, Copy)]
struct Token {
    kind: Kind,
    start: usize,
    end: usize,
    line: usize,
    column: usize,
    /// A line break lies between the previous token and this one.
    newline_before: bool,
}

const MAX_DEPTH: usize = 256;

fn error(message: impl Into<String>, token: &Token) -> JsonError {
    JsonError {
        message: message.into(),
        line: token.line,
        column: token.column,
    }
}

struct Lexer<'a> {
    text: &'a str,
    pos: usize,
    line: usize,
    column: usize,
}

impl Lexer<'_> {
    fn peek(&self) -> Option<char> {
        self.text[self.pos..].chars().next()
    }

    fn bump(&mut self) -> Option<char> {
        let c = self.peek()?;
        self.pos += c.len_utf8();
        if c == '\n' {
            self.line += 1;
            self.column = 1;
        } else {
            self.column += 1;
        }
        Some(c)
    }

    fn token(&self, kind: Kind, start: usize, line: usize, column: usize, nl: bool) -> Token {
        Token {
            kind,
            start,
            end: self.pos,
            line,
            column,
            newline_before: nl,
        }
    }

    fn string(&mut self, at: &Token) -> Result<(), JsonError> {
        self.bump();
        loop {
            match self.bump() {
                Some('"') => return Ok(()),
                Some('\\') => {
                    self.bump();
                }
                Some('\n') | None => return Err(error("Unterminated string", at)),
                Some(_) => {}
            }
        }
    }

    fn block_comment(&mut self, at: &Token) -> Result<(), JsonError> {
        self.bump();
        self.bump();
        loop {
            match self.bump() {
                Some('*') if self.peek() == Some('/') => {
                    self.bump();
                    return Ok(());
                }
                Some(_) => {}
                None => return Err(error("Unterminated comment", at)),
            }
        }
    }

    fn slash(&mut self, probe: &Token) -> Result<Kind, JsonError> {
        match self.text[self.pos..].chars().nth(1) {
            Some('/') => {
                while self.peek().is_some_and(|c| c != '\n') {
                    self.bump();
                }
                Ok(Kind::LineComment)
            }
            Some('*') => {
                self.block_comment(probe)?;
                Ok(Kind::BlockComment)
            }
            _ => Err(error("Unexpected '/'", probe)),
        }
    }

    fn next(&mut self) -> Result<Option<Token>, JsonError> {
        let mut newline = false;
        while let Some(c) = self.peek() {
            if !c.is_whitespace() {
                break;
            }
            newline |= c == '\n';
            self.bump();
        }
        let (start, line, column) = (self.pos, self.line, self.column);
        let Some(c) = self.peek() else {
            return Ok(None);
        };
        let probe = self.token(Kind::Literal, start, line, column, newline);
        let kind = match c {
            '{' | '}' | '[' | ']' | ',' | ':' => {
                self.bump();
                match c {
                    '{' => Kind::LBrace,
                    '}' => Kind::RBrace,
                    '[' => Kind::LBracket,
                    ']' => Kind::RBracket,
                    ',' => Kind::Comma,
                    _ => Kind::Colon,
                }
            }
            '"' => {
                self.string(&probe)?;
                Kind::Str
            }
            '/' => self.slash(&probe)?,
            _ => {
                while self
                    .peek()
                    .is_some_and(|c| !c.is_whitespace() && !"{}[],:\"/".contains(c))
                {
                    self.bump();
                }
                Kind::Literal
            }
        };
        Ok(Some(self.token(kind, start, line, column, newline)))
    }
}

fn tokenize(text: &str) -> Result<Vec<Token>, JsonError> {
    let mut lexer = Lexer {
        text,
        pos: 0,
        line: 1,
        column: 1,
    };
    let mut tokens = Vec::new();
    while let Some(token) = lexer.next()? {
        tokens.push(token);
    }
    Ok(tokens)
}

fn is_number(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut i = usize::from(bytes.first() == Some(&b'-'));
    let digits = |from: usize| {
        bytes[from.min(bytes.len())..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count()
    };
    match bytes.get(i) {
        Some(b'0') => i += 1,
        Some(b'1'..=b'9') => i += digits(i),
        _ => return false,
    }
    if bytes.get(i) == Some(&b'.') {
        let n = digits(i + 1);
        if n == 0 {
            return false;
        }
        i += 1 + n;
    }
    if matches!(bytes.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(bytes.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let n = digits(i);
        if n == 0 {
            return false;
        }
        i += n;
    }
    i == bytes.len()
}

/// Checks that the significant tokens (comments skipped) form exactly one JSON value.
struct Checker<'a> {
    text: &'a str,
    tokens: Vec<Token>,
    pos: usize,
}

impl Checker<'_> {
    fn peek(&self) -> Option<Token> {
        self.tokens.get(self.pos).copied()
    }

    fn end_error(&self, expected: &str) -> JsonError {
        let last = self.tokens.last().copied();
        JsonError {
            message: format!("Unexpected end of the document, expected {expected}"),
            line: last.map_or(1, |t| t.line),
            column: last.map_or(1, |t| t.column + (t.end - t.start)),
        }
    }

    fn unexpected(&self, token: &Token, expected: &str) -> JsonError {
        let short: String = self.text[token.start..token.end].chars().take(20).collect();
        error(format!("Unexpected '{short}', expected {expected}"), token)
    }

    fn need(&self, expected: &str) -> Result<Token, JsonError> {
        self.peek().ok_or_else(|| self.end_error(expected))
    }

    fn value(&mut self, depth: usize) -> Result<(), JsonError> {
        let token = self.need("a value")?;
        if depth > MAX_DEPTH {
            return Err(error("The nesting is too deep", &token));
        }
        self.pos += 1;
        match token.kind {
            Kind::LBrace => self.members(depth),
            Kind::LBracket => self.elements(depth),
            Kind::Str => Ok(()),
            Kind::Literal => {
                let raw = &self.text[token.start..token.end];
                if matches!(raw, "true" | "false" | "null") || is_number(raw) {
                    Ok(())
                } else {
                    Err(self.unexpected(&token, "a value"))
                }
            }
            _ => Err(self.unexpected(&token, "a value")),
        }
    }

    /// After an item: a comma (skipped) or the closing token (left for the caller).
    fn separator(&mut self, close: Kind, expected: &str) -> Result<(), JsonError> {
        let next = self.need(expected)?;
        if next.kind == Kind::Comma {
            self.pos += 1;
            Ok(())
        } else if next.kind == close {
            Ok(())
        } else {
            Err(self.unexpected(&next, expected))
        }
    }

    fn members(&mut self, depth: usize) -> Result<(), JsonError> {
        loop {
            let key = self.need("'}'")?;
            match key.kind {
                Kind::RBrace => {
                    self.pos += 1;
                    return Ok(());
                }
                Kind::Str => self.pos += 1,
                _ => return Err(self.unexpected(&key, "a property name in double quotes")),
            }
            let colon = self.need("':'")?;
            if colon.kind != Kind::Colon {
                return Err(self.unexpected(&colon, "':' after the property name"));
            }
            self.pos += 1;
            self.value(depth + 1)?;
            self.separator(Kind::RBrace, "',' or '}'")?;
        }
    }

    fn elements(&mut self, depth: usize) -> Result<(), JsonError> {
        loop {
            let next = self.need("']'")?;
            if next.kind == Kind::RBracket {
                self.pos += 1;
                return Ok(());
            }
            self.value(depth + 1)?;
            self.separator(Kind::RBracket, "',' or ']'")?;
        }
    }
}

fn validate(text: &str, tokens: &[Token]) -> Result<(), JsonError> {
    let significant: Vec<Token> = tokens
        .iter()
        .filter(|t| !matches!(t.kind, Kind::LineComment | Kind::BlockComment))
        .copied()
        .collect();
    let mut checker = Checker {
        text,
        tokens: significant,
        pos: 0,
    };
    checker.value(0)?;
    match checker.peek() {
        None => Ok(()),
        Some(extra) => Err(error(
            "Unexpected content after the end of the JSON value",
            &extra,
        )),
    }
}

struct Printer<'a> {
    text: &'a str,
    indent: &'a str,
    out: String,
    level: usize,
    pending_newline: bool,
    need_space: bool,
}

impl Printer<'_> {
    fn flush(&mut self) {
        if self.pending_newline {
            self.out.push('\n');
            for _ in 0..self.level {
                self.out.push_str(self.indent);
            }
            self.pending_newline = false;
        }
    }

    fn raw(&self, token: &Token) -> &str {
        &self.text[token.start..token.end]
    }

    fn word(&mut self, token: &Token) {
        self.flush();
        if self.need_space {
            self.out.push(' ');
            self.need_space = false;
        }
        let raw = self.raw(token).to_string();
        self.out.push_str(&raw);
    }

    fn comment(&mut self, token: &Token) {
        let own_line = token.newline_before || self.out.is_empty();
        if own_line {
            self.pending_newline = !self.out.is_empty();
            self.flush();
        } else if !self.out.ends_with([' ', '\n']) {
            self.out.push(' ');
        }
        let raw = self.raw(token).to_string();
        self.out.push_str(&raw);
        self.need_space = false;
        if token.kind == Kind::LineComment || own_line {
            self.pending_newline = true;
        } else {
            self.need_space = true;
        }
    }

    fn open(&mut self, tokens: &[Token], i: usize) -> usize {
        let token = tokens[i];
        self.word(&token);
        let close = if token.kind == Kind::LBrace {
            Kind::RBrace
        } else {
            Kind::RBracket
        };
        match tokens.get(i + 1) {
            Some(next) if next.kind == close => {
                let raw = self.raw(next).to_string();
                self.out.push_str(&raw);
                i + 1
            }
            _ => {
                self.level += 1;
                self.pending_newline = true;
                i
            }
        }
    }

    fn run(&mut self, tokens: &[Token]) {
        let mut i = 0;
        while i < tokens.len() {
            let token = tokens[i];
            match token.kind {
                Kind::LBrace | Kind::LBracket => i = self.open(tokens, i),
                Kind::RBrace | Kind::RBracket => {
                    self.level = self.level.saturating_sub(1);
                    self.pending_newline = true;
                    self.need_space = false;
                    self.word(&token);
                }
                Kind::Comma => {
                    self.need_space = false;
                    self.out.push(',');
                    self.pending_newline = true;
                }
                Kind::Colon => {
                    self.need_space = false;
                    self.out.push_str(": ");
                }
                Kind::LineComment | Kind::BlockComment => self.comment(&token),
                Kind::Str | Kind::Literal => self.word(&token),
            }
            i += 1;
        }
    }
}

/// Formats `text` (JSON or JSONC) with `indent` as one level of indentation (`"  "`, `"    "`, `"\t"`) and `eol`
/// (`"\n"` or `"\r\n"`) as the line ending. An empty or whitespace-only document is returned unchanged; a document
/// that ends with a line break still does. The result is stable: formatting it again changes nothing.
pub fn format_json(text: &str, indent: &str, eol: &str) -> Result<String, JsonError> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let normalized = text.replace("\r\n", "\n");
    let tokens = tokenize(&normalized)?;
    if tokens.is_empty() {
        return Ok(text.to_string());
    }
    validate(&normalized, &tokens)?;
    let mut printer = Printer {
        text: &normalized,
        indent,
        out: String::with_capacity(normalized.len() + normalized.len() / 4),
        level: 0,
        pending_newline: false,
        need_space: false,
    };
    printer.run(&tokens);
    let mut out = printer.out;
    if normalized.ends_with('\n') {
        out.push('\n');
    }
    Ok(if eol == "\n" {
        out
    } else {
        out.replace('\n', eol)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fmt(text: &str) -> String {
        format_json(text, "  ", "\n").expect("valid")
    }

    #[test]
    fn a_minified_package_json_becomes_readable() {
        let input = r#"{"name":"r","scripts":{"dev":"vite","build":"vite build"},"dependencies":{"react":"19.0.0"}}"#;
        let expected = "{\n  \"name\": \"r\",\n  \"scripts\": {\n    \"dev\": \"vite\",\n    \"build\": \"vite build\"\n  },\n  \"dependencies\": {\n    \"react\": \"19.0.0\"\n  }\n}";
        assert_eq!(fmt(input), expected);
    }

    #[test]
    fn formatting_is_stable_and_keeps_a_final_newline_only_when_there_was_one() {
        let once = fmt("{\"a\":[1,2,{\"b\":null}],\"c\":\"x\"}\n");
        assert!(once.ends_with("}\n") && !once.ends_with("\n\n"));
        assert_eq!(fmt(&once), once);
        assert!(!fmt("[1]").ends_with('\n'));
    }

    #[test]
    fn empty_containers_strings_and_numbers_are_copied_verbatim() {
        assert_eq!(
            fmt(r#"{"a":{},"b":[],"c":"a\"b\\","d":-0.5e+10,"e":true}"#),
            "{\n  \"a\": {},\n  \"b\": [],\n  \"c\": \"a\\\"b\\\\\",\n  \"d\": -0.5e+10,\n  \"e\": true\n}"
        );
    }

    #[test]
    fn tabs_and_windows_line_endings_are_honoured() {
        assert_eq!(
            format_json("{\"a\":1}", "\t", "\r\n").expect("ok"),
            "{\r\n\t\"a\": 1\r\n}"
        );
        assert_eq!(
            format_json("{\r\n\"a\":1\r\n}\r\n", "  ", "\r\n").expect("ok"),
            "{\r\n  \"a\": 1\r\n}\r\n"
        );
    }

    #[test]
    fn comments_and_trailing_commas_are_kept() {
        let input = "// top\n{\"a\":1, // one\n/* block */ \"b\":[1,2,],\n// own line\n\"c\":2}";
        let out = fmt(input);
        assert_eq!(
            out,
            "// top\n{\n  \"a\": 1, // one\n  /* block */\n  \"b\": [\n    1,\n    2,\n  ],\n  // own line\n  \"c\": 2\n}"
        );
        assert_eq!(fmt(&out), out);
    }

    #[test]
    fn invalid_documents_are_refused_with_a_position() {
        let err =
            format_json("{\n  \"a\": 1\n  \"b\": 2\n}", "  ", "\n").expect_err("missing comma");
        assert_eq!((err.line, err.column), (3, 3));
        assert!(err.message.contains("expected ',' or '}'"), "{err}");
        for bad in ["{\"a\":}", "{a:1}", "[1,2", "{\"a\":\"x", "{} {}", "[01]"] {
            assert!(format_json(bad, "  ", "\n").is_err(), "{bad}");
        }
        let end = format_json("{\"a\":1", "  ", "\n").expect_err("open");
        assert!(end.message.contains("end of the document"));
    }

    #[test]
    fn empty_input_and_scalars_are_fine() {
        assert_eq!(fmt("  \n"), "  \n");
        assert_eq!(fmt(" 42 "), "42");
        assert_eq!(fmt("\"s\""), "\"s\"");
    }

    #[test]
    fn deep_nesting_is_refused_instead_of_overflowing_the_stack() {
        let deep = format!("{}{}", "[".repeat(400), "]".repeat(400));
        assert!(format_json(&deep, "  ", "\n").is_err());
    }
}
