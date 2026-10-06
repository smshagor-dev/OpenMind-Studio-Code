//! Run Code for assembly: NASM sources (`.asm`, `.nasm`) are assembled by NASM into an object file and linked by gcc
//! (GNU ld) into a Windows program; GNU assembler sources (`.s`, `.S`) are assembled and linked by gcc in one step.
//! Everything is written to the run's build folder, never next to the source. The syntax is chosen from the file name
//! and the architecture from the user's setting; each syntax/architecture pair maps to the tool and object format that
//! really supports it (x86 needs the Assembly runtime's optional i686 toolchain).

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::compiled::{BuildStep, LinkStep};
use crate::display::command_line;
use crate::error::RunError;
use crate::kind::RunnableKind;
use crate::plan::{child_path_with, RunPlan};
use crate::runtime::{resolve_executable, ResolvedExecutable, RunEnvironment, RuntimeSource};

/// Which assembler language a file is written in. NASM is the supported default; GAS is what `.s`/`.S` files are.
/// (MASM and FASM would be further variants: each brings its own assembler and object format.)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Syntax {
    Nasm,
    Gas,
}

/// The target architecture (the `assembly.architecture` setting).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Arch {
    #[default]
    X64,
    X86,
}

impl Arch {
    pub fn parse(value: &str) -> Self {
        match value {
            "x86" => Self::X86,
            _ => Self::X64,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::X64 => "x86-64",
            Self::X86 => "x86",
        }
    }

    /// NASM's output format for this architecture.
    pub fn nasm_format(self) -> &'static str {
        match self {
            Self::X64 => "win64",
            Self::X86 => "win32",
        }
    }
}

/// The user's Assembly settings that change a build (read by the app from the settings file).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AssemblyOptions {
    pub arch: Arch,
    /// Extra NASM arguments, as typed (quote-aware, never through a shell).
    pub assembler_args: String,
    /// Extra linker (gcc) arguments, as typed.
    pub linker_args: String,
}

pub fn syntax_of(file: &Path) -> Syntax {
    match file
        .extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
    {
        Some(ext) if ext == "s" => Syntax::Gas,
        _ => Syntax::Nasm,
    }
}

/// How the program starts: through the C runtime (`main`), or at its own entry symbol with no C runtime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    CMain,
    Raw(String),
}

/// Symbols a raw (no C runtime) program may start at, in the order they are preferred.
const RAW_ENTRIES: &[&str] = &["start", "_start", "mainCRTStartup", "_mainCRTStartup"];

/// The names a source exports: NASM `global a, b` (`global main:function` too), GAS `.globl`/`.global`.
pub fn exported_symbols(text: &str, syntax: Syntax) -> Vec<String> {
    let mut names = Vec::new();
    for raw in text.lines() {
        let code = match syntax {
            Syntax::Nasm => raw.split(';').next().unwrap_or(""),
            Syntax::Gas => raw.split(['#', '@']).next().unwrap_or(""),
        };
        let code = code.trim();
        let lower = code.to_ascii_lowercase();
        let rest = match syntax {
            Syntax::Nasm => lower
                .strip_prefix("global ")
                .or_else(|| lower.strip_prefix("[global "))
                .map(|_| &code[code.find(char::is_whitespace).unwrap_or(0)..]),
            Syntax::Gas => lower
                .strip_prefix(".globl ")
                .or_else(|| lower.strip_prefix(".global "))
                .map(|_| &code[code.find(char::is_whitespace).unwrap_or(0)..]),
        };
        let Some(rest) = rest else { continue };
        for name in rest.trim_end_matches(']').split(',') {
            let name = name.split(':').next().unwrap_or("").trim();
            if !name.is_empty() {
                names.push(name.to_string());
            }
        }
    }
    names
}

