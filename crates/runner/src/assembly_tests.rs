use std::ffi::OsString;
use std::fs;

use super::*;

const HELLO64: &str = "        default rel\n        global  main\n        extern  printf\n        section .text\nmain:   ret\n";

/// A stand-in Assembly runtime: `runtimes/assembly/versions/2.15.05/bin/{nasm,gcc}.exe` with its launchers in
/// `runtimes/assembly/shims/2.15.05`, and (optionally) the x86 add-on's `w64devkit/bin/gcc.exe`.
struct Install {
    _temp: tempfile::TempDir,
    root: PathBuf,
    shims: PathBuf,
    install: PathBuf,
}

fn install(with_x86: bool) -> Install {
    let temp = tempfile::tempdir().expect("tmp");
    let root = temp.path().join("My App");
    let install = root
        .join("runtimes")
        .join("assembly")
        .join("versions")
        .join("2.15.05");
    let shims = root
        .join("runtimes")
        .join("assembly")
        .join("shims")
        .join("2.15.05");
    fs::create_dir_all(install.join("bin")).expect("bin");
    fs::create_dir_all(&shims).expect("shims");
    for tool in ["nasm", "gcc"] {
        fs::write(install.join("bin").join(format!("{tool}.exe")), "").expect("tool");
        fs::write(shims.join(format!("{tool}.cmd")), "@echo off").expect("shim");
    }
    if with_x86 {
        fs::create_dir_all(install.join("w64devkit").join("bin")).expect("x86");
        fs::write(install.join("w64devkit").join("bin").join("gcc.exe"), "").expect("x86 gcc");
    }
    Install {
        _temp: temp,
        root,
        shims,
        install,
    }
}

impl Install {
    fn source(&self, name: &str, text: &str) -> PathBuf {
        let folder = self.root.join("My Project");
        fs::create_dir_all(&folder).expect("project");
        let file = folder.join(name);
        fs::write(&file, text).expect("source");
        file
    }

    fn plan(&self, file: &Path, options: &AssemblyOptions) -> Result<RunPlan, RunError> {
        let environment = RunEnvironment {
            path_prepend: vec![self.shims.clone()],
            vars: Vec::new(),
        };
        plan_assembly(
            file,
            self.root.join("My Project"),
            &environment,
            Some(OsString::new()),
            &self.root.join("cache").join("run-builds").join("run-1"),
            options,
        )
    }
}

#[test]
fn exported_symbols_are_read_from_nasm_and_gas_sources() {
    let nasm = "  global main, helper:function ; the entry\n;global commented\nGLOBAL Second\n[global third]\n";
    assert_eq!(
        exported_symbols(nasm, Syntax::Nasm),
        ["main", "helper", "Second", "third"]
    );
    let gas = "\t.globl main\n# .globl commented\n\t.global _start, other\n";
    assert_eq!(
        exported_symbols(gas, Syntax::Gas),
        ["main", "_start", "other"]
    );
}

#[test]
fn the_entry_is_main_through_the_c_runtime_or_a_raw_start_symbol() {
    assert_eq!(
        entry_point("global main", Syntax::Nasm, Arch::X64).expect("main"),
        Entry::CMain
    );
    assert_eq!(
        entry_point("global _main", Syntax::Nasm, Arch::X86).expect("_main"),
        Entry::CMain
    );
    assert_eq!(
        entry_point("global start", Syntax::Nasm, Arch::X64).expect("start"),
        Entry::Raw("start".into())
    );
    assert_eq!(
        entry_point("global _start", Syntax::Nasm, Arch::X86).expect("_start"),
        Entry::Raw("_start".into())
    );
    assert_eq!(
        entry_point(".globl main", Syntax::Gas, Arch::X64).expect("gas"),
        Entry::CMain
    );
    // A 32-bit `main` without the underscore is named, with the fix.
    let wrong = entry_point("global main", Syntax::Nasm, Arch::X86).expect_err("x86 main");
    assert!(wrong.to_string().contains("global _main"), "{wrong}");
    let none = entry_point("section .data\nx db 1", Syntax::Nasm, Arch::X64).expect_err("none");
    assert!(none.to_string().contains("global main"), "{none}");
}

#[test]
fn an_inc_file_is_assembly_only_when_it_looks_like_assembly() {
    let dir = tempfile::tempdir().expect("tmp");
    let asm = dir.path().join("macros.inc");
    fs::write(&asm, "%macro print 1\n  nop\n%endmacro\nBUFSIZE equ 64\n").expect("asm");
    assert!(is_assembly_include(&asm));
    let php = dir.path().join("config.inc");
    fs::write(&php, "<?php\n$db = 'x';\n").expect("php");
    assert!(!is_assembly_include(&php));
    let plain = dir.path().join("notes.inc");
    fs::write(&plain, "just words\n").expect("plain");
    assert!(!is_assembly_include(&plain));
}

