import type { RecentFileInfo } from "../services/ipc";

interface WelcomePaneProps {
  recentFiles: RecentFileInfo[];
  onNewFile: () => void;
  onOpenFile: () => void;
  onOpenRecent: (path: string) => void;
}

export function WelcomePane({
  recentFiles,
  onNewFile,
  onOpenFile,
  onOpenRecent,
}: WelcomePaneProps) {
  return (
    <div className="welcome-pane">
      <h1 className="welcome-pane__title">OpenMind Studio</h1>
      <div className="welcome-pane__actions">
        <button type="button" onClick={onNewFile}>
          New File
        </button>
        <button type="button" onClick={onOpenFile}>
          Open File...
        </button>
      </div>
      {recentFiles.length > 0 && (
        <div className="welcome-pane__recent">
          <h2>Recent</h2>
          <ul>
            {recentFiles.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  className="welcome-pane__recent-item"
                  onClick={() => {
                    onOpenRecent(file.path);
                  }}
                >
                  {file.path}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
