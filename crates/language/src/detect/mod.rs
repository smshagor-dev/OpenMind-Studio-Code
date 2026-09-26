//! The detectors: each looks at one folder and says what it saw. They only read names and small files.

mod backend;
mod native;
mod web;

use crate::project::{Detection, Dir};

/// Everything the folder looks like, most specific first within each detector.
pub fn detect_dir(dir: &Dir) -> Vec<Detection> {
    let mut all = Vec::new();
    all.extend(web::detect(dir));
    all.extend(backend::detect(dir));
    all.extend(native::detect(dir));
    all
}
