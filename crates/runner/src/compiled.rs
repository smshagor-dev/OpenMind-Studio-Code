//! Run Code for compiled languages (C, C++, Java, Rust, Fortran, Pascal): one execution description shared by
//! all of them — which compiler, the build command, the output (an executable or a Java class), the working folder, the environment
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
    /// The folder the compiler runs in: the source file's own folder, so a compiler that looks in its working
    /// folder first (Free Pascal's units, gfortran's module files) finds the files next to the source, not
    /// same-named ones in the workspace root. The program itself still runs in the plan's `cwd`.
    pub cwd: PathBuf,
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
            // `runtimes/<kind>/versions/<version>/...`, or a runtime's launcher `runtimes/<kind>/shims/<version>/<name>.cmd`
            // (Free Pascal's `fpc64`).
            let shim = runtime
                .iter()
                .position(|part| part == "shims")
                .filter(|index| index + 3 == runtime.len());
            let marker = runtime.iter().position(|part| part == "versions").or(shim);
            let kind = marker
                .and_then(|index| index.checked_sub(1))
                .and_then(|index| runtime.get(index).cloned());
            let version = match shim {
                Some(index) if marker == Some(index) => runtime.get(index + 1).cloned(),
                _ => portable_version(&tool.path),
            };
            match (kind, version) {
                // w64devkit (the Fortran runtime) is a whole GCC: its gcc/g++ build C and C++ too, so say where it is from.
                (Some(kind), Some(version)) if kind == "fortran" => {
                    format!("OpenMind portable {name} (w64devkit GCC from the Fortran runtime {version})")
                }
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

/// The first word of a Pascal source after its comments and compiler directives: `program`, `unit`, `library` ...
fn pascal_first_word(text: &str) -> String {
    let mut rest = text.trim_start_matches('\u{feff}');
    loop {
        rest = rest.trim_start();
        if let Some(after) = rest.strip_prefix("//") {
            rest = after.split_once('\n').map_or("", |(_, tail)| tail);
        } else if let Some(after) = rest.strip_prefix('{') {
            rest = after.split_once('}').map_or("", |(_, tail)| tail);
        } else if let Some(after) = rest.strip_prefix("(*") {
            rest = after.split_once("*)").map_or("", |(_, tail)| tail);
        } else {
            break;
        }
    }
    rest.chars()
        .take_while(char::is_ascii_alphabetic)
        .collect::<String>()
        .to_ascii_lowercase()
}

/// A Pascal unit or library, or a Fortran file of modules/procedures only, compiles but has no program to run:
/// say so instead of building it and then failing to start (or link) an executable.
fn refuse_library_file(kind: RunnableKind, file: &Path) -> Result<(), RunError> {
    let reason = match kind {
        RunnableKind::Pascal => {
            let text = std::fs::read_to_string(file).unwrap_or_default();
            match pascal_first_word(&text).as_str() {
                "unit" => "This is a Pascal unit, not a program: run the program that uses it.",
                "library" => {
                    "This is a Pascal library (a DLL), not a program, so there is nothing to run."
                }
                _ => return Ok(()),
            }
        }
        RunnableKind::Fortran if crate::fortran::is_library_file(file) => {
            "This file has no main program (only modules or procedures): run the file with the `program` that uses it."
        }
        _ => return Ok(()),
    };
    Err(RunError::NotRunnable(reason.into()))
}

/// The plan for a C, C++, Java, Rust, Fortran or Pascal file: compile into `build_dir`, then run the result from `cwd`.
pub(crate) fn plan_compiled(
    kind: RunnableKind,
    file: &Path,
    cwd: PathBuf,
    environment: &RunEnvironment,
    system_path: Option<OsString>,
    build_dir: &Path,
) -> Result<RunPlan, RunError> {
    refuse_library_file(kind, file)?;
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
                    // Warnings and notes: without an fpc.cfg Free Pascal prints errors only.
                    "-vwn".into(),
                    format!("-FE{dir}"),
                    format!("-o{output_text}"),
                    source,
                ],
                vec![compiler_name, file_name, format!("-o{exe}")],
                vec![output_text],
                vec![exe],
                output,
            )
        }
        RunnableKind::Fortran => {
            let output = build_dir.join(executable_name(&stem));
            let output_text = output.to_string_lossy().into_owned();
            let exe = executable_name(&stem);
            let companions = crate::fortran::companion_sources(file);
            let mut argv = vec![
                compiler_path,
                // One line per problem (`file:line:col: Error: text`), so it can become a Problems entry.
                "-fdiagnostics-plain-output".into(),
                // Module files go to the build folder, never into the project.
                "-J".into(),
                dir,
            ];
            let mut shown = vec![compiler_name];
            for companion in &companions {
                argv.push(companion.to_string_lossy().into_owned());
                shown.push(
                    companion
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                );
            }
            argv.extend([source, "-o".into(), output_text.clone()]);
            shown.extend([file_name, "-o".into(), exe.clone()]);
            (argv, shown, vec![output_text], vec![exe], output)
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
    let build_cwd = file.parent().map_or_else(|| cwd.clone(), Path::to_path_buf);
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
            cwd: build_cwd,
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
    fn pascal_sources_are_read_past_their_comments() {
        assert_eq!(pascal_first_word("unit Pricing;\ninterface"), "unit");
        assert_eq!(
            pascal_first_word("\u{feff}{ header }\n(* more *)\n// line\n{$mode objfpc}\nUNIT X;"),
            "unit"
        );
        assert_eq!(pascal_first_word("library Tools;"), "library");
        assert_eq!(pascal_first_word("{ demo }\nprogram Hello;"), "program");
        assert_eq!(
            pascal_first_word("begin writeln('no header'); end."),
            "begin"
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
    fn portable_compilers_are_labelled_with_their_runtime_and_version() {
        let label = |path: &str| {
            compiler_label(&ResolvedExecutable {
                path: PathBuf::from(path),
                source: RuntimeSource::Portable,
            })
        };
        assert_eq!(
            label("E:/app/runtimes/fortran/versions/13.1.0/bin/gfortran.exe"),
            "OpenMind portable gfortran (w64devkit GCC from the Fortran runtime 13.1.0)"
        );
        // Its gcc builds C too: the label says it isn't the C/C++ toolchain (LLVM-MinGW).
        assert_eq!(
            label("E:/app/runtimes/fortran/shims/13.1.0/gcc.cmd"),
            "OpenMind portable gcc (w64devkit GCC from the Fortran runtime 13.1.0)"
        );
        assert_eq!(
            label("E:/app/runtimes/llvm-mingw/versions/20260922/bin/clang.exe"),
            "OpenMind portable clang (llvm-mingw 20260922)"
        );
        assert_eq!(
            label("E:/app/runtimes/pascal/shims/3.2.3/fpc64.cmd"),
            "OpenMind portable fpc64 (pascal 3.2.3)"
        );
        assert_eq!(label("E:/app/shims/tool.cmd"), "OpenMind portable tool");
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
