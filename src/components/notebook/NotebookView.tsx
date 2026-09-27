import { useEffect, useState, useSyncExternalStore } from "react";

import { container } from "../../services/container";
import { parseMarkdown } from "../../services/markdown";
import type { CellState, NotebookDoc } from "../../services/notebook/notebookService";
import "../../styles/notebook.css";
import { BlockList } from "../MarkdownPreview";
import { CellEditor } from "./CellEditor";
import { NotebookOutputs } from "./NotebookOutput";

function Toolbar({ doc }: { doc: NotebookDoc }) {
  const notebooks = container.notebooks;
  const runAllReason = doc.cells.some((c) => c.kind === "code")
    ? notebooks.runReason(doc.path, doc.cells.find((c) => c.kind === "code")?.key ?? "")
    : "There are no code cells.";
  return (
    <div className="notebook__toolbar" role="toolbar" aria-label="Notebook">
      <button
        type="button"
        disabled={runAllReason !== null}
        title={runAllReason ?? "Run every code cell (asks first)"}
        onClick={() => void notebooks.runAll(doc.path)}
      >
        ▶▶ Run All
      </button>
      <button
        type="button"
        disabled={doc.kernel === null}
        title={
          doc.kernel === null
            ? "No kernel is running."
            : "Stop the kernel (a running cell ends; variables are lost)"
        }
        onClick={() => void notebooks.stopKernel(doc.path)}
      >
        ■ Stop
      </button>
      <button
        type="button"
        title="Pick the Python that runs this notebook's cells"
        disabled={!doc.trusted}
        onClick={() => void notebooks.selectKernel(doc.path)}
      >
        Select Kernel
      </button>
      <span className="notebook__kernel" title={doc.kernel ?? undefined}>
        {doc.kernel ?? "Kernel not configured"}
      </span>
      <button
        type="button"
        onClick={() => {
          notebooks.clearOutputs(doc.path);
        }}
      >
        Clear Outputs
      </button>
      <button
        type="button"
        disabled={!doc.dirty}
        title={doc.dirty ? "Save the notebook" : "No unsaved changes"}
        onClick={() => void notebooks.save(doc.path, doc.conflict)}
      >
        {doc.conflict ? "Overwrite on Disk" : "Save"}
      </button>
      <span
        className={doc.trusted ? "notebook__trust notebook__trust--on" : "notebook__trust"}
        title={
          doc.trusted
            ? "Trusted: cells may run and HTML output is shown (sanitized)."
            : "Not trusted: nothing runs and HTML output is hidden."
        }
      >
        {doc.trusted ? "Trusted" : "Untrusted"}
      </span>
      {doc.trusted ? (
        <button type="button" onClick={() => void notebooks.setTrusted(doc.path, false)}>
          Stop Trusting
        </button>
      ) : null}
      {doc.dirty ? <span className="notebook__dirty">Unsaved changes</span> : null}
    </div>
  );
}

function TrustBanner({ doc }: { doc: NotebookDoc }) {
  if (doc.trusted) return null;
  return (
    <div className="notebook__banner" role="note">
      <p>
        This notebook is not trusted. Nothing in it has run: its cells run only after you trust it
        and pick a kernel, and its HTML output stays hidden. Trust it only if you know where it
        comes from.
      </p>
      <button type="button" onClick={() => void container.notebooks.setTrusted(doc.path, true)}>
        Trust Notebook
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
          label="Markdown cell"
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
          Done
        </button>
      </>
    );
  }
  return (
    <div
      className="markdown-preview notebook__markdown"
      title="Double-click to edit"
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
    <section className="notebook__cell" aria-label={`Cell ${String(index + 1)} (${cell.kind})`}>
      <div className="notebook__gutter">
        {cell.kind === "code" ? (
          <button
            type="button"
            className="notebook__run"
            aria-label={`Run cell ${String(index + 1)}`}
            disabled={reason !== null}
            title={reason ?? "Run Cell (Shift+Enter)"}
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
            aria-label={`Cell ${String(index + 1)} type`}
            value={cell.kind}
            onChange={(event) => {
              notebooks.setKind(doc.path, cell.key, event.target.value as CellState["kind"]);
            }}
          >
            <option value="code">Code</option>
            <option value="markdown">Markdown</option>
            <option value="raw">Raw</option>
          </select>
          <button
            type="button"
            title="Move up"
            onClick={() => {
              notebooks.moveCell(doc.path, cell.key, -1);
            }}
          >
            ↑
          </button>
          <button
            type="button"
            title="Move down"
            onClick={() => {
              notebooks.moveCell(doc.path, cell.key, 1);
            }}
          >
            ↓
          </button>
          <button
            type="button"
            title="Add a code cell below"
            onClick={() => {
              notebooks.addCell(doc.path, cell.key, "code");
            }}
          >
            + Code
          </button>
          <button
            type="button"
            title="Add a Markdown cell below"
            onClick={() => {
              notebooks.addCell(doc.path, cell.key, "markdown");
            }}
          >
            + Markdown
          </button>
          <button
            type="button"
            aria-label={`Delete cell ${String(index + 1)}`}
            title="Delete cell"
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
            label={`Cell ${String(index + 1)} source`}
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
    return <p className="file-preview__empty">Opening the notebook…</p>;
  if (doc.status === "error") {
    return (
      <div className="file-preview__empty" role="alert">
        <p>{doc.error}</p>
      </div>
    );
  }
  return (
    <div className="notebook" aria-label="Notebook">
      <Toolbar doc={doc} />
      <TrustBanner doc={doc} />
      {doc.language.toLowerCase() !== "python" ? (
        <p className="notebook__banner" role="note">
          This is a {doc.language} notebook: it can be read and edited, but OpenMind can only run
          Python cells.
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
            + Code
          </button>
          <button
            type="button"
            onClick={() => {
              notebooks.addCell(path, null, "markdown");
            }}
          >
            + Markdown
          </button>
        </div>
      </div>
    </div>
  );
}