/// The program's entry: `main` (on x86 the C name `_main`) goes through the C runtime; `start`/`_start` ... are used
/// as the entry symbol with no C runtime. A file that exports neither has nothing to run.
pub fn entry_point(text: &str, syntax: Syntax, arch: Arch) -> Result<Entry, RunError> {
    let names = exported_symbols(text, syntax);
    let c_main = match (syntax, arch) {
        // NASM writes symbol names as they are: a 32-bit C `main` is `_main`.
        (Syntax::Nasm, Arch::X86) => "_main",
        _ => "main",
    };
    if names.iter().any(|name| name == c_main) {
        return Ok(Entry::CMain);
    }
    if let Some(raw) = RAW_ENTRIES
        .iter()
        .find(|entry| names.iter().any(|name| name == *entry))
    {
        return Ok(Entry::Raw((*raw).to_string()));
    }
    let hint = if syntax == Syntax::Nasm && arch == Arch::X86 && names.iter().any(|n| n == "main") {
        "A 32-bit program's C entry is `_main`: declare `global _main` (or set the architecture to x86-64)."
            .to_string()
    } else {
        format!(
            "This file declares no entry point: add `{} {c_main}` (runs through the C runtime) or `{} start` (your own entry, no C runtime).",
            if syntax == Syntax::Nasm { "global" } else { ".globl" },
            if syntax == Syntax::Nasm { "global" } else { ".globl" },
        )
    };
    Err(RunError::NotRunnable(hint))
}

/// Whether an `.inc` file is an assembly include (NASM macros, constants, data) rather than a PHP include.
pub fn is_assembly_include(file: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(file) else {
        return false;
    };
    if text.contains("<?") {
        return false;
    }
    text.lines().any(|line| {
        let lower = line.trim().to_ascii_lowercase();
        [
            "%macro", "%define", "%include", "%assign", "struc ", "section ", "extern ",
        ]
        .iter()
        .any(|marker| lower.starts_with(marker))
            || lower.split_whitespace().nth(1).is_some_and(|word| {
                matches!(
                    word,
                    "equ" | "db" | "dw" | "dd" | "dq" | "resb" | "resd" | "resq"
                )
            })
    })
}

/// The real program behind a Runtime Manager launcher: `runtimes/<kind>/shims/<v>/<name>.cmd` ->
/// `runtimes/<kind>/versions/<v>/bin/<name>.exe` (launchers and installs are always siblings). Anything else as is.
fn real_program(found: &Path) -> PathBuf {
    let candidate = (|| {
        let version_dir = found.parent()?;
        let shims = version_dir.parent()?;
        if shims.file_name()? != "shims" {
            return None;
        }
        let name = found.file_stem()?.to_string_lossy().into_owned();
        let exe = shims
            .parent()?
            .join("versions")
            .join(version_dir.file_name()?)
            .join("bin")
            .join(format!("{name}.exe"));
        exe.is_file().then_some(exe)
    })();
    candidate.unwrap_or_else(|| found.to_path_buf())
}

/// The install folder (`runtimes/assembly/versions/<v>`) of a portable tool found in its `bin`.
fn install_of(program: &Path) -> Option<PathBuf> {
    let bin = program.parent()?;
    (bin.file_name()? == "bin").then(|| bin.parent().map(Path::to_path_buf))?
}

fn find(
    name: &str,
    environment: &RunEnvironment,
    system_path: Option<&std::ffi::OsStr>,
) -> Option<ResolvedExecutable> {
    resolve_executable(name, environment, &[], system_path).map(|found| ResolvedExecutable {
        path: real_program(&found.path),
        source: found.source,
    })
}

/// `gdb --args <program> <arguments>` for a built assembly program: the Assembly runtime's GDB for x86-64, the x86
/// add-on's for 32-bit programs (a 64-bit GDB can't run them). The program keeps its symbols (labels, functions), so
/// `break main`, `stepi`, `info registers` and `x/` work; NASM's win64/win32 objects carry no source-line debug
/// information GDB reads, so stepping is per instruction (`layout asm`).
pub fn debugger_argv(
    plan: &RunPlan,
    environment: &RunEnvironment,
    system_path: Option<&std::ffi::OsStr>,
    arch: Arch,
) -> Result<Vec<String>, RunError> {
    let gdb = find("gdb", environment, system_path)
        .ok_or_else(|| RunError::CompilerMissing(missing_gdb()))?;
    let gdb = match arch {
        Arch::X64 => gdb.path,
        Arch::X86 => (gdb.source == RuntimeSource::Portable)
            .then(|| install_of(&gdb.path))
            .flatten()
            .map(|install| install.join("w64devkit").join("bin").join("gdb.exe"))
            .filter(|path| path.is_file())
            .ok_or_else(|| RunError::CompilerMissing(missing_x86()))?,
    };
    let mut argv = vec![gdb.to_string_lossy().into_owned(), "--args".to_string()];
    argv.extend(plan.argv.iter().cloned());
    Ok(argv)
}

