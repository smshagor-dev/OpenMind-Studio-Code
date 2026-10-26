import { useSyncExternalStore } from "react";

import { t } from "../i18n";
import { vscodeImport } from "../services/vscodeImport";
import { sourceKey, type VsCodeImportService } from "../services/vscodeImport/vscodeImportService";

/** "Import from VS Code" on the Settings page: every step is a click; existing OpenMind files are backed up first. */
export function VsCodeImportPanel({ service = vscodeImport }: { service?: VsCodeImportService }) {
  const state = useSyncExternalStore(
    (listener) => service.subscribe(listener),
    () => service.getState(),
  );
  const { expanded, sources, selected, preview, result, busy, error, notice } = state;
  const blocker = service.applyBlocker();
  return (
    <section className="prefs-import" aria-label={t("vscodeImport.title")}>
      <button className="prefs-json" type="button" onClick={() => void service.toggle()}>
        {expanded ? t("vscodeImport.hide") : t("vscodeImport.show")}
      </button>
      {expanded ? (
        <div className="prefs-import__details">
          <p>{t("vscodeImport.intro")}</p>
          {sources.length === 0 ? (
            busy ? null : <p role="status">{t("vscodeImport.noSources")}</p>
          ) : (
            <>
              <label htmlFor="vscode-import-source">{t("vscodeImport.source")} </label>
              <select
                id="vscode-import-source"
                value={selected}
                disabled={busy}
                onChange={(event) => {
                  service.select(event.target.value);
                }}
              >
                {sources.map((source) => (
                  <option key={sourceKey(source)} value={sourceKey(source)}>
                    {source.label}
                  </option>
                ))}
              </select>{" "}
              <button className="prefs-json" type="button" disabled={busy} onClick={() => void service.inspect()}>
                {t("vscodeImport.preview")}
              </button>
            </>
          )}
          {preview ? (
            <div aria-live="polite">
              <p>
                {t("vscodeImport.summary", {
                  settings: preview.settings.length,
                  shortcuts: preview.keybindings.length,
                  snippets: preview.snippets.length,
                  extensions: preview.extensions.length,
                })}
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={state.importSettings}
                  onChange={(event) => {
                    service.setImportSettings(event.target.checked);
                  }}
                />{" "}
                {t("vscodeImport.importSettings")}
              </label>{" "}
              <label>
                <input
                  type="checkbox"
                  checked={state.importShortcuts}
                  onChange={(event) => {
                    service.setImportShortcuts(event.target.checked);
                  }}
                />{" "}
                {t("vscodeImport.importShortcuts")}
              </label>
              {preview.skipped.length > 0 ? (
                <details>
                  <summary>{t("vscodeImport.skipped", { count: preview.skipped.length })}</summary>
                  <ul>
                    {preview.skipped.map((value, index) => (
                      <li key={value + String(index)}>{value}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {preview.extensions.length > 0 ? (
                <details>
                  <summary>{t("vscodeImport.extensions")}</summary>
                  <p>{t("vscodeImport.extensionsNote")}</p>
                  <ul>
                    {preview.extensions.map((name) => (
                      <li key={name}>
                        {name}{" "}
                        <button
                          type="button"
                          className="prefs-json"
                          disabled={busy}
                          onClick={() => void service.importExtension(name)}
                        >
                          {t("vscodeImport.importExtension")}
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {preview.warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
              <button
                type="button"
                className="prefs-json"
                disabled={busy || blocker !== null}
                title={blocker ?? undefined}
                onClick={() => void service.apply()}
              >
                {t("vscodeImport.apply")}
              </button>{" "}
              <button type="button" className="prefs-json" disabled={busy} onClick={() => void service.importProfile()}>
                {t("vscodeImport.saveProfile")}
              </button>{" "}
              <button
                type="button"
                className="prefs-json"
                disabled={busy || preview.snippets.length === 0}
                title={preview.snippets.length === 0 ? t("vscodeImport.reason.noSnippets") : undefined}
                onClick={() => void service.importSnippets()}
              >
                {t("vscodeImport.importSnippets")}
              </button>
            </div>
          ) : null}
          {notice ? <p role="status">{notice}</p> : null}
          {result ? (
            <p role="status">
              {t("vscodeImport.result", { settings: result.settingsImported, shortcuts: result.shortcutsImported })}
              {result.settingsBackup ? " " + t("vscodeImport.settingsBackup", { path: result.settingsBackup }) : ""}
              {result.shortcutsBackup ? " " + t("vscodeImport.shortcutsBackup", { path: result.shortcutsBackup }) : ""}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="prefs-banner prefs-banner--error">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
