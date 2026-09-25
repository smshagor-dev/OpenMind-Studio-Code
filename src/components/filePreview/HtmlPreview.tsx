import { useEffect, useState } from "react";

import { describeHtmlSource } from "../../services/preview/htmlCheck";
import { prepareWebviewHtml } from "../../services/webviewHtml";

/**
 * A sanitized, read-only view of an HTML file. The page goes through the same rewriting as extension webviews with
 * scripts off (event handlers, frames, forms' actions, base/meta refresh, unsafe and remote addresses removed, a
 * restrictive CSP first) and is shown in a frame with an empty `sandbox` (no scripts, no same-origin, no forms, no
 * navigation, no popups). Local files are never loaded, and nothing is fetched: remote content is always blocked.
 */
export function HtmlPreview({ text }: { text: string }) {
  const [state, setState] = useState<{ html: string; notices: string[] } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void prepareWebviewHtml(text, {
      enableScripts: false,
      token: "",
      state: null,
      readResource: () => Promise.reject(new Error("A preview never loads local files.")),
    }).then((prepared) => {
      if (cancelled) return;
      const source = describeHtmlSource(text);
      const blocked = prepared.blocked.filter((line) => !source.includes(line));
      setState({ html: prepared.html, notices: [...source, ...blocked] });
    });
    return () => {
      cancelled = true;
    };
  }, [text]);

  if (state === null) return <p className="file-preview__empty">Preparing the preview…</p>;
  return (
    <div className="file-preview__html">
      <p className="file-preview__notice" role="note">
        Scripts and remote content are always blocked in this read-only HTML preview.
      </p>
      {state.notices.length > 0 ? (
        <ul className="file-preview__notice file-preview__notice-list" role="status">
          {state.notices.slice(0, 8).map((line) => (
            <li key={line}>{line}</li>
          ))}
          {state.notices.length > 8 ? <li>…and {state.notices.length - 8} more.</li> : null}
        </ul>
      ) : null}
      <iframe
        className="file-preview__html-frame"
        title="HTML preview"
        sandbox=""
        allow=""
        referrerPolicy="no-referrer"
        srcDoc={state.html}
      />
    </div>
  );
}
