use std::collections::HashMap;

use openmind_runtime_manager::manifest::RuntimeRegistry;
use openmind_workloads::{
    component, framework, framework_missing, plan, resolve, Facts, LspFact, Provision, RuntimeFact,
    Selection, State, WarningKind, COMPONENTS, FRAMEWORKS, PACKS, WORKLOADS,
};

/// The facts of a fresh copy of OpenMind on Windows x64: every built-in runtime available, nothing installed, the
/// offline LSP bundle present, nothing found on the computer.
fn fresh() -> Facts {
    let registry = RuntimeRegistry::builtin();
    let mut facts = Facts::default();
    for manifest in registry.all() {
        let (download_bytes, install_bytes) =
            manifest.sizes(&manifest.default_version, "windows-x64");
        facts.runtimes.insert(
            manifest.id.clone(),
            RuntimeFact {
                installed: None,
                available: manifest
                    .artifact(&manifest.default_version, "windows-x64")
                    .is_some(),
                default_version: manifest.default_version.clone(),
                download_bytes,
                install_bytes,
                license_acceptance: manifest
                    .license
                    .as_ref()
                    .is_some_and(|l| l.acceptance_required),
            },
        );
    }
    for server in [
        "typescript",
        "json",
        "css",
        "html",
        "python",
        "yaml",
        "bash",
        "dockerfile",
        "rust",
        "clangd",
    ] {
        facts.lsp.insert(
            server.to_string(),
            LspFact {
                bundled: true,
                installed: false,
            },
        );
    }
    facts
}

fn selection(workloads: &[&str], add: &[&str], remove: &[&str]) -> Selection {
    let own = |list: &[&str]| list.iter().map(|s| (*s).to_string()).collect();
    Selection {
        workloads: own(workloads),
        add: own(add),
        remove: own(remove),
    }
}

#[test]
fn the_catalog_is_consistent_with_itself_and_the_runtime_manager() {
    let registry = RuntimeRegistry::builtin();
    for c in COMPONENTS {
        assert_eq!(
            COMPONENTS.iter().filter(|o| o.id == c.id).count(),
            1,
            "{} is listed once",
            c.id
        );
        for required in c.requires {
            assert!(
                component(required).is_some(),
                "{} requires unknown {required}",
                c.id
            );
        }
        if let Provision::Runtime { id } | Provision::IncludedWith { runtime: id } = c.provision {
            assert!(
                registry.get(id).is_ok(),
                "{}: no Runtime Manager manifest {id}",
                c.id
            );
        }
    }
    for w in WORKLOADS {
        for id in w.components {
            assert!(
                component(id).is_some(),
                "workload {} lists unknown {id}",
                w.id
            );
        }
        for id in w.frameworks {
            assert!(
                framework(id).is_some(),
                "workload {} lists unknown framework {id}",
                w.id
            );
        }
    }
    for p in PACKS {
        for id in p.components {
            assert!(component(id).is_some(), "pack {} lists unknown {id}", p.id);
        }
    }
    for f in FRAMEWORKS {
        for id in f.needs {
            assert!(
                component(id).is_some(),
                "framework {} needs unknown {id}",
                f.id
            );
        }
    }
    // The twelve workloads and twelve packs the milestone asks for.
    assert_eq!(WORKLOADS.len(), 12);
    assert_eq!(PACKS.len(), 12);
    // Every installable manifest is somewhere in the full offline toolkit.
    let full = WORKLOADS
        .iter()
        .find(|w| w.id == "full-offline")
        .expect("full");
    for manifest in registry.all() {
        assert!(
            full.components.contains(&manifest.id.as_str()),
            "full offline toolkit lacks {}",
            manifest.id
        );
    }
}

