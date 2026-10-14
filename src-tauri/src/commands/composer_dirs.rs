//! Composer's folders, apart from `database.rs` (the PHP stack's commands).

use std::path::Path;

/// Composer's home and cache. A one-profile copy keeps them where they always were (`data/composer`, `cache/composer`);
/// a copy whose machine state is per computer (a network installation, a portable drive shared by several computers)
/// uses this computer's own cache folder, because Composer rewrites both while it runs and two computers must not
/// write one folder at the same time.
pub fn composer_dirs(
    paths: &openmind_core::AppPaths,
    app_root: &Path,
) -> (std::path::PathBuf, std::path::PathBuf) {
    if paths.machine_cache_dir == paths.cache_dir {
        (
            app_root.join("data").join("composer"),
            app_root.join("cache").join("composer"),
        )
    } else {
        (
            paths.machine_cache_dir.join("composer-home"),
            paths.machine_cache_dir.join("composer"),
        )
    }
}

#[cfg(test)]
mod composer_dir_tests {
    use super::composer_dirs;
    use openmind_core::{AppPaths, MachineDataPaths};
    use std::path::Path;

    #[test]
    fn a_one_profile_copy_keeps_composers_folders_where_they_were() {
        let root = Path::new("/apps/OpenMind Studio");
        let (home, cache) = composer_dirs(&AppPaths::from_root(root.to_path_buf()), root);
        assert_eq!(home, root.join("data").join("composer"));
        assert_eq!(cache, root.join("cache").join("composer"));
    }

    #[test]
    fn a_shared_installation_gives_each_computer_its_own_composer_folders() {
        let share = Path::new("/share/OpenMind Studio");
        let pc_a = AppPaths::network(
            share.to_path_buf(),
            MachineDataPaths::local(Path::new("/pc-a/local"), "pca"),
        );
        let pc_b = AppPaths::network(
            share.to_path_buf(),
            MachineDataPaths::local(Path::new("/pc-b/local"), "pcb"),
        );
        let (a_home, a_cache) = composer_dirs(&pc_a, share);
        let (b_home, b_cache) = composer_dirs(&pc_b, share);
        assert!(a_home.starts_with("/pc-a/local") && a_cache.starts_with("/pc-a/local"));
        assert!(b_home.starts_with("/pc-b/local") && b_cache.starts_with("/pc-b/local"));
        assert!(!a_home.starts_with(share) && !a_cache.starts_with(share));
    }
}
