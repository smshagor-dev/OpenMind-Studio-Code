import type { PinnedFolderEntry, RecentFileInfo, WorkspaceInfo } from "../services/ipc";
import { NewFileIcon, NewFolderIcon, PinIcon } from "./icons";

interface StartPageProps {
  recentFiles: RecentFileInfo[];
  recentFolders: WorkspaceInfo[];
  pinnedFolders: PinnedFolderEntry[];
  onNewFile: () => void;
  onOpenFile: () => void;
  onOpenFolder: () => void;
  onOpenRecentFile: (path: string) => void;
  onOpenRecentFolder: (path: string) => void;
  onUnpinFolder: (path: string) => void;
}

const RECENT_LIMIT = 8;

function parentDir(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index > 0 ? path.slice(0, index) : path;
}

function baseName(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index >= 0 ? path.slice(index + 1) : path;
}

/** Shown when no editor is open — laid out like VS Code's Welcome page (Start + Recent). */
export function StartPage(props: StartPageProps) {
  const { recentFiles, recentFolders, pinnedFolders, onOpenRecentFile, onOpenRecentFolder } = props;
  return (
    <div className="welcome">
      <div className="welcome__inner">
        <header className="welcome__header">
          <h1 className="welcome__title">OpenMind Studio</h1>
          <p className="welcome__subtitle">Portable AI-ready development environment</p>
        </header>
        <div className="welcome__columns">
          <div className="welcome__column">
            <section className="welcome__section">
              <h2>Start</h2>
              <ul className="welcome__list">
                <li>
                  <button type="button" className="welcome__link" onClick={props.onNewFile}>
                    <NewFileIcon /> New File...
                  </button>
                </li>
                <li>
                  <button type="button" className="welcome__link" onClick={props.onOpenFile}>
                    <NewFileIcon /> Open File...
                  </button>
                </li>
                <li>
                  <button type="button" className="welcome__link" onClick={props.onOpenFolder}>
                    <NewFolderIcon /> Open Folder...
                  </button>
                </li>
              </ul>
            </section>
            {pinnedFolders.length > 0 ? (
              <section className="welcome__section">
                <h2>Pinned</h2>
                <ul className="welcome__list">
                  {pinnedFolders.map((folder) => (
                    <li key={`pinned:${folder.path}`} className="welcome__recent">
                      <button
                        type="button"
                        className="welcome__link"
                        title={folder.path}
                        onClick={() => {
                          onOpenRecentFolder(folder.path);
                        }}
                      >
                        {folder.label ?? baseName(folder.path)}
                      </button>
                      <span className="welcome__recent-path">{parentDir(folder.path)}</span>
                      <button
                        type="button"
                        className="welcome__unpin"
                        title="Unpin Folder"
                        aria-label="Unpin Folder"
                        onClick={() => {
                          props.onUnpinFolder(folder.path);
                        }}
                      >
                        <PinIcon filled size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {recentFolders.length > 0 || recentFiles.length > 0 ? (
              <section className="welcome__section">
                <h2>Recent</h2>
                <ul className="welcome__list">
                  {recentFolders.slice(0, RECENT_LIMIT).map((folder) => (
                    <RecentRow
                      key={`folder:${folder.path}`}
                      name={folder.name}
                      detail={parentDir(folder.path)}
                      title={folder.path}
                      onOpen={() => {
                        onOpenRecentFolder(folder.path);
                      }}
                    />
                  ))}
                  {recentFiles.slice(0, RECENT_LIMIT).map((file) => (
                    <RecentRow
                      key={`file:${file.path}`}
                      name={baseName(file.path)}
                      detail={parentDir(file.path)}
                      title={file.path}
                      onOpen={() => {
                        onOpenRecentFile(file.path);
                      }}
                    />
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function RecentRow(props: { name: string; detail: string; title: string; onOpen: () => void }) {
  return (
    <li className="welcome__recent">
      <button type="button" className="welcome__link" title={props.title} onClick={props.onOpen}>
        {props.name}
      </button>
      <span className="welcome__recent-path">{props.detail}</span>
    </li>
  );
}