#[test]
fn x86_64_assembles_with_nasm_win64_links_with_gcc_and_runs_the_program() {
    let fx = install(false);
    let file = fx.source("hello world.asm", HELLO64);
    let plan = fx.plan(&file, &AssemblyOptions::default()).expect("plan");
    let build = plan.build.as_ref().expect("build");
    // The launcher was found; the real program behind it runs.
    assert_eq!(build.compiler, fx.install.join("bin").join("nasm.exe"));
    assert_eq!(build.argv[1..3], ["-f", "win64"]);
    assert!(
        build.argv[3] == "-I" && build.argv[4].ends_with('/'),
        "{:?}",
        build.argv
    );
    // A backslash before a closing quote would escape the quote when a terminal passes the line on.
    assert!(
        !build.argv.iter().any(|arg| arg.ends_with('\\')),
        "{:?}",
        build.argv
    );
    assert!(build.argv.ends_with(&[
        file.to_string_lossy().into_owned(),
        "-o".into(),
        fx.root
            .join("cache")
            .join("run-builds")
            .join("run-1")
            .join("hello world.obj")
            .to_string_lossy()
            .into_owned(),
    ]));
    assert_eq!(
        build.display,
        "nasm -f win64 \"hello world.asm\" -o \"hello world.obj\""
    );
    let link = build.link.as_ref().expect("link step");
    assert_eq!(
        link.argv[0],
        fx.install.join("bin").join("gcc.exe").to_string_lossy()
    );
    // gcc is told where its own `as`/`ld` are, so a terminal PATH holding only launchers can link too.
    assert_eq!(
        link.argv[1],
        format!("-B{}/", fx.install.join("bin").display())
    );
    assert_eq!(
        link.display,
        "gcc \"hello world.obj\" -o \"hello world.exe\""
    );
    // Everything is written to the build folder; the program runs from the project folder.
    assert_eq!(
        build.dir,
        fx.root.join("cache").join("run-builds").join("run-1")
    );
    assert_eq!(
        plan.resolved,
        fx.root
            .join("cache")
            .join("run-builds")
            .join("run-1")
            .join("hello world.exe")
    );
    assert_eq!(plan.cwd, fx.root.join("My Project"));
    assert!(
        plan.runtime_label.contains("assembly 2.15.05, x86-64"),
        "{}",
        plan.runtime_label
    );
}

#[test]
fn x86_uses_nasm_win32_and_the_x86_add_on_linker_only() {
    let options = AssemblyOptions {
        arch: Arch::X86,
        ..AssemblyOptions::default()
    };
    let missing = install(false);
    let file = missing.source("hello32.asm", "global _main\n_main: ret\n");
    let refused = missing.plan(&file, &options).expect_err("no x86 toolchain");
    assert!(matches!(refused, RunError::CompilerMissing(_)));
    assert!(
        refused.to_string().contains("x86 (32-bit) toolchain"),
        "{refused}"
    );

    let fx = install(true);
    let file = fx.source("hello32.asm", "global _main\n_main: ret\n");
    let plan = fx.plan(&file, &options).expect("plan");
    let build = plan.build.as_ref().expect("build");
    assert_eq!(build.argv[1..3], ["-f", "win32"]);
    let link = build.link.as_ref().expect("link");
    assert_eq!(
        link.argv[0],
        fx.install
            .join("w64devkit")
            .join("bin")
            .join("gcc.exe")
            .to_string_lossy()
    );
}

#[test]
fn a_raw_entry_links_without_the_c_runtime_at_its_exact_symbol() {
    let fx = install(false);
    let file = fx.source("raw.asm", "global start\nextern ExitProcess\nstart: ret\n");
    let plan = fx.plan(&file, &AssemblyOptions::default()).expect("plan");
    let link = plan
        .build
        .as_ref()
        .and_then(|b| b.link.as_ref())
        .expect("link");
    for arg in ["-nostartfiles", "-Wl,-e,start", "-lkernel32", "-luser32"] {
        assert!(
            link.argv.iter().any(|a| a == arg),
            "{arg} in {:?}",
            link.argv
        );
    }
}

#[test]
fn extra_arguments_are_split_like_a_command_line_and_placed_before_the_files() {
    let fx = install(false);
    let file = fx.source("args.asm", HELLO64);
    let options = AssemblyOptions {
        arch: Arch::X64,
        assembler_args: r#"-w+all -D "NAME=two words""#.into(),
        linker_args: "-lgdi32".into(),
    };
    let plan = fx.plan(&file, &options).expect("plan");
    let build = plan.build.as_ref().expect("build");
    let position = |arg: &str| build.argv.iter().position(|a| a == arg).expect(arg);
    assert!(position("-w+all") < position(&file.to_string_lossy()));
    assert!(build.argv.iter().any(|a| a == "NAME=two words"));
    let link = build.link.as_ref().expect("link");
    assert_eq!(link.argv.last().map(String::as_str), Some("-lgdi32"));
    let broken = AssemblyOptions {
        assembler_args: "\"open".into(),
        ..AssemblyOptions::default()
    };
    let message = fx.plan(&file, &broken).expect_err("unclosed").to_string();
    assert_eq!(
        message,
        "The run command isn't valid: the extra assembler arguments (Settings > Assembly) can't be read: a quote is never closed",
        "one clear sentence, naming where to fix it"
    );
}

