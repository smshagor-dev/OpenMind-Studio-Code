import { useState } from "react";

import { container } from "../services/container";
import "../styles/sourceControl.css";

/** The current branch with its sync counts (`main 1↑ 0↓`) and a dirty marker. Click handling is the caller's. */
export function GitBranchIndicator(props: { onClick: () => void; className?: string }) {
  const sc = container.sourceControl;
  const branch = sc.branchLabel();
  if (branch === null) return null;
  const sync = sc.syncLabel();
  const dirty = sc.changeCount() > 0;
  const changes = sc.changeCount();
  return (
    <button
      type="button"
      className={props.className ?? "git-branch"}
      aria-label={`Git branch ${branch}`}
      title={`Branch ${branch}${dirty ? ` — ${String(changes)} changed file${changes === 1 ? "" : "s"}` : " — no changes"}`}
      onClick={props.onClick}
    >
      <span aria-hidden="true">⎇ </span>
      <span>{branch}</span>
      {dirty ? <span title="Uncommitted changes"> *</span> : null}
      {sync !== null ? <span> {sync}</span> : null}
    </button>
  );
}

/** Lists local branches: switch (never forced), create from the current one, delete with confirmation. UI only. */
export function GitBranchPanel() {
  const sc = container.sourceControl;
  const branches = sc.getState().branches;
  const busy = !sc.fileActionState().enabled;
  const [name, setName] = useState("");
  return (
    <section className="git-branches" aria-label="Branches">
      <ul className="git-branches__list">
        {branches.map((branch) => (
          <li key={branch.name} className="git-branches__item">
            <span className="git-branches__name">
              {branch.current ? "✓ " : ""}
              {branch.name}
              {branch.upstream ? (
                <span className="git-row__folder"> → {branch.upstream}</span>
              ) : null}
            </span>
            {branch.current ? null : (
              <>
                <button
                  type="button"
                  className="git-row__action"
                  aria-label={`Switch to ${branch.name}`}
                  disabled={busy}
                  onClick={() => void sc.switchBranch(branch.name).then(() => sc.loadBranches())}
                >
                  Switch
                </button>
                <button
                  type="button"
                  className="git-row__action"
                  aria-label={`Delete branch ${branch.name}`}
                  disabled={busy}
                  onClick={() => {
                    sc.requestDeleteBranch(branch.name);
                  }}
                >
                  Delete
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      <form
        className="git-branches__create"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() === "") return;
          void sc.createBranch(name).then((created) => {
            if (created) setName("");
            return sc.loadBranches();
          });
        }}
      >
        <input
          className="git-input"
          aria-label="New branch name"
          placeholder="New branch name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <button
          type="submit"
          className="git-button"
          disabled={busy || name.trim() === ""}
          title={name.trim() === "" ? "Enter a branch name." : "Create the branch and switch to it"}
        >
          Create Branch
        </button>
      </form>
    </section>
  );
}
