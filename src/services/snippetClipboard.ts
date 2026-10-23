import { SnippetParser, Variable } from "monaco-editor/editor/contrib/snippet/browser/snippetParser.js";

/** Inspect the same parsed grammar Monaco inserts, including escapes and transforms. */
export function snippetUsesClipboard(value: string): boolean {
  let found = false;
  new SnippetParser().parse(value).walk(marker => {
    if (marker instanceof Variable && marker.name === "CLIPBOARD") found = true;
    return true;
  });
  return found;
}
