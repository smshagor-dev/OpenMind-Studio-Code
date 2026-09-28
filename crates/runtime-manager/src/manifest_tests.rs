use super::*;

fn valid_json() -> String {
    r#"{
      "id": "demo", "displayName": "Demo", "description": "d", "defaultVersion": "1.0.0",
      "versionCommand": { "executable": "demo.exe", "args": ["--version"] },
      "binDirs": ["."], "verifyFiles": ["demo.exe"],
      "versions": [ { "version": "1.0.0", "artifacts": [
        { "platform": "windows-x64", "url": "https://example.com/demo.zip",
          "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
          "archive": "zip" } ] } ]
    }"#
    .to_string()
}

#[test]
fn builtin_registry_has_the_shipped_runtimes_with_usable_windows_artifacts() {
    let registry = RuntimeRegistry::builtin();

    for id in [
        "node",
        "python",
        "git",
        "php",
        "composer",
        "mariadb",
        "phpmyadmin",
    ] {
        let manifest = registry.get(id).expect(id);
        assert!(
            manifest
                .artifact(&manifest.default_version, "windows-x64")
                .is_some(),
            "{id}"
        );
    }
    assert_eq!(registry.all().count(), BUILTIN.len());
}

#[test]
fn the_php_manifest_is_portable_https_only_and_uses_a_relative_php_ini() {
    let registry = RuntimeRegistry::builtin();
    let php = registry.get("php").expect("php");

    assert_eq!(
        php.env.get("OPENMIND_PHP").map(String::as_str),
        Some("{dir}\\php.exe")
    );
    assert!(php.verify_files.iter().any(|file| file == "php.ini"));
    let ini = php
        .seed_files
        .iter()
        .find(|f| f.path == "php.ini")
        .expect("php.ini");
    assert!(
        ini.content.contains("extension_dir = \"ext\""),
        "relative extension dir"
    );
    assert!(
        !ini.content.contains(":\\"),
        "no absolute path may be baked in"
    );
    for version in &php.versions {
        for artifact in &version.artifacts {
            assert!(artifact.url.starts_with("https://downloads.php.net/"));
            assert_eq!(artifact.sha256.len(), 64);
        }
    }
}

#[test]
fn the_composer_manifest_installs_one_phar_and_runs_it_through_the_active_php() {
    let registry = RuntimeRegistry::builtin();
    let composer = registry.get("composer").expect("composer");
    let artifact = composer
        .artifact(&composer.default_version, "windows-x64")
        .expect("artifact");

    assert_eq!(artifact.archive, ArchiveKind::File);
    assert_eq!(artifact.install_as.as_deref(), Some("composer.phar"));
    assert_eq!(composer.shims[0].name, "composer");
    assert_eq!(composer.shims[0].via_env.as_deref(), Some("OPENMIND_PHP"));
}

#[test]
fn a_file_artifact_needs_a_plain_install_name_and_a_zip_may_not_have_one() {
    let file = valid_json().replace("\"archive\": \"zip\"", "\"archive\": \"file\"");
    assert!(
        RuntimeManifest::parse(&file).is_err(),
        "file without installAs"
    );
    let traversal = valid_json().replace(
        "\"archive\": \"zip\"",
        "\"archive\": \"file\", \"installAs\": \"../x\"",
    );
    assert!(RuntimeManifest::parse(&traversal).is_err());
    let stray = valid_json().replace(
        "\"archive\": \"zip\"",
        "\"archive\": \"zip\", \"installAs\": \"x.phar\"",
    );
    assert!(RuntimeManifest::parse(&stray).is_err());
}

#[test]
fn a_seed_file_path_and_a_shim_variable_are_validated() {
    let escaping = valid_json().replace(
        "\"versions\"",
        "\"seedFiles\": [{ \"path\": \"../php.ini\", \"content\": \"x\" }], \"versions\"",
    );
    assert!(RuntimeManifest::parse(&escaping).is_err());
    let bad_var = valid_json().replace(
        "\"versions\"",
        "\"shims\": [{ \"name\": \"t\", \"target\": \"t.exe\", \"viaEnv\": \"php; calc\" }], \"versions\"",
    );
    assert!(RuntimeManifest::parse(&bad_var).is_err());
}

