import { container } from "../../services/container";
import type { FilePreviewDoc, PreviewModel } from "../../services/filePreviewService";

export const SHEET_LIMITATION =
  "This spreadsheet preview is read-only and does not evaluate formulas or macros.";

function columnName(index: number): string {
  let name = "";
  let n = index + 1;
  while (n > 0) {
    const rest = (n - 1) % 26;
    name = String.fromCharCode(65 + rest) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function Grid({ rows }: { rows: string[][] }) {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  return (
    <div className="file-preview__grid-wrap">
      <table className="file-preview__table file-preview__table--grid">
        <thead>
          <tr>
            <th aria-label="Row" />
            {Array.from({ length: width }, (_, col) => (
              <th key={col}>{columnName(col)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              <th scope="row">{rowIndex + 1}</th>
              {Array.from({ length: width }, (_, col) => (
                <td key={col}>{row[col] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function counts(rows: number, cols: number): string {
  return `${String(rows)} row${rows === 1 ? "" : "s"} × ${String(cols)} column${cols === 1 ? "" : "s"}`;
}

/** An Excel sheet (with a sheet list) or a CSV, as a read-only grid. Cell values are plain text. */
export function SheetPreview({
  doc,
  model,
}: {
  doc: FilePreviewDoc;
  model: Extract<PreviewModel, { type: "xlsx" | "csv" }>;
}) {
  if (model.type === "csv") {
    const { table } = model;
    return (
      <div className="file-preview__sheet">
        <div className="file-preview__sheet-bar">
          <span>
            {counts(table.totalRows, table.totalCols)}
            {model.partialFile ? " (partial)" : ""}
          </span>
          <span>Delimiter: {table.delimiter === "\t" ? "tab" : table.delimiter}</span>
        </div>
        {table.truncatedRows || table.truncatedCols || model.partialFile ? (
          <p className="file-preview__notice" role="status">
            {[
              table.truncatedRows
                ? `Showing the first ${String(table.rows.length)} of ${String(table.totalRows)} rows.`
                : null,
              table.truncatedCols
                ? `Showing the first ${String(table.rows[0]?.length ?? 0)} of ${String(table.totalCols)} columns.`
                : null,
              model.partialFile
                ? "The file is large: only its first part was read, so the counts are for that part."
                : null,
            ]
              .filter((line) => line !== null)
              .join(" ")}
          </p>
        ) : null}
        <Grid rows={table.rows} />
      </div>
    );
  }
  const { xlsx } = model;
  const { sheet } = xlsx;
  return (
    <div className="file-preview__sheet">
      <p className="file-preview__notice" role="note">
        {SHEET_LIMITATION}
      </p>
      {xlsx.hasMacros ? (
        <p className="file-preview__notice" role="status">
          This workbook contains a macro project. Macros are never run.
        </p>
      ) : null}
      <div className="file-preview__sheet-bar">
        <div className="file-preview__sheet-tabs" role="tablist" aria-label="Sheets">
          {xlsx.sheets.map((name, index) => (
            <button
              key={`${name}:${String(index)}`}
              type="button"
              role="tab"
              aria-selected={index === xlsx.selected}
              className={
                index === xlsx.selected
                  ? "file-preview__sheet-tab is-active"
                  : "file-preview__sheet-tab"
              }
              onClick={() => {
                void container.filePreviews.setSheet(doc.id, index);
              }}
            >
              {name}
            </button>
          ))}
        </div>
        <span>{counts(sheet.totalRows, sheet.totalCols)}</span>
      </div>
      {sheet.truncatedRows || sheet.truncatedCols ? (
        <p className="file-preview__notice" role="status">
          {`Showing the first ${String(sheet.rows.length)} rows and ${String(sheet.rows[0]?.length ?? 0)} columns of ${counts(sheet.totalRows, sheet.totalCols)}.`}
        </p>
      ) : null}
      {sheet.rows.length === 0 ? (
        <p className="file-preview__empty">This sheet has no values.</p>
      ) : (
        <Grid rows={sheet.rows} />
      )}
    </div>
  );
}
