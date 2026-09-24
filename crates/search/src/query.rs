use std::path::PathBuf;

use globset::{Glob, GlobBuilder, GlobSet, GlobSetBuilder};
use regex::{Regex, RegexBuilder};
use serde::Deserialize;

use crate::error::SearchError;

/// Folders that are never searched: dependency and build output that would
/// bury real results and make a search on a real project take forever.
pub const ALWAYS_EXCLUDED_DIRS: [&str; 6] =
    ["node_modules", ".git", "target", "dist", "build", "vendor"];

const DEFAULT_MAX_RESULTS: usize = 10_000;
/// Compiled-pattern size cap, so a hostile regex can't allocate without bound.
const REGEX_SIZE_LIMIT: usize = 4 * 1024 * 1024;

fn default_max_results() -> usize {
    DEFAULT_MAX_RESULTS
}

/// What the user asked for. Everything is plain data from the UI; nothing
/// here is executed or interpreted beyond being compiled into a regex/globs.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub root: PathBuf,
    pub text: String,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub use_regex: bool,
    /// Only files matching one of these are searched (empty = all files).
    #[serde(default)]
    pub include: Vec<String>,
    /// Files and folders matching any of these are skipped.
    #[serde(default)]
    pub exclude: Vec<String>,
    #[serde(default = "default_max_results")]
    pub max_results: usize,
}

/// A query turned into the matchers the walker uses.
pub struct CompiledQuery {
    pub regex: Regex,
    pub include: Option<GlobSet>,
    pub exclude: GlobSet,
}

impl SearchQuery {
    pub fn compile(&self) -> Result<CompiledQuery, SearchError> {
        if self.text.is_empty() {
            return Err(SearchError::EmptyQuery);
        }
        let mut pattern = if self.use_regex {
            self.text.clone()
        } else {
            regex::escape(&self.text)
        };
        if self.whole_word {
            pattern = format!(r"\b(?:{pattern})\b");
        }
        let regex = RegexBuilder::new(&pattern)
            .case_insensitive(!self.case_sensitive)
            .size_limit(REGEX_SIZE_LIMIT)
            .build()
            .map_err(|err| SearchError::InvalidRegex(err.to_string()))?;
        Ok(CompiledQuery {
            regex,
            include: if self.include.iter().all(|p| p.trim().is_empty()) {
                None
            } else {
                Some(build_globs(&self.include)?)
            },
            exclude: build_globs(&self.exclude)?,
        })
    }
}

/// VS Code-style patterns: `*.ts` matches in any folder, `src` or `src/**`
/// matches everything under `src`, `a/b.txt` is anchored to the search root.
/// Matching is on root-relative, forward-slash paths, so a pattern can never
/// address anything outside the searched folder.
fn build_globs(patterns: &[String]) -> Result<GlobSet, SearchError> {
    let mut builder = GlobSetBuilder::new();
    for raw in patterns {
        let pattern = raw.trim().trim_start_matches("./").trim_end_matches('/');
        if pattern.is_empty() {
            continue;
        }
        let base = if pattern.contains('/') {
            pattern.trim_start_matches('/').to_string()
        } else {
            format!("**/{pattern}")
        };
        for candidate in [base.clone(), format!("{base}/**")] {
            builder.add(compile_glob(raw, &candidate)?);
        }
    }
    builder.build().map_err(|err| SearchError::InvalidGlob {
        pattern: patterns.join(", "),
        reason: err.to_string(),
    })
}

fn compile_glob(original: &str, candidate: &str) -> Result<Glob, SearchError> {
    GlobBuilder::new(candidate)
        .literal_separator(true)
        .case_insensitive(cfg!(windows))
        .build()
        .map_err(|err| SearchError::InvalidGlob {
            pattern: original.trim().to_string(),
            reason: err.kind().to_string(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(text: &str) -> SearchQuery {
        SearchQuery {
            root: PathBuf::from("."),
            text: text.into(),
            case_sensitive: false,
            whole_word: false,
            use_regex: false,
            include: vec![],
            exclude: vec![],
            max_results: 10,
        }
    }

    #[test]
    fn literal_text_is_escaped_so_regex_characters_are_just_characters() {
        let compiled = query("a.b(c)").compile().expect("compile");

        assert!(compiled.regex.is_match("xx a.b(c) yy"));
        assert!(!compiled.regex.is_match("aXb(c)"));
    }

    #[test]
    fn case_and_whole_word_options_change_what_matches() {
        let mut q = query("cat");
        assert!(q.compile().expect("c").regex.is_match("CAT"));
        q.case_sensitive = true;
        assert!(!q.compile().expect("c").regex.is_match("CAT"));
        q.whole_word = true;
        let compiled = q.compile().expect("c");
        assert!(compiled.regex.is_match("a cat sat"));
        assert!(!compiled.regex.is_match("concatenate"));
    }

    #[test]
    fn an_empty_or_invalid_query_is_a_clear_error() {
        assert!(matches!(query("").compile(), Err(SearchError::EmptyQuery)));
        let mut q = query("(unclosed");
        q.use_regex = true;
        assert!(matches!(q.compile(), Err(SearchError::InvalidRegex(_))));
    }

    #[test]
    fn a_regex_too_large_to_compile_is_rejected_not_allocated() {
        let mut q = query(r"(\w{100}){100}");
        q.use_regex = true;

        assert!(matches!(q.compile(), Err(SearchError::InvalidRegex(_))));
    }

    #[test]
    fn globs_follow_vs_code_conventions() {
        let mut q = query("x");
        q.include = vec!["*.ts".into(), "docs".into()];
        q.exclude = vec!["**/*.min.js".into(), "src/generated/".into()];
        let compiled = q.compile().expect("compile");

        let include = compiled.include.expect("include");
        assert!(include.is_match("a.ts"));
        assert!(include.is_match("deep/er/a.ts"));
        assert!(include.is_match("docs/readme.md"));
        assert!(!include.is_match("a.rs"));
        assert!(compiled.exclude.is_match("lib/x.min.js"));
        assert!(compiled.exclude.is_match("src/generated/api.ts"));
        assert!(!compiled.exclude.is_match("src/api.ts"));
    }

    #[test]
    fn a_broken_glob_is_reported_with_the_pattern() {
        let mut q = query("x");
        q.include = vec!["[unclosed".into()];

        let error = q.compile().err().expect("error");

        assert!(error.to_string().contains("[unclosed"), "{error}");
    }

    #[test]
    fn blank_patterns_are_ignored() {
        let mut q = query("x");
        q.include = vec!["  ".into(), "".into()];
        q.exclude = vec![" ".into()];

        let compiled = q.compile().expect("compile");

        assert!(compiled.include.is_none());
        assert!(!compiled.exclude.is_match("anything"));
    }
}
