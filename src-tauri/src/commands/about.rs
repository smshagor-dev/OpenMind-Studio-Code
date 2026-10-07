//! Help > About: what the About window shows and what "Copy system info" copies. Everything here is public
//! diagnostic information — no keys, passwords, project content or provider settings.

use serde::Serialize;
use tauri::State;

use crate::app_state::AppState;

pub const PRODUCT_NAME: &str = "OpenMind Studio";
pub const DESCRIPTION: &str =
    "A portable, native code editor with a built-in terminal, Git, language servers, a debugger and a local PHP stack.";
pub const AUTHOR_NAME: &str = "Md Shahanur Islam Shagor";
pub const AUTHOR_ROLE: &str = "Founder & Developer, OpenMind Studio";
pub const AUTHOR_LINE: &str = "Independent Researcher and Software Engineer";
pub const AUTHOR_GITHUB: &str = "https://github.com/smshagor-dev";
pub const LICENSE: &str = "Apache-2.0";
pub const SUPPORT_EMAIL: &str = "smshagor.dev@gmail.com";
pub const TELEGRAM: &str = "@smshagor1";
pub const WHATSAPP: &str = "smshagor1";
/// The author's portfolio address. Empty until one is configured: nothing is invented, and the About window
/// shows no portfolio entry while this is empty.
pub const PORTFOLIO_URL: &str = "";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Author {
    pub name: String,
    pub role: String,
    pub line: String,
    pub github: String,
    pub support_email: String,
    pub telegram: String,
    pub whatsapp: String,
    /// `None` until a portfolio address is configured.
    pub portfolio: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AboutInfo {
    pub name: String,
    pub version: String,
    pub tauri_version: String,
    pub rustc: String,
    pub webview: String,
    pub os: String,
    pub arch: String,
    pub license: String,
    pub description: String,
    pub app_dir: String,
    pub logs_dir: String,
    pub author: Author,
}

impl AboutInfo {
    pub fn new(app_dir: &str, logs_dir: &str, webview: String, tauri_version: String) -> Self {
        Self {
            name: PRODUCT_NAME.into(),
            version: env!("CARGO_PKG_VERSION").into(),
            tauri_version,
            rustc: env!("OPENMIND_RUSTC").into(),
            webview,
            os: std::env::consts::OS.into(),
            arch: std::env::consts::ARCH.into(),
            license: LICENSE.into(),
            description: DESCRIPTION.into(),
            app_dir: app_dir.into(),
            logs_dir: logs_dir.into(),
            author: Author {
                name: AUTHOR_NAME.into(),
                role: AUTHOR_ROLE.into(),
                line: AUTHOR_LINE.into(),
                github: AUTHOR_GITHUB.into(),
                support_email: SUPPORT_EMAIL.into(),
                telegram: TELEGRAM.into(),
                whatsapp: WHATSAPP.into(),
                portfolio: (!PORTFOLIO_URL.is_empty()).then(|| PORTFOLIO_URL.to_string()),
            },
        }
    }

    /// The text "Copy system info" puts on the clipboard: versions, platform and where the app lives.
    pub fn system_info(&self) -> String {
        [
            format!("{} {}", self.name, self.version),
            format!("OS: {} ({})", self.os, self.arch),
            format!("WebView: {}", self.webview),
            format!("Tauri: {}", self.tauri_version),
            format!("Compiler: {}", self.rustc),
            format!("App folder: {}", self.app_dir),
            format!("Logs: {}", self.logs_dir),
            format!("License: {}", self.license),
            format!("Support: {}", self.author.support_email),
        ]
        .join("\n")
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AboutResponse {
    #[serde(flatten)]
    pub info: AboutInfo,
    pub system_info: String,
}

#[tauri::command]
pub fn about_info(state: State<'_, AppState>) -> AboutResponse {
    let webview = tauri::webview_version().unwrap_or_else(|_| "unknown".into());
    let app_dir = state.app_root.to_string_lossy().replace('\\', "/");
    let logs_dir = state.paths.logs_dir.to_string_lossy().replace('\\', "/");
    let info = AboutInfo::new(&app_dir, &logs_dir, webview, tauri::VERSION.to_string());
    let system_info = info.system_info();
    AboutResponse { info, system_info }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info() -> AboutInfo {
        AboutInfo::new(
            "C:/My Apps/OpenMind Studio",
            "C:/My Apps/OpenMind Studio/logs",
            "153.0".into(),
            "2.11".into(),
        )
    }

    #[test]
    fn the_about_model_has_the_product_version_and_author() {
        let info = info();
        assert_eq!(info.name, "OpenMind Studio");
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(info.author.name, "Md Shahanur Islam Shagor");
        assert_eq!(info.author.role, "Founder & Developer, OpenMind Studio");
        assert!(info.author.github.starts_with("https://github.com/"));
        assert!(!info.arch.is_empty());
        assert_eq!(info.author.support_email, "smshagor.dev@gmail.com");
        assert_eq!(info.author.telegram, "@smshagor1");
        assert_eq!(info.author.whatsapp, "smshagor1");
        assert!(
            info.author.portfolio.is_none(),
            "no portfolio address is invented"
        );
    }

    #[test]
    fn the_licence_is_apache_2_and_matches_the_project_metadata() {
        assert_eq!(info().license, "Apache-2.0");
        assert!(!info().license.contains("Proprietary"));
        assert_eq!(env!("CARGO_PKG_LICENSE"), "Apache-2.0");
    }

    #[test]
    fn the_copied_system_info_has_the_diagnostics_and_no_secrets() {
        let text = info().system_info();
        for wanted in [
            "OpenMind Studio",
            "OS:",
            "WebView: 153.0",
            "Tauri: 2.11",
            "Logs:",
            "License: Apache-2.0",
            "Support: smshagor.dev@gmail.com",
        ] {
            assert!(text.contains(wanted), "{wanted}");
        }
        assert!(
            !text.contains("Commit"),
            "no commit or build hash is copied"
        );
        let lower = text.to_lowercase();
        for secret in ["password", "api key", "apikey", "token", "secret", "dpapi"] {
            assert!(!lower.contains(secret), "{secret}");
        }
    }
}
