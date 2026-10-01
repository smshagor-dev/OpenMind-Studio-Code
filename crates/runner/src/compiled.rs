//! Run Code for compiled languages (C, C++, Java, Rust): one execution description shared by all four — which
//! compiler, the build command, the output (an executable or a Java class), the working folder, the environment
//! and the build folder that is removed after the run. Compilers are found like interpreters: OpenMind's portable
//! toolchains first, the system PATH last; nothing is installed and PATH is changed only for the child.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use crate::display::command_line;
use crate::error::RunError;
use crate::kind::RunnableKind;
use crate::plan::{child_path, RunPlan};
use crate::runtime::{
    portable_version, resolve_executable, ResolvedExecutable, RunEnvironment, RuntimeSource,
};

/// The compile step that runs before the program. Its output folder is `dir`, created before the compiler starts
/// and deleted (with everything the compiler wrote) when the run ends.
#[derive(Debug, Clone)]
pub struct BuildStep {
    /// `argv[0]` is the absolute path of the compiler.
    pub argv: Vec<String>,
    /// The compile command as the user would type it (display only).
    pub display: String,
    pub compiler: PathBuf,
    pub dir: PathBuf,
}

/// Compilers tried for a kind, in order. The first one found in OpenMind's portable toolchains wins; otherwise the
/// first one found anywhere.
fn compilers(kind: RunnableKind) -> &'static [&'static str] {
    match kind {
        RunnableKind::C => &["clang", "gcc"],
        RunnableKind::Cpp => &["clang++", "g++"],
        RunnableKind::Java => &["javac"],
        RunnableKind::Rust => &["rustc"],
        RunnableKind::Fortran => &["gfortran"],
        RunnableKind::Pascal => &["fpc64", "fpc"],
        _ => &[],
    }
}

/// Why no compiler was found, and where to get one (shown on the disabled Run button).
pub fn missing_compiler(kind: RunnableKind) -> String {
    match kind {
        RunnableKind::C | RunnableKind::Cpp => format!(
            "No {} compiler found ({}). Install the C/C++ toolchain (LLVM-MinGW) from the Runtime Manager.",
            kind.display_name(),
            compilers(kind).join(" or ")
        ),
        RunnableKind::Java => {
            "No Java compiler (javac) found. Install the Java JDK from the Runtime Manager.".into()
        }
        RunnableKind::Rust => "rustc was not found. Rust is managed outside OpenMind Studio: install it with rustup (https://rustup.rs), then restart OpenMind Studio.".into(),
        RunnableKind::Fortran => {
            "No Fortran compiler (gfortran) found. Install Fortran from the Runtime Manager.".into()
        }
        RunnableKind::Pascal => {
            "No Pascal compiler (fpc64 or fpc) found. Install Pascal from the Runtime Manager.".into()
        }
        _ => format!("{} has no compiler.", kind.display_name()),
    }
}

fn find_compiler(
    kind: RunnableKind,
    environment: &RunEnvironment,
    system_path: Option<&OsStr>,
) -> Option<ResolvedExecutable> {
    let found: Vec<ResolvedExecutable> = compilers(kind)
        .iter()
        .filter_map(|name| resolve_executable(name, environment, &[], system_path))
        .collect();
    found
        .iter()
        .find(|tool| tool.source == RuntimeSource::Portable)
        .or_else(|| found.first())
        .cloned()
}

