use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use super::*;
use crate::plan::{plan, RunRequest};

/// A .NET Framework 4.8.1 `Release`.
const NET_481: u32 = 533_509;

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    workspace: PathBuf,
}

fn fixture() -> Fixture {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("app ü");
    let workspace = root.join("My Work");
    fs::create_dir_all(&workspace).expect("workspace");
    Fixture {
        _temp: temp,
        root,
        workspace,
    }
}

impl Fixture {
    fn source(&self, relative: &str, body: &str) -> PathBuf {
        let file = self.workspace.join(relative);
        fs::create_dir_all(file.parent().expect("parent")).expect("dir");
        fs::write(&file, body).expect("source");
        file
    }

    /// An empty stand-in for `name` in `runtimes/<runtime>/versions/<version>`, returned as that folder.
    fn runtime(&self, runtime: &str, version: &str, name: &str) -> PathBuf {
        let dir = self
            .root
            .join("runtimes")
            .join(runtime)
            .join("versions")
            .join(version);
        fs::create_dir_all(&dir).expect("dir");
        fs::write(dir.join(name), "").expect("stand-in");
        dir
    }

    fn plan(
        &self,
        file: &Path,
        dirs: Vec<PathBuf>,
        pascal: PascalOptions,
    ) -> Result<RunPlan, RunError> {
        let request = RunRequest {
            file: file.to_path_buf(),
            workspace: Some(self.workspace.clone()),
            template: None,
            arguments: None,
            assembly: Default::default(),
            pascal,
        };
        let env = RunEnvironment {
            path_prepend: dirs,
            vars: Vec::new(),
        };
        plan(
            &request,
            &env,
            &self.root,
            Some(OsString::new()),
            &self.root.join("cache").join("run-builds").join("run 1"),
        )
    }
}

fn abc(dotnet: Option<u32>) -> PascalOptions {
    PascalOptions {
        compiler: PascalCompiler::PascalAbcNet,
        dotnet_framework: dotnet,
        installed_dirs: Vec::new(),
    }
}

#[test]
fn the_setting_value_picks_the_compiler_and_anything_else_is_free_pascal() {
    assert_eq!(
        PascalCompiler::parse("pascalabc"),
        PascalCompiler::PascalAbcNet
    );
    assert_eq!(
        PascalCompiler::parse(" pascalabc "),
        PascalCompiler::PascalAbcNet
    );
    for other in ["fpc", "", "PascalABC", "delphi"] {
        assert_eq!(
            PascalCompiler::parse(other),
            PascalCompiler::FreePascal,
            "{other}"
        );
    }
    assert_eq!(PascalCompiler::default(), PascalCompiler::FreePascal);
    assert_eq!(PascalCompiler::PascalAbcNet.runtime_id(), "pascalabc");
    assert_eq!(PascalCompiler::FreePascal.runtime_id(), "pascal");
}

#[cfg(windows)]
#[test]
fn pascalabc_builds_into_the_build_folder_with_its_documented_arguments() {
    let f = fixture();
    let bin = f.runtime("pascalabc", "4.0.0.3883", "pabcnetcclear.exe");
    let file = f.source(
        "src dir/привет мир.pas",
        "program Hi;\nbegin\n  WriteLn('hi');\nend.\n",
    );

    let plan = f
        .plan(&file, vec![bin.clone()], abc(Some(NET_481)))
        .expect("plan");
    let build = plan.build.as_ref().expect("build");

    let output = build.dir.join("привет мир.exe");
    assert_eq!(
        build.argv[0],
        bin.join("pabcnetcclear.exe").to_string_lossy()
    );
    assert_eq!(build.argv[1], format!("/Output:{}", output.display()));
    assert_eq!(build.argv[2], file.to_string_lossy());
    assert_eq!(build.argv.len(), 3);
    assert_eq!(build.display, "pabcnetcclear \"привет мир.pas\"");
    assert_eq!(build.cwd, f.workspace.join("src dir"));
    assert!(
        build.dir.starts_with(f.root.join("cache")),
        "never next to the source"
    );
    assert_eq!(plan.argv, [output.to_string_lossy()]);
    assert_eq!(plan.resolved, output);
    assert_eq!(plan.display, "\"привет мир.exe\"");
    assert_eq!(plan.runtime_label, "OpenMind PascalABC.NET 4.0.0.3883");
    assert_eq!(plan.cwd, f.workspace, "the program runs in the workspace");
}

