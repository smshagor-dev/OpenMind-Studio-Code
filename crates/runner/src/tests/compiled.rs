//! Run Code for compiled languages against real compilers. C and C++ use the LLVM-MinGW `bin` folder named by
//! `OPENMIND_TEST_LLVM_MINGW` (else a clang/gcc on PATH); Java and Rust use the machine's `javac`/`rustc`. A test
//! whose compiler is missing says so and passes without running.

use std::fs;
use std::path::{Path, PathBuf};

use super::*;

struct Setup {
    _temp: tempfile::TempDir,
    workspace: PathBuf,
    builds: PathBuf,
    env: RunEnvironment,
    system: Option<OsString>,
}

fn setup() -> Setup {
    let temp = tempfile::tempdir().expect("tempdir");
    let workspace = temp.path().join("My Programs");
    fs::create_dir_all(&workspace).expect("workspace");
    let builds = temp.path().join("app dir").join("cache").join(BUILD_ROOT);
    let env = RunEnvironment {
        path_prepend: std::env::var_os("OPENMIND_TEST_LLVM_MINGW")
            .map(PathBuf::from)
            .into_iter()
            .collect(),
        vars: Vec::new(),
    };
    Setup {
        workspace,
        builds,
        env,
        system: std::env::var_os("PATH"),
        _temp: temp,
    }
}

impl Setup {
    fn source(&self, name: &str, body: &str) -> PathBuf {
        let dir = self.workspace.join("src dir");
        fs::create_dir_all(&dir).expect("dir");
        let file = dir.join(name);
        fs::write(&file, body).expect("source");
        file
    }

    /// `None` (and a note) when the machine has no compiler for this file.
    fn plan(&self, file: &Path, build: &str) -> Option<RunPlan> {
        let request = RunRequest {
            file: file.to_path_buf(),
            workspace: Some(self.workspace.clone()),
            template: None,
            arguments: None,
            assembly: Default::default(),
        };
        let root = self.workspace.parent().expect("parent");
        match plan(
            &request,
            &self.env,
            root,
            self.system.clone(),
            &self.builds.join(build),
        ) {
            Ok(plan) => Some(plan),
            Err(RunError::CompilerMissing(reason)) => {
                eprintln!("skipped: {reason}");
                None
            }
            Err(err) => panic!("plan failed: {err}"),
        }
    }
}

