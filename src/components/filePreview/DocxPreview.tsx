import { Fragment } from "react";

import type { DocxBlock, DocxModel } from "../../services/previewIpc";

export const DOCX_LIMITATION =
  "This DOCX preview is read-only and may not exactly match Microsoft Word layout.";

function Block({ block }: { block: DocxBlock }) {
  if (block.type === "table") {
    return (
      <table className="file-preview__table file-preview__table--doc">
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (block.heading !== null) {
    const Tag = `h${String(Math.min(Math.max(block.heading, 1), 6))}` as "h1";
    return <Tag>{block.text}</Tag>;
  }
  if (block.list) return <p className="file-preview__list-item">• {block.text}</p>;
  return <p>{block.text}</p>;
}

/** The text of a Word document: headings, paragraphs, list items and tables. Plain elements, no HTML string. */
export function DocxPreview({ docx }: { docx: DocxModel }) {
  const { metadata } = docx;
  const details = [
    metadata.title === null ? null : `Title: ${metadata.title}`,
    metadata.author === null ? null : `Author: ${metadata.author}`,
    metadata.created === null ? null : `Created: ${metadata.created}`,
    metadata.modified === null ? null : `Modified: ${metadata.modified}`,
  ].filter((line): line is string => line !== null);
  return (
    <div className="file-preview__doc" role="document" aria-label="Document preview">
      <p className="file-preview__notice" role="note">
        {DOCX_LIMITATION}
      </p>
      {docx.hasMacros ? (
        <p className="file-preview__notice" role="status">
          This document contains a macro project. Macros are never run.
        </p>
      ) : null}
      {docx.imageCount > 0 ? (
        <p className="file-preview__notice" role="status">
          {`${String(docx.imageCount)} embedded image${docx.imageCount === 1 ? " is" : "s are"} not shown.`}
        </p>
      ) : null}
      {docx.truncated ? (
        <p className="file-preview__notice" role="status">
          The document is long; only the first part is shown.
        </p>
      ) : null}
      {details.length > 0 ? (
        <p className="file-preview__meta-block">
          {details.map((line) => (
            <Fragment key={line}>
              {line}
              <br />
            </Fragment>
          ))}
        </p>
      ) : null}
      {docx.blocks.length === 0 ? (
        <p className="file-preview__empty">This document has no readable text.</p>
      ) : (
        docx.blocks.map((block, index) => <Block key={index} block={block} />)
      )}
    </div>
  );
}
