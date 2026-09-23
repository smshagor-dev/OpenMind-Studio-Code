use std::path::{Path, PathBuf};

use crate::error::CoreError;

/// Portable filesystem layout for the application: every path is resolved
/// relative to the directory containing the running executable, never a
/// per-user OS directory (`%APPDATA%`, `~/.config`, ...). This is what lets
/// Openmind Studio run entirely from its own folder without admin rights.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppPaths {
    pub exe_dir: PathBuf,
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
}

impl AppPaths {
    /// Resolve paths from the real running executable's location.
    pub fn resolve() -> Result<Self, CoreError> {
        let exe_path = std::env::current_exe().map_err(CoreError::ResolveExePath)?;
        Ok(Self::from_exe_path(&exe_path))
    }

    /// Pure, unit-testable variant of [`Self::resolve`] taking the exe path
    /// as input instead of reading it from the environment.
    pub fn from_exe_path(exe_path: &Path) -> Self {
        let exe_dir = match exe_path.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
            _ => PathBuf::from("."),
        };
        let data_dir = exe_dir.join("data");
        let db_path = data_dir.join("openmind-studio.db");

        Self {
            exe_dir,
            data_dir,
            db_path,
        }
    }

    /// Create the data directory if it doesn't exist yet.
    pub fn ensure_data_dir(&self) -> Result<(), CoreError> {
        std::fs::create_dir_all(&self.data_dir).map_err(|source| CoreError::CreateDataDir {
            path: self.data_dir.clone(),
            source,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_data_dir_next_to_exe() {
        let exe_path = Path::new("C:/Apps/Openmind Studio/openmind-studio.exe");

        let paths = AppPaths::from_exe_path(exe_path);

        assert_eq!(paths.exe_dir, Path::new("C:/Apps/Openmind Studio"));
        assert_eq!(paths.data_dir, Path::new("C:/Apps/Openmind Studio/data"));
        assert_eq!(
            paths.db_path,
            Path::new("C:/Apps/Openmind Studio/data/openmind-studio.db")
        );
    }

    #[test]
    fn falls_back_to_current_dir_when_exe_has_no_parent() {
        let exe_path = Path::new("openmind-studio.exe");

        let paths = AppPaths::from_exe_path(exe_path);

        assert_eq!(paths.exe_dir, Path::new("."));
        assert_eq!(paths.data_dir, Path::new("./data"));
    }
}
