import { useState, useSyncExternalStore } from "react";
import type { KeyboardEvent } from "react";

import { useCommandStateRefresh } from "../appHooks";
import { container } from "../services/container";
import { normalizeKeyEvent } from "../services/keybindings";
import type { AssignCheck, ChangeResult, KeybindingRow } from "../services/keybindingsManager";

interface Editing {
  command: string;
  key: string | null;
  check: AssignCheck | null;
  error: string | null;
}

/** The Keyboard Shortcuts tab: every command with its key, and editing that detects conflicts. */
export function KeybindingsTab() {
  useSyncExternalStore(
    (listener) => container.keybindingsManager.subscribe(listener),
    () => container.keybindingsManager.getState(),
  );
  const page = useSyncExternalStore(
    (listener) => container.preferencesPage.subscribe(listener),
    () => container.preferencesPage.getState(),
  );
  useCommandStateRefresh();
  const manager = container.keybindingsManager;
  const [editing, setEditing] = useState<Editing | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const rows = manager.rows(page.query);
  const fileError = manager.getState().error;
  const jsonEnabled = container.commands.isEnabled("preferences.openKeybindingsJson");

  async function apply(action: Promise<ChangeResult>) {
    const result = await action;
    setMessage(result.ok ? null : result.error);
    if (result.ok) setEditing(null);
  }

  async function confirm(current: Editing, replace: boolean) {
    if (current.key === null) return;
    const result = await manager.assign(current.command, current.key, replace);
    if (result.ok) {
      setEditing(null);
      setMessage(null);
    } else {
      setEditing({ ...current, error: result.error });
    }
  }

  function record(row: KeybindingRow, event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setEditing(null);
      return;
    }
    if (event.key === "Enter" && editing?.key != null) {
      event.preventDefault();
      void confirm(editing, false);
      return;
    }
    const key = normalizeKeyEvent({
      code: event.code,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
    });
    event.preventDefault();
    event.stopPropagation();
    if (key === null) return;
    setEditing({
      command: row.command,
      key,
      check: manager.checkAssign(row.command, key),
      error: null,
    });
  }

  return (
    <div className="prefs-keys">
      <div className="prefs-toolbar">
        <input
          type="search"
          className="prefs-search"
          aria-label="Search keyboard shortcuts"
          placeholder="Search by command name, category or keybinding"
          value={page.query}
          onChange={(event) => {
            container.preferencesPage.setQuery(event.target.value);
          }}
        />
        <button
          type="button"
          className="prefs-json"
          disabled={!jsonEnabled}
          title={
            container.commands.reasonFor("preferences.openKeybindingsJson") ??
            "Edit keybindings.json"
          }
          onClick={() => {
            container.run("preferences.openKeybindingsJson");
          }}
        >
          Open Keyboard Shortcuts (JSON)
        </button>
      </div>
      {fileError ? (
        <p className="prefs-banner prefs-banner--error" role="alert">
          keybindings.json has a problem, so the defaults are used and it will not be changed:{" "}
          {fileError}
        </p>
      ) : null}
      {message ? (
        <p className="prefs-banner prefs-banner--error" role="alert">
          {message}
        </p>
      ) : null}
      <table className="prefs-table" aria-label="Keyboard shortcuts">
        <thead>
          <tr>
            <th scope="col">Command</th>
            <th scope="col">Keybinding</th>
            <th scope="col">Source</th>
            <th scope="col">
              <span className="prefs-visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4} className="prefs-empty">
                No shortcuts match “{page.query}”.
              </td>
            </tr>
          ) : null}
          {rows.map((row) => {
            const current = editing?.command === row.command ? editing : null;
            const blocked = current?.check?.ok === false && current.check.blocked;
            return (
              <tr
                key={row.command}
                className={row.conflicts.length > 0 ? "prefs-table__row--conflict" : undefined}
              >
                <td>
                  <span className="prefs-table__title">{row.title}</span>
                  <span className="prefs-table__meta">
                    {row.category} · {row.command}
                  </span>
                </td>
                <td>
                  {current ? (
                    <div className="prefs-record">
                      <input
                        autoFocus
                        className="prefs-input"
                        aria-label={`Press the new shortcut for ${row.title}`}
                        placeholder="Press the keys, then Enter"
                        readOnly
                        value={current.key ?? ""}
                        onKeyDown={(event) => {
                          record(row, event);
                        }}
                      />
                      {current.check && !current.check.ok ? (
                        <p className="prefs-row__error" role="alert">
                          {current.check.reason}
                        </p>
                      ) : null}
                      {current.error ? (
                        <p className="prefs-row__error" role="alert">
                          {current.error}
                        </p>
                      ) : null}
                      <div className="prefs-record__buttons">
                        {current.check && !current.check.ok && !current.check.blocked ? (
                          <button
                            type="button"
                            onClick={() => {
                              void confirm(current, true);
                            }}
                          >
                            Replace
                          </button>
                        ) : null}
                        <button
                          type="button"
                          disabled={current.key === null || blocked}
                          onClick={() => {
                            void confirm(current, false);
                          }}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditing(null);
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : row.keys.length === 0 ? (
                    <span className="prefs-table__none">Not bound</span>
                  ) : (
                    row.keys.map((key) => (
                      <kbd key={key} className="prefs-kbd">
                        {key}
                      </kbd>
                    ))
                  )}
                  {!current && row.conflicts.length > 0 ? (
                    <span className="prefs-table__conflict" role="status">
                      Also used by {row.conflicts.join(", ")}
                    </span>
                  ) : null}
                </td>
                <td>
                  {row.source === "user"
                    ? "User"
                    : row.source === "default"
                      ? "Default"
                      : row.source === "extension"
                        ? (row.extension ?? "Extension")
                        : "—"}
                </td>
                <td className="prefs-table__actions">
                  <button
                    type="button"
                    aria-label={`Change keybinding of ${row.title}`}
                    disabled={!row.change.enabled}
                    title={row.change.reason ?? "Change the keybinding"}
                    onClick={() => {
                      setMessage(null);
                      setEditing({ command: row.command, key: null, check: null, error: null });
                    }}
                  >
                    Change
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove keybinding of ${row.title}`}
                    disabled={!row.change.enabled || row.keys.length === 0}
                    title={
                      row.change.reason ??
                      (row.keys.length === 0 ? "It has no keybinding" : "Remove the keybinding")
                    }
                    onClick={() => {
                      void apply(manager.remove(row.command));
                    }}
                  >
                    Remove
                  </button>
                  <button
                    type="button"
                    aria-label={`Reset keybinding of ${row.title}`}
                    disabled={!row.customized}
                    title={
                      row.customized ? "Back to the default keybinding" : "Already the default"
                    }
                    onClick={() => {
                      void apply(manager.reset(row.command));
                    }}
                  >
                    Reset
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
