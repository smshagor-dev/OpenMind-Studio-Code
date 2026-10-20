import { useEffect, useRef, useSyncExternalStore } from "react";

import { t, useT } from "../../i18n";
import { container } from "../../services/container";
import { fileGitRemote, gitViews } from "../../services/editorMenu";
import { formatDate } from "../../services/git/fileGitService";
import type { CommitView } from "../../services/git/gitViewsService";
import "../../styles/gitViews.css";

function report(error: unknown): void {
  container.events.emit("appError", { message: error instanceof Error ? error.message : String(error) });
}

async function copy(text: string, notice: string): Promise<void> {
  await container.ipc.clipboardWriteText(text);
  container.events.emit("appNotice", { message: notice });
}

function Actions({ view }: { view: CommitView }) {
  const details = view.details;
  if (details === null) return null;
  const line = view.line ?? 1;
  const target = { path: view.path, line, endLine: line };
  const short = details.hash.slice(0, 7);
  return (
    <div className="commit-details__actions">
      {view.compact ? (
        <button type="button" className="file-git-view__button" onClick={() => { gitViews.expandCommit(); }}>
          {t("gitView.moreDetails")}
        </button>
      ) : null}
      <button
        type="button"
        className="file-git-view__button"
        onClick={() => {
          void copy(details.hash, t("gitFile.copied", { text: details.hash })).catch(report);
        }}
      >
        {t("gitView.copySha")}
      </button>
      <button
        type="button"
        className="file-git-view__button"
        onClick={() => {
          void copy(details.message, t("gitFile.copiedMessage", { hash: short })).catch(report);
        }}
      >
        {t("gitView.copyMessage")}
      </button>
      {view.line !== null ? (
        <button
          type="button"
          className="file-git-view__button"
          onClick={() => {
            gitViews.closeCommit();
            void fileGitRemote.commitOnRemote(target, "open").catch(report);
          }}
        >
          {t("gitView.openOnRemote")}
        </button>
      ) : null}
    </div>
  );
}

/** Quick Show Line Commit (compact) and Inspect Line Commit Details: who, when, the whole message, the files. */
export function CommitDetailsDialog() {
  useT();
  const view = useSyncExternalStore(
    (listener) => gitViews.subscribe(listener),
    () => gitViews.getState().commit,
  );
  const cardRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (view !== null) cardRef.current?.focus();
  }, [view]);
  if (view === null) return null;
  const details = view.details;
  const subject = details?.message.split("\n")[0] ?? "";
  return (
    <div
      className="commit-details"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) gitViews.closeCommit();
      }}
    >
      <div
        ref={cardRef}
        className="commit-details__card"
        role="dialog"
        aria-modal="true"
        aria-label={t("gitView.commit")}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") gitViews.closeCommit();
        }}
      >
        <div className="commit-details__head">
          <h2 className="commit-details__subject">{details ? subject : t("gitView.commit")}</h2>
          <button
            type="button"
            className="file-git-view__close"
            aria-label={t("gitView.close")}
            title={t("gitView.close")}
            onClick={() => {
              gitViews.closeCommit();
            }}
          >
            ×
          </button>
        </div>
        {view.loading ? <p className="file-git-view__message">{t("gitView.loading")}</p> : null}
        {view.error ? (
          <p className="file-git-view__message file-git-view__message--error" role="alert">
            {view.error}
          </p>
        ) : null}
        {details ? (
          <>
            <dl className="commit-details__facts">
              <dt>{t("gitView.fact.commit")}</dt>
              <dd>{details.hash}</dd>
              <dt>{t("gitView.fact.author")}</dt>
              <dd>
                {details.author} &lt;{details.authorEmail}&gt; · {formatDate(details.authorTime)}
              </dd>
              {!view.compact ? (
                <>
                  <dt>{t("gitView.fact.committer")}</dt>
                  <dd>
                    {details.committer} &lt;{details.committerEmail}&gt; · {formatDate(details.commitTime)}
                  </dd>
                  <dt>{t("gitView.fact.parents")}</dt>
                  <dd>{details.parents.map((parent) => parent.slice(0, 7)).join(", ") || "—"}</dd>
                </>
              ) : null}
            </dl>
            {!view.compact && details.message.includes("\n") ? (
              <pre className="commit-details__message">{details.message}</pre>
            ) : null}
            {!view.compact ? (
              <ul className="commit-details__files" aria-label={t("gitView.files")}>
                {details.files.map((file) => (
                  <li key={`${file.status}:${file.path}`}>
                    <span className="commit-details__status">{file.status}</span>
                    <span>{file.origPath ? `${file.origPath} → ${file.path}` : file.path}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : null}
        <Actions view={view} />
      </div>
    </div>
  );
}
