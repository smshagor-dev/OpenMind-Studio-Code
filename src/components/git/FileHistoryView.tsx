import { useEffect, useMemo, useRef, useSyncExternalStore, type KeyboardEvent } from "react";

import { t, useT } from "../../i18n";
import { container } from "../../services/container";
import { fileGit, gitViews } from "../../services/editorMenu";
import { layoutGraph } from "../../services/git/commitGraph";
import type { FileCommit } from "../../services/git/fileGitIpc";
import { formatDate } from "../../services/git/fileGitService";
import type { HistoryMode, HistoryView } from "../../services/git/gitViewsService";
import { GraphCell, Timeline } from "./historyGraphics";
import "../../styles/gitViews.css";

/** The timeline's drawing width; a narrower view scrolls sideways. */
const TIMELINE_WIDTH = 900;

const MODES: { mode: HistoryMode; key: string }[] = [
  { mode: "list", key: "gitView.mode.list" },
  { mode: "graph", key: "gitView.mode.graph" },
  { mode: "visual", key: "gitView.mode.visual" },
];

function run(action: () => Promise<void>): void {
  action().catch((error: unknown) => {
    container.events.emit("appError", { message: error instanceof Error ? error.message : String(error) });
  });
}

function describe(commit: FileCommit): string {
  const changed =
    commit.additions === null ? "" : ` · +${String(commit.additions)} −${String(commit.deletions ?? 0)}`;
  return `${commit.shortHash} ${commit.subject} — ${commit.author}, ${formatDate(commit.authorTime)}${changed}`;
}

/** What can be done with the selected commit. */
function CommitActions({ history, commit }: { history: HistoryView; commit: FileCommit }) {
  const index = history.commits.findIndex((entry) => entry.hash === commit.hash);
  const previous = async () =>
    history.commits[index + 1] ?? (history.more ? await fileGit.previousOf(history.path, commit) : null);
  const actions: [string, () => Promise<void>][] = [
    ["gitFile.action.changes", async () => fileGit.showCommitChange(history.path, commit, await previous(), null)],
    ["gitFile.action.working", () => fileGit.compareCommitWithWorking(history.path, commit, null)],
    [
      "gitFile.action.open",
      async () => {
        await fileGit.openAtCommit(history.path, commit);
        // The tab it opened is under this view: show it.
        gitViews.closeHistory();
      },
    ],
    ["gitFile.action.details", () => gitViews.showCommit(history.path, commit.hash, false, null)],
    [
      "gitView.copySha",
      async () => {
        await container.ipc.clipboardWriteText(commit.hash);
        container.events.emit("appNotice", { message: t("gitFile.copied", { text: commit.hash }) });
      },
    ],
  ];
  return (
    <div className="file-history__actions" role="toolbar" aria-label={describe(commit)}>
      {actions.map(([key, action]) => (
        <button
          key={key}
          type="button"
          className="file-git-view__button"
          onClick={() => {
            run(action);
          }}
        >
          {t(key)}
        </button>
      ))}
    </div>
  );
}

function HistoryRows({ history }: { history: HistoryView }) {
  const rows = useMemo(
    () => (history.mode === "graph" ? layoutGraph(history.commits) : null),
    [history.mode, history.commits],
  );
  const width = rows === null ? 0 : Math.max(1, ...rows.map((row) => row.width));
  const move = (event: KeyboardEvent, index: number) => {
    const next = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : null;
    const commit = history.commits[index];
    if (event.key === "Enter" && commit) {
      event.preventDefault();
      run(async () => fileGit.showCommitChange(history.path, commit, history.commits[index + 1] ?? null, null));
      return;
    }
    if (next === null || next < 0 || next >= history.commits.length) return;
    event.preventDefault();
    gitViews.selectCommit(history.commits[next]?.hash ?? null);
    const target = event.currentTarget.parentElement?.children[next];
    if (target instanceof HTMLElement) target.focus();
  };
  return (
    <div className="file-history" role="listbox" aria-label={t("gitView.history", { name: history.name })}>
      {history.commits.map((commit, index) => (
        <div
          key={commit.hash}
          className="file-history__row"
          role="option"
          tabIndex={commit.hash === history.selected || (history.selected === null && index === 0) ? 0 : -1}
          aria-selected={commit.hash === history.selected}
          title={describe(commit)}
          onClick={() => {
            gitViews.selectCommit(commit.hash);
          }}
          onDoubleClick={() => {
            run(async () => fileGit.showCommitChange(history.path, commit, history.commits[index + 1] ?? null, null));
          }}
          onKeyDown={(event) => {
            move(event, index);
          }}
        >
          {rows?.[index] ? <GraphCell row={rows[index]} width={width} /> : null}
          <span className="file-history__hash">{commit.shortHash}</span>
          <span className="file-history__subject">{commit.subject}</span>
          <span className="file-history__meta">
            {commit.author} · {formatDate(commit.authorTime)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** File History over the editor area: the commits that changed the file (renames followed), in three views. */
export function FileHistoryView() {
  useT();
  const history = useSyncExternalStore(
    (listener) => gitViews.subscribe(listener),
    () => gitViews.getState().history,
  );
  const sectionRef = useRef<HTMLElement | null>(null);
  const path = history?.path ?? null;
  // The view takes the keyboard when it opens (Escape closes it, arrows move through the commits).
  useEffect(() => {
    if (path !== null) sectionRef.current?.focus();
  }, [path]);
  if (history === null) return null;
  const selected = history.commits.find((commit) => commit.hash === history.selected) ?? null;
  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      className="file-git-view"
      aria-label={t("gitView.history", { name: history.name })}
      onKeyDown={(event) => {
        if (event.key === "Escape") gitViews.closeHistory();
      }}
    >
      <header className="file-git-view__header">
        <span className="file-git-view__title" title={history.path}>
          {t("gitView.history", { name: history.name })}
        </span>
        {MODES.map(({ mode, key }) => (
          <button
            key={mode}
            type="button"
            className="file-git-view__button"
            aria-pressed={history.mode === mode}
            onClick={() => {
              gitViews.setHistoryMode(mode);
            }}
          >
            {t(key)}
          </button>
        ))}
        <button
          type="button"
          className="file-git-view__close"
          aria-label={t("gitView.close")}
          title={t("gitView.close")}
          onClick={() => {
            gitViews.closeHistory();
          }}
        >
          ×
        </button>
      </header>
      <div className="file-git-view__body">
        {history.error ? (
          <p className="file-git-view__message file-git-view__message--error" role="alert">
            {history.error}
          </p>
        ) : null}
        {!history.loading && !history.error && history.commits.length === 0 ? (
          <p className="file-git-view__message">{t("gitFile.noHistory")}</p>
        ) : null}
        {history.mode === "visual" ? (
          <div className="git-timeline">
            <Timeline
              commits={history.commits}
              selected={history.selected}
              onSelect={(hash) => {
                gitViews.selectCommit(hash);
              }}
              width={TIMELINE_WIDTH}
              label={describe}
            />
          </div>
        ) : (
          <HistoryRows history={history} />
        )}
        {history.loading ? <p className="file-git-view__message">{t("gitView.loading")}</p> : null}
        {history.more && !history.loading ? (
          <button
            type="button"
            className="file-git-view__button file-history__more"
            onClick={() => {
              void gitViews.loadMore();
            }}
          >
            {t("gitView.loadMore")}
          </button>
        ) : null}
        {selected ? <CommitActions history={history} commit={selected} /> : null}
      </div>
    </section>
  );
}
