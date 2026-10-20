//! Run Code with the real PascalABC.NET compiler: `OPENMIND_TEST_PASCALABC` names the folder holding `pabcnetcclear.exe`
//! (the official `PABCNETC.zip` unpacked). Without it each test says so and passes without running anything — such a
//! pass is not a compiler check.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use super::*;

fn compiler_dir() -> Option<PathBuf> {
    let dir = std::env::var_os("OPENMIND_TEST_PASCALABC").map(PathBuf::from);
    if dir.is_none() {
        eprintln!("skipped: OPENMIND_TEST_PASCALABC is not set");
    }
    dir
}

struct Work {
    _temp: tempfile::TempDir,
    workspace: PathBuf,
    builds: PathBuf,
}

fn work() -> Work {
    let temp = tempfile::tempdir().expect("tempdir");
    let workspace = temp.path().join("Мой проект ü");
    fs::create_dir_all(&workspace).expect("workspace");
    let builds = temp.path().join("app dir").join("cache").join(BUILD_ROOT);
    Work {
        workspace,
        builds,
        _temp: temp,
    }
}

impl Work {
    fn write(&self, relative: &str, body: &str) -> PathBuf {
        let file = self.workspace.join(relative);
        fs::create_dir_all(file.parent().expect("parent")).expect("dir");
        fs::write(&file, body).expect("source");
        file
    }

    fn plan(&self, file: &Path, bin: &Path, build: &str, arguments: Option<&str>) -> RunPlan {
        let request = RunRequest {
            file: file.to_path_buf(),
            workspace: Some(self.workspace.clone()),
            template: None,
            arguments: arguments.map(str::to_string),
            assembly: Default::default(),
            pascal: PascalOptions {
                compiler: PascalCompiler::PascalAbcNet,
                dotnet_framework: openmind_core::dotnet_framework::installed_release(),
                installed_dirs: Vec::new(),
            },
        };
        let env = RunEnvironment {
            path_prepend: vec![bin.to_path_buf()],
            vars: Vec::new(),
        };
        plan(
            &request,
            &env,
            self.workspace.parent().expect("parent"),
            Some(OsString::new()),
            &self.builds.join(build),
        )
        .expect("plan")
    }

    /// The workspace's files, so a test can see the build wrote nothing there.
    fn files(&self) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(&self.workspace)
            .expect("read")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        names.sort();
        names
    }
}

