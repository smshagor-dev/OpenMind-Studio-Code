import { useState } from "react";

import { container } from "../services/container";
import type { SettingDefinition, SettingsScope, SettingValue } from "../services/ipc";
import { categoryLabel, optionLabel, settingDescription, settingTitle } from "../i18n/settingsText";
import { t } from "../i18n";

interface SettingRowProps {
  def: SettingDefinition;
  scope: SettingsScope;
  value: SettingValue;
}

/** One setting: title, description, the right control for its kind, "modified" mark, Reset and validation message. UI only. */
export function SettingRow({ def, scope, value }: SettingRowProps) {
  const settings = container.settings;
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const available = settings.scopeAvailability(scope, def.id);
  const modified = settings.isSetIn(scope, def.id);
  const overridden = scope === "user" && settings.isSetIn("workspace", def.id);
  const shown = draft ?? String(value);

  async function commit(next: SettingValue) {
    const result = await settings.set(scope, def.id, next);
    setError(result.ok ? null : result.error);
    if (result.ok) setDraft(null);
  }

  function commitNumber() {
    if (draft === null) return;
    const text = draft.trim();
    if (!/^-?\d+$/.test(text)) {
      setError(t("settings.row.wholeNumber", { title: settingTitle(def) }));
      return;
    }
    void commit(Number(text));
  }

  const id = `setting-${def.id}`;
  return (
    <div className={modified ? "prefs-row prefs-row--modified" : "prefs-row"} data-setting={def.id}>
      <div className="prefs-row__head">
        <label className="prefs-row__title" htmlFor={id}>
          <span className="prefs-row__category">{categoryLabel(def.category)}: </span>
          {settingTitle(def)}
        </label>
        <code className="prefs-row__id">{def.id}</code>
        {modified ? (
          <span className="prefs-row__badge" title={scope === "user" ? t("settings.row.setInUser") : t("settings.row.setInWorkspace")}>
            {t("settings.row.modified")}
          </span>
        ) : null}
        {modified ? (
          <button
            type="button"
            className="prefs-row__reset"
            aria-label={t("settings.row.resetNamed", { title: settingTitle(def) })}
            title={t(scope === "user" ? "settings.row.resetUserTitle" : "settings.row.resetWorkspaceTitle", { value: String(def.default) })}
            onClick={() => {
              setDraft(null);
              setError(null);
              void settings.reset(scope, def.id).then((result) => {
                if (!result.ok) setError(result.error);
              });
            }}
          >
            {t("common.reset")}
          </button>
        ) : null}
      </div>
      <p className="prefs-row__description">{settingDescription(def)}</p>
      {def.id === "workbench.language" ? (
        <p className="prefs-row__note">{t("settings.language.appliesNow")}</p>
      ) : null}
      <div className="prefs-row__control">
        {def.kind.type === "bool" ? (
          <label className="prefs-check">
            <input
              id={id}
              type="checkbox"
              checked={value === true}
              disabled={!available.enabled}
              title={available.reason}
              onChange={(event) => {
                void commit(event.target.checked);
              }}
            />
            <span>{value === true ? t("common.on") : t("common.off")}</span>
          </label>
        ) : null}
        {def.kind.type === "enum" ? (
          <select
            id={id}
            value={String(value)}
            disabled={!available.enabled}
            title={available.reason}
            onChange={(event) => {
              void commit(event.target.value);
            }}
          >
            {def.kind.options.map((option) => (
              <option key={option.value} value={option.value}>
                {optionLabel(def.id, option)}
              </option>
            ))}
          </select>
        ) : null}
        {def.kind.type === "int" ? (
          <input
            id={id}
            type="text"
            inputMode="numeric"
            className={error ? "prefs-input prefs-input--invalid" : "prefs-input"}
            value={shown}
            disabled={!available.enabled}
            title={
              available.enabled
                ? t("settings.row.range", { min: def.kind.min, max: def.kind.max })
                : available.reason
            }
            aria-invalid={error !== null}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            onBlur={commitNumber}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitNumber();
              if (event.key === "Escape") {
                setDraft(null);
                setError(null);
              }
            }}
          />
        ) : null}
        {def.kind.type === "text" ? (
          <input
            id={id}
            type="text"
            className={
              error
                ? "prefs-input prefs-input--wide prefs-input--invalid"
                : "prefs-input prefs-input--wide"
            }
            value={shown}
            disabled={!available.enabled}
            title={available.reason}
            aria-invalid={error !== null}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            onBlur={() => {
              if (draft !== null && draft !== String(value)) void commit(draft);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && draft !== null) void commit(draft);
              if (event.key === "Escape") {
                setDraft(null);
                setError(null);
              }
            }}
          />
        ) : null}
      </div>
      {!available.enabled ? <p className="prefs-row__note">{available.reason}</p> : null}
      {overridden ? (
        <p className="prefs-row__note">
          {t("settings.row.overridden")}
        </p>
      ) : null}
      {error ? (
        <p className="prefs-row__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