fn missing_gdb() -> String {
    "GDB is not installed: it comes with the Assembly toolchain. Install Assembly from the Runtime Manager.".into()
}

/// The real `nasm.exe` the Run Code environment finds (OpenMind's Assembly runtime first), for asm-lsp's diagnostics.
pub fn find_nasm(
    environment: &RunEnvironment,
    system_path: Option<&std::ffi::OsStr>,
) -> Option<PathBuf> {
    find("nasm", environment, system_path).map(|found| found.path)
}

/// asm-lsp's `.asm-lsp.toml` for NASM sources: diagnostics come from `nasm` (absolute path, so asm-lsp needs nothing
/// on PATH) assembling to `NUL` in the format of the chosen architecture — the same check Run Code's build makes.
/// Without NASM, asm-lsp still gives hover, completion and symbols; only its diagnostics are switched off.
pub fn asm_lsp_config(nasm: Option<&Path>, arch: Arch) -> String {
    let set = match arch {
        Arch::X64 => "x86-64",
        Arch::X86 => "x86",
    };
    let mut lines = vec![
        "# Written by OpenMind Studio from its Assembly settings; a project's own .asm-lsp.toml is used instead."
            .to_string(),
        "[default_config]".into(),
        "version = \"0.10.1\"".into(),
        "assembler = \"nasm\"".into(),
        format!("instruction_set = \"{set}\""),
        String::new(),
        "[default_config.opts]".into(),
    ];
    match nasm {
        Some(nasm) => lines.extend([
            format!(
                "compiler = {}",
                toml_string(&nasm.to_string_lossy().replace('\\', "/"))
            ),
            format!(
                "compile_flags_txt = [\"-f\", \"{}\", \"-o\", \"NUL\"]",
                arch.nasm_format()
            ),
            "diagnostics = true".into(),
            "default_diagnostics = true".into(),
        ]),
        None => lines.extend([
            "diagnostics = false".into(),
            "default_diagnostics = false".into(),
        ]),
    }
    let mut config = lines.join("\n");
    config.push('\n');
    config
}

