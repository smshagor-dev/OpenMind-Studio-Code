import type { ProviderInvoke, ProviderRegistration } from "./extensionHostBridge";

/** An edit as the host sends it (0-based lines and UTF-16 columns). */
export interface HostTextEdit {
  range: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  newText: string;
}

/** The same edit the way the editor's `textWithEdits` wants it (1-based, Monaco style). */
export interface EditorTextEdit {
  range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
  text: string;
}

export function toEditorEdits(edits: HostTextEdit[]): EditorTextEdit[] {
  return edits.map((edit) => ({
    range: {
      startLineNumber: edit.range.startLine + 1,
      startColumn: edit.range.startColumn + 1,
      endLineNumber: edit.range.endLine + 1,
      endColumn: edit.range.endColumn + 1,
    },
    text: edit.newText,
  }));
}

interface Entry {
  handle: string;
  extension: string;
  name: string;
  languages: Set<string>;
  invoke: ProviderInvoke;
}

/** One formatter an extension offers for a document. */
export interface ExtensionFormatter {
  /** `ext:<extension id>`: stable across restarts, so it can be remembered as the default formatter. */
  id: string;
  name: string;
  extension: string;
  /** The extension's edits for the whole document at `path`. */
  format: (path: string, options: { tabSize: number; insertSpaces: boolean }) => Promise<HostTextEdit[]>;
}

/**
 * Document formatting providers extensions register (`languages.registerDocumentFormattingEditProvider`,
 * Milestone 18). They are offered by Format Document next to the built-in, project, bundled and language-server
 * formatters — as one more choice, never ahead of them: an extension's formatter runs only when the user chose it
 * (Format Document With..., or the default formatter) or when nothing else can format the file. UI-free.
 */
export class ExtensionFormatterRegistry {
  private readonly entries = new Map<string, Entry>();

  register(registration: ProviderRegistration, invoke: ProviderInvoke): () => void {
    if (registration.kind !== "formatting") return () => undefined;
    const languages = new Set(
      registration.selector.map((item) => item.language).filter((l): l is string => typeof l === "string"),
    );
    this.entries.set(registration.handle, {
      handle: registration.handle,
      extension: registration.extension,
      name: registration.displayName ?? registration.extension,
      languages,
      invoke,
    });
    return () => {
      this.entries.delete(registration.handle);
    };
  }

  /** The extensions' formatters for a language (one per extension: its first provider). */
  forLanguage(language: string): ExtensionFormatter[] {
    const seen = new Set<string>();
    const out: ExtensionFormatter[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.languages.has(language) && !entry.languages.has("*")) continue;
      if (seen.has(entry.extension)) continue;
      seen.add(entry.extension);
      out.push({
        id: `ext:${entry.extension}`,
        name: `${entry.name} (extension)`,
        extension: entry.extension,
        format: async (path, options) => {
          const answer = await entry.invoke({ path, options });
          return Array.isArray(answer) ? (answer as HostTextEdit[]) : [];
        },
      });
    }
    return out;
  }

  /** Everything registered is gone (the host stopped). */
  clear(): void {
    this.entries.clear();
  }
}
