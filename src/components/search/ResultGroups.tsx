import { MATCHES_PER_FILE, RESULT_PAGE } from "../../services/searchService";
import type { SearchFileMatches, SearchLineMatch } from "../../services/ipc";
import { FileTypeIcon } from "../fileIcons";
import { ChevronIcon } from "../icons";

/** How a list of grouped results is folded, paged and opened (the text search keeps it in its service). */
export interface ResultGroupsController {
  collapsed: readonly string[];
  visibleFiles: number;
  expandedFiles: readonly string[];
  toggle: (relativePath: string) => void;
  showMore: () => void;
  expand: (relativePath: string) => void;
  open: (file: SearchFileMatches, match: SearchLineMatch) => void;
}

function directoryOf(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/");
  return slash === -1 ? "" : relativePath.slice(0, slash);
}

/**
 * Results grouped by file, drawn a page at a time (a huge result set never freezes the panel): the first files, a
 * "Show more files" button for the rest, and a file's own matches cut at 100 with "Show all". Click a match to open it.
 */
export function ResultGroups({
  files,
  controller,
  label,
}: {
  files: SearchFileMatches[];
  controller: ResultGroupsController;
  label: string;
}) {
  if (files.length === 0) return null;
  const shown = files.slice(0, controller.visibleFiles);
  const hidden = files.length - shown.length;
  return (
    <>
      <ul className="search-results" aria-label={label}>
        {shown.map((file) => (
          <FileResult
            key={file.path}
            file={file}
            collapsed={controller.collapsed.includes(file.relativePath)}
            expanded={controller.expandedFiles.includes(file.relativePath)}
            controller={controller}
          />
        ))}
      </ul>
      {hidden > 0 ? (
        <button type="button" className="search-more" onClick={controller.showMore}>
          {`Show ${String(Math.min(hidden, RESULT_PAGE))} more file${Math.min(hidden, RESULT_PAGE) === 1 ? "" : "s"} (${String(hidden)} not shown)`}
        </button>
      ) : null}
    </>
  );
}

function FileResult({
  file,
  collapsed,
  expanded,
  controller,
}: {
  file: SearchFileMatches;
  collapsed: boolean;
  expanded: boolean;
  controller: ResultGroupsController;
}) {
  const name = file.relativePath.slice(file.relativePath.lastIndexOf("/") + 1);
  const matches = expanded ? file.matches : file.matches.slice(0, MATCHES_PER_FILE);
  const more = file.matches.length - matches.length;
  return (
    <li className="search-file">
      <button
        type="button"
        className="search-file__header"
        aria-expanded={!collapsed}
        title={file.path}
        onClick={() => {
          controller.toggle(file.relativePath);
        }}
      >
        <ChevronIcon expanded={!collapsed} />
        <FileTypeIcon name={name} />
        <span className="search-file__name">{name}</span>
        <span className="search-file__dir">{directoryOf(file.relativePath)}</span>
        <span className="search-file__count">{file.matches.length}</span>
      </button>
      {collapsed ? null : (
        <ul>
          {matches.map((match, index) => (
            <li key={`${String(match.line)}:${String(match.column)}:${String(index)}`}>
              <MatchRow file={file} match={match} controller={controller} />
            </li>
          ))}
          {more > 0 ? (
            <li>
              <button
                type="button"
                className="search-more search-more--inline"
                onClick={() => {
                  controller.expand(file.relativePath);
                }}
              >
                {`Show all ${String(file.matches.length)} matches in this file`}
              </button>
            </li>
          ) : null}
        </ul>
      )}
    </li>
  );
}

function MatchRow({
  file,
  match,
  controller,
}: {
  file: SearchFileMatches;
  match: SearchLineMatch;
  controller: ResultGroupsController;
}) {
  // Highlight offsets are UTF-16 units, exactly what string slicing uses.
  const before = match.preview.slice(0, match.previewStart);
  const hit = match.preview.slice(match.previewStart, match.previewEnd);
  const after = match.preview.slice(match.previewEnd);
  return (
    <button
      type="button"
      className="search-match"
      title={`Line ${String(match.line)}, column ${String(match.column)}`}
      onClick={() => {
        controller.open(file, match);
      }}
    >
      <span className="search-match__text">
        {before}
        <mark>{hit}</mark>
        {after}
      </span>
    </button>
  );
}
