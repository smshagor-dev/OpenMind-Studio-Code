//! The filesystem authority (Layer 3): before anything touches the Owner's workspace for a remote request, the
//! request is authorized and its target resolved here.
//!
//! For an existing entry the peer names only a [`FileId`]; the path comes from the Owner's [`FileTable`]. A new
//! name (create, rename target) arrives as a [`RelPath`], already validated by its type. Then, in order: the
//! session and permission ([`Authority::authorize`]), the entry exists, the path is shareable ([`privacy`] — a
//! sensitive file is answered exactly like an unknown one, so its existence isn't revealed), and the path resolves
//! inside the workspace without crossing a link or junction ([`WorkspaceRoot::resolve`]). The caller then performs
//! the change through the app's own file operations, which check containment once more.

use std::path::{Path, PathBuf};

use crate::authority::{Actor, Authority};
use crate::authz::Action;
use crate::error::CollabError;
use crate::files::{FileEntry, FileId, FileKind, FileTable, RelPath};
use crate::privacy;
use crate::workspace::WorkspaceRoot;

/// What a remote peer asks to do with the workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileRequest {
    Read(FileId),
    Write(FileId),
    Create { path: RelPath, kind: FileKind },
    Rename { file: FileId, to: RelPath },
    Delete(FileId),
}

/// An authorized request's targets: the entry's relative path and absolute path, and for a rename the new ones.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Authorized {
    pub file: Option<FileId>,
    pub path: RelPath,
    pub absolute: PathBuf,
    pub destination: Option<(RelPath, PathBuf)>,
}

/// The Owner's shared workspace: its folder and its id <-> path map.
#[derive(Debug, Clone)]
pub struct SharedWorkspace {
    root: WorkspaceRoot,
    files: FileTable,
}

impl SharedWorkspace {
    pub fn new(root: &Path, files: FileTable) -> Result<Self, CollabError> {
        Ok(Self {
            root: WorkspaceRoot::new(root)?,
            files,
        })
    }

    pub fn files(&self) -> &FileTable {
        &self.files
    }

    pub fn files_mut(&mut self) -> &mut FileTable {
        &mut self.files
    }

    pub fn root(&self) -> &WorkspaceRoot {
        &self.root
    }

    /// Authorizes `request` by `actor` and resolves its targets.
    pub fn authorize(
        &self,
        authority: &Authority,
        actor: &Actor,
        request: &FileRequest,
    ) -> Result<Authorized, CollabError> {
        let action = match request {
            FileRequest::Read(_) => Action::ReadFile,
            FileRequest::Write(_) => Action::WriteFile,
            FileRequest::Create { .. } => Action::CreateFile,
            FileRequest::Rename { .. } => Action::RenameFile,
            FileRequest::Delete(_) => Action::DeleteFile,
        };
        authority.authorize(actor, &action)?;
        match request {
            FileRequest::Read(id) | FileRequest::Write(id) | FileRequest::Delete(id) => {
                let entry = self.shared_entry(id)?;
                if matches!(request, FileRequest::Write(_)) && entry.kind != FileKind::File {
                    return Err(CollabError::UnsafePath(
                        "a folder has no content to write".into(),
                    ));
                }
                self.resolved(Some(id.clone()), entry.path.clone(), None)
            }
            FileRequest::Create { path, .. } => {
                self.check_new_name(path)?;
                self.resolved(None, path.clone(), None)
            }
            FileRequest::Rename { file, to } => {
                let entry = self.shared_entry(file)?;
                self.check_new_name(to)?;
                let destination = (to.clone(), self.root.resolve(to)?);
                self.resolved(Some(file.clone()), entry.path.clone(), Some(destination))
            }
        }
    }

    fn shared_entry(&self, id: &FileId) -> Result<&FileEntry, CollabError> {
        let entry = self.files.get(id).ok_or(CollabError::UnknownFile)?;
        if !privacy::is_shareable(&entry.path) {
            return Err(CollabError::UnknownFile);
        }
        Ok(entry)
    }

    /// A name a peer wants to create or rename to: shareable and not taken.
    fn check_new_name(&self, path: &RelPath) -> Result<(), CollabError> {
        if !privacy::is_shareable(path) {
            return Err(CollabError::UnsafePath(
                "that name is reserved for files that are never shared".into(),
            ));
        }
        if self.files.id_of(path).is_some() {
            return Err(CollabError::UnsafePath(format!(
                "\"{path}\" already exists"
            )));
        }
        Ok(())
    }

    fn resolved(
        &self,
        file: Option<FileId>,
        path: RelPath,
        destination: Option<(RelPath, PathBuf)>,
    ) -> Result<Authorized, CollabError> {
        let absolute = self.root.resolve(&path)?;
        Ok(Authorized {
            file,
            path,
            absolute,
            destination,
        })
    }
}

#[cfg(test)]
#[path = "fsauth_tests.rs"]
mod tests;