#[test]
fn nothing_without_a_safe_app_local_package_is_ever_installable() {
    let facts = fresh();
    for id in [
        "redis",
        "gdb",
        "rustup",
        "cargo",
        "docker",
        "docker-compose",
        "msvc",
        "cuda",
        "rocm",
        "android-studio",
        "android-emulator",
        "xcode",
        "dotnet-framework",
        "maui",
        "jdtls",
        "csharp-lsp",
        "phpactor",
        "nuget-offline",
    ] {
        let status = resolve(component(id).expect(id), &facts);
        assert!(
            !status.state.installable(),
            "{id} must not be installable: {:?}",
            status.state
        );
        assert!(
            status.reason.as_deref().is_some_and(|r| !r.is_empty()),
            "{id} needs a reason"
        );
    }
    for (id, state) in [
        ("docker", State::AdminRequired),
        ("msvc", State::AdminRequired),
        ("cuda", State::AdminRequired),
        ("redis", State::ExternalRequired),
        ("rustup", State::ExternalRequired),
        ("gdb", State::Planned),
    ] {
        assert_eq!(
            resolve(component(id).expect(id), &facts).state,
            state,
            "{id}"
        );
    }
}

#[test]
fn statuses_follow_the_facts_honestly() {
    let mut facts = fresh();
    let jdk = || resolve(component("jdk").expect("jdk"), &fresh());
    assert_eq!(jdk().state, State::Available);
    assert_eq!(jdk().runtime.as_deref(), Some("jdk"));
    assert!(jdk().download_bytes.is_some_and(|b| b > 100_000_000));
    // Heavy: Flutter, .NET, PostgreSQL, LLVM-MinGW; still installable.
    for id in ["flutter", "dotnet", "postgresql", "llvm-mingw"] {
        let status = resolve(component(id).expect(id), &facts);
        assert_eq!(status.state, State::HeavySdk, "{id}");
        assert!(status.state.installable());
    }
    // Installed: the active version is shown; what comes with it is installed too.
    facts.runtimes.get_mut("node").expect("node").installed = Some("24.21.0".into());
    let npm = resolve(component("npm").expect("npm"), &facts);
    assert_eq!(
        (npm.state, npm.version.as_deref()),
        (State::Installed, Some("24.21.0"))
    );
    // No download for this platform: unsupported architecture, with the reason.
    facts.runtimes.get_mut("go").expect("go").available = false;
    let go = resolve(component("go").expect("go"), &facts);
    assert_eq!(go.state, State::UnsupportedArchitecture);
    assert!(go.reason.is_some());
    // Found on this computer: an external tool counts as installed (from the system); a runtime stays installable.
    facts
        .found
        .insert("docker".into(), "C:/Program Files/Docker/docker.exe".into());
    facts
        .found
        .insert("java".into(), "C:/jdk/bin/java.exe".into());
    let docker = resolve(component("docker").expect("docker"), &facts);
    assert_eq!(
        (docker.state, docker.source.as_str()),
        (State::Installed, "system")
    );
    let jdk_found = resolve(component("jdk").expect("jdk"), &facts);
    assert_eq!(jdk_found.state, State::Available);
    assert!(jdk_found.found.is_some());
    // The offline LSP bundle: installed; without it, Language Tools.
    assert_eq!(
        resolve(component("lsp-pyright").expect("p"), &facts).state,
        State::Installed
    );
    facts.lsp.clear();
    assert_eq!(
        resolve(component("lsp-pyright").expect("p"), &facts).state,
        State::ManualInstall
    );
    // Project tools say how to add them.
    let prettier = resolve(component("prettier").expect("prettier"), &facts);
    assert_eq!(prettier.state, State::ManualInstall);
    assert_eq!(prettier.command.as_deref(), Some("npm i -D prettier"));
    // Android: the licence must be accepted.
    assert!(resolve(component("android-cmdline-tools").expect("a"), &facts).license_acceptance);
}

#[test]
fn minimal_and_an_empty_selection_install_nothing() {
    for s in [selection(&["minimal"], &[], &[]), selection(&[], &[], &[])] {
        let p = plan(&s, &fresh());
        assert!(p.install.is_empty() && p.components.is_empty() && p.warnings.is_empty());
        assert_eq!((p.download_bytes, p.install_bytes), (0, 0));
    }
}

