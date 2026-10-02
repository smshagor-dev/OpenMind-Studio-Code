//! The other Fortran sources Run Code compiles with the active file. A Fortran program usually keeps its modules
//! and external procedures in files next to it (`main.f90` + `mathx.f90`); compiled on its own, `use mathx` fails
//! ("Cannot open module file") and a `call` to a procedure of another file fails to link. So the files in the
//! same folder that hold no main program are compiled too, modules before the files that `use` them.
//!
//! Only that one folder is read (no sub-folders, no links followed), small files only, and only to look for
//! `program`, `module`, `use`, `subroutine` and `function` statements: nothing is run or written.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// Extensions Run Code treats as Fortran (see `kind::detect`).
pub const EXTENSIONS: &[&str] = &["f", "for", "f90", "f95", "f03", "f08"];

/// A folder with more Fortran files than this is not scanned (Run Code builds the active file alone).
const MAX_FILES: usize = 200;
/// Larger files are skipped: source files of a program this size are not something Run Code builds.
const MAX_BYTES: u64 = 2 * 1024 * 1024;

/// Modules every compiler provides: never looked for in a file.
const INTRINSIC_MODULES: &[&str] = &[
    "iso_fortran_env",
    "iso_c_binding",
    "ieee_arithmetic",
    "ieee_exceptions",
    "ieee_features",
    "omp_lib",
    "omp_lib_kinds",
    "openacc",
];

/// What one source file declares.
#[derive(Debug, Default, PartialEq, Eq)]
struct Outline {
    program: bool,
    modules: BTreeSet<String>,
    uses: BTreeSet<String>,
    procedures: bool,
    /// The first statement starts a module, submodule, procedure or block data (not a main program).
    library_first: bool,
}

fn is_fixed_form(path: &Path) -> bool {
    matches!(extension(path).as_deref(), Some("f" | "for"))
}

fn extension(path: &Path) -> Option<String> {
    path.extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
}

pub fn is_fortran(path: &Path) -> bool {
    extension(path).is_some_and(|ext| EXTENSIONS.contains(&ext.as_str()))
}

/// The statement text of a line, lowercased, without its comment: `!` anywhere outside a string, and in fixed
/// form a `C`, `c` or `*` in the first column.
fn statement(line: &str, fixed: bool) -> String {
    if fixed && line.starts_with(['c', 'C', '*']) {
        return String::new();
    }
    let mut quote = None;
    let mut text = String::new();
    for c in line.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None if c == '\'' || c == '"' => quote = Some(c),
            None if c == '!' => break,
            None => {}
        }
        text.push(c);
    }
    text.trim().to_ascii_lowercase()
}

fn name_at(text: &str) -> Option<String> {
    let name: String = text
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    name.chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic())
        .then_some(name)
}

/// `use mathx`, `use :: mathx`, `use, non_intrinsic :: mathx, only: f` -> `mathx`; `use, intrinsic :: ...` -> none.
fn used_module(rest: &str) -> Option<String> {
    let rest = rest.trim_start();
    let rest = if let Some(after) = rest.strip_prefix(',') {
        let (nature, tail) = after.split_once("::")?;
        if nature.trim() == "intrinsic" {
            return None;
        }
        tail
    } else {
        rest.strip_prefix("::").unwrap_or(rest)
    };
    name_at(rest).filter(|name| !INTRINSIC_MODULES.contains(&name.as_str()))
}

/// Words that may come before `subroutine`/`function` in a procedure's first line.
fn is_procedure_start(text: &str) -> bool {
    // `integer(kind=8) function f` / `character*10 function g`: what is in parentheses never decides.
    let mut depth = 0usize;
    let flat: String = text
        .chars()
        .map(|c| match c {
            '(' => {
                depth += 1;
                ' '
            }
            ')' => {
                depth = depth.saturating_sub(1);
                ' '
            }
            _ if depth > 0 => ' ',
            _ => c,
        })
        .collect();
    for word in flat
        .split(|c: char| c.is_whitespace() || matches!(c, ',' | '*' | ':'))
        .filter(|word| !word.is_empty())
    {
        match word {
            "subroutine" | "function" => return true,
            "pure" | "impure" | "elemental" | "recursive" | "module" | "integer" | "real"
            | "logical" | "character" | "complex" | "double" | "precision" | "type" | "class" => {}
            _ if word.chars().all(|c| c.is_ascii_digit()) => {}
            _ => return false,
        }
    }
    false
}

