//! Run Code for Fortran and Pascal. The argument lists are checked with stand-in compiler files (always run); the
//! builds themselves use the real compilers whose `bin` folders are named by `OPENMIND_TEST_FORTRAN` (w64devkit's
//! `bin`, holding gfortran) and `OPENMIND_TEST_PASCAL` (the folder holding the `fpc64` shim); a test whose compiler
//! isn't there says so and passes without running.

use std::fs;
use std::path::{Path, PathBuf};

use super::*;

struct Project {
    _temp: tempfile::TempDir,
    workspace: PathBuf,
    builds: PathBuf,
}

fn project() -> Project {
    let temp = tempfile::tempdir().expect("tempdir");
    let workspace = temp.path().join("My Workspace");
    fs::create_dir_all(&workspace).expect("workspace");
    let builds = temp.path().join("app dir").join("cache").join(BUILD_ROOT);
    Project {
        workspace,
        builds,
        _temp: temp,
    }
}

impl Project {
    fn write(&self, relative: &str, body: &str) -> PathBuf {
        let file = self.workspace.join(relative);
        fs::create_dir_all(file.parent().expect("parent")).expect("dir");
        fs::write(&file, body).expect("source");
        file
    }

    fn plan_with(&self, file: &Path, bin: PathBuf, build: &str) -> RunPlan {
        let request = RunRequest {
            file: file.to_path_buf(),
            workspace: Some(self.workspace.clone()),
            template: None,
        };
        let env = RunEnvironment {
            path_prepend: vec![bin],
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

    /// A plan on the real compiler, or `None` (with a note) when the variable isn't set.
    fn real_plan(&self, file: &Path, variable: &str, build: &str) -> Option<RunPlan> {
        let Some(bin) = std::env::var_os(variable).map(PathBuf::from) else {
            eprintln!("skipped: {variable} is not set");
            return None;
        };
        Some(self.plan_with(file, bin, build))
    }

    /// Every file in the workspace, relative, so a test can see the build wrote nothing there.
    fn files(&self) -> Vec<String> {
        let mut found = Vec::new();
        let mut stack = vec![self.workspace.clone()];
        while let Some(dir) = stack.pop() {
            for entry in fs::read_dir(&dir).expect("read").map(|e| e.expect("entry")) {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else {
                    let relative = path.strip_prefix(&self.workspace).expect("inside");
                    found.push(relative.to_string_lossy().replace('\\', "/"));
                }
            }
        }
        found.sort();
        found
    }
}

/// A folder holding empty stand-ins for `names`, so a plan can be made without a compiler.
fn stand_ins(project: &Project, names: &[&str]) -> PathBuf {
    let bin = project.workspace.parent().expect("parent").join("fake bin");
    fs::create_dir_all(&bin).expect("bin");
    for name in names {
        fs::write(bin.join(name), "").expect("stand-in");
    }
    bin
}

/// Runs to the end: (program stdout, build lines, exit code, build failed).
fn run(plan: &RunPlan) -> (Vec<String>, Vec<String>, Option<i32>, bool) {
    let collector = Collector::new();
    RunRegistry::new()
        .start(plan, collector.sink())
        .expect("start");
    let exit = collector.wait_for_exit();
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

const MAIN_F90: &str = "program main\n  use mathx\n  implicit none\n  call greet()\n  print '(a,i0)', 'twice=', twice(21)\nend program main\n";
const MATHX_F90: &str = "module mathx\n  implicit none\ncontains\n  integer function twice(n)\n    integer, intent(in) :: n\n    twice = 2 * n\n  end function twice\nend module mathx\n";
const GREET_F: &str = "      SUBROUTINE GREET()\nC     fixed-form external procedure\n      PRINT '(A)', 'hello from fixed form'\n      END\n";

#[test]
fn fortran_plans_plain_diagnostics_module_folder_and_the_library_files_next_to_it() {
    let p = project();
    let bin = stand_ins(&p, &["gfortran.exe"]);
    let main = p.write("app src/main.f90", MAIN_F90);
    p.write("app src/mathx.f90", MATHX_F90);
    p.write("app src/greet.f", GREET_F);
    p.write("app src/other.f90", "program other\nend program other\n");

    let plan = p.plan_with(&main, bin, "run 1");
    let build = plan.build.as_ref().expect("build");

    assert_eq!(build.argv[1..3], ["-fdiagnostics-plain-output", "-J"]);
    assert_eq!(PathBuf::from(&build.argv[3]), build.dir);
    let sources: Vec<&str> = build.argv[4..build.argv.len() - 2]
        .iter()
        .map(|arg| arg.rsplit(['/', '\\']).next().unwrap_or_default())
        .collect();
    assert_eq!(sources, ["greet.f", "mathx.f90", "main.f90"]);
    assert_eq!(
        build.display,
        "gfortran greet.f mathx.f90 main.f90 -o main.exe"
    );
    assert_eq!(build.cwd, p.workspace.join("app src"));
    assert_eq!(
        plan.cwd, p.workspace,
        "the program still runs in the workspace"
    );
}

#[test]
fn pascal_plans_attached_options_warnings_and_the_source_folder_as_build_folder() {
    let p = project();
    let bin = stand_ins(&p, &["fpc64.cmd"]);
    let main = p.write("pas app/hello world.pas", "program hello;\nbegin\nend.\n");

    let plan = p.plan_with(&main, bin, "run 2");
    let build = plan.build.as_ref().expect("build");

    assert_eq!(build.argv[1], "-vwn");
    // Free Pascal refuses `-FE <dir>` / `-o <file>` as separate arguments ("Illegal parameter: -o").
    assert_eq!(build.argv[2], format!("-FE{}", build.dir.display()));
    assert_eq!(
        build.argv[3],
        format!("-o{}", build.dir.join("hello world.exe").display())
    );
    assert_eq!(
        build.display,
        "fpc64 \"hello world.pas\" \"-ohello world.exe\""
    );
    assert_eq!(build.cwd, p.workspace.join("pas app"));
}

#[test]
fn pascal_falls_back_to_fpc_when_there_is_no_fpc64_and_prefers_the_portable_one() {
    let p = project();
    let main = p.write("hello.pas", "program hello;\nbegin\nend.\n");
    let only_fpc = stand_ins(&p, &["fpc.exe"]);
    let fallback = p.plan_with(&main, only_fpc, "run 8");
    assert!(fallback
        .build
        .expect("build")
        .display
        .starts_with("fpc hello.pas"));

    // A system `fpc` on PATH loses to OpenMind's portable `fpc64` shim.
    let system = p.workspace.parent().expect("parent").join("system bin");
    fs::create_dir_all(&system).expect("system");
    fs::write(system.join("fpc.exe"), "").expect("fpc");
    let portable = p.workspace.parent().expect("parent").join("portable shims");
    fs::create_dir_all(&portable).expect("portable");
    fs::write(portable.join("fpc64.cmd"), "").expect("fpc64");
    let request = RunRequest {
        file: main.clone(),
        workspace: Some(p.workspace.clone()),
        template: None,
    };
    let env = RunEnvironment {
        path_prepend: vec![portable],
        vars: Vec::new(),
    };
    let plan = plan(
        &request,
        &env,
        p.workspace.parent().expect("parent"),
        Some(system.into_os_string()),
        &p.builds.join("run 9"),
    )
    .expect("plan");
    assert_eq!(plan.source, RuntimeSource::Portable);
    assert!(plan
        .build
        .expect("build")
        .display
        .starts_with("fpc64 hello.pas"));
}

#[test]
fn fortran_builds_modules_and_fixed_form_procedures_from_other_files_without_touching_the_project()
{
    let p = project();
    let main = p.write("app src/main.f90", MAIN_F90);
    p.write("app src/mathx.f90", MATHX_F90);
    p.write("app src/greet.f", GREET_F);
    let before = p.files();
    let Some(plan) = p.real_plan(&main, "OPENMIND_TEST_FORTRAN", "run 3") else {
        return;
    };

    let (stdout, build, code, failed) = run(&plan);

    assert!(!failed, "{build:?}");
    assert_eq!(stdout, ["hello from fixed form", "twice=42"]);
    assert_eq!(code, Some(0));
    assert_eq!(p.files(), before, "no .mod or .o file in the project");
    assert!(!plan.build.expect("build").dir.exists());
}

#[test]
fn a_fortran_error_is_one_line_with_its_position_and_nothing_runs() {
    let p = project();
    let file = p.write(
        "bad.f90",
        "program bad\n  implicit none\n  print *, y\nend program bad\n",
    );
    let Some(plan) = p.real_plan(&file, "OPENMIND_TEST_FORTRAN", "run 4") else {
        return;
    };

    let (stdout, build, _, failed) = run(&plan);

    assert!(failed);
    assert!(stdout.is_empty());
    assert!(
        build
            .iter()
            .any(|line| line
                .ends_with("bad.f90:3:12: Error: Symbol 'y' at (1) has no IMPLICIT type")),
        "{build:?}"
    );
}

#[test]
fn pascal_uses_the_unit_next_to_the_program_and_reports_warnings() {
    let p = project();
    // A same-named file in the workspace root must not be taken for the unit.
    p.write("greet.pas", "program greet;\nbegin\nend.\n");
    p.write(
        "pas app/greet.pas",
        "unit greet;\ninterface\nfunction Hello(const n: string): string;\nimplementation\nfunction Hello(const n: string): string;\nbegin\n  Hello := 'Hi ' + n;\nend;\nend.\n",
    );
    let main = p.write(
        "pas app/hello world.pas",
        "program app;\nuses greet;\nvar i, j: integer;\nbegin\n  j := i + 1;\n  writeln(Hello('unit'), ' ', j - j);\nend.\n",
    );
    let before = p.files();
    let Some(plan) = p.real_plan(&main, "OPENMIND_TEST_PASCAL", "run 5") else {
        return;
    };

    let (stdout, build, code, failed) = run(&plan);

    assert!(!failed, "{build:?}");
    assert_eq!(stdout, ["Hi unit 0"]);
    assert_eq!(code, Some(0));
    assert!(
        build
            .iter()
            .any(|line| line.starts_with("hello world.pas(5,8) Warning: Variable \"i\"")),
        "{build:?}"
    );
    assert_eq!(p.files(), before, "no .ppu, .o or .exe in the project");
}

#[test]
fn a_pascal_error_names_line_and_column_and_nothing_runs() {
    let p = project();
    let file = p.write("bad.pas", "program bad;\nbegin\n  writeln(zz);\nend.\n");
    let Some(plan) = p.real_plan(&file, "OPENMIND_TEST_PASCAL", "run 6") else {
        return;
    };

    let (stdout, build, _, failed) = run(&plan);

    assert!(failed);
    assert!(stdout.is_empty());
    assert!(
        build
            .iter()
            .any(|line| line == "bad.pas(3,11) Error: Identifier not found \"zz\""),
        "{build:?}"
    );
}
