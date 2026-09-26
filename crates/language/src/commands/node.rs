//! Commands of Node.js projects: the `package.json` scripts, and the shells built on Node (Tauri, Electron, Expo).

use super::{cmd, safe_name, Category, Command};
use crate::project::{Detection, Dir};
use crate::tools::Os;

/// The scripts worth a button, with what they are.
const KNOWN_SCRIPTS: &[(&str, Category)] = &[
    ("dev", Category::Dev),
    ("start", Category::Run),
    ("serve", Category::Run),
    ("preview", Category::Run),
    ("build", Category::Build),
    ("test", Category::Test),
    ("lint", Category::Lint),
    ("typecheck", Category::Lint),
    ("format", Category::Format),
    ("fmt", Category::Format),
];

/// Scripts that only mean something in a mobile project.
const MOBILE_SCRIPTS: &[(&str, Category)] = &[
    ("android", Category::Run),
    ("ios", Category::Run),
    ("web", Category::Run),
];

fn pm_tools(pm: &str) -> Vec<&'static str> {
    match pm {
        "pnpm" => vec!["node", "pnpm"],
        "yarn" => vec!["node", "yarn"],
        "bun" => vec!["bun"],
        _ => vec!["node", "npm"],
    }
}

/// `npm run <script>`, `pnpm run <script>`, ...
fn run_script(pm: &str, script: &str) -> Vec<String> {
    vec![pm.to_string(), "run".to_string(), script.to_string()]
}

/// `pnpm tauri dev`; npm needs `run` in front.
fn run_bin(pm: &str, bin: &str, args: &[&str]) -> Vec<String> {
    let mut argv = vec![pm.to_string()];
    if pm == "npm" {
        argv.push("run".to_string());
    }
    argv.push(bin.to_string());
    argv.extend(args.iter().map(|a| (*a).to_string()));
    argv
}

fn with_argv(mut command: Command, argv: Vec<String>) -> Command {
    command.argv = argv;
    command
}

pub fn commands(dir: &Dir, pm: &str, detections: &[Detection], os: Os) -> Vec<Command> {
    let has = |id: &str| detections.iter().any(|d| d.id == id);
    let tools = pm_tools(pm);
    let mobile = has("react-native") || has("expo") || has("ionic") || has("capacitor");
    let mut out = Vec::new();
    if !dir.has("node_modules") {
        out.push(
            with_argv(
                cmd(
                    "node.install",
                    &format!("Install dependencies ({pm} install)"),
                    Category::Install,
                    &[],
                    &tools,
                ),
                vec![pm.to_string(), "install".to_string()],
            )
            .network()
            .note("Downloads the project's packages."),
        );
    }
    let known = KNOWN_SCRIPTS.iter().chain(if mobile {
        MOBILE_SCRIPTS.iter()
    } else {
        [].iter()
    });
    for (script, category) in known {
        if dir.script(script).is_none() || !safe_name(script) {
            continue;
        }
        let mut command = with_argv(
            cmd(
                &format!("node.script.{script}"),
                &format!("{pm} run {script}"),
                *category,
                &[],
                &tools,
            ),
            run_script(pm, script),
        );
        if let Some(body) = dir.script(script) {
            command = command.note(&format!(
                "package.json: {}",
                body.chars().take(120).collect::<String>()
            ));
        }
        if *script == "ios" && os != Os::MacOs {
            command = command.unavailable("iOS builds require macOS and Xcode.");
        }
        if *script == "android" {
            command.tools.push("android-sdk".to_string());
        }
        out.push(command);
    }
    shells(dir, pm, detections, &tools, &mut out);
    if has("prisma") {
        out.push(cmd(
            "prisma.validate",
            "Validate the Prisma schema",
            Category::Lint,
            &["npx", "prisma", "validate"],
            &["node", "npx"],
        ));
    }
    out
}

/// Tauri, Electron and Expo commands that have no script of their own.
fn shells(dir: &Dir, pm: &str, detections: &[Detection], tools: &[&str], out: &mut Vec<Command>) {
    let has = |id: &str| detections.iter().any(|d| d.id == id);
    if has("tauri") && dir.script("tauri").is_some() {
        let mut tauri_tools = tools.to_vec();
        tauri_tools.push("cargo");
        out.push(with_argv(
            cmd(
                "tauri.dev",
                &format!("{} tauri dev", if pm == "npm" { "npm run" } else { pm }),
                Category::Dev,
                &[],
                &tauri_tools,
            ),
            run_bin(pm, "tauri", &["dev"]),
        ));
        out.push(with_argv(
            cmd(
                "tauri.build",
                &format!("{} tauri build", if pm == "npm" { "npm run" } else { pm }),
                Category::Build,
                &[],
                &tauri_tools,
            ),
            run_bin(pm, "tauri", &["build"]),
        ));
    }
    let has_run = dir.script("start").is_some() || dir.script("dev").is_some();
    if has("electron") && !has_run {
        out.push(
            cmd(
                "electron.run",
                "Run Electron (npx electron .)",
                Category::Run,
                &["npx", "electron", "."],
                &["node", "npx"],
            )
            .note("Needs electron installed in node_modules."),
        );
    }
    if has("expo") && dir.script("start").is_none() {
        out.push(
            cmd(
                "expo.start",
                "Start Expo (npx expo start)",
                Category::Dev,
                &["npx", "expo", "start"],
                &["node", "npx"],
            )
            .note("Opens the Expo dev server; no emulator is started by OpenMind."),
        );
    }
}
