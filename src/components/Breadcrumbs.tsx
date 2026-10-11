import { container } from "../services/container";
import { pathSegments } from "../services/explorerTree";
import { FileTypeIcon } from "./fileIcons";
import { ChevronRightSmallIcon } from "./icons";
import { isRemotePath, remoteDisplaySegments, remoteOrigin } from "./remoteTabPath";
import { t } from "../i18n";

interface BreadcrumbsProps {
  path: string | null;
  title: string;
  rootPath: string | null;
  /** The tab's document (a remote collaboration document is shown by its shared folder and path, not its address). */
  docId?: string;
}

/**
 * The path bar under the tabs. Folder segments inside the workspace reveal
 * that folder in the explorer when clicked (VS Code opens a picker there —
 * revealing is the part of that behavior this app supports today).
 */
export function Breadcrumbs({ path, title, rootPath, docId }: BreadcrumbsProps) {
  const remote = isRemotePath(path);
  const segments = remote
    ? (remoteDisplaySegments(docId ? remoteOrigin(docId) : undefined) ?? [title]).map((name) => ({
        name,
        path: "",
      }))
    : path
      ? pathSegments(path, rootPath)
      : [{ name: title, path: "" }];
  const insideWorkspace = (segmentPath: string) =>
    rootPath !== null && segmentPath.length > rootPath.length && segmentPath.startsWith(rootPath);

  return (
    <nav className="breadcrumbs" aria-label={t("editor.breadcrumbs")}>
      {segments.map((segment, index) => {
        const last = index === segments.length - 1;
        return (
          <span key={`${segment.path}-${index}`} className="breadcrumbs__item">
            {index > 0 ? (
              <span className="breadcrumbs__separator">
                <ChevronRightSmallIcon />
              </span>
            ) : null}
            {last ? <FileTypeIcon name={segment.name} /> : null}
            <button
              type="button"
              className="breadcrumbs__label"
              disabled={!insideWorkspace(segment.path)}
              onClick={() => {
                container.run("view.showExplorer");
                void container.explorer.revealPath(segment.path);
              }}
            >
              {segment.name}
            </button>
          </span>
        );
      })}
    </nav>
  );
}
