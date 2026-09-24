import * as monaco from "monaco-editor";
import { useSyncExternalStore } from "react";

import { container } from "../services/container";
import type { DocumentSnapshot } from "../services/documentService";
import type { LineEnding, TextEncoding } from "../services/ipc";
import { DebugStatusItem } from "./DebugStatusItem";
import { GitBranchIndicator } from "./GitBranchIndicator";
import { LspStatusItem } from "./LspStatusItem";
import { ErrorIcon, WarningIcon } from "./icons";

const ENCODING_LABELS: Record<TextEncoding, string> = {
  utf8: "UTF-8",
  "utf8-bom": "UTF-8 with BOM",
  "utf16-le": "UTF-16 LE",
  "utf16-be": "UTF-16 BE",
  windows1252: "Windows 1252",
};

const EOL_LABELS: Record<LineEnding, string> = {
  lf: "LF",
  crlf: "CRLF",
  cr: "CR",
  mixed: "Mixed",
};

function languageName(languageId: string): string {
  const language = monaco.languages.getLanguages().find((entry) => entry.id === languageId);
  return language?.aliases?.[0] ?? languageId;
}

interface StatusBarProps {
  activeDocument: DocumentSnapshot | null;
  hasWorkspace: boolean;
}

/**
 * VS Code's status bar: problems on the left; cursor position, indentation,
 * encoding, line endings and language on the right. Blue with a folder open,
 * purple without — VS Code's "no folder" color.
 */
export function StatusBar({ activeDocument, hasWorkspace }: StatusBarProps) {
  const status = useSyncExternalStore(
    (listener) => container.editor.subscribe(listener),
    () => container.editor.getStatus(),
  );
  useSyncExternalStore(
    (listener) => container.sourceControl.subscribe(listener),
    () => container.sourceControl.getState(),
  );
  const problems = useSyncExternalStore(
    (listener) => container.markers.subscribe(listener),
    () => container.markers.getCounts(),
  );

  return (
    <footer
      className={hasWorkspace ? "statusbar" : "statusbar statusbar--no-folder"}
      aria-label="Status bar"
    >
      <div className="statusbar__left">
        <button
          type="button"
          className="statusbar__item"
          title={`Errors: ${problems.errors}, Warnings: ${problems.warnings}`}
          onClick={() => {
            if (container.commands.isEnabled("go.nextProblem")) container.run("go.nextProblem");
          }}
        >
          <ErrorIcon />
          <span>{problems.errors}</span>
          <WarningIcon />
          <span>{problems.warnings}</span>
        </button>
        <DebugStatusItem />
        <GitBranchIndicator
          className="statusbar__item"
          onClick={() => {
            container.run("view.showSourceControl");
          }}
        />
      </div>
      {status && activeDocument ? (
        <div className="statusbar__right">
          <button
            type="button"
            className="statusbar__item"
            title="Go to Line/Column"
            onClick={() => {
              container.run("go.toLine");
            }}
          >
            Ln {status.line}, Col {status.column}
            {status.selectedChars > 0
              ? status.selectionCount > 1
                ? ` (${status.selectedChars} selected in ${status.selectionCount} selections)`
                : ` (${status.selectedChars} selected)`
              : ""}
          </button>
          <span className="statusbar__item" title="Indentation">
            {status.insertSpaces ? "Spaces" : "Tab Size"}: {status.tabSize}
          </span>
          <span className="statusbar__item" title="Encoding">
            {ENCODING_LABELS[activeDocument.encoding]}
          </span>
          <span className="statusbar__item" title="End of Line Sequence">
            {EOL_LABELS[activeDocument.lineEnding]}
          </span>
          <LspStatusItem />
          <span className="statusbar__item" title="Language Mode">
            {languageName(status.languageId)}
          </span>
        </div>
      ) : null}
    </footer>
  );
}
