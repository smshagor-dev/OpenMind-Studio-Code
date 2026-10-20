//! Run Code for Assembly with the real tools: NASM + gcc from the `bin` folder named by `OPENMIND_TEST_ASSEMBLY`
//! (w64devkit's `bin`, holding nasm.exe and gcc.exe). Without it each test says so and passes without running.

use std::fs;
use std::path::PathBuf;

use super::*;

const HELLO: &str = "        default rel\n        global  main\n        extern  printf\n        section .data\nfmt:    db \"args=%d last=%s\", 10, 0\n        section .text\nmain:\n        sub     rsp, 40\n        mov     r8, [rdx + rcx*8 - 8]\n        lea     rdx, [rcx - 1]\n        lea     rcx, [fmt]\n        call    printf\n        add     rsp, 40\n        mov     eax, 3\n        ret\n";
const RAW: &str = "        default rel\n        global  start\n        extern  ExitProcess\n        section .text\nstart:\n        sub     rsp, 40\n        mov     ecx, 7\n        call    ExitProcess\n";
const GAS: &str = "\t.globl main\nmain:\n\tmovl $5, %eax\n\tret\n";

struct Fixture {
    _temp: tempfile::TempDir,
    project: PathBuf,
    builds: PathBuf,
    bin: PathBuf,
}

fn fixture() -> Option<Fixture> {
    let Some(bin) = std::env::var_os("OPENMIND_TEST_ASSEMBLY").map(PathBuf::from) else {
        eprintln!("skipped: OPENMIND_TEST_ASSEMBLY is not set");
        return None;
    };
    let temp = tempfile::tempdir().expect("tempdir");
    let project = temp.path().join("My Asm Project");
    fs::create_dir_all(&project).expect("project");
    let builds = temp.path().join("app dir").join("cache").join(BUILD_ROOT);
    Some(Fixture {
        _temp: temp,
        project,
        builds,
        bin,
    })
}

impl Fixture {
    fn plan(&self, name: &str, text: &str, arguments: Option<&str>) -> Result<RunPlan, RunError> {
        let file = self.project.join(name);
        fs::write(&file, text).expect("source");
        let request = RunRequest {
            file,
            workspace: Some(self.project.clone()),
            template: None,
            arguments: arguments.map(str::to_string),
            assembly: Default::default(),
            pascal: Default::default(),
        };
        let env = RunEnvironment {
            path_prepend: vec![self.bin.clone()],
            vars: Vec::new(),
        };
        plan(
            &request,
            &env,
            &self.project,
            Some(OsString::new()),
            &self.builds.join(name),
        )
    }
}

fn system32() -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
        .join("System32")
}

/// Runs to the end: (all output lines, exit code, build failed).
fn run(plan: &RunPlan) -> (Vec<String>, Option<i32>, bool) {
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
    let lines = collector
        .snapshot()
        .iter()
        .filter_map(|event| match &event.event {
            RunEventKind::Output { line, .. } => Some(line.trim_end().to_string()),
            _ => None,
        })
        .collect();
    (lines, code, build_failed)
}

