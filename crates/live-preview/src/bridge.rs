//! The console bridge every served HTML page gets, and the page that runs a lone script.
//!
//! The bridge reports to the window that embeds the page (`parent.postMessage`, `{__openmind: "browser", ...}`):
//! `console.*` calls, uncaught errors, rejected promises, files that failed to load, and the page's address and
//! title. It changes nothing else: the original `console` functions still run.

use crate::request::percent_encode;

/// The bridge script's address.
pub const BRIDGE_PATH: &str = "/__openmind__/console.js";
/// The page that runs one script: `?src=/path/app.js` (`&module=1` for an ES module).
pub const RUN_SCRIPT_PATH: &str = "/__openmind__/run";

pub const BRIDGE_SCRIPT: &str = r#"(function () {
  if (window.parent === window || window.__openmindConsole) return;
  window.__openmindConsole = true;
  var origin = location.origin;
  function send(message) {
    message.__openmind = "browser";
    try { window.parent.postMessage(message, "*"); } catch (e) { /* the app is gone */ }
  }
  function short(url) {
    return typeof url === "string" && url.indexOf(origin) === 0 ? url.slice(origin.length) : String(url);
  }
  function show(value) {
    if (typeof value === "string") return value;
    if (value === undefined) return "undefined";
    if (typeof value === "function") return "ƒ " + (value.name || "anonymous") + "()";
    if (typeof value === "symbol" || typeof value === "bigint") return value.toString();
    if (value instanceof Error) return value.stack || (value.name + ": " + value.message);
    if (typeof Element !== "undefined" && value instanceof Element) {
      var html = value.outerHTML || "<" + value.tagName.toLowerCase() + ">";
      return html.length > 300 ? html.slice(0, 300) + "…" : html;
    }
    try {
      var seen = [];
      var text = JSON.stringify(value, function (key, item) {
        if (typeof item === "object" && item !== null) {
          if (seen.indexOf(item) >= 0) return "[Circular]";
          seen.push(item);
        }
        if (typeof item === "function") return "ƒ " + (item.name || "anonymous") + "()";
        if (item === undefined) return "undefined";
        return item;
      }, 2);
      if (text === undefined) return String(value);
      return text.length > 10000 ? text.slice(0, 10000) + "…" : text;
    } catch (e) {
      return String(value);
    }
  }
  function where() {
    return { href: short(location.href), title: document.title };
  }
  ["log", "info", "warn", "error", "debug", "trace"].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) parts.push(show(arguments[i]));
      send({ type: "console", level: level === "trace" ? "log" : level, text: parts.join(" ") });
      if (typeof original === "function") return original.apply(console, arguments);
    };
  });
  var originalTable = console.table;
  console.table = function (data) {
    send({ type: "console", level: "log", text: show(data) });
    if (typeof originalTable === "function") return originalTable.apply(console, arguments);
  };
  var originalClear = console.clear;
  console.clear = function () {
    send({ type: "clear" });
    if (typeof originalClear === "function") return originalClear.apply(console, arguments);
  };
  window.addEventListener("error", function (event) {
    if (event instanceof ErrorEvent) {
      var at = event.filename ? " (" + short(event.filename) + ":" + event.lineno + ":" + event.colno + ")" : "";
      var text = event.error && event.error.stack ? event.error.stack : (event.message || "Script error.");
      send({ type: "console", level: "error", text: "Uncaught " + text + at });
      return;
    }
    var target = event.target;
    if (target && target !== window && (target.src || target.href)) {
      send({ type: "console", level: "error", text: "Failed to load " + short(target.src || target.href) });
    }
  }, true);
  window.addEventListener("unhandledrejection", function (event) {
    send({ type: "console", level: "error", text: "Uncaught (in promise) " + show(event.reason) });
  });
  send(Object.assign({ type: "location" }, where()));
  window.addEventListener("load", function () { send(Object.assign({ type: "loaded" }, where())); });
  window.addEventListener("hashchange", function () { send(Object.assign({ type: "location" }, where())); });
})();
"#;

fn bridge_tag() -> String {
    format!("<script src=\"{BRIDGE_PATH}\"></script>")
}