fn outline(text: &str, fixed: bool) -> Outline {
    let mut found = Outline::default();
    let mut first = true;
    for line in text.lines() {
        let line = statement(line, fixed);
        if first && !line.is_empty() {
            first = false;
            found.library_first = line.starts_with("module ")
                || line.starts_with("submodule")
                || line.starts_with("block data")
                || line.starts_with("blockdata")
                || is_procedure_start(&line);
        }
        let mut words = line.splitn(2, char::is_whitespace);
        let first = words.next().unwrap_or_default();
        let rest = words.next().unwrap_or_default();
        match first {
            "program" => found.program = true,
            "module" => match name_at(rest) {
                Some(name) if !matches!(name.as_str(), "procedure" | "function" | "subroutine") => {
                    found.modules.insert(name);
                }
                _ => {}
            },
            _ if first == "use" || first.starts_with("use,") || first.starts_with("use::") => {
                if let Some(name) = used_module(line.get(3..).unwrap_or_default()) {
                    found.uses.insert(name);
                }
            }
            "end" => {}
            _ if is_procedure_start(&line) => found.procedures = true,
            _ => {}
        }
    }
    found.uses.retain(|name| !found.modules.contains(name));
    found
}

fn read_outline(path: &Path) -> Option<Outline> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    Some(outline(
        &String::from_utf8_lossy(&bytes),
        is_fixed_form(path),
    ))
}

/// The Fortran files next to `file` that hold no main program but define a module or procedure, ordered so that
/// a module's file comes before every file that uses it (otherwise by name). `file` itself is not included.
pub fn companion_sources(file: &Path) -> Vec<PathBuf> {
    let Some(dir) = file.parent() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut candidates: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| is_fortran(path) && !same_file(path, file))
        .take(MAX_FILES + 1)
        .collect();
    if candidates.len() > MAX_FILES {
        return Vec::new();
    }
    candidates.sort();
    let library: BTreeMap<PathBuf, Outline> = candidates
        .into_iter()
        .filter_map(|path| read_outline(&path).map(|outline| (path, outline)))
        .filter(|(_, outline)| !outline.program && outline.library_first)
        .collect();
    order(library)
}

/// Whether `file` holds no main program, only modules or procedures (a library file that other files use): it
/// compiles but has nothing to run.
pub fn is_library_file(file: &Path) -> bool {
    read_outline(file).is_some_and(|outline| !outline.program && outline.library_first)
}

fn same_file(a: &Path, b: &Path) -> bool {
    a.file_name().zip(b.file_name()).is_some_and(|(x, y)| {
        x.to_string_lossy()
            .eq_ignore_ascii_case(&y.to_string_lossy())
    })
}