/// Runs to the end; returns the program's stdout, the build's lines and the exit event's fields.
fn run(plan: &RunPlan) -> (Vec<String>, Vec<String>, Option<i32>, bool) {
    let registry = RunRegistry::new();
    let collector = Collector::new();
    registry.start(plan, collector.sink()).expect("start");
    // Includes compiler startup, compilation, linking and program execution.
    // Direct process tests retain their 20-second deadline.
    let exit = collector.wait_for_exit_within(Duration::from_secs(120));
    let RunEventKind::Exited {
        code, build_failed, ..
    } = exit.event
    else {
        panic!("expected an exit");
    };
    let events = collector.snapshot();
    let lines = |phase: Phase, stream: Option<Stream>| {
        events
            .iter()
            .filter_map(|event| match &event.event {
                RunEventKind::Output {
                    stream: s,
                    line,
                    phase: p,
                } if *p == phase && stream.is_none_or(|wanted| wanted == *s) => Some(line.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    (
        lines(Phase::Run, Some(Stream::Stdout)),
        lines(Phase::Build, None),
        code,
        build_failed,
    )
}

const C_PROGRAM: &str = r#"#include <stdio.h>
int main(void) {
    char name[64];
    printf("start\n");
    /* Run Code's Output has no keyboard: stdin is at its end at once, never faked. */
    if (scanf("%63s", name) != 1) { printf("no input\n"); return 4; }
    printf("got %s\n", name);
    return 0;
}
"#;

#[test]
fn c_compiles_into_its_build_folder_runs_without_fake_input_and_cleans_up() {
    let s = setup();
    let file = s.source("hello world.c", C_PROGRAM);
    let Some(plan) = s.plan(&file, "run 1") else {
        return;
    };
    let build = plan.build.clone().expect("a build step");
    assert!(build.dir.starts_with(&s.builds));
    assert!(plan.argv[0].ends_with("hello world.exe"), "{:?}", plan.argv);
    assert_eq!(plan.display, "\"hello world.exe\"");

    let (stdout, _, code, build_failed) = run(&plan);

    assert_eq!(stdout, ["start", "no input"]);
    assert_eq!((code, build_failed), (Some(4), false));
    assert!(
        !build.dir.exists(),
        "the build folder is removed after the run"
    );
    assert!(s.builds.exists(), "only the run's own folder is removed");
}

#[test]
fn a_compile_error_is_reported_as_the_build_and_nothing_runs() {
    let s = setup();
    let file = s.source("broken.c", "int main(void) { return missing_name; }\n");
    let Some(plan) = s.plan(&file, "run 2") else {
        return;
    };

    let (stdout, build_lines, code, build_failed) = run(&plan);

    assert!(build_failed);
    assert_ne!(code, Some(0));
    assert!(stdout.is_empty(), "the program never ran");
    assert!(
        build_lines.iter().any(|line| line.contains("missing_name")),
        "{build_lines:?}"
    );
    assert!(!plan.build.expect("build").dir.exists());
}

#[test]
fn cpp_compiles_and_runs_with_spaces_in_every_path() {
    let s = setup();
    let file = s.source(
        "my app.cpp",
        "#include <iostream>\nint main() { std::cout << \"C++ ok\" << std::endl; return 0; }\n",
    );
    let Some(plan) = s.plan(&file, "run 3") else {
        return;
    };

    let (stdout, _, code, _) = run(&plan);

    assert_eq!(stdout, ["C++ ok"]);
    assert_eq!(code, Some(0));
}

#[test]
fn java_compiles_to_classes_and_runs_the_packaged_main_class() {
    let s = setup();
    let file = s.source(
        "Greeter.java",
        "// demo\npackage demo.app;\n\npublic class Greeter {\n  public static void main(String[] args) {\n    System.out.println(\"Java ok\");\n  }\n}\n",
    );
    let Some(plan) = s.plan(&file, "run 4") else {
        return;
    };
    assert_eq!(
        plan.argv.last().map(String::as_str),
        Some("demo.app.Greeter")
    );
    assert_eq!(plan.display, "java demo.app.Greeter");

    let (stdout, _, code, _) = run(&plan);

    assert_eq!(stdout, ["Java ok"]);
    assert_eq!(code, Some(0));
    assert!(!plan.build.expect("build").dir.exists());
}

#[test]
fn rust_compiles_a_standalone_file_and_runs_it() {
    let s = setup();
    let file = s.source(
        "hello rust.rs",
        "fn main() { let mut line = String::new(); let read = std::io::stdin().read_line(&mut line).unwrap_or(0); println!(\"rust ok, read {read} bytes\"); }\n",
    );
    let Some(plan) = s.plan(&file, "run 5") else {
        return;
    };

    let (stdout, build_lines, code, build_failed) = run(&plan);

    assert!(!build_failed, "{build_lines:?}");
    assert_eq!(stdout, ["rust ok, read 0 bytes"]);
    assert_eq!(code, Some(0));
}

#[test]
fn stopping_a_built_program_kills_it_and_removes_the_build_folder() {
    let s = setup();
    let file = s.source(
        "forever.c",
        "#include <stdio.h>\n#include <windows.h>\nint main(void) { printf(\"running\\n\"); fflush(stdout); for (;;) Sleep(100); }\n",
    );
    let Some(plan) = s.plan(&file, "run 6") else {
        return;
    };
    let registry = RunRegistry::new();
    let collector = Collector::new();
    let info = registry.start(&plan, collector.sink()).expect("start");
    let deadline = Instant::now() + Duration::from_secs(20);
    while !collector
        .output(Stream::Stdout)
        .contains(&"running".to_string())
    {
        assert!(Instant::now() < deadline, "the program never started");
        std::thread::sleep(Duration::from_millis(50));
    }

    assert!(registry.stop(&info.run_id));
    let exit = collector.wait_for_exit();

    assert!(matches!(
        exit.event,
        RunEventKind::Exited { stopped: true, .. }
    ));
    let program = plan.resolved.clone();
    let deadline = Instant::now() + Duration::from_secs(5);
    while program.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!plan.build.expect("build").dir.exists(), "cleaned up");
}

#[test]
fn a_missing_compiler_is_a_clear_reason_and_a_custom_command_is_refused() {
    let s = setup();
    let file = s.source("a.c", "int main(void){return 0;}");
    let request = |template: Option<&str>| RunRequest {
        file: file.clone(),
        workspace: None,
        template: template.map(Into::into),
        arguments: None,
        assembly: Default::default(),
    };
    let empty = RunEnvironment::default();
    let error = plan(
        &request(None),
        &empty,
        &s.workspace,
        Some(OsString::new()),
        &s.builds,
    )
    .expect_err("no compiler");
    assert!(matches!(&error, RunError::CompilerMissing(reason) if reason.contains("LLVM-MinGW")));
    let custom = plan(
        &request(Some("gcc \"${file}\"")),
        &empty,
        &s.workspace,
        Some(OsString::new()),
        &s.builds,
    )
    .expect_err("refused");
    assert!(matches!(custom, RunError::BadCommand(_)));
}

#[test]
fn a_build_folder_outside_run_builds_is_never_cleared() {
    let s = setup();
    let file = s.source("a.c", "int main(void){return 0;}");
    let Some(mut plan) = s.plan(&file, "run 7") else {
        return;
    };
    let precious = s.workspace.join("precious");
    fs::create_dir_all(&precious).expect("dir");
    fs::write(precious.join("keep.txt"), "x").expect("file");
    if let Some(build) = plan.build.as_mut() {
        build.dir = precious.clone();
    }

    let error = RunRegistry::new()
        .start(&plan, Collector::new().sink())
        .expect_err("refused");

    assert!(matches!(error, RunError::StartFailed { .. }));
    assert!(precious.join("keep.txt").exists());
}
