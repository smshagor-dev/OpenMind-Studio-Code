import type {
  PreferencesSnapshot,
  SettingDefinition,
  SettingSource,
  SettingValue,
} from "../services/ipc";

/** A small, realistic slice of the backend's setting definitions for tests. */
export const TEST_DEFINITIONS: SettingDefinition[] = [
  {
    id: "editor.fontSize",
    category: "Editor",
    title: "Font Size",
    description: "Font size of the editor in pixels.",
    kind: { type: "int", min: 8, max: 40 },
    default: 14,
    scope: "both",
  },
  {
    id: "editor.fontFamily",
    category: "Editor",
    title: "Font Family",
    description: "Font family list of the editor.",
    kind: { type: "text", maxLength: 200 },
    default: "Consolas, monospace",
    scope: "both",
  },
  {
    id: "editor.wordWrap",
    category: "Editor",
    title: "Word Wrap",
    description: "Wrap long lines at the edge of the editor.",
    kind: { type: "bool" },
    default: false,
    scope: "both",
  },
  {
    id: "editor.lineNumbers",
    category: "Editor",
    title: "Line Numbers",
    description: "Controls how line numbers are shown.",
    kind: {
      type: "enum",
      options: [
        { value: "on", label: "On" },
        { value: "off", label: "Off" },
        { value: "relative", label: "Relative" },
      ],
    },
    default: "on",
    scope: "both",
  },
  {
    id: "terminal.fontSize",
    category: "Terminal",
    title: "Font Size",
    description: "Font size of the integrated terminal in pixels.",
    kind: { type: "int", min: 8, max: 32 },
    default: 14,
    scope: "user",
  },
  {
    id: "workbench.colorTheme",
    category: "Workbench",
    title: "Color Theme",
    description: "Colors of the workbench, the editor and the terminal.",
    kind: {
      type: "enum",
      options: [
        { value: "system", label: "System" },
        { value: "dark", label: "Dark" },
        { value: "light", label: "Light" },
        { value: "high-contrast", label: "High Contrast" },
      ],
    },
    default: "dark",
    scope: "user",
  },
  {
    id: "workbench.language",
    category: "Language",
    title: "Display Language",
    description: "The language of OpenMind Studio's own menus, dialogs and messages.",
    kind: {
      type: "enum",
      options: [
        { value: "system", label: "System Default" },
        { value: "en", label: "English" },
        { value: "ru", label: "Русский (Russian)" },
        { value: "bn", label: "বাংলা (Bangla)" },
      ],
    },
    default: "system",
    scope: "user",
  },
];

export interface FixtureOptions {
  values?: Record<string, SettingValue>;
  sources?: Record<string, SettingSource>;
  workspace?: string | null;
  userSet?: string[];
  workspaceSet?: string[];
}

/** A snapshot over `TEST_DEFINITIONS`: every setting at its default unless `values` says otherwise. */
export function makePreferences(options: FixtureOptions = {}): PreferencesSnapshot {
  const workspace = options.workspace ?? null;
  return {
    definitions: TEST_DEFINITIONS,
    categories: ["Language", "Editor", "Terminal", "Workbench"],
    values: [
      ...TEST_DEFINITIONS.map((def) => ({
        id: def.id,
        value: options.values?.[def.id] ?? def.default,
        source:
          options.sources?.[def.id] ??
          (options.values?.[def.id] === undefined ? ("default" as const) : ("user" as const)),
      })),
      // Settings a test sets that the small fixture has no definition for still have a value.
      ...Object.entries(options.values ?? {})
        .filter(([id]) => !TEST_DEFINITIONS.some((def) => def.id === id))
        .map(([id, value]) => ({ id, value, source: "user" as const })),
    ],
    workspace,
    userFile: "C:/app/settings/settings.json",
    workspaceFile: workspace === null ? null : `${workspace}/.openmind/settings.json`,
    userSet: options.userSet ?? Object.keys(options.values ?? {}),
    workspaceSet: options.workspaceSet ?? [],
    userError: null,
    workspaceError: null,
    userIssues: [],
    workspaceIssues: [],
  };
}

/** No definitions at all: what the fake IPC answers unless a test cares about settings. */
export function emptyPreferences(): PreferencesSnapshot {
  return {
    definitions: [],
    categories: [],
    values: [],
    workspace: null,
    userFile: "C:/app/settings/settings.json",
    workspaceFile: null,
    userSet: [],
    workspaceSet: [],
    userError: null,
    workspaceError: null,
    userIssues: [],
    workspaceIssues: [],
  };
}
