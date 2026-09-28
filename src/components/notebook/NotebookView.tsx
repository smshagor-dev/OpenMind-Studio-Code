import { useEffect, useState, useSyncExternalStore } from "react";

import { container } from "../../services/container";
import { parseMarkdown } from "../../services/markdown";
import type { CellState, NotebookDoc } from "../../services/notebook/notebookService";
import "../../styles/notebook.css";
import { BlockList } from "../MarkdownPreview";
import { CellEditor } from "./CellEditor";
import { NotebookOutputs } from "./NotebookOutput";
import { t } from "../../i18n";

function Toolbar({ doc }: { doc: NotebookDoc }) {
  const notebooks = container.notebooks;
  const runAllReason = doc.cells.some((c) => c.kind === "code")
    ? notebooks.runReason(doc.path, doc.cells.find((c) => c.kind === "code")?.key ?? "")
    : t("notebook.noCodeCells");
  return (
    <div className="notebook__toolbar" role="toolbar" aria-label={t("notebook.label")}>
      <button
        type="button"
        disabled={runAllReason !== null}
        title={runAllReason ?? t("notebook.runAllTitle")}
        onClick={() => void notebooks.runAll(doc.path)}
      >
        ▶▶ {t("notebook.runAll")}
      </button>
      <button
        type="button"
        disabled={doc.kernel === null}
        title={
          doc.kernel === null
            ? t("notebook.noKernelRunning")
            : t("notebook.stopTitle")
        }
        onClick={() => void notebooks.stopKernel(doc.path)}
      >
        ■ {t("notebook.stop")}
      </button>
      <button
        type="button"
        title={t("notebook.selectKernelTitle")}
        disabled={!doc.trusted}
        onClick={() => void notebooks.selectKernel(doc.path)}
      >
        {t("notebook.selectKernel")}
      </button>
      <span className="notebook__kernel" title={doc.kernel ?? undefined}>
        {doc.kernel ?? t("notebook.kernelNotConfigured")}
      </span>
      <button
        type="button"
        onClick={() => {
          notebooks.clearOutputs(doc.path);
        }}
      >
        {t("notebook.clearOutputs")}
      </button>
      <button
        type="button"
        disabled={!doc.dirty}
        title={doc.dirty ? t("notebook.saveTitle") : t("notebook.noChanges")}
        onClick={() => void notebooks.save(doc.path, doc.conflict)}
      >
        {doc.conflict ? t("notebook.overwrite") : t("common.save")}
      </button>
      <span
        className={doc.trusted ? "notebook__trust notebook__trust--on" : "notebook__trust"}
        title={
          doc.trusted
            ? t("notebook.trustedTitle")
            : t("notebook.untrustedTitle")
        }
      >
        {doc.trusted ? t("notebook.trusted") : t("notebook.untrusted")}
      </span>
      {doc.trusted ? (
        <button type="button" onClick={() => void notebooks.setTrusted(doc.path, false)}>
          {t("notebook.stopTrusting")}
        </button>
      ) : null}
      {doc.dirty ? <span className="notebook__dirty">{t("notebook.unsaved")}</span> : null}
    </div>
  );
}

function TrustBanner({ doc }: { doc: NotebookDoc }) {
  if (doc.trusted) return null;
  return (
    <div className="notebook__banner" role="note">
      <p>
        {t("notebook.trustBanner")}
      </p>
      <button type="button" onClick={() => void container.notebooks.setTrusted(doc.path, true)}>
        {t("notebook.trust")}
      </button>
    </div>
  );
}

