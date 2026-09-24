import { container } from "../services/container";
import type { GitFileChange } from "../services/ipc";
import { badgeFor } from "../services/sourceControlService";

export type GitGroupKind = "staged" | "changes" | "untracked";

const HEADINGS: Record<GitGroupKind, string> = {
  staged: "Staged Changes",
  changes: "Changes",
  untracked: "Untracked Changes",
};

function splitPath(path: string): { name: string; folder: string } {
  const slash = path.lastIndexOf("/");
  return slash < 0
    ? { name: path, folder: "" }
    : { name: path.slice(slash + 1), folder: path.slice(0, slash) };
}

function RowButton(props: {
  label: string;
  text: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="git-row__action"
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={(event) => {
        event.stopPropagation();
        props.onClick();
      }}
    >
      {props.text}
    </button>
  );
}

function FileRow({ change, group }: { change: GitFileChange; group: GitGroupKind }) {
  const sc = container.sourceControl;
  const badge = badgeFor(change, group === "staged");
  const { name, folder } = splitPath(change.path);
  const busy = !sc.fileActionState().enabled;
  const viewDiff = () => {
    void sc.openDiff(change, group === "staged");
  };
  const oldName = change.origPath !== null && group === "staged" ? ` ← ${change.origPath}` : "";
  return (
    <li className="git-row" data-group={group}>
      <button
        type="button"
        className="git-row__main"
        title={`${change.path}${oldName} — ${badge.title}`}
        onClick={group === "untracked" ? () => void sc.openChangedFile(change.path) : viewDiff}
      >
        <span className="git-row__name">{name}</span>
        {folder !== "" ? <span className="git-row__folder">{folder}</span> : null}
        {oldName !== "" ? <span className="git-row__folder">{oldName}</span> : null}
      </button>
      <span className="git-row__actions">
        {group !== "staged" && change.worktree !== "deleted" ? (
          <RowButton
            label={`Open File ${change.path}`}
            text="Open"
            onClick={() => void sc.openChangedFile(change.path)}
          />
        ) : null}
        {group !== "untracked" ? (
          <RowButton
            label={`${group === "staged" ? "Open Staged Diff" : "Open Diff"} ${change.path}`}
            text="Diff"
            onClick={viewDiff}
          />
        ) : null}
        {group === "staged" ? (
          <RowButton
            label={`Unstage ${change.path}`}
            text="−"
            disabled={busy}
            onClick={() =>
              void sc.unstage([change.path, ...(change.origPath ? [change.origPath] : [])])
            }
          />
        ) : (
          <RowButton
            label={`Stage ${change.path}`}
            text="+"
            disabled={busy}
            onClick={() => void sc.stage([change.path])}
          />
        )}
        {group === "changes" && !change.conflicted ? (
          <RowButton
            label={`Discard Changes ${change.path}`}
            text="↩"
            disabled={busy}
            onClick={() => {
              sc.requestDiscard([change.path]);
            }}
          />
        ) : null}
        {group === "untracked" ? (
          <RowButton
            label={`Delete ${change.path}`}
            text="🗑"
            disabled={busy}
            onClick={() => {
              sc.requestDeleteUntracked(change.path);
            }}
          />
        ) : null}
      </span>
      <span className="git-row__badge" title={badge.title} data-kind={badge.title}>
        {badge.letter}
      </span>
    </li>
  );
}

/** One group of the Source Control view (Staged Changes / Changes / Untracked Changes). UI only. */
export function GitFileList({ group, files }: { group: GitGroupKind; files: GitFileChange[] }) {
  if (files.length === 0) return null;
  return (
    <section className="git-group" aria-label={HEADINGS[group]}>
      <h4 className="git-group__heading">
        {HEADINGS[group]} <span className="git-group__count">{files.length}</span>
      </h4>
      <ul className="git-group__list">
        {files.map((change) => (
          <FileRow key={`${group}:${change.path}`} change={change} group={group} />
        ))}
      </ul>
    </section>
  );
}
