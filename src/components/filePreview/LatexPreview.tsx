import type { LatexOutline } from "../../services/preview/latexOutline";

export const LATEX_LIMITATION =
  "LaTeX compilation preview is not available yet. This is a read-only source preview.";

/** LaTeX source read as structure: title, author, sections, equations, bibliography and paragraphs. Never compiled. */
export function LatexPreview({ outline }: { outline: LatexOutline }) {
  return (
    <div
      className="file-preview__doc file-preview__latex"
      role="document"
      aria-label="LaTeX source preview"
    >
      <p className="file-preview__notice" role="note">
        {LATEX_LIMITATION}
      </p>
      {outline.truncated ? (
        <p className="file-preview__notice" role="status">
          The file is long; only the first part is shown.
        </p>
      ) : null}
      {outline.blocks.length === 0 ? (
        <p className="file-preview__empty">There is nothing to show in this file.</p>
      ) : null}
      {outline.blocks.map((block, index) => {
        switch (block.kind) {
          case "title":
            return (
              <h1 key={index} className="file-preview__latex-title">
                {block.text}
              </h1>
            );
          case "author":
            return (
              <p key={index} className="file-preview__latex-author">
                {block.text}
              </p>
            );
          case "section": {
            const Tag = `h${String(block.level + 1)}` as "h2";
            return <Tag key={index}>{block.text}</Tag>;
          }
          case "equation":
            return (
              <pre key={index} className="file-preview__equation" aria-label="Equation source">
                {block.text}
              </pre>
            );
          case "bibliography":
            return (
              <pre key={index} className="file-preview__bibliography">
                {block.text}
              </pre>
            );
          case "text":
            return <p key={index}>{block.text}</p>;
        }
      })}
    </div>
  );
}