#[test]
fn dependencies_are_added_first_and_a_removed_one_is_warned_about() {
    let facts = fresh();
    let p = plan(&selection(&[], &["maven", "kotlin"], &[]), &facts);
    assert_eq!(
        p.install,
        vec!["jdk", "maven", "kotlin"],
        "the JDK first, once"
    );
    assert!(p
        .warnings
        .iter()
        .any(|w| w.kind == WarningKind::DependencyAdded
            && w.component == "jdk"
            && w.needed_by.as_deref() == Some("maven")));
    let without = plan(&selection(&[], &["maven"], &["jdk"]), &facts);
    assert_eq!(without.install, vec!["maven"]);
    assert!(without
        .warnings
        .iter()
        .any(|w| w.kind == WarningKind::MissingDependency && w.component == "jdk"));
    // Flutter needs Git.
    assert_eq!(
        plan(&selection(&[], &["flutter"], &[]), &facts).install,
        vec!["git", "flutter"]
    );
}

#[test]
fn a_workload_plan_sums_sizes_skips_installed_runtimes_and_warns_about_the_rest() {
    let mut facts = fresh();
    let registry = RuntimeRegistry::builtin();
    let web = plan(&selection(&["web"], &[], &[]), &facts);
    assert_eq!(web.install, vec!["node", "js-debug"]);
    let sizes = |id: &str| {
        let m = registry.get(id).expect(id);
        m.sizes(&m.default_version, "windows-x64")
    };
    assert_eq!(
        web.download_bytes,
        ["node", "js-debug"]
            .iter()
            .map(|id| sizes(id).0.unwrap_or(0))
            .sum::<u64>()
    );
    assert!(web
        .warnings
        .iter()
        .any(|w| w.kind == WarningKind::ManualInstall && w.component == "prettier"));
    facts.runtimes.get_mut("node").expect("node").installed = Some("24.21.0".into());
    assert_eq!(
        plan(&selection(&["web"], &[], &[]), &facts).install,
        vec!["js-debug"]
    );

    let mobile = plan(&selection(&["mobile"], &[], &[]), &facts);
    for runtime in [
        "git",
        "flutter",
        "dart",
        "jdk",
        "android-cmdline-tools",
        "android-platform-tools",
        "gradle",
    ] {
        assert!(
            mobile.install.iter().any(|r| r == runtime),
            "mobile installs {runtime}"
        );
    }
    assert_eq!(
        mobile.licenses,
        vec!["android-cmdline-tools", "android-platform-tools"]
    );
    assert!(mobile
        .warnings
        .iter()
        .any(|w| w.kind == WarningKind::HeavySdk && w.component == "flutter"));
    assert!(mobile
        .warnings
        .iter()
        .any(|w| w.kind == WarningKind::ExternalRequired && w.component == "android-studio"));
    // Deselecting the heavy SDK takes its size out.
    let lighter = plan(&selection(&["mobile"], &[], &["flutter"]), &facts);
    assert!(lighter.download_bytes + 1_900_000_000 < mobile.download_bytes);
    assert!(!lighter.install.iter().any(|r| r == "flutter"));

    let systems = plan(&selection(&["systems"], &[], &[]), &facts);
    assert!(systems
        .warnings
        .iter()
        .any(|w| w.kind == WarningKind::AdminRequired && w.component == "msvc"));
    assert!(systems
        .warnings
        .iter()
        .any(|w| w.kind == WarningKind::Planned && w.component == "gdb"));
}

#[test]
fn a_framework_is_ready_only_when_what_it_needs_is_there() {
    let mut facts = fresh();
    let statuses = |facts: &Facts| {
        COMPONENTS
            .iter()
            .map(|c| (c.id.to_string(), resolve(c, facts)))
            .collect::<HashMap<_, _>>()
    };
    let flutter = framework("flutter-app").expect("flutter");
    assert_eq!(
        framework_missing(flutter.needs, &statuses(&facts)),
        vec!["flutter"]
    );
    // An external Flutter SDK on this computer is enough.
    facts
        .found
        .insert("flutter".into(), "D:/sdk/flutter/bin/flutter.bat".into());
    assert!(framework_missing(flutter.needs, &statuses(&facts)).is_empty());
    let maven = framework("maven-project").expect("maven");
    facts.runtimes.get_mut("jdk").expect("jdk").installed = Some("21.0.12.1".into());
    assert_eq!(
        framework_missing(maven.needs, &statuses(&facts)),
        vec!["maven"]
    );
}
