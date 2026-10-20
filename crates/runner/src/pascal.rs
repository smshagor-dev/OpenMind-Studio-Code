//! Pascal's two compilers. Free Pascal (`fpc64`/`fpc`, native code, planned by `compiled.rs`) stays the default;
//! PascalABC.NET is a second, independent choice (setting `pascal.compiler`). Its console compiler `pabcnetcclear`
//! (official `PABCNETC.zip`) targets .NET Framework 4.7.2, so it runs on Windows only, and the programs it builds are
//! .NET Framework executables. One compiler is never swapped for the other: when the chosen one is missing the run is
//! refused with the reason.
//!
//! The command line follows the compiler's own source (`pabcnetc_clear/ConsoleCompiler.cs`):
//! `pabcnetcclear /Output:<absolute path\name.exe> <file>` — a rooted `/Output:` also sets the output folder, so
//! nothing is written next to the source. It prints `OK`, or `Compile errors:` and the first error as
//! `[line,col] file.pas: message`, and exits 0 (built) or 1 (errors); it never waits for a key.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::compiled::{executable_name, refuse_library_file, BuildStep};
use crate::display::command_line;
use crate::error::RunError;
use crate::kind::RunnableKind;
use crate::plan::{child_path, RunPlan};
use crate::runtime::{portable_version, resolve_executable, RunEnvironment, RuntimeSource};

/// The Runtime Manager item of PascalABC.NET (Free Pascal's is `pascal`).
pub const PASCALABC_RUNTIME: &str = "pascalabc";

/// The command-line compiler of the official console ZIP.
const PASCALABC_COMPILER: &str = "pabcnetcclear";

/// Which compiler builds `.pas`/`.pp` files.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PascalCompiler {
    /// Free Pascal: the default, also for anyone who never chose.
    #[default]
    FreePascal,
    PascalAbcNet,
}

impl PascalCompiler {
    /// The `pascal.compiler` setting's value: `pascalabc`, anything else (`fpc`, empty, unknown) is Free Pascal.
    pub fn parse(value: &str) -> Self {
        match value.trim() {
            "pascalabc" => Self::PascalAbcNet,
            _ => Self::FreePascal,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::FreePascal => "fpc",
            Self::PascalAbcNet => PASCALABC_RUNTIME,
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::FreePascal => "Free Pascal",
            Self::PascalAbcNet => "PascalABC.NET",
        }
    }

    /// The Runtime Manager item that installs it.
    pub fn runtime_id(self) -> &'static str {
        match self {
            Self::FreePascal => "pascal",
            Self::PascalAbcNet => PASCALABC_RUNTIME,
        }
    }
}

/// Pascal's build options, filled by the app (from the settings and this computer), never by the page asking for
/// the run.
#[derive(Debug, Clone, Default)]
pub struct PascalOptions {
    pub compiler: PascalCompiler,
    /// This computer's .NET Framework 4.x `Release` (`openmind_core::dotnet_framework`), `None` when absent.
    pub dotnet_framework: Option<u32>,
    /// Folders of a PascalABC.NET installed by its own setup (`Program Files (x86)\PascalABC.NET`), looked in after
    /// OpenMind's runtime and the PATH; such a compiler is labelled "System".
    pub installed_dirs: Vec<PathBuf>,
}

/// Why PascalABC.NET can't build anything here, if it can't.
fn unavailable(options: &PascalOptions) -> Option<String> {
    if !cfg!(windows) {
        return Some(
            "PascalABC.NET's console compiler runs on Windows only (it is built for .NET Framework 4.7.2). Choose Free Pascal in Settings > Pascal > Compiler."
                .into(),
        );
    }
    let release = options.dotnet_framework;
    if openmind_core::dotnet_framework::satisfies(
        release,
        openmind_core::dotnet_framework::RELEASE_4_7_2,
    ) {
        return None;
    }
    Some(match release {
        Some(release) => format!(
            "PascalABC.NET needs .NET Framework 4.7.2 or later; this computer has .NET Framework {}. Update it with Windows Update or Microsoft's .NET Framework installer (OpenMind doesn't install Windows components).",
            openmind_core::dotnet_framework::version_name(release)
        ),
        None => "PascalABC.NET needs .NET Framework 4.7.2 or later, which isn't installed on this computer. Install it with Windows Update or Microsoft's .NET Framework installer (OpenMind doesn't install Windows components).".into(),
    })
}

