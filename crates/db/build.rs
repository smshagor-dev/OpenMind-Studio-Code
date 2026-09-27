//! `sqlx::migrate!` embeds `migrations/*.sql` when this crate compiles, but on stable Rust a proc macro can't
//! declare those files as inputs, so Cargo would keep a cached build with old SQL (and old checksums) after a
//! migration is added or changed. These lines make Cargo rebuild the crate when that happens.

include!("migration_inputs.rs");

fn main() {
    let crate_dir =
        std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap_or_default());
    for line in rerun_if_changed_lines(&crate_dir) {
        println!("{line}");
    }
}