#[test]
fn parses_a_valid_manifest_with_defaults() {
    let manifest = RuntimeManifest::parse(&valid_json()).expect("parse");

    assert_eq!(manifest.id, "demo");
    let artifact = manifest.artifact("1.0.0", "windows-x64").expect("artifact");
    assert_eq!(artifact.strip_components, 0);
    assert!(manifest.env.is_empty());
    assert!(manifest.artifact("1.0.0", "linux-x64").is_none());
    assert_eq!(manifest.versions_for("windows-x64"), vec!["1.0.0"]);
    assert!(manifest.versions_for("linux-x64").is_empty());
}

#[test]
fn rejects_http_urls() {
    let json = valid_json().replace("https://", "http://");

    assert!(matches!(
        RuntimeManifest::parse(&json),
        Err(RuntimeError::InsecureUrl(_))
    ));
}

#[test]
fn rejects_bad_checksums_ids_and_paths() {
    for json in [
        valid_json().replace(&"0".repeat(64), "abc"),
        valid_json().replace("\"id\": \"demo\"", "\"id\": \"../evil\""),
        valid_json().replace("\"binDirs\": [\".\"]", "\"binDirs\": [\"..\"]"),
        valid_json().replace(
            "\"verifyFiles\": [\"demo.exe\"]",
            "\"verifyFiles\": [\"C:/Windows/x.exe\"]",
        ),
        valid_json().replace(
            "\"defaultVersion\": \"1.0.0\"",
            "\"defaultVersion\": \"9.9.9\"",
        ),
        valid_json().replace("\"verifyFiles\": [\"demo.exe\"]", "\"verifyFiles\": []"),
    ] {
        assert!(
            matches!(
                RuntimeManifest::parse(&json),
                Err(RuntimeError::InvalidManifest(_))
            ),
            "{json}"
        );
    }
}

#[test]
fn rejects_unsafe_extract_roots_setup_steps_and_feature_files() {
    for json in [
        valid_json().replace("\"archive\": \"zip\"", "\"archive\": \"zip\", \"extractRoot\": \"../x\""),
        valid_json().replace("\"archive\": \"zip\"", "\"archive\": \"zip\", \"extractRoot\": \".\""),
        valid_json().replace(
            "\"binDirs\"",
            "\"postInstall\": [{ \"description\": \"d\", \"executable\": \"C:/evil.exe\", \"args\": [] }], \"binDirs\"",
        ),
        valid_json().replace(
            "\"binDirs\"",
            "\"features\": [{ \"id\": \"f\", \"label\": \"f\", \"verifyFile\": \"../x\" }], \"binDirs\"",
        ),
    ] {
        assert!(
            matches!(
                RuntimeManifest::parse(&json),
                Err(RuntimeError::InvalidManifest(_))
            ),
            "{json}"
        );
    }
}

#[test]
fn accepts_an_extract_root_setup_steps_and_features() {
    let json = valid_json()
        .replace("\"archive\": \"zip\"", "\"archive\": \"zip\", \"extractRoot\": \"tools\"")
        .replace(
            "\"binDirs\"",
            "\"postInstall\": [{ \"description\": \"d\", \"executable\": \"demo.exe\", \"args\": [\"-x\"] }], \"features\": [{ \"id\": \"f\", \"label\": \"F\", \"verifyFile\": \"Scripts/f.exe\" }], \"binDirs\"",
        );

    let manifest = RuntimeManifest::parse(&json).expect("parse");

    let artifact = manifest.artifact("1.0.0", "windows-x64").expect("artifact");
    assert_eq!(artifact.extract_root.as_deref(), Some("tools"));
    assert_eq!(manifest.post_install.len(), 1);
    assert_eq!(manifest.features[0].missing_note, "");
}