/// Dependencies first; a cycle or a module nobody defines leaves the remaining files in name order.
fn order(mut library: BTreeMap<PathBuf, Outline>) -> Vec<PathBuf> {
    let mut defined_by: BTreeMap<String, PathBuf> = BTreeMap::new();
    for (path, outline) in &library {
        for module in &outline.modules {
            defined_by
                .entry(module.clone())
                .or_insert_with(|| path.clone());
        }
    }
    let mut ordered = Vec::new();
    while !library.is_empty() {
        let ready = library
            .iter()
            .find(|(_, outline)| {
                outline.uses.iter().all(|module| {
                    defined_by
                        .get(module)
                        .is_none_or(|owner| !library.contains_key(owner))
                })
            })
            .map(|(path, _)| path.clone())
            .or_else(|| library.keys().next().cloned());
        let Some(next) = ready else { break };
        library.remove(&next);
        ordered.push(next);
    }
    ordered
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn statements_lose_comments_but_not_strings() {
        assert_eq!(statement("  USE MathX ! the maths", false), "use mathx");
        assert_eq!(statement("print *, 'a!b' ! c", false), "print *, 'a!b'");
        assert_eq!(statement("C     PROGRAM OLD", true), "");
        assert_eq!(statement("      PROGRAM OLD", true), "program old");
    }

    #[test]
    fn outlines_find_programs_modules_uses_and_procedures() {
        let text = "module geometry\n  use, intrinsic :: iso_fortran_env\n  use shapes, only: circle\n  use :: units\n  \
                    use, non_intrinsic :: helpers\n  use geometry_extra\ncontains\n  pure real function area(r)\n  end function\n  \
                    module procedure p\nend module geometry\n";
        let found = outline(text, false);
        assert!(!found.program);
        assert_eq!(found.modules, BTreeSet::from(["geometry".to_string()]));
        assert_eq!(
            found.uses,
            BTreeSet::from(["geometry_extra", "helpers", "shapes", "units"].map(String::from))
        );
        assert!(found.procedures);

        let main = outline(
            "program main\n  use geometry\n  call run()\nend program main\n",
            false,
        );
        assert!(main.program);
        let external = outline("      SUBROUTINE GREET(N)\n      END\n", true);
        assert!(external.procedures && !external.program);
        assert!(outline("integer(kind=8) function big(n)\nend function\n", false).procedures);
        assert!(outline("character*10 function label()\nend function\n", false).procedures);
        assert!(!outline("call run()\nprint *, f(1)\n", false).procedures);
        assert!(!outline("x = 1\nend\n", false).procedures);
    }

    #[test]
    fn companions_are_the_library_files_next_to_the_program_in_dependency_order() {
        let temp = tempfile::tempdir().expect("tempdir");
        let dir = temp.path().join("my project");
        fs::create_dir_all(dir.join("sub")).expect("dir");
        let write = |name: &str, text: &str| fs::write(dir.join(name), text).expect("write");
        write(
            "main.f90",
            "program main\n  use b_top\n  call ext()\nend program\n",
        );
        // `b_top` (in a_top.f90) uses `z_base`, whose file sorts after it: the dependency must still come first.
        write("a_top.f90", "module b_top\n  use z_base\nend module\n");
        write("z_base.f90", "module z_base\nend module\n");
        write("ext.f", "      SUBROUTINE EXT()\n      END\n");
        write("other_program.f90", "program other\nend program\n");
        // A FORTRAN 77 main program has no PROGRAM statement; the subroutine after it doesn't make it a library.
        write(
            "legacy.f",
            "      PRINT *, 'OLD'\n      CALL HELP()\n      END\n      SUBROUTINE HELP()\n      END\n",
        );
        write("notes.txt", "module not_fortran\n");
        write("sub/deep.f90", "module deep\nend module\n");
        let names: Vec<String> = companion_sources(&dir.join("main.f90"))
            .iter()
            .map(|path| {
                path.file_name()
                    .expect("name")
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert_eq!(names, ["ext.f", "z_base.f90", "a_top.f90"]);
    }

    #[test]
    fn library_files_are_told_apart_from_main_programs() {
        let temp = tempfile::tempdir().expect("tempdir");
        let check = |name: &str, text: &str| {
            let file = temp.path().join(name);
            fs::write(&file, text).expect("write");
            is_library_file(&file)
        };
        assert!(check(
            "shapes.f90",
            "! shapes\nmodule shapes\ncontains\nend module\n"
        ));
        assert!(check(
            "ext.f",
            "C     helper\n      SUBROUTINE EXT()\n      END\n"
        ));
        assert!(check("f.f90", "pure integer function f(n)\nend function\n"));
        assert!(!check("main.f90", "program main\nend program\n"));
        // A FORTRAN 77 main program needs no PROGRAM statement, even with subroutines after it.
        assert!(!check(
            "old.f",
            "      PRINT *, 'HI'\n      CALL S()\n      END\n      SUBROUTINE S()\n      END\n"
        ));
        assert!(!check(
            "module_main.f90",
            "module m\nend module\nprogram p\nuse m\nend program\n"
        ));
    }

    #[test]
    fn a_lone_file_and_a_module_cycle_still_give_an_answer() {
        let temp = tempfile::tempdir().expect("tempdir");
        let main = temp.path().join("hello.f90");
        fs::write(&main, "program hello\nend program\n").expect("write");
        assert!(companion_sources(&main).is_empty());

        fs::write(temp.path().join("a.f90"), "module a\n use b\nend module\n").expect("write");
        fs::write(temp.path().join("b.f90"), "module b\n use a\nend module\n").expect("write");
        assert_eq!(companion_sources(&main).len(), 2);
    }
}