#[test]
fn nasm_x64_assembles_links_and_runs_with_arguments_through_the_c_runtime() {
    let Some(fx) = fixture() else { return };
    let plan = fx
        .plan("hello world.asm", HELLO, Some(r#"one "two words""#))
        .expect("plan");
    let (lines, code, failed) = run(&plan);
    assert!(!failed, "{lines:?}");
    assert_eq!(code, Some(3), "{lines:?}");
    assert!(
        lines.iter().any(|l| l == "args=2 last=two words"),
        "{lines:?}"
    );
    // The link step is shown in the build output; nothing was written next to the source.
    assert!(lines.iter().any(|l| l.starts_with("> gcc")), "{lines:?}");
    let left: Vec<_> = fs::read_dir(&fx.project).expect("read").collect();
    assert_eq!(left.len(), 1, "only the source stays in the project");
}

#[test]
fn a_raw_start_entry_runs_without_the_c_runtime() {
    let Some(fx) = fixture() else { return };
    let plan = fx.plan("raw.asm", RAW, None).expect("plan");
    let (lines, code, failed) = run(&plan);
    assert!(!failed, "{lines:?}");
    assert_eq!(code, Some(7), "{lines:?}");
}

#[test]
fn a_nasm_error_fails_the_build_with_a_file_line_diagnostic_and_never_runs() {
    let Some(fx) = fixture() else { return };
    let plan = fx
        .plan(
            "broken.asm",
            "global main\nmain:\n        movv eax, 1\n        ret\n",
            None,
        )
        .expect("plan");
    let (lines, _, failed) = run(&plan);
    assert!(failed, "{lines:?}");
    assert!(
        lines.iter().any(|l| l.contains("broken.asm:3: error:")),
        "a diagnostic the Problems parser reads: {lines:?}"
    );
}

#[test]
fn the_run_in_terminal_line_builds_an_include_and_runs_in_powershell_and_cmd() {
    let Some(fx) = fixture() else { return };
    fs::write(fx.project.join("greet.inc"), "%define EXIT_CODE 9\n").expect("include");
    let source = "%include \"greet.inc\"\n        global  main\n        section .text\nmain:\n        mov     eax, EXIT_CODE\n        ret\n";
    // A plain name with spaces, and one with characters every shell treats specially.
    for (name, arguments) in [
        ("uses include.asm", "a b"),
        ("odd & name $x 'q' (1);.asm", r#"x&y "two | words" $HOME"#),
    ] {
        let plan = fx.plan(name, source, Some(arguments)).expect("plan");
        let build = plan.build.as_ref().expect("build");
        fs::create_dir_all(&build.dir).expect("build dir");
        let mut steps = vec![build.argv.clone()];
        steps.extend(build.link.as_ref().map(|link| link.argv.clone()));
        steps.push(plan.argv.clone());
        for (shell, style) in [
            ("powershell", ShellStyle::PowerShell),
            ("cmd", ShellStyle::Cmd),
        ] {
            let line = match shell_chain(&steps, style) {
                Ok(line) => line,
                // cmd.exe can't be given `&`, `$`, quotes or `;` safely: the line is refused, never typed.
                Err(refused) if shell == "cmd" && name.contains('&') => {
                    assert!(
                        refused.to_string().contains("cmd.exe would interpret"),
                        "{refused}"
                    );
                    continue;
                }
                Err(err) => panic!("{shell}: {err}"),
            };
            let output = shell_command(shell, &line)
                .current_dir(&fx.project)
                // Like an OpenMind terminal: the toolchain's `bin` is not on PATH (only its launchers would be), so
                // the line must work with absolute programs and gcc's `-B`.
                .env("PATH", system32())
                .output()
                .expect("shell");
            assert_eq!(
                output.status.code(),
                Some(9),
                "{shell}: {line}\n{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }
}

/// `line` run the way a terminal runs what is typed into it.
fn shell_command(shell: &str, line: &str) -> std::process::Command {
    let mut command = std::process::Command::new(shell);
    if shell == "powershell" {
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!("{line}; exit $LASTEXITCODE"),
        ]);
    } else {
        // cmd.exe reads its own command line: the line goes in raw, as a terminal would type it. `/C` strips one pair
        // of outer quotes from a line that starts with a quote (an interactive cmd doesn't), hence the pair.
        use std::os::windows::process::CommandExt;
        command.arg("/C").raw_arg(format!("\"{line}\""));
    }
    command
}

#[test]
fn a_name_with_shell_characters_builds_and_runs_with_its_arguments_untouched() {
    let Some(fx) = fixture() else { return };
    let plan = fx
        .plan(
            "odd & name $x 'q' (1);.asm",
            HELLO,
            Some(r#"x&y "two | words""#),
        )
        .expect("plan");
    let (lines, code, failed) = run(&plan);
    assert!(!failed, "{lines:?}");
    assert_eq!(code, Some(3), "{lines:?}");
    assert!(
        lines.iter().any(|l| l == "args=2 last=two | words"),
        "{lines:?}"
    );
}

#[test]
fn gas_sources_build_with_gcc() {
    let Some(fx) = fixture() else { return };
    let plan = fx.plan("gas.s", GAS, None).expect("plan");
    let (lines, code, failed) = run(&plan);
    assert!(!failed, "{lines:?}");
    assert_eq!(code, Some(5), "{lines:?}");
}

#[test]
fn a_link_error_fails_the_build_and_never_runs_an_older_program() {
    let Some(fx) = fixture() else { return };
    let good =
        "        global  main\n        section .text\nmain:\n        mov     eax, 9\n        ret\n";
    let unresolved = "        global  main\n        extern  not_defined_anywhere\n        section .text\nmain:\n        call    not_defined_anywhere\n        ret\n";
    // Run Code: the linker's error is a build failure and nothing runs.
    let plan = fx.plan("linked.asm", unresolved, None).expect("plan");
    let (lines, _, failed) = run(&plan);
    assert!(failed, "{lines:?}");
    assert!(
        lines
            .iter()
            .any(|l| l.contains("undefined reference to `not_defined_anywhere'")),
        "the linker's message reaches the Output (and the Problems parser): {lines:?}"
    );
    // Run in Terminal reuses its build folder: after a good build left `linked.exe` there, a failing link must stop
    // the chain before the old program could run.
    let chain = |text: &str| {
        let plan = fx.plan("linked.asm", text, None).expect("plan");
        let build = plan.build.as_ref().expect("build");
        fs::create_dir_all(&build.dir).expect("build dir");
        let mut steps = vec![build.argv.clone()];
        steps.extend(build.link.as_ref().map(|link| link.argv.clone()));
        steps.push(plan.argv.clone());
        let line = shell_chain(&steps, ShellStyle::PowerShell).expect("line");
        shell_command("powershell", &line)
            .current_dir(&fx.project)
            .env("PATH", system32())
            .output()
            .expect("shell")
    };
    assert_eq!(chain(good).status.code(), Some(9));
    let failed = chain(unresolved);
    assert_ne!(
        failed.status.code(),
        Some(9),
        "the old linked.exe ran after the link failed"
    );
    assert!(
        String::from_utf8_lossy(&failed.stderr).contains("undefined reference")
            || String::from_utf8_lossy(&failed.stdout).contains("undefined reference")
    );
}

#[test]
fn standard_output_and_standard_error_both_reach_the_output() {
    let Some(fx) = fixture() else { return };
    let source = "        default rel\n        global  main\n        extern  GetStdHandle\n        extern  WriteFile\n        extern  printf\n        section .data\nerr:    db \"to stderr\", 10\nout:    db \"to stdout\", 10, 0\n        section .text\nmain:\n        sub     rsp, 56\n        lea     rcx, [out]\n        call    printf\n        mov     ecx, -12\n        call    GetStdHandle\n        mov     rcx, rax\n        lea     rdx, [err]\n        mov     r8d, 10\n        lea     r9, [rsp + 40]\n        mov     qword [rsp + 32], 0\n        call    WriteFile\n        add     rsp, 56\n        xor     eax, eax\n        ret\n";
    let plan = fx.plan("streams.asm", source, None).expect("plan");
    let (lines, code, failed) = run(&plan);
    assert!(!failed, "{lines:?}");
    assert_eq!(code, Some(0), "{lines:?}");
    assert!(lines.iter().any(|l| l == "to stdout"), "{lines:?}");
    assert!(lines.iter().any(|l| l == "to stderr"), "{lines:?}");
}