/// "OpenMind portable clang (llvm-mingw 20260922)", "System javac".
fn compiler_label(tool: &ResolvedExecutable) -> String {
    let name = tool
        .path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    match tool.source {
        RuntimeSource::Portable => {
            let runtime = tool
                .path
                .components()
                .map(|part| part.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            let kind = runtime
                .iter()
                .position(|part| part == "versions")
                .and_then(|index| index.checked_sub(1))
                .and_then(|index| runtime.get(index).cloned());
            match (kind, portable_version(&tool.path)) {
                (Some(kind), Some(version)) => {
                    format!("OpenMind portable {name} ({kind} {version})")
                }
                _ => format!("OpenMind portable {name}"),
            }
        }
        RuntimeSource::Project => format!("project-local {name}"),
        RuntimeSource::System => format!("System {name}"),
    }
}

/// The executable name a compiler writes: `hello.exe` on Windows.
fn executable_name(stem: &str) -> String {
    if cfg!(windows) {
        format!("{stem}.exe")
    } else {
        stem.to_string()
    }
}

/// rustc takes the crate name from the file name, which may hold spaces or dashes it refuses: `hello world` ->
/// `hello_world`, `1st` -> `_1st`.
fn rust_crate_name(stem: &str) -> String {
    let name: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    match name.chars().next() {
        Some(first) if !first.is_ascii_digit() => name,
        _ => format!("_{name}"),
    }
}

fn is_java_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|first| first.is_alphabetic() || first == '_' || first == '$')
        && chars.all(|c| c.is_alphanumeric() || c == '_' || c == '$')
}

/// The class `java` must start: the file's `package` (if any) plus the file name, which is what a public class
/// with `main` must be called. Only the leading part of the file is read; comments before `package` are skipped.
pub fn java_main_class(source: &str, stem: &str) -> Result<String, RunError> {
    if !is_java_identifier(stem) {
        return Err(RunError::NotRunnable(format!(
            "\"{stem}\" isn't a valid Java class name, so the file can't be run. Rename it to match its public class."
        )));
    }
    let mut package = None;
    let mut in_comment = false;
    for raw in source.lines() {
        let mut line = raw.trim();
        if in_comment {
            match line.find("*/") {
                Some(end) => {
                    in_comment = false;
                    line = line[end + 2..].trim();
                }
                None => continue,
            }
        }
        if line.starts_with("/*") && !line.contains("*/") {
            in_comment = true;
            continue;
        }
        if line.is_empty() || line.starts_with("//") || line.starts_with("/*") {
            continue;
        }
        if let Some(rest) = line.strip_prefix("package ") {
            let name = rest.trim().trim_end_matches(';').trim();
            if !name.split('.').all(is_java_identifier) {
                return Err(RunError::NotRunnable(format!(
                    "The package name \"{name}\" isn't valid."
                )));
            }
            package = Some(name.to_string());
        }
        // `package` can only be the first statement: anything else ends the search.
        break;
    }
    Ok(match package {
        Some(package) => format!("{package}.{stem}"),
        None => stem.to_string(),
    })
}

