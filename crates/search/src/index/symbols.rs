//! Symbols read from source text with line-based patterns: a lightweight fallback for when no language server is
//! running. It is **heuristic** (no parser): a construct spread over several lines, generated code or an unusual
//! style can be missed or misread, and the "container" is guessed from indentation and braces.

use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Symbol {
    pub name: String,
    /// function, method, class, interface, enum, struct, trait, type, module, variable, constant, heading or key.
    pub kind: String,
    /// 1-based line.
    pub line: u32,
    /// 1-based column of the name, in UTF-16 units (how Monaco counts).
    pub column: u32,
    pub container: Option<String>,
}

/// Most symbols kept per file (a generated file can define millions).
pub const MAX_SYMBOLS_PER_FILE: usize = 5_000;
/// JSON keys are only read from files up to this size.
const MAX_JSON_BYTES: usize = 200 * 1024;

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).unwrap_or_else(|_| Regex::new("$^").unwrap_or_else(|_| unreachable_regex()))
}

/// `Regex::new("$^")` can't fail; this only exists so no `unwrap`/`expect` is needed.
fn unreachable_regex() -> Regex {
    Regex::new("a").unwrap_or_else(|_| unreachable_regex())
}

fn utf16_len(text: &str) -> u32 {
    u32::try_from(text.encode_utf16().count()).unwrap_or(u32::MAX)
}

fn indent_of(line: &str) -> usize {
    line.chars()
        .take_while(|c| *c == ' ' || *c == '\t')
        .map(|c| if c == '\t' { 4 } else { 1 })
        .sum()
}

struct Collector {
    out: Vec<Symbol>,
    /// Enclosing class-like constructs: (name, indentation of the declaration).
    containers: Vec<(String, usize)>,
}

impl Collector {
    fn new() -> Self {
        Self {
            out: Vec::new(),
            containers: Vec::new(),
        }
    }

    fn full(&self) -> bool {
        self.out.len() >= MAX_SYMBOLS_PER_FILE
    }

    /// Leaves the containers a line at `indent` is no longer inside of.
    fn close_scopes(&mut self, line: &str, indent: usize) {
        let trimmed = line.trim_start();
        if trimmed.is_empty() {
            return;
        }
        if trimmed.starts_with('}') {
            if self.containers.last().is_some_and(|(_, at)| indent <= *at) {
                self.containers.pop();
            }
            return;
        }
        let continuation = trimmed.starts_with(['@', '#', '/', '*', ')', ']', '.', '{']);
        if continuation {
            return;
        }
        while self.containers.last().is_some_and(|(_, at)| indent <= *at) {
            self.containers.pop();
        }
    }

    fn container(&self) -> Option<String> {
        self.containers.last().map(|(name, _)| name.clone())
    }

    fn push(&mut self, line_no: usize, line: &str, name_start: usize, name: &str, kind: &str) {
        if self.full() || name.is_empty() {
            return;
        }
        self.out.push(Symbol {
            name: name.to_string(),
            kind: kind.to_string(),
            line: u32::try_from(line_no + 1).unwrap_or(u32::MAX),
            column: utf16_len(&line[..name_start]) + 1,
            container: self.container(),
        });
    }

    fn open_container(&mut self, name: &str, indent: usize) {
        self.containers.push((name.to_string(), indent));
    }
}

static TS_DECL: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|class|interface|enum|type|namespace|const enum)\s+([A-Za-z_$][\w$]*)",
    )
});
static TS_VAR: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"^\s*(?:export\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(async\s*)?(?:\(|function|[A-Za-z_$][\w$]*\s*=>)?",
    )
});
static TS_METHOD: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"^\s+(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\([^)]*\)?[^;{=]*\{?\s*$",
    )
});
static PY_DECL: LazyLock<Regex> =
    LazyLock::new(|| re(r"^\s*(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)"));