#[test]
fn gas_sources_are_assembled_and_linked_by_gcc_in_one_step() {
    let fx = install(false);
    let file = fx.source("gas.s", "\t.globl main\nmain:\n\tret\n");
    let plan = fx.plan(&file, &AssemblyOptions::default()).expect("plan");
    let build = plan.build.as_ref().expect("build");
    assert_eq!(build.compiler, fx.install.join("bin").join("gcc.exe"));
    assert!(build.link.is_none(), "gcc assembles and links .s itself");
    assert_eq!(build.display, "gcc gas.s -o gas.exe");
}

#[test]
fn without_the_toolchain_the_plan_says_what_to_install() {
    let temp = tempfile::tempdir().expect("tmp");
    let file = temp.path().join("hello.asm");
    fs::write(&file, HELLO64).expect("source");
    let empty = RunEnvironment {
        path_prepend: Vec::new(),
        vars: Vec::new(),
    };
    let refused = plan_assembly(
        &file,
        temp.path().to_path_buf(),
        &empty,
        Some(OsString::new()),
        &temp.path().join("run-builds/run-1"),
        &AssemblyOptions::default(),
    )
    .expect_err("no toolchain");
    assert!(matches!(refused, RunError::CompilerMissing(_)));
    let text = refused.to_string();
    assert!(
        text.contains("Assembly toolchain is not installed") && text.contains("Runtime Manager"),
        "{text}"
    );
}

#[test]
fn the_asm_lsp_config_checks_with_the_found_nasm_in_the_chosen_format() {
    let fx = install(false);
    let environment = RunEnvironment {
        path_prepend: vec![fx.shims.clone()],
        vars: Vec::new(),
    };
    let nasm = find_nasm(&environment, Some(&OsString::new())).expect("nasm");
    assert_eq!(nasm, fx.install.join("bin").join("nasm.exe"));
    let config = asm_lsp_config(Some(&nasm), Arch::X64);
    let expected = format!(
        "compiler = \"{}\"",
        nasm.to_string_lossy().replace('\\', "/")
    );
    assert!(config.contains(&expected), "{config}");
    assert!(config.contains("compile_flags_txt = [\"-f\", \"win64\", \"-o\", \"NUL\"]"));
    assert!(config.contains("instruction_set = \"x86-64\""));
    assert!(config.contains("assembler = \"nasm\""));
    let x86 = asm_lsp_config(Some(&nasm), Arch::X86);
    assert!(x86.contains("\"win32\"") && x86.contains("instruction_set = \"x86\""));
    // Without NASM there is nothing to check with: diagnostics are off, the rest of asm-lsp still works.
    let none = asm_lsp_config(None, Arch::X64);
    assert!(none.contains("diagnostics = false") && !none.contains("compiler"));
    // A quote or backslash in a path can't break out of the TOML string.
    let odd = asm_lsp_config(Some(Path::new("C:/a \"b\"/nasm.exe")), Arch::X64);
    assert!(odd.contains(r#"compiler = "C:/a \"b\"/nasm.exe""#), "{odd}");
}

#[test]
fn gdb_runs_the_built_program_with_its_arguments_and_matches_the_architecture() {
    let fx = install(true);
    fs::write(fx.install.join("bin").join("gdb.exe"), "").expect("gdb");
    fs::write(fx.shims.join("gdb.cmd"), "@echo off").expect("shim");
    fs::write(fx.install.join("w64devkit").join("bin").join("gdb.exe"), "").expect("x86 gdb");
    let environment = RunEnvironment {
        path_prepend: vec![fx.shims.clone()],
        vars: Vec::new(),
    };
    let file = fx.source("hello.asm", HELLO64);
    let plan = fx.plan(&file, &AssemblyOptions::default()).expect("plan");
    let argv = debugger_argv(&plan, &environment, Some(&OsString::new()), Arch::X64).expect("gdb");
    assert_eq!(
        argv[0],
        fx.install.join("bin").join("gdb.exe").to_string_lossy()
    );
    assert_eq!(argv[1], "--args");
    assert_eq!(argv[2..], plan.argv[..]);
    let x86 =
        debugger_argv(&plan, &environment, Some(&OsString::new()), Arch::X86).expect("x86 gdb");
    assert_eq!(
        x86[0],
        fx.install
            .join("w64devkit")
            .join("bin")
            .join("gdb.exe")
            .to_string_lossy()
    );

    let without = install(false);
    let env = RunEnvironment {
        path_prepend: vec![without.shims.clone()],
        vars: Vec::new(),
    };
    let missing =
        debugger_argv(&plan, &env, Some(&OsString::new()), Arch::X64).expect_err("no gdb");
    assert!(
        missing.to_string().contains("GDB is not installed"),
        "{missing}"
    );
}

#[test]
fn a_tool_that_isnt_a_runtime_launcher_is_used_as_found() {
    let dir = tempfile::tempdir().expect("tmp");
    let system = dir.path().join("nasm.exe");
    fs::write(&system, "").expect("tool");
    assert_eq!(real_program(&system), system);
    assert_eq!(Arch::parse("x86"), Arch::X86);
    assert_eq!(Arch::parse("anything else"), Arch::X64);
}
