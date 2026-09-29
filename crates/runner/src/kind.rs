use std::path::Path;

use serde::Serialize;

/// The kinds of file Run Code can execute, and what each runs with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RunnableKind {
    Python,
    Node,
    Php,
    TypeScript,
    /// Compiled languages: built into a temporary folder first (see `compiled.rs`).
    C,
    Cpp,
    Java,
    Rust,
    /// Not a file Run Code can run: the database server's own processes.
    MariaDb,
}

impl RunnableKind {
    /// Human name, also the Output channel the run's output goes to.
    pub fn display_name(self) -> &'static str {
        match self {
            Self::Python => "Python",
            Self::Node => "Node.js",
            Self::Php => "PHP",
            Self::TypeScript => "TypeScript",
            Self::C => "C",
            Self::Cpp => "C++",
            Self::Java => "Java",
            Self::Rust => "Rust",
            Self::MariaDb => "MariaDB",
        }
    }

    /// The runtime manifest id whose portable install provides the interpreter.
    pub fn runtime_id(self) -> &'static str {
        match self {
            Self::Python => "python",
            Self::Node | Self::TypeScript => "node",
            Self::Php => "php",
            Self::C | Self::Cpp => "llvm-mingw",
            Self::Java => "jdk",
            // Not a Runtime Manager download: rustup manages Rust.
            Self::Rust => "rust",
            Self::MariaDb => "mariadb",
        }
    }

    /// The default command template (`${file}` etc. are expanded per token,
    /// so a path with spaces stays one argument).
    pub fn default_template(self) -> &'static str {
        match self {
            Self::Python => "python \"${file}\"",
            Self::Node => "node \"${file}\"",
            Self::Php => "php \"${file}\"",
            Self::TypeScript => "tsx \"${file}\"",
            // Never used: compiled languages are planned by `compiled.rs`.
            Self::C => "clang",
            Self::Cpp => "clang++",
            Self::Java => "javac",
            Self::Rust => "rustc",
            // Never used: MariaDB's commands are built by `stack.rs`, not from a template.
            Self::MariaDb => "mysqld",
        }
    }

    /// Built before it runs (C, C++, Java, Rust).
    pub fn is_compiled(self) -> bool {
        matches!(self, Self::C | Self::Cpp | Self::Java | Self::Rust)
    }

    /// Extra environment for the child so its output isn't held back by pipe buffering.
    pub fn extra_env(self) -> &'static [(&'static str, &'static str)] {
        match self {
            Self::Python => &[("PYTHONUNBUFFERED", "1")],
            _ => &[],
        }
    }
}

/// What the Run button should do for a file, judged from its extension alone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Detection {
    Runnable(RunnableKind),
    /// Not runnable, with the reason to show. `previewable` marks files that
    /// have a preview instead (Markdown, HTML).
    NotRunnable {
        reason: String,
        previewable: bool,
    },
}

pub fn detect(path: &Path) -> Detection {
    let extension = path
        .extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase());
    let not = |reason: &str, previewable: bool| Detection::NotRunnable {
        reason: reason.to_string(),
        previewable,
    };
    match extension.as_deref() {
        Some("py") => Detection::Runnable(RunnableKind::Python),
        Some("js" | "mjs" | "cjs") => Detection::Runnable(RunnableKind::Node),
        Some("php") => Detection::Runnable(RunnableKind::Php),
        Some("ts") => Detection::Runnable(RunnableKind::TypeScript),
        Some("c") => Detection::Runnable(RunnableKind::C),
        Some("cpp" | "cc" | "cxx" | "c++") => Detection::Runnable(RunnableKind::Cpp),
        Some("java") => Detection::Runnable(RunnableKind::Java),
        Some("rs") => Detection::Runnable(RunnableKind::Rust),
        Some("md" | "markdown") => not(
            "Markdown files aren't run — open the preview instead.",
            true,
        ),
        Some("html" | "htm") => not("HTML files aren't run as code.", false),
        Some("json") => not("JSON files can't be run.", false),
        Some("yaml" | "yml") => not("YAML files can't be run.", false),
        Some("xml") => not("XML files can't be run.", false),
        Some("css") => not("CSS files can't be run.", false),
        Some(other) => Detection::NotRunnable {
            reason: format!("Run Code doesn't support .{other} files."),
            previewable: false,
        },
        None => not(
            "Run Code doesn't support files without an extension.",
            false,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind(name: &str) -> Detection {
        detect(Path::new(name))
    }

    #[test]
    fn supported_extensions_map_to_their_runtime_case_insensitively() {
        assert_eq!(kind("a.py"), Detection::Runnable(RunnableKind::Python));
        assert_eq!(kind("A.PY"), Detection::Runnable(RunnableKind::Python));
        for name in ["a.js", "a.mjs", "a.cjs"] {
            assert_eq!(
                kind(name),
                Detection::Runnable(RunnableKind::Node),
                "{name}"
            );
        }
        assert_eq!(kind("a.php"), Detection::Runnable(RunnableKind::Php));
        assert_eq!(kind("a.ts"), Detection::Runnable(RunnableKind::TypeScript));
        assert_eq!(kind("a.c"), Detection::Runnable(RunnableKind::C));
        for name in ["a.cpp", "a.CC", "a.cxx"] {
            assert_eq!(kind(name), Detection::Runnable(RunnableKind::Cpp), "{name}");
        }
        assert_eq!(kind("A.java"), Detection::Runnable(RunnableKind::Java));
        assert_eq!(kind("main.rs"), Detection::Runnable(RunnableKind::Rust));
        assert!(RunnableKind::Rust.is_compiled() && !RunnableKind::Python.is_compiled());
        // A header is not a program.
        assert!(matches!(kind("a.h"), Detection::NotRunnable { .. }));
    }

    #[test]
    fn markdown_is_previewable_not_runnable() {
        for name in ["README.md", "notes.markdown"] {
            assert!(
                matches!(
                    kind(name),
                    Detection::NotRunnable {
                        previewable: true,
                        ..
                    }
                ),
                "{name}"
            );
        }
    }

    #[test]
    fn html_is_not_run_as_code_and_has_no_preview_to_offer() {
        let Detection::NotRunnable {
            reason,
            previewable,
        } = kind("index.html")
        else {
            panic!("html must not be runnable");
        };
        assert!(!previewable);
        assert!(reason.contains("HTML"));
    }

    #[test]
    fn data_files_and_unknown_types_say_why_they_cannot_run() {
        for name in ["package.json", "ci.yml", "a.yaml", "d.xml", "s.css"] {
            let Detection::NotRunnable {
                reason,
                previewable,
            } = kind(name)
            else {
                panic!("{name} must not be runnable");
            };
            assert!(!previewable, "{name}");
            assert!(reason.contains("can't be run"), "{reason}");
        }
        let Detection::NotRunnable { reason, .. } = kind("archive.zip") else {
            panic!("zip must not be runnable");
        };
        assert!(reason.contains(".zip"));
        assert!(matches!(kind("Makefile"), Detection::NotRunnable { .. }));
        assert!(matches!(kind("a.exe"), Detection::NotRunnable { .. }));
    }

    #[test]
    fn typescript_uses_the_node_runtime_and_python_is_unbuffered() {
        assert_eq!(RunnableKind::TypeScript.runtime_id(), "node");
        assert_eq!(
            RunnableKind::Python.extra_env(),
            &[("PYTHONUNBUFFERED", "1")]
        );
        assert!(RunnableKind::Node.extra_env().is_empty());
    }
}
