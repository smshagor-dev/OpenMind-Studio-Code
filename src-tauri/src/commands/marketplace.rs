//! The extension marketplace: Open VSX (open-vsx.org), the open registry
//! VSCodium and other VS Code-compatible editors use. Everything the
//! Extensions view lists comes from its public API; nothing is made up.
//!
//! Only `https://open-vsx.org/` is ever contacted, over the Runtime Manager's
//! HTTPS-only client: URLs found in API answers are dropped unless they point
//! there. A download must match the SHA256 Open VSX publishes for it (a
//! mismatch deletes the file) before the regular install flow — which reads
//! the package and asks the user to trust it — sees it.

use std::io::Read;
use std::path::PathBuf;

use openmind_runtime_manager::download::{download, verify_sha256, HttpClient, UreqClient};
use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::app_state::AppState;

const API: &str = "https://open-vsx.org/api";
const ORIGIN: &str = "https://open-vsx.org/";
/// OpenMind Studio runs on 64-bit Windows: platform-specific extensions are picked for it.
const TARGET_PLATFORM: &str = "win32-x64";
const MAX_JSON_BYTES: u64 = 4 * 1024 * 1024;
const MAX_TEXT_BYTES: u64 = 1024 * 1024;
const MAX_PAGE: u32 = 50;

/// One extension in a list.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketItem {
    pub namespace: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub version: String,
    pub icon_url: Option<String>,
    pub download_count: u64,
    pub average_rating: Option<f64>,
    pub review_count: u64,
    pub verified: bool,
    pub deprecated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPage {
    pub total: u64,
    pub offset: u64,
    pub items: Vec<MarketItem>,
}

/// Everything the extension page shows.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketDetails {
    #[serde(flatten)]
    pub item: MarketItem,
    pub publisher: String,
    pub categories: Vec<String>,
    pub tags: Vec<String>,
    pub license: Option<String>,
    pub repository: Option<String>,
    pub homepage: Option<String>,
    pub last_updated: Option<String>,
    pub engine: Option<String>,
    pub preview: bool,
    pub readme_url: Option<String>,
    pub changelog_url: Option<String>,
    pub page_url: String,
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// A URL from an API answer, kept only when it points at Open VSX itself.
fn open_vsx_url(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|url| url.starts_with(ORIGIN))
        .map(str::to_string)
}

/// An `http(s)` link to show (repository, homepage); opened in the browser, never fetched.
fn web_link(value: Option<&Value>) -> Option<String> {
    let url = value?.as_str()?.trim();
    let url = url.strip_prefix("git+").unwrap_or(url);
    (url.starts_with("https://") || url.starts_with("http://")).then(|| url.to_string())
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Namespaces and names are letters, digits, `-`, `_` and `.` — nothing that changes the URL's shape.
pub fn valid_ident(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value.starts_with('.')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

pub fn parse_item(value: &Value) -> Option<MarketItem> {
    let namespace = text(value, "namespace").filter(|s| valid_ident(s))?;
    let name = text(value, "name").filter(|s| valid_ident(s))?;
    Some(MarketItem {
        display_name: text(value, "displayName").unwrap_or_else(|| name.clone()),
        description: text(value, "description").unwrap_or_default(),
        version: text(value, "version").unwrap_or_default(),
        icon_url: open_vsx_url(value.pointer("/files/icon")),
        download_count: value
            .get("downloadCount")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        average_rating: value.get("averageRating").and_then(Value::as_f64),
        review_count: value
            .get("reviewCount")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        verified: value.get("verified").and_then(Value::as_bool) == Some(true),
        deprecated: value.get("deprecated").and_then(Value::as_bool) == Some(true),
        namespace,
        name,
    })
}

pub fn parse_page(value: &Value) -> MarketPage {
    MarketPage {
        total: value.get("totalSize").and_then(Value::as_u64).unwrap_or(0),
        offset: value.get("offset").and_then(Value::as_u64).unwrap_or(0),
        items: value
            .get("extensions")
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(parse_item).collect())
            .unwrap_or_default(),
    }
}

pub fn parse_details(value: &Value) -> Option<MarketDetails> {
    let item = parse_item(value)?;
    let publisher = text(value, "namespaceDisplayName").unwrap_or_else(|| item.namespace.clone());
    let page_url = format!(
        "https://open-vsx.org/extension/{}/{}",
        item.namespace, item.name
    );
    Some(MarketDetails {
        publisher,
        categories: string_list(value.get("categories")),
        tags: string_list(value.get("tags")),
        license: text(value, "license"),
        repository: web_link(value.get("repository")),
        homepage: web_link(value.get("homepage")),
        last_updated: text(value, "timestamp"),
        engine: value
            .pointer("/engines/vscode")
            .and_then(Value::as_str)
            .map(str::to_string),
        preview: value.get("preview").and_then(Value::as_bool) == Some(true),
        readme_url: open_vsx_url(value.pointer("/files/readme")),
        changelog_url: open_vsx_url(value.pointer("/files/changelog")),
        page_url,
        item,
    })
}

/// The sort orders the view offers, mapped to Open VSX's `sortBy`.
pub fn sort_key(sort: &str) -> &'static str {
    match sort {
        "installs" => "downloadCount",
        "rating" => "rating",
        "updated" => "timestamp",
        _ => "relevance",
    }
}

