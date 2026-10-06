import { useId, useMemo, useState } from "react";

import { t } from "../i18n";

export interface LanguageOption {
  value: string;
  /** What the list shows ("Español (Spanish)", "System Default — currently English"). */
  label: string;
}

interface LanguagePickerProps {
  id: string;
  label: string;
  options: readonly LanguageOption[];
  value: string;
  disabled?: boolean;
  title?: string;
  onChange: (value: string) => void;
}

/** Options whose label (own or English name) contains the query, or whose code starts with it. */
function filterLanguages(options: readonly LanguageOption[], query: string): LanguageOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...options];
  return options.filter(
    (option) => option.label.toLowerCase().includes(needle) || option.value.toLowerCase().startsWith(needle),
  );
}

/**
 * Settings > Display Language: a drop-down with a search box (a combobox). Typing filters by the language's own name,
 * its English name or its code; arrow keys move, Enter picks, Escape closes. UI only.
 */
export function LanguagePicker({ id, label, options, value, disabled, title, onChange }: LanguagePickerProps) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const current = options.find((option) => option.value === value);
  const shown = useMemo(() => filterLanguages(options, query), [options, query]);

  function openList() {
    if (disabled) return;
    setQuery("");
    setActive(Math.max(0, options.findIndex((option) => option.value === value)));
    setOpen(true);
  }

  function close() {
    setOpen(false);
    setQuery("");
  }

  function pick(option: LanguageOption | undefined) {
    if (!option) return;
    close();
    if (option.value !== value) onChange(option.value);
  }

  return (
    <div className="prefs-language-picker">
      <input
        id={id}
        type="text"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && shown[active] ? `${listId}-${shown[active].value}` : undefined}
        className="prefs-input prefs-language-picker__input"
        placeholder={open ? t("settings.language.search") : undefined}
        value={open ? query : (current?.label ?? value)}
        disabled={disabled}
        title={title}
        spellCheck={false}
        onFocus={openList}
        onClick={() => {
          if (!open) openList();
        }}
        onBlur={close}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            if (!open) openList();
            else setActive((index) => Math.min(index + 1, shown.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((index) => Math.max(index - 1, 0));
          } else if (event.key === "Enter" && open) {
            event.preventDefault();
            pick(shown[active]);
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            close();
          }
        }}
      />
      <span className="prefs-language-picker__chevron" aria-hidden="true">
        ▾
      </span>
      {open ? (
        <ul className="prefs-language-picker__list" role="listbox" id={listId} aria-label={label}>
          {shown.length === 0 ? (
            <li className="prefs-language-picker__empty">{t("settings.language.noMatch", { query: query.trim() })}</li>
          ) : (
            shown.map((option, index) => (
              <li
                key={option.value}
                id={`${listId}-${option.value}`}
                role="option"
                aria-selected={option.value === value}
                className={[
                  "prefs-language-picker__option",
                  index === active ? "prefs-language-picker__option--active" : "",
                  option.value === value ? "prefs-language-picker__option--current" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                // Mouse down, not click: the input's blur would close the list before a click lands.
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(option);
                }}
                onMouseEnter={() => {
                  setActive(index);
                }}
              >
                <span>{option.label}</span>
                {option.value === value ? <span aria-hidden="true">✓</span> : null}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