function MarkdownCell({ doc, cell }: { doc: NotebookDoc; cell: CellState }) {
  const [editing, setEditing] = useState(cell.source === "");
  if (editing) {
    return (
      <>
        <CellEditor
          source={cell.source}
          language="markdown"
          label={t("notebook.markdownCell")}
          onChange={(text) => {
            container.notebooks.setSource(doc.path, cell.key, text);
          }}
        />
        <button
          type="button"
          className="notebook__done"
          onClick={() => {
            setEditing(false);
          }}
        >
          {t("common.done")}
        </button>
      </>
    );
  }
  return (
    <div
      className="markdown-preview notebook__markdown"
      title={t("notebook.doubleClickToEdit")}
      onDoubleClick={() => {
        setEditing(true);
      }}
    >
      <BlockList
        blocks={parseMarkdown(cell.source)}
        onLink={(href) => {
          if (/^https?:\/\//i.test(href))
            void container.ipc.openExternalUrl(href).catch(() => undefined);
        }}
      />
    </div>
  );
}

function Cell({ doc, cell, index }: { doc: NotebookDoc; cell: CellState; index: number }) {
  const notebooks = container.notebooks;
  const reason = notebooks.runReason(doc.path, cell.key);
  const running = doc.running === cell.key;
  return (
    <section className="notebook__cell" aria-label={t("notebook.cellLabel", { number: index + 1, kind: cell.kind })}>
      <div className="notebook__gutter">
        {cell.kind === "code" ? (
          <button
            type="button"
            className="notebook__run"
            aria-label={t("notebook.runCellNumber", { number: index + 1 })}
            disabled={reason !== null}
            title={reason ?? t("notebook.runCellTitle")}
            onClick={() => void notebooks.runCell(doc.path, cell.key)}
          >
            {running ? "…" : "▶"}
          </button>
        ) : null}
        <span className="notebook__count">
          {cell.kind === "code"
            ? `[${running ? "*" : cell.executionCount === null ? " " : String(cell.executionCount)}]`
            : ""}
        </span>
      </div>
      <div className="notebook__body">
        <div className="notebook__cell-actions">
          <select
            aria-label={t("notebook.cellType", { number: index + 1 })}
            value={cell.kind}
            onChange={(event) => {
              notebooks.setKind(doc.path, cell.key, event.target.value as CellState["kind"]);
            }}
          >
            <option value="code">{t("notebook.kind.code")}</option>
            <option value="markdown">{t("notebook.kind.markdown")}</option>
            <option value="raw">{t("notebook.kind.raw")}</option>
          </select>
          <button
            type="button"
            title={t("notebook.moveUp")}
            onClick={() => {
              notebooks.moveCell(doc.path, cell.key, -1);
            }}
          >
            ↑
          </button>
          <button
            type="button"
            title={t("notebook.moveDown")}
            onClick={() => {
              notebooks.moveCell(doc.path, cell.key, 1);
            }}
          >
            ↓
          </button>
          <button
            type="button"
            title={t("notebook.addCodeBelow")}
            onClick={() => {
              notebooks.addCell(doc.path, cell.key, "code");
            }}
          >
            + {t("notebook.kind.code")}
          </button>
          <button
            type="button"
            title={t("notebook.addMarkdownBelow")}
            onClick={() => {
              notebooks.addCell(doc.path, cell.key, "markdown");
            }}
          >
            + {t("notebook.kind.markdown")}
          </button>
          <button
            type="button"
            aria-label={t("notebook.deleteCellNumber", { number: index + 1 })}
            title={t("notebook.deleteCell")}
            onClick={() => {
              notebooks.deleteCell(doc.path, cell.key);
            }}
          >
            ×
          </button>
        </div>
        {cell.kind === "markdown" ? (
          <MarkdownCell doc={doc} cell={cell} />
        ) : (
          <CellEditor
            source={cell.source}
            language={cell.kind === "code" ? doc.language : "plaintext"}
            label={t("notebook.cellSource", { number: index + 1 })}
            onChange={(text) => {
              notebooks.setSource(doc.path, cell.key, text);
            }}
            onRun={() => void notebooks.runCell(doc.path, cell.key)}
          />
        )}
        {cell.kind === "code" ? (
          <NotebookOutputs outputs={cell.outputs} trusted={doc.trusted} />
        ) : null}
      </div>
    </section>
  );
}

/** A Jupyter notebook: cells, outputs, trust and the kernel. Opening it runs nothing. */
export function NotebookView({ path }: { path: string }) {
  const notebooks = container.notebooks;
  useSyncExternalStore(
    (listener) => notebooks.subscribe(listener),
    () => notebooks.get(path),
  );
  useEffect(() => {
    void notebooks.open(path);
  }, [notebooks, path]);
  const doc = notebooks.get(path);
  if (!doc || doc.status === "loading")
    return <p className="file-preview__empty">{t("notebook.opening")}</p>;
  if (doc.status === "error") {
    return (
      <div className="file-preview__empty" role="alert">
        <p>{doc.error}</p>
      </div>
    );
  }
  return (
    <div className="notebook" aria-label={t("notebook.label")}>
      <Toolbar doc={doc} />
      <TrustBanner doc={doc} />
      {doc.language.toLowerCase() !== "python" ? (
        <p className="notebook__banner" role="note">
          {t("notebook.otherLanguage", { language: doc.language })}
        </p>
      ) : null}
      <div className="notebook__cells">
        {doc.cells.map((cell, index) => (
          <Cell key={cell.key} doc={doc} cell={cell} index={index} />
        ))}
        <div className="notebook__add">
          <button
            type="button"
            onClick={() => {
              notebooks.addCell(path, null, "code");
            }}
          >
            + {t("notebook.kind.code")}
          </button>
          <button
            type="button"
            onClick={() => {
              notebooks.addCell(path, null, "markdown");
            }}
          >
            + {t("notebook.kind.markdown")}
          </button>
        </div>
      </div>
    </div>
  );
}