pub fn search_url(query: &str, sort: &str, offset: u32, size: u32) -> Result<String, String> {
    let url = tauri::Url::parse_with_params(
        &format!("{API}/-/search"),
        &[
            ("query", query.trim()),
            ("sortBy", sort_key(sort)),
            ("sortOrder", "desc"),
            ("offset", &offset.to_string()),
            ("size", &size.clamp(1, MAX_PAGE).to_string()),
            // No `targetPlatform` here: Open VSX's filter keeps only extensions with
            // per-platform builds and drops every universal one (18,392 -> 522). The
            // Windows build is picked when the page opens and on download instead.
            ("includeAllVersions", "false"),
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(url.to_string())
}

/// The hash out of a `.sha256` file (`<hex>` or `<hex>  <file name>`).
pub fn parse_sha256(body: &str) -> Option<String> {
    let hash = body.split_whitespace().next()?;
    (hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit())).then(|| hash.to_lowercase())
}

// ---- HTTP ------------------------------------------------------------------------------------------------------

enum Fetched {
    Found(String),
    NotFound,
}

fn fetch(url: &str, cap: u64) -> Result<Fetched, String> {
    if !url.starts_with(ORIGIN) {
        return Err("Only open-vsx.org is contacted.".into());
    }
    let response = UreqClient::new()
        .get(url, None)
        .map_err(|err| format!("Couldn't reach Open VSX: {err}"))?;
    if response.status == 404 {
        return Ok(Fetched::NotFound);
    }
    if response.status != 200 {
        return Err(format!("Open VSX answered HTTP {}.", response.status));
    }
    let mut body = String::new();
    response
        .body
        .take(cap + 1)
        .read_to_string(&mut body)
        .map_err(|err| format!("Couldn't read the answer from Open VSX: {err}"))?;
    if body.len() as u64 > cap {
        return Err("The answer from Open VSX is too large.".into());
    }
    Ok(Fetched::Found(body))
}

fn fetch_json(url: &str) -> Result<Option<Value>, String> {
    match fetch(url, MAX_JSON_BYTES)? {
        Fetched::NotFound => Ok(None),
        Fetched::Found(body) => serde_json::from_str(&body)
            .map(Some)
            .map_err(|err| format!("Open VSX sent something unexpected: {err}")),
    }
}

/// The Windows build of an extension if it has platform builds, else its universal one.
fn details_json(namespace: &str, name: &str) -> Result<Value, String> {
    if !valid_ident(namespace) || !valid_ident(name) {
        return Err("That isn't a valid extension name.".into());
    }
    let targeted = fetch_json(&format!("{API}/{namespace}/{name}/{TARGET_PLATFORM}"))?;
    if let Some(value) = targeted.filter(|v| v.get("error").is_none()) {
        return Ok(value);
    }
    match fetch_json(&format!("{API}/{namespace}/{name}"))? {
        Some(value) if value.get("error").is_none() => Ok(value),
        _ => Err(format!("{namespace}.{name} isn't on Open VSX.")),
    }
}

async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(job)
        .await
        .map_err(|err| err.to_string())?
}