/// Runs to the end: (stdout lines of the program, build lines, exit code, build failed).
fn run(plan: &RunPlan) -> (Vec<String>, Vec<String>, Option<i32>, bool) {
    let collector = Collector::new();
    RunRegistry::new()
        .start(plan, collector.sink())
        .expect("start");
    let exit = collector.wait_for_exit_within(Duration::from_secs(120));
    let RunEventKind::Exited {
        code, build_failed, ..
    } = exit.event
    else {
        panic!("expected an exit");
    };
    let lines = |want: Phase, stdout_only: bool| {
        collector
            .snapshot()
            .iter()
            .filter_map(|event| match &event.event {
                RunEventKind::Output {
                    stream,
                    line,
                    phase,
                } if *phase == want && (!stdout_only || *stream == Stream::Stdout) => {
                    Some(line.trim_end().to_string())
                }
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    (
        lines(Phase::Run, true),
        lines(Phase::Build, false),
        code,
        build_failed,
    )
}

const HELLO: &str = "program Hello;\nbegin\n  WriteLn('Hello, мир! ব');\nend.\n";

const ARRAYS_AND_CLASSES: &str = "\
type
  TPoint = class
    X, Y: integer;
    constructor Create(x, y: integer);
    begin
      Self.X := x; Self.Y := y;
    end;
    function Len2: integer := X * X + Y * Y;
  end;
var a: array[1..5] of integer;
begin
  for var i := 1 to 5 do a[i] := 6 - i;
  var s := 0;
  foreach var v in a do s += v;
  WriteLn('sum=', s);
  var p := new TPoint(3, 4);
  WriteLn('len2=', p.Len2);
end.
";

/// PascalABC.NET's own language: dynamic arrays with methods, lambdas and sequences.
const ABC_FEATURES: &str = "\
begin
  var a := Arr(5, 3, 9, 1);
  a.Sort;
  a.Println;
  Range(1, 5).Select(i -> i * i).Where(x -> x mod 2 = 1).Println;
  var (q, r) := (17 div 5, 17 mod 5);
  Println(q, r);
end.
";

const INPUT: &str = "\
var name: string; age: integer;
begin
  Write('Name: '); ReadLn(name);
  Write('Age: '); ReadLn(age);
  if age >= 18 then WriteLn(name, ' is an adult') else WriteLn(name, ' is a minor');
end.
";

#[test]
fn hello_arrays_classes_and_pascalabc_features_compile_and_run() {
    let Some(bin) = compiler_dir() else {
        return;
    };
    let w = work();
    let cases = [
        ("hello.pas", HELLO, vec!["Hello, мир! ব"]),
        (
            "arrays and classes.pas",
            ARRAYS_AND_CLASSES,
            vec!["sum=15", "len2=25"],
        ),
        ("abc.pas", ABC_FEATURES, vec!["1 3 5 9", "1 9 25", "3 2"]),
    ];
    for (index, (name, body, expected)) in cases.into_iter().enumerate() {
        let file = w.write(name, body);
        let plan = w.plan(&file, &bin, &format!("run {index}"), None);
        let (stdout, build, code, failed) = run(&plan);
        assert!(!failed, "{name}: {build:?}");
        assert_eq!(stdout, expected, "{name}: {build:?}");
        assert_eq!(code, Some(0), "{name}");
        let build_dir = plan.build.as_ref().expect("build").dir.clone();
        assert!(
            !build_dir.exists(),
            "{name}: the build folder is removed when the run ends"
        );
    }
    assert_eq!(
        w.files(),
        ["abc.pas", "arrays and classes.pas", "hello.pas"],
        "nothing written next to the sources"
    );
}

#[test]
fn a_compile_error_names_its_line_and_column_and_nothing_runs() {
    let Some(bin) = compiler_dir() else {
        return;
    };
    let w = work();
    let file = w.write(
        "bad.pas",
        "begin\n  var x: integer := 'text';\n  WriteLn(x);\nend.\n",
    );
    let (stdout, build, _, failed) = run(&w.plan(&file, &bin, "bad", None));
    assert!(failed, "{build:?}");
    assert!(stdout.is_empty());
    assert!(
        build
            .iter()
            .any(|line| line == "[2,21] bad.pas: Incompatible types: 'string' and 'integer'"),
        "{build:?}"
    );
}

#[test]
fn the_program_gets_its_arguments_and_reads_piped_input() {
    let Some(bin) = compiler_dir() else {
        return;
    };
    let w = work();
    let args = w.write(
        "args.pas",
        "begin\n  WriteLn('count=', ParamCount);\n  for var i := 1 to ParamCount do WriteLn(ParamStr(i));\nend.\n",
    );
    let (stdout, build, code, _) = run(&w.plan(&args, &bin, "args", Some(r#"7 "two words""#)));
    assert_eq!(stdout, ["count=2", "7", "two words"], "{build:?}");
    assert_eq!(code, Some(0));

    // Run in Terminal types the input; here the built program reads it from a pipe the same way.
    let input = w.write("input.pas", INPUT);
    let plan = w.plan(&input, &bin, "input", None);
    let build = plan.build.as_ref().expect("build");
    fs::create_dir_all(&build.dir).expect("dir");
    let compiled = Command::new(&build.argv[0])
        .args(&build.argv[1..])
        .stdin(Stdio::null())
        .output()
        .expect("compile");
    assert!(
        compiled.status.success(),
        "{}",
        String::from_utf8_lossy(&compiled.stdout)
    );
    // ASCII only: the program decodes its input with the console's code page (850/437 on a Western Windows) while its
    // output is UTF-8, so non-Latin typed text needs `chcp 65001` first (docs/pascal.md).
    for (typed, expected) in [
        ("Shagor\n23\n", "Shagor is an adult"),
        ("Lena\n12\n", "Lena is a minor"),
    ] {
        let mut child = Command::new(&plan.resolved)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("program");
        child
            .stdin
            .take()
            .expect("stdin")
            .write_all(typed.as_bytes())
            .expect("type");
        let out = child.wait_with_output().expect("output");
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim_end(),
            format!("Name: Age: {expected}")
        );
    }
}

#[test]
fn reading_past_the_end_of_input_ends_the_program_instead_of_hanging() {
    let Some(bin) = compiler_dir() else {
        return;
    };
    let w = work();
    let file = w.write("input.pas", INPUT);
    // Run Code's process has no keyboard: its input is closed.
    let (_, build, code, failed) = run(&w.plan(&file, &bin, "eof", None));
    assert!(!failed, "{build:?}");
    assert_ne!(code, Some(0), "a read past the end of input fails the run");
}

#[test]
fn stop_kills_a_running_pascalabc_program() {
    let Some(bin) = compiler_dir() else {
        return;
    };
    let w = work();
    let file = w.write(
        "loop.pas",
        "begin\n  WriteLn('started');\n  while true do Sleep(50);\nend.\n",
    );
    let plan = w.plan(&file, &bin, "loop", None);
    let registry = RunRegistry::new();
    let collector = Collector::new();
    let info = registry.start(&plan, collector.sink()).expect("start");
    let started = std::time::Instant::now();
    while !collector.snapshot().iter().any(|event| {
        matches!(&event.event, RunEventKind::Output { line, phase: Phase::Run, .. } if line.trim_end() == "started")
    }) {
        assert!(started.elapsed() < Duration::from_secs(120), "never started");
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(registry.stop(&info.run_id));
    let exit = collector.wait_for_exit_within(Duration::from_secs(20));
    assert!(matches!(exit.event, RunEventKind::Exited { .. }));
    assert!(
        !plan.build.expect("build").dir.exists(),
        "cleaned after Stop too"
    );
}