#[test]
fn rejects_shims_that_could_inject_script_text_or_escape_the_install() {
    let shim = |name: &str, target: &str, args: &str| {
        valid_json().replace(
            "\"binDirs\"",
            &format!(
                "\"shims\": [{{ \"name\": \"{name}\", \"target\": \"{target}\", \"args\": {args} }}], \"binDirs\""
            ),
        )
    };
    for json in [
        shim("pip", "python.exe", r#"["-m", "pip & calc"]"#),
        shim("pip", "python.exe", r#"["%PATH%"]"#),
        shim("pip", "python.exe", r#"["\"quoted\""]"#),
        shim("pip", "../python.exe", "[]"),
        shim("pip", "C:/python.exe", "[]"),
        shim("..", "python.exe", "[]"),
        shim("a b", "python.exe", "[]"),
    ] {
        assert!(
            matches!(
                RuntimeManifest::parse(&json),
                Err(RuntimeError::InvalidManifest(_))
            ),
            "{json}"
        );
    }
    let ok = RuntimeManifest::parse(&shim("pip3", "python.exe", r#"["-m", "pip"]"#))
        .expect("valid shim");
    assert_eq!(ok.shims[0].name, "pip3");
}

#[test]
fn rejects_malformed_json() {
    assert!(matches!(
        RuntimeManifest::parse("{ nope"),
        Err(RuntimeError::InvalidManifest(_))
    ));
}

#[test]
fn overrides_replace_add_and_skip_broken_files_without_failing() {
    let dir = tempfile::tempdir().expect("tempdir");
    std::fs::write(
        dir.path().join("node.json"),
        valid_json().replace("demo", "node"),
    )
    .expect("write");
    std::fs::write(dir.path().join("extra.json"), valid_json()).expect("write");
    std::fs::write(dir.path().join("broken.json"), "{ not json").expect("write");
    std::fs::write(dir.path().join("readme.txt"), "ignored").expect("write");

    let (registry, warnings) = RuntimeRegistry::builtin().with_overrides(dir.path());

    assert_eq!(registry.get("node").expect("node").display_name, "Demo");
    assert!(registry.get("demo").is_ok());
    assert!(registry.get("python").is_ok());
    assert_eq!(warnings.len(), 1);
    assert!(warnings[0].contains("broken.json"));
}

#[test]
fn a_missing_overrides_directory_is_fine() {
    let (registry, warnings) =
        RuntimeRegistry::builtin().with_overrides(Path::new("Z:/does/not/exist"));

    assert_eq!(registry.all().count(), BUILTIN.len());
    assert!(warnings.is_empty());
}

#[test]
fn unknown_runtime_is_a_typed_error() {
    assert!(matches!(
        RuntimeRegistry::builtin().get("cobol"),
        Err(RuntimeError::UnknownRuntime(_))
    ));
}

#[test]
fn safe_component_rules() {
    for ok in ["node", "24.21.0", "2.55.0.5", "a-b_c+d"] {
        assert!(is_safe_component(ok), "{ok}");
    }
    for bad in ["", ".", "..", "../x", "a/b", "a\\b", ".hidden", "a b", "C:"] {
        assert!(!is_safe_component(bad), "{bad}");
    }
}

#[test]
fn every_builtin_manifest_is_valid_for_windows_x64_and_requires_only_known_runtimes() {
    let registry = RuntimeRegistry::builtin();
    let ids: Vec<&str> = registry.all().map(|m| m.id.as_str()).collect();
    assert_eq!(ids.len(), BUILTIN.len(), "every built-in manifest parses");
    for manifest in registry.all() {
        assert!(
            manifest
                .artifact(&manifest.default_version, "windows-x64")
                .is_some(),
            "{} has a Windows x64 download",
            manifest.id
        );
        for required in &manifest.requires {
            assert!(
                ids.contains(&required.as_str()),
                "{} requires unknown {required}",
                manifest.id
            );
        }
    }
}

#[test]
fn workload_runtimes_carry_sizes_licences_and_honest_flags() {
    let registry = RuntimeRegistry::builtin();
    for id in [
        "jdk",
        "maven",
        "gradle",
        "kotlin",
        "go",
        "cmake",
        "ninja",
        "llvm-mingw",
        "git-lfs",
        "kubectl",
        "terraform",
        "helm",
        "dotnet",
        "dart",
        "flutter",
        "android-cmdline-tools",
        "android-platform-tools",
        "sqlite",
        "postgresql",
    ] {
        let manifest = registry.get(id).expect(id);
        let (download, install) = manifest.sizes(&manifest.default_version, "windows-x64");
        assert!(
            download.is_some_and(|d| d > 0) && install.is_some_and(|i| i > 0),
            "{id} sizes"
        );
        assert!(manifest.license.is_some(), "{id} licence");
    }
    for id in ["android-cmdline-tools", "android-platform-tools"] {
        let license = registry
            .get(id)
            .expect(id)
            .license
            .clone()
            .expect("licence");
        assert!(
            license.acceptance_required,
            "{id}: the Android SDK licence must be accepted first"
        );
    }
    // Tools whose version command is slow, starts a JVM or may download are never run from the system PATH.
    for id in [
        "flutter",
        "dart",
        "gradle",
        "maven",
        "kotlin",
        "android-cmdline-tools",
    ] {
        assert!(
            !registry.get(id).expect(id).probe_system,
            "{id} must not be probed"
        );
    }
    for id in ["maven", "gradle", "kotlin", "android-cmdline-tools"] {
        assert_eq!(
            registry.get(id).expect(id).requires,
            vec!["jdk".to_string()],
            "{id}"
        );
    }
    assert_eq!(
        registry.get("flutter").expect("flutter").requires,
        vec!["git".to_string()]
    );
    // Tools' caches and telemetry switches: app-local caches, no telemetry from processes OpenMind starts.
    let dotnet = registry.get("dotnet").expect("dotnet");
    assert_eq!(
        dotnet
            .env
            .get("DOTNET_CLI_TELEMETRY_OPTOUT")
            .map(String::as_str),
        Some("1")
    );
    assert!(dotnet
        .env
        .get("NUGET_PACKAGES")
        .is_some_and(|v| v.starts_with("{cache}")));
    assert_eq!(
        registry
            .get("go")
            .expect("go")
            .env
            .get("GOTOOLCHAIN")
            .map(String::as_str),
        Some("local")
    );
    assert_eq!(
        registry
            .get("terraform")
            .expect("terraform")
            .env
            .get("CHECKPOINT_DISABLE")
            .map(String::as_str),
        Some("1")
    );
    // The .NET SDK's first run must not change the user's PATH or certificate store.
    for (key, value) in [
        ("DOTNET_ADD_GLOBAL_TOOLS_TO_PATH", "false"),
        ("DOTNET_GENERATE_ASPNET_CERTIFICATE", "false"),
    ] {
        assert_eq!(
            dotnet.env.get(key).map(String::as_str),
            Some(value),
            "{key}"
        );
    }
    // No switch that the tool ignores is claimed (Go reads its telemetry mode from its own config, not the env).
    assert!(!registry
        .get("go")
        .expect("go")
        .env
        .contains_key("GOTELEMETRY"));
}

#[test]
fn an_install_that_needs_licence_acceptance_is_blocked_until_accepted() {
    let registry = RuntimeRegistry::builtin();
    let android = registry.get("android-cmdline-tools").expect("android");
    let reason = android.license_blocker(false).expect("blocked");
    assert!(
        reason.contains("Android Software Development Kit License Agreement"),
        "{reason}"
    );
    assert_eq!(android.license_blocker(true), None);
    // A licence without required acceptance never blocks.
    assert_eq!(
        registry.get("jdk").expect("jdk").license_blocker(false),
        None
    );
    assert_eq!(
        registry.get("node").expect("node").license_blocker(false),
        None
    );
}

#[test]
fn a_bad_requirement_or_licence_is_refused() {
    let bad_requires =
        valid_json().replacen("\"versions\"", "\"requires\": [\"../x\"], \"versions\"", 1);
    assert!(RuntimeManifest::parse(&bad_requires).is_err());
    let bad_license = valid_json().replacen(
        "\"versions\"",
        "\"license\": {\"name\": \"x\", \"url\": \"http://x\"}, \"versions\"",
        1,
    );
    assert!(RuntimeManifest::parse(&bad_license).is_err());
}
