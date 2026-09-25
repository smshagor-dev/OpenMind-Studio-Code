use std::io::Write;

/// Writes a ZIP file with the given parts into a temp dir and returns its path (test helper).
pub fn zip_with(dir: &tempfile::TempDir, name: &str, parts: &[(&str, &str)]) -> String {
    let path = dir.path().join(name);
    let file = std::fs::File::create(&path).expect("create");
    let mut writer = zip::ZipWriter::new(file);
    for (part, content) in parts {
        writer
            .start_file(*part, zip::write::SimpleFileOptions::default())
            .expect("start");
        writer.write_all(content.as_bytes()).expect("write");
    }
    writer.finish().expect("finish");
    path.to_string_lossy().into_owned()
}