/// A TOML basic string.
fn toml_string(text: &str) -> String {
    let mut out = String::from('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if c.is_control() => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

pub fn missing_toolchain() -> String {
    "Assembly toolchain is not installed: NASM and the linker (gcc/ld) are needed to build this file. Install Assembly from the Runtime Manager.".into()
}

fn missing_x86() -> String {
    "x86 (32-bit) programs need the Assembly runtime's x86 toolchain: add it in the Runtime Manager (Assembly > x86 (32-bit) toolchain), or set the architecture to x86-64.".into()
}

/// The gcc that links for `arch`: the x64 one next to NASM, or the x86 add-on's (never a random 32-bit gcc).
fn linker_for(
    arch: Arch,
    environment: &RunEnvironment,
    system_path: Option<&std::ffi::OsStr>,
) -> Result<ResolvedExecutable, RunError> {
    let gcc = find("gcc", environment, system_path)
        .ok_or_else(|| RunError::CompilerMissing(missing_toolchain()))?;
    match arch {
        Arch::X64 => Ok(gcc),
        Arch::X86 => {
            let x86 = (gcc.source == RuntimeSource::Portable)
                .then(|| install_of(&gcc.path))
                .flatten()
                .map(|install| install.join("w64devkit").join("bin").join("gcc.exe"))
                .filter(|path| path.is_file())
                .ok_or_else(|| RunError::CompilerMissing(missing_x86()))?;
            Ok(ResolvedExecutable {
                path: x86,
                source: RuntimeSource::Portable,
            })
        }
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// The linker arguments that pick the entry: none for `main`, else no C runtime and the exact entry symbol.
fn entry_args(entry: &Entry) -> Vec<String> {
    match entry {
        Entry::CMain => Vec::new(),
        Entry::Raw(symbol) => vec![
            "-nostartfiles".into(),
            format!("-Wl,-e,{symbol}"),
            // Windows API programs without a C runtime call kernel32/user32 directly.
            "-lkernel32".into(),
            "-luser32".into(),
        ],
    }
}

/// "OpenMind portable nasm (assembly 2.15.05)", "System nasm".
fn label(tool: &ResolvedExecutable, arch: Arch) -> String {
    let name = tool
        .path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    let version = install_of(&tool.path).and_then(|install| {
        install
            .file_name()
            .map(|v| v.to_string_lossy().into_owned())
    });
    match (tool.source, version) {
        (RuntimeSource::Portable, Some(version)) => {
            format!(
                "OpenMind portable {name} (assembly {version}, {})",
                arch.label()
            )
        }
        (RuntimeSource::Portable, None) => format!("OpenMind portable {name} ({})", arch.label()),
        (RuntimeSource::Project, _) => format!("project-local {name} ({})", arch.label()),
        (RuntimeSource::System, _) => format!("System {name} ({})", arch.label()),
    }
}

/// The extra arguments from a setting: quote-aware splitting only (never a shell); empty text is none.
fn extra_arguments(text: &str, what: &str) -> Result<Vec<String>, RunError> {
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    if text.contains(['\n', '\r', '\0']) {
        return Err(RunError::BadCommand(format!(
            "the extra {what} arguments contain a line break (setting assembly.extra{}Args)",
            if what == "assembler" {
                "Assembler"
            } else {
                "Linker"
            }
        )));
    }
    crate::template::tokenize(text).map_err(|err| {
        // `tokenize` says what is wrong inside a "The run command isn't valid" error: only that part is kept.
        let reason = match err {
            RunError::BadCommand(reason) => reason,
            other => other.to_string(),
        };
        RunError::BadCommand(format!(
            "the extra {what} arguments (Settings > Assembly) can't be read: {reason}"
        ))
    })
}

/// The plan for an assembly file: assemble (and link) into `build_dir`, then run the program from `cwd`.
pub(crate) fn plan_assembly(
    file: &Path,
    cwd: PathBuf,
    environment: &RunEnvironment,
    system_path: Option<OsString>,
    build_dir: &Path,
    options: &AssemblyOptions,
) -> Result<RunPlan, RunError> {
    let syntax = syntax_of(file);
    let source_text = std::fs::read_to_string(file).unwrap_or_default();
    let gcc = linker_for(options.arch, environment, system_path.as_deref())?;
    let stem = file
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| "program".into());
    let inputs = Inputs {
        file,
        build_dir,
        exe_name: format!("{stem}.exe"),
        stem,
        source_dir: file.parent().map_or_else(|| cwd.clone(), Path::to_path_buf),
        entry: entry_point(&source_text, syntax, options.arch)?,
        assembler_args: extra_arguments(&options.assembler_args, "assembler")?,
        linker_args: extra_arguments(&options.linker_args, "linker")?,
        gcc: &gcc,
    };
    let steps = match syntax {
        Syntax::Nasm => nasm_steps(&inputs, options.arch, environment, system_path.as_deref())?,
        Syntax::Gas => gas_steps(&inputs),
    };
    // gcc runs `as`/`ld` from its own folder: that folder goes first on the build's (and the program's) PATH.
    let tool_dirs: Vec<PathBuf> = [&steps.tool.path, &gcc.path]
        .iter()
        .filter_map(|path| path.parent().map(Path::to_path_buf))
        .collect();
    let path_var = child_path_with(environment, &tool_dirs, system_path)?;
    let exe = build_dir.join(&inputs.exe_name);
    Ok(RunPlan {
        kind: RunnableKind::Assembly,
        file: file.to_path_buf(),
        argv: vec![text(&exe)],
        cwd,
        env: environment.vars.clone(),
        path_var,
        runtime_label: label(&steps.tool, options.arch),
        source: steps.tool.source,
        display: command_line(std::slice::from_ref(&inputs.exe_name)),
        resolved: exe,
        build: Some(BuildStep {
            argv: steps.argv,
            display: command_line(&steps.shown),
            compiler: steps.tool.path,
            dir: build_dir.to_path_buf(),
            cwd: inputs.source_dir,
            link: steps.link,
        }),
    })
}

/// What both syntaxes build from.
struct Inputs<'a> {
    file: &'a Path,
    build_dir: &'a Path,
    stem: String,
    exe_name: String,
    source_dir: PathBuf,
    entry: Entry,
    assembler_args: Vec<String>,
    linker_args: Vec<String>,
    gcc: &'a ResolvedExecutable,
}

/// The build: the program that runs first, its arguments and what the Output shows, and the link after it.
struct Steps {
    tool: ResolvedExecutable,
    argv: Vec<String>,
    shown: Vec<String>,
    link: Option<LinkStep>,
}

impl Inputs<'_> {
    /// `gcc -B<its folder>/`: gcc finds `as`, `ld` and `collect2`'s linker next to itself, whatever PATH the build
    /// runs with — a terminal's PATH holds only the toolchain's launchers (`ld.cmd`), which collect2 doesn't run.
    fn gcc_prefix(&self) -> Option<String> {
        self.gcc
            .path
            .parent()
            .map(|dir| format!("-B{}/", dir.display()))
    }
}

/// NASM assembles into an object, then gcc links it.
fn nasm_steps(
    inputs: &Inputs<'_>,
    arch: Arch,
    environment: &RunEnvironment,
    system_path: Option<&std::ffi::OsStr>,
) -> Result<Steps, RunError> {
    let nasm = find("nasm", environment, system_path)
        .ok_or_else(|| RunError::CompilerMissing(missing_toolchain()))?;
    let object_name = format!("{}.obj", inputs.stem);
    let object = text(&inputs.build_dir.join(&object_name));
    let format = arch.nasm_format();
    // `%include "macros.inc"` finds files next to the source. NASM appends the include name to this text, so it needs a
    // separator at the end: `/` (accepted on Windows), never `\` — a trailing backslash before a closing quote escapes
    // the quote when a terminal passes the line on ("C:\My Work\" swallows the arguments after it).
    let include = format!("{}/", inputs.source_dir.display());
    let mut argv = vec![
        text(&nasm.path),
        "-f".into(),
        format.into(),
        "-I".into(),
        include,
    ];
    argv.extend(inputs.assembler_args.iter().cloned());
    argv.extend([text(inputs.file), "-o".into(), object.clone()]);
    let mut shown = vec!["nasm".into(), "-f".into(), format.into()];
    shown.extend(inputs.assembler_args.iter().cloned());
    shown.extend([file_name(inputs.file), "-o".into(), object_name.clone()]);

    let exe = text(&inputs.build_dir.join(&inputs.exe_name));
    let mut link_argv = vec![text(&inputs.gcc.path)];
    link_argv.extend(inputs.gcc_prefix());
    link_argv.extend([object, "-o".into(), exe]);
    link_argv.extend(entry_args(&inputs.entry));
    link_argv.extend(inputs.linker_args.iter().cloned());
    let mut link_shown = vec![
        "gcc".into(),
        object_name,
        "-o".into(),
        inputs.exe_name.clone(),
    ];
    link_shown.extend(entry_args(&inputs.entry));
    link_shown.extend(inputs.linker_args.iter().cloned());
    Ok(Steps {
        tool: nasm,
        argv,
        shown,
        link: Some(LinkStep {
            argv: link_argv,
            display: command_line(&link_shown),
        }),
    })
}

/// gcc assembles a GNU as source with `as` and links it in one step.
fn gas_steps(inputs: &Inputs<'_>) -> Steps {
    let mut argv = vec![text(&inputs.gcc.path)];
    argv.extend(inputs.gcc_prefix());
    argv.extend([
        text(inputs.file),
        "-o".into(),
        text(&inputs.build_dir.join(&inputs.exe_name)),
    ]);
    argv.extend(entry_args(&inputs.entry));
    argv.extend(inputs.assembler_args.iter().cloned());
    argv.extend(inputs.linker_args.iter().cloned());
    let mut shown = vec![
        "gcc".into(),
        file_name(inputs.file),
        "-o".into(),
        inputs.exe_name.clone(),
    ];
    shown.extend(entry_args(&inputs.entry));
    shown.extend(inputs.assembler_args.iter().cloned());
    shown.extend(inputs.linker_args.iter().cloned());
    Steps {
        tool: inputs.gcc.clone(),
        argv,
        shown,
        link: None,
    }
}

#[cfg(test)]
#[path = "assembly_tests.rs"]
mod tests;
