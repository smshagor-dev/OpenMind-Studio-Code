use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Created,
    Modified,
    Removed,
    /// `from` was renamed or moved to `path`.
    Renamed,
}

/// One change to one path (absolute, in the operating system's own style).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub kind: ChangeKind,
    pub from: Option<String>,
}

/// Everything that happened in one quiet period. A huge burst (a checkout of
/// thousands of files) is reported as `overflow` with no list: the caller
/// re-checks what it cares about instead of handling every path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeBatch {
    pub changes: Vec<FileChange>,
    pub overflow: bool,
}
