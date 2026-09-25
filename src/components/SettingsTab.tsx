import { useSyncExternalStore } from "react";

import { container } from "../services/container";
import type { SettingsIssue, SettingsScope } from "../services/ipc";
import { SettingRow } from "./SettingRow";

function IssueList({ issues, label }: { issues: SettingsIssue[]; label: string }) {
  if (issues.length === 0) return null;
  return (
    <ul className="prefs-issues" aria-label={`Problems in ${label}`}>
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
        {state.loadError ?? "Loading settings…"}
      </p>
    );
  }

  const fileError = scope === "user" ? snapshot.userError : snapshot.workspaceError;
  const issues = scope === "user" ? snapshot.userIssues : snapshot.workspaceIssues;
  const jsonTitle = jsonEnabled
    ? scope === "workspace"
      ? (snapshot.workspaceFile ?? "")
      : snapshot.userFile
    : (container.commands.reasonFor(jsonCommand) ?? "Not available.");
  return (
    <div className="prefs-settings">
      <div className="prefs-toolbar">
        <input
          type="search"
          className="prefs-search"
          aria-label="Search settings"
          placeholder="Search settings"
          value={page.query}
          onChange={(event) => {
            container.preferencesPage.setQuery(event.target.value);
          }}
        />
        <div className="prefs-scope" role="tablist" aria-label="Settings scope">
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
            User
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scope === "workspace"}
            disabled={!workspace.enabled}
            title={
              workspace.reason ??
              `Settings of ${folderName ?? "the open folder"}, stored in .openmind/settings.json`
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
            {folderName ? `Workspace: ${folderName}` : "Workspace"}
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
          Open Settings (JSON)
        </button>
      </div>
      {fileError ? (
        <p className="prefs-banner prefs-banner--error" role="alert">
          The {scope} settings file has a problem, so its values are ignored and it will not be
          changed: {fileError}
        </p>
      ) : null}
      <IssueList issues={issues} label={`${scope} settings`} />
      <div className="prefs-body">
        <nav className="prefs-nav" aria-label="Settings categories">
          <button
            type="button"
            className={
              page.category === null ? "prefs-nav__item prefs-nav__item--active" : "prefs-nav__item"
            }
            onClick={() => {
              container.preferencesPage.setCategory(null);
            }}
          >
            All Settings <span className="prefs-nav__count">{total}</span>
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
              {group.category} <span className="prefs-nav__count">{group.settings.length}</span>
            </button>
          ))}
        </nav>
        <div className="prefs-list" role="region" aria-label="Settings">
          {visible.length === 0 ? (
            <p className="prefs-empty" role="status">
              No settings match “{page.query}”.
            </p>
          ) : (
            visible.map((group) => (
              <section key={group.category} aria-label={group.category}>
                <h2 className="prefs-group">{group.category}</h2>
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