/// Puts the bridge first in the page: right after `<head>`, else after `<html>`, else after the doctype, else at the
/// very start — so it runs before the page's own scripts.
pub fn inject_bridge(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let at = tag_end(&lower, "<head")
        .or_else(|| tag_end(&lower, "<html"))
        .or_else(|| tag_end(&lower, "<!doctype"))
        .unwrap_or(0);
    let mut out = String::with_capacity(html.len() + 64);
    out.push_str(&html[..at]);
    out.push_str(&bridge_tag());
    out.push_str(&html[at..]);
    out
}

/// The byte after the `>` of the first `<name` tag (not `<header` for `<head`).
fn tag_end(lower: &str, name: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(found) = lower[from..].find(name) {
        let start = from + found;
        let after = start + name.len();
        let next = lower[after..].chars().next();
        if matches!(
            next,
            Some('>') | Some(' ') | Some('\t') | Some('\n') | Some('\r') | Some('/')
        ) {
            return lower[after..].find('>').map(|close| after + close + 1);
        }
        from = after;
    }
    None
}

/// A page that runs the script at `src` (an address inside the folder) with the bridge, so its output reaches the
/// console. `module` runs it as an ES module (for `import`/`export`).
pub fn run_script_page(src: &str, module: bool) -> String {
    let name = src.rsplit('/').next().unwrap_or(src);
    let address: String = src
        .split('/')
        .map(percent_encode)
        .collect::<Vec<_>>()
        .join("/");
    let kind = if module { " type=\"module\"" } else { "" };
    format!(
        "<!doctype html>\n<html><head><meta charset=\"utf-8\">{bridge}<title>{title}</title>\
         <style>body{{font:13px system-ui,sans-serif;color:#555;margin:16px}}code{{font-family:Consolas,monospace}}</style>\
         </head><body><p>Running <code>{title}</code> — its output is in the console below.</p>\
         <script{kind} src=\"{address}\"></script></body></html>\n",
        bridge = bridge_tag(),
        title = escape(name),
    )
}

/// A simple listing of a folder (names escaped), for a folder without `index.html`.
pub fn directory_page(address: &str, entries: &[(String, bool)]) -> String {
    let mut items = String::new();
    if address != "/" {
        items.push_str("<li><a href=\"../\">../</a></li>");
    }
    for (name, is_dir) in entries {
        let suffix = if *is_dir { "/" } else { "" };
        items.push_str(&format!(
            "<li><a href=\"{}{suffix}\">{}{suffix}</a></li>",
            percent_encode(name),
            escape(name)
        ));
    }
    format!(
        "<!doctype html>\n<html><head><meta charset=\"utf-8\">{bridge}<title>Index of {title}</title>\
         <style>body{{font:13px system-ui,sans-serif;margin:16px}}li{{margin:2px 0}}</style></head>\
         <body><h1>Index of {title}</h1><ul>{items}</ul></body></html>\n",
        bridge = bridge_tag(),
        title = escape(address),
    )
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bridge_goes_first_in_head_html_or_the_page() {
        let tag = bridge_tag();
        assert_eq!(
            inject_bridge("<!DOCTYPE html><HTML lang=en><head><script>x()</script></head>"),
            format!("<!DOCTYPE html><HTML lang=en><head>{tag}<script>x()</script></head>")
        );
        assert_eq!(
            inject_bridge("<html><header>h</header></html>"),
            format!("<html>{tag}<header>h</header></html>")
        );
        assert_eq!(inject_bridge("<p>bare</p>"), format!("{tag}<p>bare</p>"));
        assert_eq!(
            inject_bridge("<!doctype html>\n<p>x</p>"),
            format!("<!doctype html>{tag}\n<p>x</p>")
        );
    }

    #[test]
    fn the_script_page_escapes_the_name_and_encodes_the_address() {
        let page = run_script_page("/my dir/a<b>.js", true);
        assert!(page.contains("<script type=\"module\" src=\"/my%20dir/a%3Cb%3E.js\"></script>"));
        assert!(page.contains("<title>a&lt;b&gt;.js</title>"));
        assert!(page.contains(BRIDGE_PATH));
        assert!(!run_script_page("/a.js", false).contains("type=\"module\""));
    }

    #[test]
    fn listings_escape_names() {
        let page = directory_page("/sub/", &[("<x>.html".into(), false), ("css".into(), true)]);
        assert!(page.contains("&lt;x&gt;.html"));
        assert!(page.contains("href=\"%3Cx%3E.html\""));
        assert!(page.contains("href=\"css/\""));
        assert!(page.contains("href=\"../\""));
    }
}