// ---- commands --------------------------------------------------------------------------------------------------

/// Searches Open VSX (an empty query lists everything, e.g. by install count).
#[tauri::command]
pub async fn ext_market_search(
    query: String,
    sort: String,
    offset: u32,
    size: u32,
) -> Result<MarketPage, String> {
    let url = search_url(&query, &sort, offset, size)?;
    blocking(move || {
        let value = fetch_json(&url)?.ok_or("Open VSX search isn't available.")?;
        Ok(parse_page(&value))
    })
    .await
}

/// One extension's page (the Windows build when there is one).
#[tauri::command]
pub async fn ext_market_details(namespace: String, name: String) -> Result<MarketDetails, String> {
    blocking(move || {
        let value = details_json(&namespace, &name)?;
        parse_details(&value).ok_or_else(|| "Open VSX sent an incomplete extension.".to_string())
    })
    .await
}

/// A README or CHANGELOG from Open VSX (only URLs on open-vsx.org).
#[tauri::command]
pub async fn ext_market_text(url: String) -> Result<String, String> {
    blocking(move || match fetch(&url, MAX_TEXT_BYTES)? {
        Fetched::Found(body) => Ok(body),
        Fetched::NotFound => Err("Open VSX has no such file.".into()),
    })
    .await
}

/// Downloads an extension's `.vsix` into `cache/extensions/`, checked against the
/// SHA256 Open VSX publishes, and returns its path for the normal install flow.
#[tauri::command]
pub async fn ext_market_download(
    namespace: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // A download in progress: this computer's own cache (two computers fetching one extension must not share a file).
    let dir = state.paths.machine_cache_dir.join("extensions");
    blocking(move || {
        let value = details_json(&namespace, &name)?;
        let version = text(&value, "version").unwrap_or_else(|| "latest".into());
        let file_url = open_vsx_url(value.pointer("/files/download"))
            .ok_or("Open VSX offers no download for this extension.")?;
        let sha_url = open_vsx_url(value.pointer("/files/sha256"))
            .ok_or("Open VSX publishes no checksum for this extension, so it isn't installed.")?;
        let expected = match fetch(&sha_url, 4096)? {
            Fetched::Found(body) => parse_sha256(&body),
            Fetched::NotFound => None,
        }
        .ok_or("Open VSX's checksum for this extension couldn't be read.")?;
        if !valid_ident(&version) {
            return Err("Open VSX sent an unexpected version.".into());
        }
        let dest: PathBuf = dir.join(format!("{namespace}.{name}-{version}.vsix"));
        let client = UreqClient::new();
        download(&client, &file_url, &dest, None, &mut |_, _| {})
            .map_err(|err| format!("The download failed: {err}"))?;
        verify_sha256(&dest, &expected, &mut |_, _| {}).map_err(|err| {
            format!("The download didn't match Open VSX's checksum and was deleted: {err}")
        })?;
        Ok(dest.to_string_lossy().into_owned())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn python() -> Value {
        json!({
            "namespace": "ms-python", "name": "python", "displayName": "Python",
            "description": "Python language support", "version": "2026.4.0",
            "downloadCount": 59099659, "averageRating": 3.875, "reviewCount": 16,
            "verified": true, "deprecated": false, "namespaceDisplayName": "Microsoft",
            "categories": ["Programming Languages", "Debuggers"], "tags": ["python"],
            "license": "MIT", "repository": "git+https://github.com/Microsoft/vscode-python.git",
            "homepage": "javascript:alert(1)", "timestamp": "2026-03-13T04:21:53Z",
            "engines": { "vscode": "^1.95.0" },
            "files": {
                "icon": "https://open-vsx.org/api/ms-python/python/2026.4.0/file/icon.png",
                "readme": "https://open-vsx.org/api/ms-python/python/2026.4.0/file/README.md",
                "changelog": "https://evil.example/CHANGELOG.md"
            }
        })
    }

    #[test]
    fn reads_a_search_page() {
        let page = parse_page(&json!({
            "offset": 0, "totalSize": 2,
            "extensions": [python(), { "namespace": "../x", "name": "bad" }]
        }));
        assert_eq!(page.total, 2);
        assert_eq!(
            page.items.len(),
            1,
            "an entry with an unsafe namespace is dropped"
        );
        let item = &page.items[0];
        assert_eq!(item.display_name, "Python");
        assert_eq!(item.download_count, 59_099_659);
        assert_eq!(item.average_rating, Some(3.875));
        assert!(item.verified);
        assert!(item
            .icon_url
            .as_deref()
            .is_some_and(|u| u.starts_with(ORIGIN)));
    }

    #[test]
    fn details_keep_only_safe_links() {
        let details = parse_details(&python()).expect("details");
        assert_eq!(details.publisher, "Microsoft");
        assert_eq!(
            details.categories,
            vec!["Programming Languages", "Debuggers"]
        );
        assert_eq!(
            details.repository.as_deref(),
            Some("https://github.com/Microsoft/vscode-python.git")
        );
        assert_eq!(details.homepage, None, "a javascript: link is dropped");
        assert!(details.readme_url.is_some());
        assert_eq!(
            details.changelog_url, None,
            "files are fetched only from open-vsx.org"
        );
        assert_eq!(details.engine.as_deref(), Some("^1.95.0"));
        assert_eq!(
            details.page_url,
            "https://open-vsx.org/extension/ms-python/python"
        );
    }

    #[test]
    fn a_missing_display_name_falls_back_to_the_name() {
        let item =
            parse_item(&json!({ "namespace": "redhat", "name": "vscode-yaml" })).expect("item");
        assert_eq!(item.display_name, "vscode-yaml");
        assert_eq!(item.icon_url, None);
        assert_eq!(item.average_rating, None);
    }

    #[test]
    fn builds_the_search_url_with_an_encoded_query_and_no_platform_filter() {
        let url = search_url("c# & go", "installs", 20, 500).expect("url");
        assert!(url.starts_with("https://open-vsx.org/api/-/search?"));
        assert!(url.contains("query=c%23+%26+go"));
        assert!(url.contains("sortBy=downloadCount"));
        assert!(url.contains("offset=20"));
        assert!(url.contains("size=50"), "the page size is capped");
        assert!(
            !url.contains("targetPlatform"),
            "a platform filter hides every universal extension"
        );
        assert_eq!(sort_key("whatever"), "relevance");
    }

    #[test]
    fn checks_names_and_checksums() {
        assert!(valid_ident("ms-python"));
        assert!(valid_ident("vscode-yaml"));
        assert!(valid_ident("2026.4.0"));
        for bad in ["", "..", ".hidden", "a/b", "a b", "a?b", "a%2Fb"] {
            assert!(!valid_ident(bad), "{bad} must be refused");
        }
        let hash = "A".repeat(64);
        assert_eq!(
            parse_sha256(&format!("{hash}  x.vsix\n")),
            Some("a".repeat(64))
        );
        assert_eq!(parse_sha256("nope"), None);
        assert_eq!(parse_sha256(""), None);
    }

    #[test]
    fn never_fetches_outside_open_vsx() {
        assert!(fetch("https://evil.example/x", 10).is_err());
        assert!(fetch("http://open-vsx.org/api", 10).is_err());
    }
}
