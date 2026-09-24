import * as monaco from "monaco-editor";

/**
 * Monaco ships its own (main-thread) language services for TypeScript/JavaScript,
 * JSON, CSS/SCSS/Less and HTML. Next to a real language server they would answer as
 * well — duplicate completions and problems, two competing formatters, and (for
 * TypeScript, whose worker isn't available here) hovers stuck on "Loading…".
 *
 *  - JSON, CSS and HTML re-register their providers when their mode configuration
 *    changes, so their built-in features are off for exactly as long as the matching
 *    server runs, and back on when it doesn't.
 *  - TypeScript/JavaScript read the configuration once, when the first such file is
 *    opened, and never again — so they are switched off for good at start-up, before
 *    any model exists. Without the server those files honestly have no language
 *    features (the status bar says why and offers Language Tools).
 */
interface Defaults {
  readonly modeConfiguration: object;
  setModeConfiguration(config: Record<string, boolean>): void;
}

/** LSP server id → the Monaco language service defaults it replaces. */
function defaultsFor(server: string): Defaults[] {
  switch (server) {
    case "typescript":
      return [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults];
    case "json":
      return [monaco.json.jsonDefaults];
    case "css":
      return [monaco.css.cssDefaults, monaco.css.scssDefaults, monaco.css.lessDefaults];
    case "html":
      return [monaco.html.htmlDefaults];
    default:
      return [];
  }
}

/** Servers whose built-in Monaco counterpart can be switched back on. */
const SWITCHABLE = ["json", "css", "html"];
const original = new Map<Defaults, Record<string, boolean>>();

function switchOff(defaults: Defaults): void {
  const current = defaults.modeConfiguration as Record<string, boolean>;
  if (!original.has(defaults)) original.set(defaults, { ...current });
  defaults.setModeConfiguration(
    Object.fromEntries(Object.keys(current).map((key) => [key, false])),
  );
}

function restore(defaults: Defaults): void {
  const saved = original.get(defaults);
  if (saved) {
    defaults.setModeConfiguration(saved);
    original.delete(defaults);
  }
}

/** Monaco's built-in features are off for the languages of `running` servers and on for the rest. */
export function applyBuiltinFeatures(running: ReadonlySet<string>): void {
  for (const server of SWITCHABLE) {
    for (const defaults of defaultsFor(server)) {
      if (running.has(server)) switchOff(defaults);
      else restore(defaults);
    }
  }
}

/** Permanently turns off Monaco's TypeScript/JavaScript language features. Call before any model is created. */
export function disableTypeScriptBuiltins(): void {
  for (const defaults of defaultsFor("typescript")) switchOff(defaults);
}
