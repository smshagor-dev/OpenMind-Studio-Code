import { useState } from "react";

import { container } from "../../services/container";
import { parseMarkdown } from "../../services/markdown";
import { collapsed, outputView, type OutputView } from "../../services/notebook/notebookModel";
import { HtmlPreview } from "../filePreview/HtmlPreview";
import { BlockList } from "../MarkdownPreview";
import { t } from "../../i18n";

/** A long text shown collapsed until the user expands it. */
function LongText({ text, className }: { text: string; className: string }) {
  const [open, setOpen] = useState(false);
  const cut = collapsed(text);
  if (cut === null || open) return <pre className={className}>{text}</pre>;
  return (
    <>
      <pre className={className}>{cut.shown}</pre>
      <button
        type="button"
        className="notebook__expand"
        onClick={() => {
          setOpen(true);
        }}
      >
        {t("notebook.showAll", { count: cut.hiddenLines })}
      </button>
    </>
  );
}

function View({ view }: { view: OutputView }) {
  switch (view.kind) {
    case "text":
      return (
        <LongText text={view.text} className={`notebook__text notebook__text--${view.stream}`} />
      );
    case "image":
      return <img className="notebook__image" src={view.src} alt={t("notebook.output")} />;
    case "html":
      return <HtmlPreview text={view.html} />;
    case "htmlBlocked":
      return (
        <p className="notebook__blocked" role="note">
          {t("notebook.htmlHidden")}
        </p>
      );
    case "markdown":
      return (
        <div className="markdown-preview">
          <BlockList
            blocks={parseMarkdown(view.text)}
            onLink={(href) => {
              void container.ipc.openExternalUrl(href).catch(() => undefined);
            }}
          />
        </div>
      );
    case "error":
      return (
        <div className="notebook__error" role="alert">
          <strong>{view.title}</strong>
          {view.traceback !== "" ? (
            <LongText text={view.traceback} className="notebook__text" />
          ) : null}
        </div>
      );
    case "unsupported":
      return (
        <p className="notebook__blocked" role="note">
          {view.mimes.length > 0
            ? t("notebook.unsupportedOutputTypes", { types: view.mimes.join(", ") })
            : t("notebook.unsupportedOutput")}
        </p>
      );
  }
}

/** A cell's outputs, rendered safely. */
export function NotebookOutputs({
  outputs,
  trusted,
}: {
  outputs: Record<string, unknown>[];
  trusted: boolean;
}) {
  if (outputs.length === 0) return null;
  return (
    <div className="notebook__outputs" aria-label={t("notebook.output")}>
      {outputs.map((output, index) => (
        <View key={index} view={outputView(output, trusted)} />
      ))}
    </div>
  );
}