/// The plan for a C, C++, Java or Rust file: compile into `build_dir`, then run the result from `cwd`.
pub(crate) fn plan_compiled(
    kind: RunnableKind,
    file: &Path,
    cwd: PathBuf,
    environment: &RunEnvironment,
    system_path: Option<OsString>,
    build_dir: &Path,
) -> Result<RunPlan, RunError> {
    let compiler = find_compiler(kind, environment, system_path.as_deref())
        .ok_or_else(|| RunError::CompilerMissing(missing_compiler(kind)))?;
    let stem = file
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| "program".into());
    let source = file.to_string_lossy().into_owned();
    let dir = build_dir.to_string_lossy().into_owned();
    let compiler_path = compiler.path.to_string_lossy().into_owned();
    let file_name = file
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let compiler_name = compiler
        .path
        .file_stem()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();

    let (build_argv, build_shown, run_argv, run_shown, resolved) = match kind {
        RunnableKind::Java => {
            let text = std::fs::read_to_string(file).unwrap_or_default();
            let class = java_main_class(&text, &stem)?;
            // `java` from the same JDK as `javac`, else the usual lookup.
            let java = compiler
                .path
                .parent()
                .and_then(|bin| {
                    ["java.exe", "java"]
                        .iter()
                        .map(|name| bin.join(name))
                        .find(|path| path.is_file())
                })
                .or_else(|| {
                    resolve_executable("java", environment, &[], system_path.as_deref())
                        .map(|found| found.path)
                })
                .ok_or_else(|| RunError::CompilerMissing(missing_compiler(kind)))?;
            (
                vec![
                    compiler_path,
                    "-encoding".into(),
                    "UTF-8".into(),
                    "-d".into(),
                    dir.clone(),
                    source,
                ],
                vec![compiler_name, file_name],
                vec![
                    java.to_string_lossy().into_owned(),
                    "-cp".into(),
                    dir,
                    class.clone(),
                ],
                vec!["java".into(), class],
                java,
            )
        }
        RunnableKind::Pascal => {
            let output = build_dir.join(executable_name(&stem));
            let output_text = output.to_string_lossy().into_owned();
            let exe = executable_name(&stem);
            (
                vec![
                    compiler_path,
                    "-FE".into(),
                    dir,
                    "-o".into(),
                    output_text.clone(),
                    source,
                ],
                vec![compiler_name, file_name, "-o".into(), exe.clone()],
                vec![output_text],
                vec![exe],
                output,
            )
        }
        _ => {
            let output = build_dir.join(executable_name(&stem));
            let output_text = output.to_string_lossy().into_owned();
            let build_argv = if kind == RunnableKind::Rust {
                vec![
                    compiler_path,
                    "--edition".into(),
                    "2021".into(),
                    "--crate-name".into(),
                    rust_crate_name(&stem),
                    "-o".into(),
                    output_text.clone(),
                    source,
                ]
            } else {
                vec![compiler_path, source, "-o".into(), output_text.clone()]
            };
            let exe = executable_name(&stem);
            (
                build_argv,
                vec![compiler_name, file_name, "-o".into(), exe.clone()],
                vec![output_text],
                vec![exe],
                output,
            )
        }
    };

    let path_var = child_path(environment, &[], &compiler, system_path)?;
    Ok(RunPlan {
        kind,
        file: file.to_path_buf(),
        argv: run_argv,
        cwd,
        env: environment.vars.clone(),
        path_var,
        runtime_label: compiler_label(&compiler),
        source: compiler.source,
        display: command_line(&run_shown),
        resolved,
        build: Some(BuildStep {
            argv: build_argv,
            display: command_line(&build_shown),
            compiler: compiler.path,
            dir: build_dir.to_path_buf(),
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_java_main_class_is_the_package_plus_the_file_name() {
        assert_eq!(
            java_main_class("import java.util.Scanner;\nclass A {}", "Hello").expect("class"),
            "Hello"
        );
        assert_eq!(
            java_main_class(
                "/* Licence\n * text\n */\n// note\npackage com.example.app;\n\npublic class Main {}",
                "Main"
            )
            .expect("class"),
            "com.example.app.Main"
        );
        assert!(java_main_class("", "my program").is_err());
        assert!(java_main_class("", "1st").is_err());
        assert!(java_main_class("package a.b-c;", "Main").is_err());
        // A `package` after other code isn't the package statement.
        assert_eq!(
            java_main_class("public class Main { String package = \"x\"; }", "Main")
                .expect("class"),
            "Main"
        );
    }

    #[test]
    fn rust_crate_names_are_made_valid() {
        assert_eq!(rust_crate_name("hello world"), "hello_world");
        assert_eq!(rust_crate_name("user-input"), "user_input");
        assert_eq!(rust_crate_name("1st"), "_1st");
        assert_eq!(rust_crate_name("main"), "main");
        assert_eq!(rust_crate_name(""), "_");
    }

    #[test]
    fn missing_compilers_name_where_to_get_one() {
        assert!(missing_compiler(RunnableKind::C).contains("LLVM-MinGW"));
        assert!(missing_compiler(RunnableKind::C).contains("(clang or gcc)"));
        assert!(missing_compiler(RunnableKind::Cpp).contains("C++ compiler found (clang++ or g++)"));
        assert!(missing_compiler(RunnableKind::Java).contains("JDK"));
        assert!(missing_compiler(RunnableKind::Fortran).contains("gfortran"));
        assert!(missing_compiler(RunnableKind::Pascal).contains("fpc64"));
        let rust = missing_compiler(RunnableKind::Rust);
        assert!(rust.contains("rustup") && rust.contains("outside OpenMind"));
    }
}