#[cfg(windows)]
#[test]
fn free_pascal_stays_the_default_and_never_picks_pascalabc() {
    let f = fixture();
    let fpc = f.runtime("pascal", "3.2.3", "fpc64.cmd");
    let abc_bin = f.runtime("pascalabc", "4.0.0.3883", "pabcnetcclear.exe");
    let file = f.source("hello.pas", "program hello;\nbegin\nend.\n");

    let default = f
        .plan(
            &file,
            vec![abc_bin.clone(), fpc.clone()],
            PascalOptions::default(),
        )
        .expect("plan");
    assert!(default.build.expect("build").argv[0].ends_with("fpc64.cmd"));

    let chosen = f
        .plan(&file, vec![fpc.clone(), abc_bin], abc(Some(NET_481)))
        .expect("plan");
    assert!(chosen.build.expect("build").argv[0].ends_with("pabcnetcclear.exe"));

    // PascalABC.NET chosen but only Free Pascal installed: refused, not switched.
    let refused = f
        .plan(&file, vec![fpc], abc(Some(NET_481)))
        .expect_err("refused");
    assert_eq!(refused.to_string(), missing_pascalabc());
}

#[cfg(windows)]
#[test]
fn a_missing_or_old_dotnet_framework_is_named_with_what_to_do() {
    let f = fixture();
    let bin = f.runtime("pascalabc", "4.0.0.3883", "pabcnetcclear.exe");
    let file = f.source("hello.pas", "begin end.\n");

    let missing = f
        .plan(&file, vec![bin.clone()], abc(None))
        .expect_err("missing");
    assert!(
        matches!(missing, RunError::NotRunnable(_)),
        "not an install offer"
    );
    assert!(missing
        .to_string()
        .contains("needs .NET Framework 4.7.2 or later, which isn't installed"));

    let old = f
        .plan(&file, vec![bin.clone()], abc(Some(461_308)))
        .expect_err("old");
    assert!(old
        .to_string()
        .contains("this computer has .NET Framework 4.7.1"));

    assert!(
        f.plan(&file, vec![bin], abc(Some(461_808))).is_ok(),
        "4.7.2 is enough"
    );
}

#[cfg(windows)]
#[test]
fn a_pascalabc_setup_install_is_found_after_openmind_and_labelled_system() {
    let f = fixture();
    let setup = f.root.join("Program Files (x86)").join("PascalABC.NET");
    fs::create_dir_all(&setup).expect("setup");
    fs::write(setup.join("pabcnetcclear.exe"), "").expect("stand-in");
    let file = f.source("hello.pas", "begin end.\n");
    let options = PascalOptions {
        installed_dirs: vec![setup.clone()],
        ..abc(Some(NET_481))
    };

    let system = f.plan(&file, Vec::new(), options.clone()).expect("plan");
    assert_eq!(system.source, RuntimeSource::System);
    assert_eq!(
        system.runtime_label,
        format!("System PascalABC.NET ({})", setup.display())
    );

    let bin = f.runtime("pascalabc", "4.0.0.3883", "pabcnetcclear.exe");
    let portable = f.plan(&file, vec![bin], options).expect("plan");
    assert_eq!(portable.source, RuntimeSource::Portable);
}

#[cfg(windows)]
#[test]
fn units_and_libraries_are_refused_before_any_compiler_is_looked_for() {
    let f = fixture();
    let unit = f.source(
        "Pricing.pas",
        "{ prices }\nunit Pricing;\ninterface\nimplementation\nend.\n",
    );
    let err = f
        .plan(&unit, Vec::new(), abc(Some(NET_481)))
        .expect_err("unit");
    assert_eq!(
        err.to_string(),
        "This is a Pascal unit, not a program: run the program that uses it."
    );
}

#[cfg(not(windows))]
#[test]
fn pascalabc_is_refused_off_windows_with_the_reason() {
    let f = fixture();
    let dir = f.root.join("bin");
    fs::create_dir_all(&dir).expect("dir");
    fs::write(dir.join("pabcnetcclear"), "").expect("stand-in");
    let file = f.source("hello.pas", "begin end.\n");
    let err = f.plan(&file, vec![dir], abc(None)).expect_err("refused");
    assert!(err.to_string().contains("runs on Windows only"));
}
