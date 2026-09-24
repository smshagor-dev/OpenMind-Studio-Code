import * as monaco from "monaco-editor";

/**
 * Monaco ships its own (main-thread) language services for TypeScript/JavaScript,
 * JSON, CSS/SCSS/Less and HTML. Next to a real language server they would answer as
 * well — duplicate completions and problems, two competing formatters — and here their
 * worker isn't available, so their hovers sit on "Loading…" forever (seen in the app for
 * TypeScript and CSS). Switching them off *while a server runs* turned out not to be
 * reliable (TypeScript reads its settings once; the others kept a stuck hover provider),
 * so they are switched off for good at start-up, before any model exists. Without the
 * matching server those files honestly have no language features: the status bar says
 * why and offers Language Tools.
 */
interface Defaults {
  readonly modeConfiguration: object;
  setModeConfiguration(config: Record<string, boolean>): void;
}

function allDefaults(): Defaults[] {
  return [
    monaco.typescript.typescriptDefaults,
    monaco.typescript.javascriptDefaults,
    monaco.json.jsonDefaults,
    monaco.css.cssDefaults,
    monaco.css.scssDefaults,
    monaco.css.lessDefaults,
    monaco.html.htmlDefaults,
  ];
}

/** Permanently turns off Monaco's own TypeScript/JavaScript, JSON, CSS and HTML language features. */
export function disableBuiltinLanguageServices(): void {
  for (const defaults of allDefaults()) {
    const current = defaults.modeConfiguration as Record<string, boolean>;
    defaults.setModeConfiguration(
      Object.fromEntries(Object.keys(current).map((key) => [key, false])),
    );
  }
}
