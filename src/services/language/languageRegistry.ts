import type { LanguageDef, SupportLevel } from "./languageIpc";

function fileName(path: string): string {
  return (path.split(/[/\\]/).pop() ?? path).toLowerCase();
}

function filenameMatches(pattern: string, name: string): boolean {
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  const star = pattern.indexOf("*");
  if (star >= 0) {
    const head = pattern.slice(0, star);
    const tail = pattern.slice(star + 1);
    return name.length >= head.length + tail.length && name.startsWith(head) && name.endsWith(tail);
  }
  return name === pattern;
}

/**
 * The language of a file by its name: whole-name matches (`Dockerfile`, `docker-compose.yml`, `.env.*`) first, then the
 * extension. The same rules as the backend's registry (`openmind_language::language_for`); the content is never read.
 */
export function matchLanguage(registry: readonly LanguageDef[], path: string): LanguageDef | null {
  const name = fileName(path);
  const byName = registry.find((language) =>
    language.filenames.some((pattern) => filenameMatches(pattern, name)),
  );
  if (byName) return byName;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  const extension = name.slice(dot);
  return registry.find((language) => language.extensions.includes(extension)) ?? null;
}

export const LEVEL_LABELS: Record<SupportLevel, string> = {
  syntax: "Syntax highlighting",
  lsp: "Language server",
  format: "Formatting",
  lint: "Linting",
  run: "Run file",
  build: "Build",
  debug: "Debugging",
  test: "Test",
};

/** What the editor's colouring of a language is: its own grammar, the nearest one, or none. */
export function syntaxNote(language: LanguageDef): string {
  switch (language.syntax) {
    case "exact":
      return "Syntax highlighting: full.";
    case "approximate":
      return `Syntax highlighting: approximate (colored as ${language.monaco}).`;
    case "none":
      return "Syntax highlighting: none (shown as plain text).";
  }
}
