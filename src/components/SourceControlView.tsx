import { useState, useSyncExternalStore } from "react";

import { container } from "../services/container";
import "../styles/sourceControl.css";
import type { Availability } from "../services/runtimeService";
import { ConfirmDialog } from "./ConfirmDialog";
import { GitBranchIndicator, GitBranchPanel } from "./GitBranchIndicator";
import { GitCommitBox } from "./GitCommitBox";
import { GitFileList } from "./GitFileList";

function useSourceControl() {
  useSyncExternalStore(
    (listener) => container.sourceControl.subscribe(listener),
    () => container.sourceControl.getState(),
  );
  return container.sourceControl;
}

function ToolButton(props: {
  label: string;
  text: string;
  availability?: Availability;
  onClick: () => void;
}) {
  const availability = props.availability ?? { enabled: true };
  return (
    <button
      type="button"
      className="git-tool"
      aria-label={props.label}
      title={availability.enabled ? props.label : availability.reason}
      disabled={!availability.enabled}
      onClick={props.onClick}
    >
      {props.text}
    </button>
  );
}

function MoreMenu() {
  const sc = useSourceControl();
  const [open, setOpen] = useState(false);
  const item = (label: string, availability: Availability, run: () => void) => (
    <button
      key={label}
      type="button"
      role="menuitem"
      className="git-menu__item"
      disabled={!availability.enabled}
      title={availability.enabled ? label : availability.reason}
      onClick={() => {
        setOpen(false);
        run();
      }}
    >
      {label}
    </button>
  );
  const state = sc.getState();
  return (
    <div className="git-menu">
      <ToolButton
        label="More Actions"
        text="…"
        onClick={() => {
          setOpen((value) => !value);
        }}
      />
      {open ? (
        <div className="git-menu__popup" role="menu" aria-label="More Actions">
          {item("Fetch", sc.remoteState("fetch"), () => void sc.fetch())}
          {item("Pull", sc.remoteState("pull"), () => void sc.pull())}
          {item("Push", sc.remoteState("push"), () => void sc.push())}
          {item("Discard All Changes", sc.discardAllState(), () => {
            sc.requestDiscardAll();
          })}
          {item("Show Git Output", { enabled: true }, () => {
            container.output.select("Git");
            void container.panel.show("output");
          })}
          {state.allowSystem
            ? item("Stop Using System Git", { enabled: true }, () => void sc.stopUsingSystemGit())
            : null}
        </div>
      ) : null}
    </div>
  );
}

function Message({ children }: { children: string }) {
  return <p className="git-message">{children}</p>;
}

function RepositoryPanel() {
  const sc = useSourceControl();
  const state = sc.getState();
  const [showBranches, setShowBranches] = useState(false);
  const snapshot = state.snapshot;
  if (snapshot?.state !== "repository") return null;
  const groups = sc.groups();
  const empty = sc.changeCount() === 0;
  return (
    <div className="git-repo">
      <header className="git-repo__header">
        <div className="git-repo__title">
          <strong title={snapshot.root}>{snapshot.name}</strong>
          <GitBranchIndicator
            onClick={() => {
              const next = !showBranches;
              setShowBranches(next);
              if (next) void sc.loadBranches();
            }}
          />
        </div>
        <div className="git-repo__tools">
          <ToolButton label="Refresh" text="⟳" onClick={() => void sc.refresh()} />
          <ToolButton
            label="Stage All Changes"
            text="+"
            availability={sc.stageAllState()}
            onClick={() => void sc.stageAll()}
          />
          <ToolButton
            label="Unstage All Changes"
            text="−"
            availability={sc.unstageAllState()}
            onClick={() => void sc.unstageAll()}
          />
          <MoreMenu />
        </div>
      </header>
      <p className="git-repo__runtime" title={snapshot.git}>
        Git: {snapshot.git}
      </p>
      {showBranches ? <GitBranchPanel /> : null}
      {state.busy ? (
        <p className="git-message" role="status">
          {state.busy}…
        </p>
      ) : null}
      {state.error ? (
        <p className="git-message git-message--error" role="alert">
          {state.error}
        </p>
      ) : null}
      {!state.error && state.notice ? (
        <p className="git-message" role="status">
          {state.notice}
        </p>
      ) : null}
      <GitCommitBox />
      <GitFileList group="staged" files={groups.staged} />
      <GitFileList group="changes" files={groups.changes} />
      <GitFileList group="untracked" files={groups.untracked} />
      {empty ? <Message>No changes. The working tree is clean.</Message> : null}
    </div>
  );
}

function NoFolder() {
  return (
    <div className="git-empty">
      <Message>Open a folder to use Source Control.</Message>
      <button
        type="button"
        className="git-button git-button--primary"
        onClick={() => {
          container.run("file.openFolder");
        }}
      >
        Open Folder
      </button>
    </div>
  );
}

function GitMissing() {
  const sc = useSourceControl();
  const snapshot = sc.getState().snapshot;
  if (snapshot?.state !== "gitMissing") return null;
  return (
    <div className="git-empty">
      <Message>Git runtime is not installed yet.</Message>
      <button
        type="button"
        className="git-button git-button--primary"
        onClick={() => {
          sc.installGitRuntime();
        }}
      >
        Install Git Runtime
      </button>
      {snapshot.systemGit !== null ? (
        <>
          <Message>{`Git was found on this computer at ${snapshot.systemGit}. OpenMind only uses it if you allow it.`}</Message>
          <button
            type="button"
            className="git-button"
            title={`Use System Git at ${snapshot.systemGit}`}
            onClick={() => void sc.useSystemGit()}
          >
            Use System Git
          </button>
        </>
      ) : null}
    </div>
  );
}

function NotRepository() {
  const sc = useSourceControl();
  const snapshot = sc.getState().snapshot;
  if (snapshot?.state !== "notRepository") return null;
  const busy = !sc.fileActionState().enabled;
  return (
    <div className="git-empty">
      <Message>This folder is not a Git repository.</Message>
      <button
        type="button"
        className="git-button git-button--primary"
        disabled={busy}
        onClick={() => void sc.initRepository()}
      >
        Initialize Repository
      </button>
      <p className="git-repo__runtime" title={snapshot.git}>
        Git: {snapshot.git}
      </p>
      {sc.getState().error ? (
        <p className="git-message git-message--error" role="alert">
          {sc.getState().error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The Source Control side bar view. It shows exactly one of: nothing open, Git
 * missing, not a repository, or the repository (branch, commit box, Staged
 * Changes, Changes, Untracked Changes). Discards and deletes go through the
 * confirmation dialog. UI only — `SourceControlService` decides everything.
 */
export function SourceControlView() {
  const sc = useSourceControl();
  const pending = sc.getState().pending;
  const kind = sc.viewKind();
  return (
    <div className="git-view">
      {kind === "loading" ? <Message>Reading the repository…</Message> : null}
      {kind === "noFolder" ? <NoFolder /> : null}
      {kind === "gitMissing" ? <GitMissing /> : null}
      {kind === "notRepository" ? <NotRepository /> : null}
      {kind === "repository" ? <RepositoryPanel /> : null}
      {pending ? (
        <ConfirmDialog
          title={pending.title}
          message={pending.message}
          confirmLabel={pending.confirmLabel}
          onConfirm={() => void sc.confirm()}
          onCancel={() => {
            sc.cancelPending();
          }}
        />
      ) : null}
    </div>
  );
}
