import * as monaco from "monaco-editor";
import { useSyncExternalStore } from "react";

import { container } from "../services/container";
import type { DocumentSnapshot } from "../services/documentService";
import type { LineEnding, TextEncoding } from "../services/ipc";
import { AssemblyStatusItem } from "./AssemblyStatusItem";
import { PascalStatusItem } from "./PascalStatusItem";
import { DebugStatusItem } from "./DebugStatusItem";
import { IndexStatusItem } from "./IndexStatusItem";
import { FormatterStatusItem } from "./formatting/FormatterStatusItem";
import { ProfileStatusItem } from "./profiles/ProfileStatusItem";
import { UpdateStatusItem } from "./updates/UpdateStatusItem";
import { LanguageStatusItem } from "./language/LanguageStatusItem";
import { GitBranchIndicator } from "./GitBranchIndicator";
import { LspStatusItem } from "./LspStatusItem";
import { ExtensionStatusItems } from "./ExtensionStatusItems";
import { ErrorIcon, WarningIcon } from "./icons";
import { t } from "../i18n";

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
  useSyncExternalStore(
    (listener) => container.settings.subscribe(listener),
    () => container.settings.getState(),
  );
  const showBranch = container.settings.bool("git.showBranchInStatusBar", true);
  const problems = useSyncExternalStore(
    (listener) => container.markers.subscribe(listener),
    () => container.markers.getCounts(),
  );

  return (
    <footer
      className={hasWorkspace ? "statusbar" : "statusbar statusbar--no-folder"}
      aria-label={t("status.bar")}
    >
      <div className="statusbar__left">
        <button
          type="button"
          className="statusbar__item"
          title={t("status.problemsTitle", { errors: problems.errors, warnings: problems.warnings })}
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
        <IndexStatusItem />
        <LanguageStatusItem />
        <FormatterStatusItem />
        <ProfileStatusItem />
        <UpdateStatusItem />
        {showBranch ? (
          <GitBranchIndicator
            className="statusbar__item"
            onClick={() => {
              container.run("view.showSourceControl");
            }}
          />
        ) : null}
        <ExtensionStatusItems alignment="left" />
      </div>
      <div className="statusbar__right">
        <ExtensionStatusItems alignment="right" />
        {status && activeDocument ? (
          <>
            <button
              type="button"
              className="statusbar__item"
              title={t("status.goToLine")}
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
            <span className="statusbar__item" title={t("status.indentation")}>
              {status.insertSpaces ? t("status.spaces") : t("status.tabSize")}: {status.tabSize}
            </span>
            <span className="statusbar__item" title={t("status.encoding")}>
              {ENCODING_LABELS[activeDocument.encoding]}
            </span>
            <span className="statusbar__item" title={t("status.eol")}>
              {EOL_LABELS[activeDocument.lineEnding]}
            </span>
            <LspStatusItem />
            <span className="statusbar__item" title={t("status.languageMode")}>
              {languageName(status.languageId)}
            </span>
            <AssemblyStatusItem languageId={status.languageId} />
            <PascalStatusItem languageId={status.languageId} />
          </>
        ) : null}
      </div>
    </footer>
  );
}