/// The reason shown when no PascalABC.NET compiler is found.
pub fn missing_pascalabc() -> String {
    "PascalABC.NET isn't installed. Install it from the Runtime Manager, or choose Free Pascal in Settings > Pascal > Compiler."
        .into()
}

/// `pabcnetcclear` from OpenMind's runtime, the PATH, then a PascalABC.NET setup's own folder.
fn find_pascalabc(
    environment: &RunEnvironment,
    system_path: Option<&std::ffi::OsStr>,
    options: &PascalOptions,
) -> Option<crate::runtime::ResolvedExecutable> {
    resolve_executable(PASCALABC_COMPILER, environment, &[], system_path).or_else(|| {
        let dirs = std::env::join_paths(&options.installed_dirs).ok()?;
        resolve_executable(
            PASCALABC_COMPILER,
            &RunEnvironment::default(),
            &[],
            Some(&dirs),
        )
    })
}

/// "OpenMind PascalABC.NET 4.0.0.3883", or "System PascalABC.NET (C:\...)".
fn label(path: &Path, source: RuntimeSource) -> String {
    match source {
        RuntimeSource::Portable => match portable_version(path) {
            Some(version) => format!("OpenMind PascalABC.NET {version}"),
            None => "OpenMind PascalABC.NET".into(),
        },
        _ => format!(
            "System PascalABC.NET ({})",
            path.parent()
                .map_or_else(String::new, |dir| dir.display().to_string())
        ),
    }
}

/// The plan for a Pascal file built by PascalABC.NET: compile into `build_dir`, then run the program from `cwd`.
pub(crate) fn plan_pascalabc(
    file: &Path,
    cwd: PathBuf,
    environment: &RunEnvironment,
    system_path: Option<OsString>,
    build_dir: &Path,
    options: &PascalOptions,
) -> Result<RunPlan, RunError> {
    refuse_library_file(RunnableKind::Pascal, file)?;
    let compiler = find_pascalabc(environment, system_path.as_deref(), options)
        .ok_or_else(|| RunError::CompilerMissing(missing_pascalabc()))?;
    // Not "missing": installing PascalABC.NET again wouldn't help, so the Run button offers no install for these.
    if let Some(reason) = unavailable(options) {
        return Err(RunError::NotRunnable(reason));
    }
    let stem = file
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| "program".into());
    let exe = executable_name(&stem);
    let output = build_dir.join(&exe);
    let output_text = output.to_string_lossy().into_owned();
    let file_name = file
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let build_argv = vec![
        compiler.path.to_string_lossy().into_owned(),
        format!("/Output:{output_text}"),
        file.to_string_lossy().into_owned(),
    ];
    let path_var = child_path(environment, &[], &compiler, system_path)?;
    let build_cwd = file.parent().map_or_else(|| cwd.clone(), Path::to_path_buf);
    Ok(RunPlan {
        kind: RunnableKind::Pascal,
        file: file.to_path_buf(),
        argv: vec![output_text],
        cwd,
        env: environment.vars.clone(),
        path_var,
        runtime_label: label(&compiler.path, compiler.source),
        source: compiler.source,
        display: command_line(std::slice::from_ref(&exe)),
        resolved: output,
        build: Some(BuildStep {
            argv: build_argv,
            display: command_line(&[PASCALABC_COMPILER.to_string(), file_name]),
            compiler: compiler.path,
            dir: build_dir.to_path_buf(),
            cwd: build_cwd,
            link: None,
        }),
    })
}

#[cfg(test)]
#[path = "pascal_tests.rs"]
mod tests;
