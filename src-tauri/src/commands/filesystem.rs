use std::path::Path;

use openmind_fs::{DirEntryInfo, PathMetadata};

#[tauri::command]
pub async fn fs_read_dir(path: String) -> Result<Vec<DirEntryInfo>, String> {
    openmind_fs::read_dir(Path::new(&path))
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn fs_metadata(path: String) -> Result<PathMetadata, String> {
    openmind_fs::path_metadata(Path::new(&path))
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn fs_is_binary(path: String) -> Result<bool, String> {
    openmind_fs::is_binary(Path::new(&path))
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn fs_create_file(
    workspace_root: String,
    parent_dir: String,
    name: String,
) -> Result<String, String> {
    let parent = validate_within_root(&workspace_root, &parent_dir)?;
    let path = openmind_fs::create_file(&parent, &name)
        .await
        .map_err(|err| err.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn fs_create_folder(
    workspace_root: String,
    parent_dir: String,
    name: String,
) -> Result<String, String> {
    let parent = validate_within_root(&workspace_root, &parent_dir)?;
    let path = openmind_fs::create_dir(&parent, &name)
        .await
        .map_err(|err| err.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn fs_rename(
    workspace_root: String,
    path: String,
    new_name: String,
) -> Result<String, String> {
    let source = validate_within_root(&workspace_root, &path)?;
    let new_path = openmind_fs::rename(&source, &new_name)
        .await
        .map_err(|err| err.to_string())?;
    Ok(new_path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn fs_delete(workspace_root: String, path: String) -> Result<(), String> {
    let target = validate_within_root(&workspace_root, &path)?;
    openmind_fs::delete(&target)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn fs_move(
    workspace_root: String,
    source: String,
    dest_dir: String,
) -> Result<String, String> {
    let source_path = validate_within_root(&workspace_root, &source)?;
    let dest_path = validate_within_root(&workspace_root, &dest_dir)?;
    let new_path = openmind_fs::move_path(&source_path, &dest_path)
        .await
        .map_err(|err| err.to_string())?;
    Ok(new_path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn fs_copy(
    workspace_root: String,
    source: String,
    dest_dir: String,
) -> Result<String, String> {
    let source_path = validate_within_root(&workspace_root, &source)?;
    let dest_path = validate_within_root(&workspace_root, &dest_dir)?;
    let new_path = openmind_fs::copy_path(&source_path, &dest_path)
        .await
        .map_err(|err| err.to_string())?;
    Ok(new_path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn fs_duplicate(
    workspace_root: String,
    path: String,
    new_name: String,
) -> Result<String, String> {
    let source_path = validate_within_root(&workspace_root, &path)?;
    let Some(parent) = source_path.parent() else {
        return Err(format!("\"{path}\" has no parent directory"));
    };
    let new_path = openmind_fs::copy_path_as(&source_path, parent, &new_name)
        .await
        .map_err(|err| err.to_string())?;
    Ok(new_path.to_string_lossy().into_owned())
}

fn validate_within_root(workspace_root: &str, target: &str) -> Result<std::path::PathBuf, String> {
    openmind_fs::ensure_within_root(Path::new(workspace_root), Path::new(target))
        .map_err(|err| err.to_string())
}