static PY_CONST: LazyLock<Regex> = LazyLock::new(|| re(r"^([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?="));
static PHP_DECL: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"^\s*(?:(?:abstract|final|static|public|protected|private)\s+)*(function|class|interface|trait|enum|namespace)\s+&?([A-Za-z_\\][\w\\]*)",
    )
});
static PHP_CONST: LazyLock<Regex> =
    LazyLock::new(|| re(r"^\s*(?:(?:public|protected|private|final)\s+)*const\s+([A-Za-z_]\w*)"));
static RS_DECL: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|unsafe|const|extern(?:\s+\x22[^\x22]*\x22)?)\s+)*(fn|struct|enum|trait|type|mod|const|static|union)\s+([A-Za-z_]\w*)",
    )
});
static RS_IMPL: LazyLock<Regex> = LazyLock::new(|| {
    re(r"^\s*(?:unsafe\s+)?impl(?:<[^>]*>)?\s+(?:[\w:<>,\s&']+?\s+for\s+)?([A-Za-z_]\w*)")
});
static MD_HEADING: LazyLock<Regex> = LazyLock::new(|| re(r"^(#{1,6})\s+(.+?)\s*#*\s*$"));
static JSON_KEY: LazyLock<Regex> = LazyLock::new(|| re(r#"^(\s{0,4})"([^"\\]{1,80})"\s*:"#));
/// An assembly label at the start of a line (`main:`, `.loop:`), NASM or GNU as.
static ASM_LABEL: LazyLock<Regex> = LazyLock::new(|| re(r"^\s*([A-Za-z_.?@$][\w.$?@#~]*)\s*:"));
/// `NAME equ value`, `%define NAME`, `%assign NAME`, `%macro NAME` (NASM).
static ASM_EQU: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)^\s*([A-Za-z_?@$][\w.$?@#~]*)\s+equ\b"));
static ASM_DIRECTIVE: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)^\s*%\s*(i?x?define|assign|macro)\s+([A-Za-z_?@$][\w.$?@#~]*)"));

const NOT_METHODS: [&str; 14] = [
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "return",
    "function",
    "constructor_",
    "else",
    "do",
    "try",
    "with",
    "await",
    "typeof",
];

fn kind_of(keyword: &str) -> &'static str {
    match keyword {
        "class" => "class",
        "interface" => "interface",
        "enum" | "const enum" => "enum",
        "type" => "type",
        "namespace" | "mod" => "module",
        "struct" | "union" => "struct",
        "trait" => "trait",
        "const" | "static" => "constant",
        _ => "function",
    }
}

fn is_container_kind(kind: &str) -> bool {
    matches!(
        kind,
        "class" | "interface" | "enum" | "module" | "struct" | "trait"
    )
}

fn typescript(text: &str) -> Vec<Symbol> {
    let mut c = Collector::new();
    for (i, line) in text.lines().enumerate() {
        if c.full() {
            break;
        }
        let indent = indent_of(line);
        c.close_scopes(line, indent);
        if let Some(cap) = TS_DECL.captures(line) {
            if let (Some(keyword), Some(name)) = (cap.get(1), cap.get(2)) {
                let kind = kind_of(keyword.as_str().trim_end_matches('*'));
                let inside = c.container().is_some();
                c.push(
                    i,
                    line,
                    name.start(),
                    name.as_str(),
                    if kind == "function" && inside {
                        "method"
                    } else {
                        kind
                    },
                );
                if is_container_kind(kind) {
                    c.open_container(name.as_str(), indent);
                }
            }
            continue;
        }
        if let Some(cap) = TS_VAR.captures(line) {
            if let Some(name) = cap.get(2) {
                let is_fn =
                    line[name.end()..].contains("=>") || line[name.end()..].contains("function");
                let top = c.container().is_none() && indent == 0;
                let kind = if is_fn {
                    "function"
                } else if cap.get(1).is_some_and(|k| k.as_str() == "const") {
                    "constant"
                } else {
                    "variable"
                };
                if top || is_fn {
                    c.push(i, line, name.start(), name.as_str(), kind);
                }
            }
            continue;
        }
        if c.container().is_some() && indent > 0 {
            if let Some(cap) = TS_METHOD.captures(line) {
                if let Some(name) = cap.get(1) {
                    if !NOT_METHODS.contains(&name.as_str()) {
                        c.push(i, line, name.start(), name.as_str(), "method");
                    }
                }
            }
        }
    }
    c.out
}

fn python(text: &str) -> Vec<Symbol> {
    let mut c = Collector::new();
    for (i, line) in text.lines().enumerate() {
        if c.full() {
            break;
        }
        let indent = indent_of(line);
        c.close_scopes(line, indent);
        if let Some(cap) = PY_DECL.captures(line) {
            if let (Some(keyword), Some(name)) = (cap.get(1), cap.get(2)) {
                if keyword.as_str() == "class" {
                    c.push(i, line, name.start(), name.as_str(), "class");
                    c.open_container(name.as_str(), indent);
                } else {
                    let kind = if c.container().is_some() {
                        "method"
                    } else {
                        "function"
                    };
                    c.push(i, line, name.start(), name.as_str(), kind);
                }
            }
        } else if let Some(cap) = PY_CONST.captures(line) {
            if let Some(name) = cap.get(1) {
                c.push(i, line, name.start(), name.as_str(), "constant");
            }
        }
    }
    c.out
}

fn php(text: &str) -> Vec<Symbol> {
    let mut c = Collector::new();
    for (i, line) in text.lines().enumerate() {
        if c.full() {
            break;
        }
        let indent = indent_of(line);
        c.close_scopes(line, indent);
        if let Some(cap) = PHP_DECL.captures(line) {
            if let (Some(keyword), Some(name)) = (cap.get(1), cap.get(2)) {
                let word = keyword.as_str();
                let kind = if word == "function" {
                    if c.container().is_some() {
                        "method"
                    } else {
                        "function"
                    }
                } else {
                    kind_of(if word == "namespace" {
                        "namespace"
                    } else {
                        word
                    })
                };
                let short = name.as_str().rsplit('\\').next().unwrap_or(name.as_str());
                let start = name.end() - short.len();
                c.push(i, line, start, short, kind);
                if is_container_kind(kind) {
                    c.open_container(short, indent);
                }
            }
        } else if let Some(cap) = PHP_CONST.captures(line) {
            if let Some(name) = cap.get(1) {
                c.push(i, line, name.start(), name.as_str(), "constant");
            }
        }
    }
    c.out
}

fn rust(text: &str) -> Vec<Symbol> {
    let mut c = Collector::new();
    for (i, line) in text.lines().enumerate() {
        if c.full() {
            break;
        }
        let indent = indent_of(line);
        c.close_scopes(line, indent);
        if let Some(cap) = RS_IMPL.captures(line) {
            if let Some(name) = cap.get(1) {
                c.open_container(name.as_str(), indent);
            }
            continue;
        }
        if let Some(cap) = RS_DECL.captures(line) {
            if let (Some(keyword), Some(name)) = (cap.get(1), cap.get(2)) {
                let word = keyword.as_str();
                let kind = kind_of(word);
                let kind = if word == "fn" && c.container().is_some() {
                    "method"
                } else {
                    kind
                };
                c.push(i, line, name.start(), name.as_str(), kind);
                if is_container_kind(kind) && word != "struct" {
                    c.open_container(name.as_str(), indent);
                }
            }
        }
    }
    c.out
}

fn markdown(text: &str) -> Vec<Symbol> {
    let mut out = Vec::new();
    let mut fenced = false;
    for (i, line) in text.lines().enumerate() {
        if line.trim_start().starts_with("```") || line.trim_start().starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced || out.len() >= MAX_SYMBOLS_PER_FILE {
            continue;
        }
        if let Some(cap) = MD_HEADING.captures(line) {
            if let (Some(level), Some(title)) = (cap.get(1), cap.get(2)) {
                out.push(Symbol {
                    name: title.as_str().to_string(),
                    kind: "heading".into(),
                    line: u32::try_from(i + 1).unwrap_or(u32::MAX),
                    column: utf16_len(&line[..title.start()]) + 1,
                    container: Some(format!("H{}", level.as_str().len())),
                });
            }
        }
    }
    out
}

fn json(text: &str) -> Vec<Symbol> {
    if text.len() > MAX_JSON_BYTES {
        return Vec::new();
    }
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        if out.len() >= 500 {
            break;
        }
        if let Some(cap) = JSON_KEY.captures(line) {
            if let Some(key) = cap.get(2) {
                out.push(Symbol {
                    name: key.as_str().to_string(),
                    kind: "key".into(),
                    line: u32::try_from(i + 1).unwrap_or(u32::MAX),
                    column: utf16_len(&line[..key.start()]) + 1,
                    container: None,
                });
            }
        }
    }
    out
}

/// Assembly (NASM and GNU as): labels (a local `.label` belongs to the label before it), `equ` constants and NASM's
/// `%define`/`%assign` (constants) and `%macro` (functions). asm-lsp offers no workspace symbols, so Ctrl+T reads these.
fn assembly(text: &str) -> Vec<Symbol> {
    let mut c = Collector::new();
    let mut scope: Option<String> = None;
    for (i, line) in text.lines().enumerate() {
        if c.full() {
            break;
        }
        if let Some(name) = ASM_LABEL.captures(line).and_then(|cap| cap.get(1)) {
            let label = name.as_str();
            if label.starts_with('.') {
                c.containers = scope.iter().map(|outer| (outer.clone(), 0)).collect();
                c.push(i, line, name.start(), label, "function");
            } else {
                c.containers.clear();
                c.push(i, line, name.start(), label, "function");
                scope = Some(label.to_string());
            }
            continue;
        }
        c.containers.clear();
        if let Some(name) = ASM_EQU.captures(line).and_then(|cap| cap.get(1)) {
            c.push(i, line, name.start(), name.as_str(), "constant");
        } else if let Some(cap) = ASM_DIRECTIVE.captures(line) {
            if let (Some(directive), Some(name)) = (cap.get(1), cap.get(2)) {
                let kind = if directive.as_str().eq_ignore_ascii_case("macro") {
                    "function"
                } else {
                    "constant"
                };
                c.push(i, line, name.start(), name.as_str(), kind);
            }
        }
    }
    c.out
}

/// The symbols found in `text` for a language id (see `text::language_of`), or none when the language has no reader.
pub fn extract(language: &str, text: &str) -> Vec<Symbol> {
    match language {
        "nasm" | "gas" => assembly(text),
        "typescript" | "javascript" => typescript(text),
        "python" => python(text),
        "php" => php(text),
        "rust" => rust(text),
        "markdown" => markdown(text),
        "json" => json(text),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(symbols: &[Symbol]) -> Vec<String> {
        symbols
            .iter()
            .map(|s| {
                format!(
                    "{}:{}@{}:{}{}",
                    s.kind,
                    s.name,
                    s.line,
                    s.column,
                    s.container
                        .as_ref()
                        .map(|c| format!(" in {c}"))
                        .unwrap_or_default()
                )
            })
            .collect()
    }

    #[test]
    fn typescript_functions_classes_methods_types_and_arrow_constants() {
        let source = "export interface User {\n  id: number;\n}\nexport type Id = string;\nexport async function load(id: Id) {\n  return id;\n}\nconst MAX = 5;\nexport const handler = async (req) => {\n};\nclass Repo {\n  private items = [];\n  static create(): Repo {\n    return new Repo();\n  }\n  async find(id: string) {\n    if (id) {\n    }\n  }\n}\nfunction after() {}\n";
        let symbols = extract("typescript", source);
        assert_eq!(
            summary(&symbols),
            vec![
                "interface:User@1:18",
                "type:Id@4:13",
                "function:load@5:23",
                "constant:MAX@8:7",
                "function:handler@9:14",
                "class:Repo@11:7",
                "method:create@13:10 in Repo",
                "method:find@16:9 in Repo",
                "function:after@21:10",
            ]
        );
    }

    #[test]
    fn python_classes_methods_functions_and_constants() {
        let source = "MAX_SIZE = 10\n\nclass Shape:\n    def area(self):\n        return 0\n\n    async def draw(self):\n        pass\n\ndef helper(x):\n    return x\n";
        assert_eq!(
            summary(&extract("python", source)),
            vec![
                "constant:MAX_SIZE@1:1",
                "class:Shape@3:7",
                "method:area@4:9 in Shape",
                "method:draw@7:15 in Shape",
                "function:helper@10:5",
            ]
        );
    }

    #[test]
    fn php_namespaces_classes_methods_functions_and_constants() {
        let source = "<?php\nnamespace App\\Http;\n\nfinal class UserController extends Base\n{\n    const LIMIT = 10;\n\n    public function index()\n    {\n    }\n\n    private static function helper() {}\n}\n\nfunction global_fn() {}\n";
        let symbols = extract("php", source);
        assert_eq!(
            summary(&symbols),
            vec![
                "module:Http@2:15",
                "class:UserController@4:13",
                "constant:LIMIT@6:11 in UserController",
                "method:index@8:21 in UserController",
                "method:helper@12:29 in UserController",
                "function:global_fn@15:10",
            ]
        );
    }

    #[test]
    fn assembly_labels_locals_constants_and_macros() {
        let nasm = "BUFSIZE equ 64\n%define GREETING 1\n%macro print 1\n%endmacro\n        section .text\nmain:\n.next:   cmp edi, ebx\n        jmp .next ; not a label\n.done:\nhelper:\n";
        assert_eq!(
            summary(&extract("nasm", nasm)),
            [
                "constant:BUFSIZE@1:1",
                "constant:GREETING@2:9",
                "function:print@3:8",
                "function:main@6:1",
                "function:.next@7:1 in main",
                "function:.done@9:1 in main",
                "function:helper@10:1",
            ]
        );
        let gas = "\t.globl main\nmain:\n\tmovl $5, %eax\n1:\n\tret\n";
        assert_eq!(summary(&extract("gas", gas)), ["function:main@2:1"]);
    }

    #[test]
    fn rust_items_impl_methods_and_modules() {
        let source = "pub struct Config {\n    pub name: String,\n}\n\nimpl Config {\n    pub fn new() -> Self {\n        Self { name: String::new() }\n    }\n    fn secret(&self) {}\n}\n\npub(crate) async fn run() {}\nconst LIMIT: usize = 3;\ntrait Shape { fn area(&self); }\nmod inner {\n    pub enum Kind { A }\n}\n";
        assert_eq!(
            summary(&extract("rust", source)),
            vec![
                "struct:Config@1:12",
                "method:new@6:12 in Config",
                "method:secret@9:8 in Config",
                "function:run@12:21",
                "constant:LIMIT@13:7",
                "trait:Shape@14:7",
                "module:inner@15:5",
                "enum:Kind@16:14 in inner",
            ]
        );
    }

    #[test]
    fn markdown_headings_skip_code_fences_and_json_keys_are_read() {
        let md = "# Title\n\ntext\n\n```sh\n# not a heading\n```\n\n## Second ##\n";
        assert_eq!(
            summary(&extract("markdown", md)),
            vec!["heading:Title@1:3 in H1", "heading:Second@9:4 in H2"]
        );
        let json = "{\n  \"name\": \"x\",\n  \"scripts\": {\n    \"build\": \"y\"\n  }\n}\n";
        let keys = extract("json", json);
        assert_eq!(
            keys.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            vec!["name", "scripts", "build"]
        );
    }

    #[test]
    fn unknown_languages_and_huge_output_are_bounded() {
        assert!(extract("cobol", "IDENTIFICATION DIVISION.").is_empty());
        let many = "function f() {}\n".repeat(MAX_SYMBOLS_PER_FILE + 100);
        assert_eq!(extract("javascript", &many).len(), MAX_SYMBOLS_PER_FILE);
    }
}
