//! What is never shared in a room, whatever the Owner's ignore files say: version-control internals, dependency
//! and build output (large and regenerated), and files that commonly hold secrets. The manifest (Phase 5) also
//! honours `.gitignore` and `.openmindignore` through the search crawler's rules; this list is the floor that a
//! missing or careless ignore file can't lower, and the filesystem authority checks it again on every request.

use crate::files::RelPath;

/// Why a path is not shared.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exposure {
    Shared,
    /// Generated or tool-internal content (`.git`, `node_modules`, `target` ...).
    Excluded,
    /// Likely to hold secrets (`.env`, private keys, credentials ...).
    Sensitive,
}

const EXCLUDED_FOLDERS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".tox",
    ".gradle",
    ".idea",
    ".vs",
    "vendor",
    ".terraform",
    ".cache",
];

const SENSITIVE_FOLDERS: &[&str] = &[".ssh", ".aws", ".azure", ".gnupg", ".kube", ".docker"];

const SENSITIVE_NAMES: &[&str] = &[
    ".env",
    ".npmrc",
    ".pypirc",
    ".netrc",
    "_netrc",
    ".git-credentials",
    ".htpasswd",
    "credentials",
    "credentials.json",
    "secrets.json",
    "secrets.yaml",
    "secrets.yml",
    "secrets.toml",
    ".pgpass",
    ".my.cnf",
];

const SENSITIVE_PREFIXES: &[&str] = &[".env.", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];

const SENSITIVE_EXTENSIONS: &[&str] = &[
    "pem", "key", "p12", "pfx", "jks", "keystore", "kdbx", "ppk", "asc", "gpg",
];

/// Classifies a path (case-insensitive, any folder level).
pub fn classify(path: &RelPath) -> Exposure {
    let segments: Vec<String> = path.segments().map(str::to_lowercase).collect();
    let Some(name) = segments.last() else {
        return Exposure::Excluded;
    };
    if segments
        .iter()
        .any(|s| SENSITIVE_FOLDERS.contains(&s.as_str()))
    {
        return Exposure::Sensitive;
    }
    if segments
        .iter()
        .any(|s| EXCLUDED_FOLDERS.contains(&s.as_str()))
    {
        return Exposure::Excluded;
    }
    let extension = name.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("");
    if SENSITIVE_NAMES.contains(&name.as_str())
        || SENSITIVE_PREFIXES.iter().any(|p| name.starts_with(p))
        || SENSITIVE_EXTENSIONS.contains(&extension)
    {
        return Exposure::Sensitive;
    }
    Exposure::Shared
}

pub fn is_shareable(path: &RelPath) -> bool {
    classify(path) == Exposure::Shared
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(text: &str) -> Exposure {
        classify(&RelPath::parse(text).expect("path"))
    }

    #[test]
    fn secrets_and_generated_content_are_never_shared() {
        for sensitive in [
            ".env",
            "api/.env.local",
            ".ENV.production",
            "keys/server.pem",
            "certs/site.KEY",
            "home/.ssh/config",
            ".aws/credentials",
            "id_rsa",
            "id_ed25519.pub",
            "config/secrets.yml",
            ".npmrc",
            "db/.pgpass",
            "deploy/cert.pfx",
        ] {
            assert_eq!(c(sensitive), Exposure::Sensitive, "{sensitive}");
        }
        for excluded in [
            ".git/config",
            "web/node_modules/x/index.js",
            "target/debug/app",
            "src/__pycache__/a.pyc",
        ] {
            assert_eq!(c(excluded), Exposure::Excluded, "{excluded}");
        }
    }

    #[test]
    fn ordinary_files_are_shared() {
        for shared in [
            "src/main.ts",
            "README.md",
            "package.json",
            "docs/env.md",
            "src/keyboard.ts",
            "environment.ts",
        ] {
            assert_eq!(c(shared), Exposure::Shared, "{shared}");
        }
    }
}
