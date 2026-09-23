import type { RecentFileInfo, WorkspaceInfo } from "../services/ipc";

interface StartPageProps {
  recentFiles: RecentFileInfo[];
  recentFolders: WorkspaceInfo[];
  onNewFile: () => void;
  onOpenFile: () => void;
  onOpenFolder: () => void;
  onOpenRecentFile: (path: string) => void;
  onOpenRecentFolder: (path: string) => void;
}

/** Shown when no folder is open and no file is open — a VS Code-style welcome/start page. */
export function StartPage({
  recentFiles,
  recentFolders,
  onNewFile,
  onOpenFile,
  onOpenFolder,
  onOpenRecentFile,
  onOpenRecentFolder,
}: StartPageProps) {
  return (
    <div className="start-page">
      <h1 className="start-page__title">OpenMind Studio</h1>
      <p className="start-page__subtitle">Portable AI-ready development environment</p>

      <div className="start-page__actions">
        <button type="button" onClick={onOpenFolder}>
          Open Folder
        </button>
        <button type="button" onClick={onOpenFile}>
          Open File...
        </button>
        <button type="button" onClick={onNewFile}>
          New File
        </button>
      </div>

      <div className="start-page__recents">
        {recentFolders.length > 0 && (
          <div className="start-page__recent-group">
            <h2>Recent Folders</h2>
            <ul>
              {recentFolders.map((folder) => (
                <li key={folder.path}>
                  <button
                    type="button"
                    className="start-page__recent-item"
                    onClick={() => {
                      onOpenRecentFolder(folder.path);
                    }}
                  >
                    <span className="start-page__recent-name">{folder.name}</span>
                    <span className="start-page__recent-path">{folder.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {recentFiles.length > 0 && (
          <div className="start-page__recent-group">
            <h2>Recent Files</h2>
            <ul>
              {recentFiles.map((file) => (
                <li key={file.path}>
                  <button
                    type="button"
                    className="start-page__recent-item"
                    onClick={() => {
                      onOpenRecentFile(file.path);
                    }}
                  >
                    <span className="start-page__recent-path">{file.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
