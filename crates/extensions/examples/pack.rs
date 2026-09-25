//! Packs an extension folder into a `.vsix`: `cargo run -p openmind-extensions --example pack -- <folder> <out.vsix>`.
//! Used to build the sample extensions for tests and manual checks.

use std::path::Path;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [folder, out] = args.as_slice() else {
        eprintln!("usage: pack <extension folder> <out.vsix>");
        return ExitCode::from(2);
    };
    match openmind_extensions::vsix::pack(Path::new(folder), Path::new(out)) {
        Ok(()) => {
            println!("Packed {out}");
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("{err}");
            ExitCode::FAILURE
        }
    }
}
