import { useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

import { container } from "../services/container";
import type { SettingsIssue, SettingsScope } from "../services/ipc";
import { SettingRow } from "./SettingRow";
import { categoryLabel } from "../i18n/settingsText";
import { t } from "../i18n";

function IssueList({ issues, label }: { issues: SettingsIssue[]; label: string }) {
  if (issues.length === 0) return null;
  return (
    <ul className="prefs-issues" aria-label={t("settings.tab.problemsIn", { label })}>
      {issues.map((issue, index) => (
        <li
          key={`${issue.key ?? "file"}-${String(index)}`}
          className={issue.severity === "error" ? "prefs-issue prefs-issue--error" : "prefs-issue"}
        >
          {issue.message}
        </li>
      ))}
    </ul>
  );
}

type VscodeSource = { edition: string; profile: string; label: string };
type VscodePreview = {
  settings: { id: string; value: unknown }[];
  keybindings: { key: string; command: string }[];
  extensions: string[];
  snippets: string[];
  skipped: string[];
  warnings: string[];
};
type VscodeImportResult = {
  settingsImported: number;
  shortcutsImported: number;
  settingsBackup: string | null;
  shortcutsBackup: string | null;
  skipped: string[];
  warnings: string[];
};

/** Opt-in import: a source never runs external extensions and existing files are backed up. */
function VscodeImportPanel() {
  const [expanded, setExpanded] = useState(false);
  const [sources, setSources] = useState<VscodeSource[]>([]);
  const [selected, setSelected] = useState("");
  const [preview, setPreview] = useState<VscodePreview | null>(null);
  const [result, setResult] = useState<VscodeImportResult | null>(null);
  const [settings, setSettings] = useState(true);
  const [shortcuts, setShortcuts] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [extensionNotice, setExtensionNotice] = useState<string | null>(null);
  const choose = (source: VscodeSource) => source.edition + ":" + source.profile;
  const selectedSource = sources.find((source) => choose(source) === selected);

  const load = async () => {
    setExpanded(true);
    setBusy(true);
    setError(null);
    try {
      const detected = await invoke<VscodeSource[]>("vscode_import_sources");
      setSources(detected);
      setSelected(detected[0] ? choose(detected[0]) : "");
      setPreview(null);
      setResult(null);
    } catch (failure) {
      setError(String(failure));
    } finally { setBusy(false); }
  };

  const inspect = async () => {
    if (!selectedSource) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setPreview(await invoke<VscodePreview>("vscode_import_preview", {
        edition: selectedSource.edition, profile: selectedSource.profile,
      }));
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  };

  const apply = async () => {
    if (!selectedSource || !preview || (!settings && !shortcuts)) return;
    setBusy(true);
    setError(null);
    try {
      const applied = await invoke<VscodeImportResult>("vscode_import_apply", {
        edition: selectedSource.edition, profile: selectedSource.profile,
        importSettings: settings, importShortcuts: shortcuts,
      });
      setResult(applied);
      await container.settings.reload();
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  };

  const importExtension = async (folder: string) => {
    if (!selectedSource) return;
    setBusy(true);
    setError(null);
    setExtensionNotice(null);
    try {
      const imported = await invoke<{ id: string }>("vscode_import_extension", {
        edition: selectedSource.edition, folder,
      });
      setExtensionNotice("Imported " + imported.id + " (disabled). Review its compatibility and permissions in Extensions before enabling.");
      await container.extensions.registry.refresh();
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  };

  return (
    <section className="prefs-import" aria-label="Import settings from VS Code">
      <button className="prefs-json" type="button" onClick={() => {
        if (expanded) { setExpanded(false); } else { void load(); }
      }}>
        {expanded ? "Hide VS Code import" : "Import from VS Code"}
      </button>
      {expanded ? (
        <div className="prefs-import__details">
          <p>Import compatible settings and shortcuts from a local VS Code profile. Existing OpenMind files are backed up. Credentials and extensions are never executed or copied.</p>
          {sources.length === 0 ? <p role="status">No VS Code user profiles detected on this computer.</p> : (
            <>
              <label htmlFor="vscode-import-source">VS Code profile </label>
              <select id="vscode-import-source" value={selected} disabled={busy}
                onChange={(event) => { setSelected(event.target.value); setPreview(null); setResult(null); }}>
                {sources.map((source) => <option key={choose(source)} value={choose(source)}>{source.label}</option>)}
              </select>
              <button className="prefs-json" type="button" disabled={busy} onClick={() => void inspect()}>
                Preview compatible items
              </button>
            </>
          )}
          {preview ? (
            <div aria-live="polite">
              <p>{preview.settings.length} supported settings · {preview.keybindings.length} shortcuts · {preview.snippets.length} snippet files · {preview.extensions.length} installed extensions found.</p>
              <label><input type="checkbox" checked={settings} onChange={(event) => setSettings(event.target.checked)} /> Import compatible settings</label>{" "}
              <label><input type="checkbox" checked={shortcuts} onChange={(event) => setShortcuts(event.target.checked)} /> Import unconditional shortcuts</label>
              {preview.skipped.length > 0 ? <details><summary>{preview.skipped.length} unsupported or skipped settings and shortcuts</summary>
                <ul>{preview.skipped.map((value, index) => <li key={value + index}>{value}</li>)}</ul>
              </details> : null}
              {preview.extensions.length > 0 ? <details><summary>Detected VS Code extensions (review required)</summary>
                <ul>{preview.extensions.map((name) => <li key={name}>{name}{" "}
                  <button type="button" className="prefs-json" disabled={busy}
                    onClick={() => void importExtension(name)}>Import disabled</button>
                </li>)}</ul>
              </details> : null}
              {preview.warnings.map((warning) => <p key={warning}>{warning}</p>)}
              <button type="button" className="prefs-json" disabled={busy || (!settings && !shortcuts)}
                onClick={() => void apply()}>Import selected items</button>
            </div>
          ) : null}
          {extensionNotice ? <p role="status">{extensionNotice}</p> : null}
          {result ? <p role="status">Imported {result.settingsImported} settings and {result.shortcutsImported} shortcuts.
            {result.settingsBackup ? " Settings backup: " + result.settingsBackup + "." : ""}
            {result.shortcutsBackup ? " Shortcuts backup: " + result.shortcutsBackup + "." : ""}
          </p> : null}
          {error ? <p role="alert" className="prefs-banner prefs-banner--error">{error}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

/** The Settings tab: search, User/Workspace scope, categories, and every setting with its control. */
export function SettingsTab() {
  const page = useSyncExternalStore(
    (listener) => container.preferencesPage.subscribe(listener),
    () => container.preferencesPage.getState(),
  );
  const state = useSyncExternalStore(
    (listener) => container.settings.subscribe(listener),
    () => container.settings.getState(),
  );
  const snapshot = state.snapshot;
  const settings = container.settings;
  const workspace = settings.workspaceAvailability();
  const scope: SettingsScope =
    page.scope === "workspace" && workspace.enabled ? "workspace" : "user";
  const groups = settings.search(page.query);
  const visible =
    page.category === null ? groups : groups.filter((group) => group.category === page.category);
  const total = groups.reduce((sum, group) => sum + group.settings.length, 0);
  const jsonCommand =
    scope === "workspace"
      ? "preferences.openWorkspaceSettingsJson"
      : "preferences.openSettingsJson";
  const jsonEnabled = container.commands.isEnabled(jsonCommand);
  const folderName = snapshot?.workspace?.split(/[\\/]/).filter(Boolean).pop() ?? null;

  if (snapshot === null) {
    return (
      <p className="prefs-empty" role="status">
        {state.loadError ?? t("settings.tab.loading")}
      </p>
    );
  }

  const fileError = scope === "user" ? snapshot.userError : snapshot.workspaceError;
  const issues = scope === "user" ? snapshot.userIssues : snapshot.workspaceIssues;
  const jsonTitle = jsonEnabled
    ? scope === "workspace"
      ? (snapshot.workspaceFile ?? "")
      : snapshot.userFile
    : (container.commands.reasonFor(jsonCommand) ?? t("common.notAvailable"));
  return (
    <div className="prefs-settings">
      {scope === "user" ? <VscodeImportPanel /> : null}
      <div className="prefs-toolbar">
        <input
          type="search"
          className="prefs-search"
          aria-label={t("settings.tab.search")}
          placeholder={t("settings.tab.search")}
          value={page.query}
          onChange={(event) => {
            container.preferencesPage.setQuery(event.target.value);
          }}
        />
        <div className="prefs-scope" role="tablist" aria-label={t("settings.tab.scope")}>
          <button
            type="button"
            role="tab"
            aria-selected={scope === "user"}
            className={
              scope === "user" ? "prefs-scope__tab prefs-scope__tab--active" : "prefs-scope__tab"
            }
            onClick={() => {
              container.preferencesPage.setScope("user");
            }}
          >
            {t("settings.scope.user")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scope === "workspace"}
            disabled={!workspace.enabled}
            title={
              workspace.reason ??
              t("settings.tab.workspaceTitle", { folder: folderName ?? t("settings.tab.theOpenFolder") })
            }
            className={
              scope === "workspace"
                ? "prefs-scope__tab prefs-scope__tab--active"
                : "prefs-scope__tab"
            }
            onClick={() => {
              container.preferencesPage.setScope("workspace");
            }}
          >
            {folderName ? t("settings.tab.workspaceNamed", { folder: folderName }) : t("settings.scope.workspace")}
          </button>
        </div>
        <button
          type="button"
          className="prefs-json"
          disabled={!jsonEnabled}
          title={jsonTitle}
          onClick={() => {
            container.run(jsonCommand);
          }}
        >
          {t("settings.tab.openJson")}
        </button>
      </div>
      {fileError ? (
        <p className="prefs-banner prefs-banner--error" role="alert">
          {t(scope === "user" ? "settings.tab.userFileProblem" : "settings.tab.workspaceFileProblem", { error: fileError })}
        </p>
      ) : null}
      <IssueList
        issues={issues}
        label={scope === "user" ? t("settings.tab.userSettings") : t("settings.tab.workspaceSettings")}
      />
      <div className="prefs-body">
        <nav className="prefs-nav" aria-label={t("settings.tab.categories")}>
          <button
            type="button"
            className={
              page.category === null ? "prefs-nav__item prefs-nav__item--active" : "prefs-nav__item"
            }
            onClick={() => {
              container.preferencesPage.setCategory(null);
            }}
          >
            {t("settings.tab.all")} <span className="prefs-nav__count">{total}</span>
          </button>
          {groups.map((group) => (
            <button
              key={group.category}
              type="button"
              className={
                page.category === group.category
                  ? "prefs-nav__item prefs-nav__item--active"
                  : "prefs-nav__item"
              }
              onClick={() => {
                container.preferencesPage.setCategory(group.category);
              }}
            >
              {categoryLabel(group.category)} <span className="prefs-nav__count">{group.settings.length}</span>
            </button>
          ))}
        </nav>
        <div className="prefs-list" role="region" aria-label={t("settings.tab.region")}>
          {visible.length === 0 ? (
            <p className="prefs-empty" role="status">
              {t("settings.tab.noMatch", { query: page.query })}
            </p>
          ) : (
            visible.map((group) => (
              <section key={group.category} aria-label={categoryLabel(group.category)}>
                <h2 className="prefs-group">{categoryLabel(group.category)}</h2>
                {group.settings.map((def) => (
                  <SettingRow
                    key={`${scope}:${def.id}`}
                    def={def}
                    scope={scope}
                    value={
                      snapshot.values.find((entry) => entry.id === def.id)?.value ?? def.default
                    }
                  />
                ))}
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
