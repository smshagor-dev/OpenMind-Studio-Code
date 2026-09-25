import { parseJsonc } from "./jsonc";

/** One snippet of a `snippets` contribution, ready to become a completion item. */
export interface ExtensionSnippet {
  name: string;
  /** Every word that offers it. */
  prefixes: string[];
  /** The text with VS Code snippet syntax (`$1`, `${2:name}`), lines joined with `\n`. */
  body: string;
  description: string;
}

function lines(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((line): line is string => typeof line === "string") : [];
}

/** Reads a VS Code snippets file (`{ "Name": { "prefix": ..., "body": ..., "description": ... } }`). */
export function parseSnippets(text: string): ExtensionSnippet[] {
  const root = parseJsonc(text);
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    throw new Error("A snippets file must be a JSON object.");
  }
  const snippets: ExtensionSnippet[] = [];
  for (const [name, value] of Object.entries(root)) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    const prefixes = lines(entry.prefix);
    const body = lines(entry.body);
    if (prefixes.length === 0 || body.length === 0) continue;
    snippets.push({
      name,
      prefixes,
      body: body.join("\n"),
      description: typeof entry.description === "string" ? entry.description : name,
    });
  }
  return snippets;
}
