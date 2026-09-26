import { invoke } from "@tauri-apps/api/core";

// Mirrors src-tauri::commands::format and openmind_format::resolve (serde camelCase).

export type FormatterSourceName = "builtIn" | "project" | "bundled" | "portable" | "system";
export type FormatterMode = "builtIn" | "stdin" | "file";

export interface FormatterInfo {
  id: string;
  name: string;
  source: FormatterSourceName | null;
  mode: FormatterMode;
  available: boolean;
  /** Why it can't be used right now. */
  reason: string | null;
  /** Where the tool was found. */
  path: string | null;
}

/** Which kinds of tool may be used (the `formatter.use*Tools` settings). */
export interface FormatPolicy {
  project: boolean;
  bundled: boolean;
  system: boolean;
}

export interface FormatOptionsAnswer {
  languageId: string | null;
  languageName: string | null;
  formatters: FormatterInfo[];
  /** The formatter that would run now. */
  selected: string | null;
  /** Why there is none. */
  reason: string | null;
}

export interface FormatRequest {
  path: string | null;
  language: string;
  text: string;
  toolId: string | null;
  preferred: string | null;
  /** One indentation level. */
  indent: string;
  eol: string;
  timeoutMs: number;
  policy: FormatPolicy;
}

export interface FormatAnswer {
  text: string;
  formatterId: string;
  formatterName: string;
  source: FormatterSourceName | null;
}

export interface FormattingIpc {
  formatOptions: (
    path: string | null,
    language: string,
    preferred: string | null,
    policy: FormatPolicy,
  ) => Promise<FormatOptionsAnswer>;
  formatRun: (request: FormatRequest) => Promise<FormatAnswer>;
}

export const tauriFormattingIpc: FormattingIpc = {
  formatOptions: (path, language, preferred, policy) =>
    invoke<FormatOptionsAnswer>("format_options", { path, language, preferred, policy }),
  formatRun: (request) => invoke<FormatAnswer>("format_run", { request }),
};
