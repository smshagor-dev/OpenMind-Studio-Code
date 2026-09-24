import type { EditorKind } from "./editorGroupService";
import type { IpcClient } from "./ipc";

const SETTINGS_KEY = "editor.associations";

const MARKDOWN_EXTENSIONS = [".md", ".markdown"];

/** The lower-cased extension including the dot (".md"), or `null` if the name has none. */
export function extensionOf(path: string | null): string | null {
  if (path === null) return null;
  const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : null;
}

export function isMarkdownPath(path: string | null): boolean {
  const extension = extensionOf(path);
  return extension !== null && MARKDOWN_EXTENSIONS.includes(extension);
}

/** Which kinds of editor a file type can be opened in — always the text editor, plus the preview for Markdown. */
export function availableKinds(path: string | null): EditorKind[] {
  return isMarkdownPath(path) ? ["text", "markdownPreview"] : ["text"];
}

/**
 * Which editor a file opens in by default, per extension (VS Code's "Set
 * Default for '.md'"). Without an entry every file opens in the text editor;
 * an entry can only name a kind that file type actually supports. Persisted in
 * `editor_settings` as one JSON object.
 */
export class EditorAssociationService {
  private associations: Readonly<Record<string, EditorKind>> = {};
  private readonly listeners = new Set<() => void>();

  constructor(private readonly ipc: IpcClient) {}

  async initialize(): Promise<void> {
    const saved = await this.ipc.settingsGet(SETTINGS_KEY).catch(() => null);
    if (saved !== null) {
      this.associations = parse(saved);
      this.notify();
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The default editor for `extension` (".md"), if one was chosen. */
  getDefault(extension: string): EditorKind | null {
    return this.associations[extension.toLowerCase()] ?? null;
  }

  /** The editor a file should open in: its chosen default, else the text editor. */
  kindFor(path: string | null): EditorKind {
    const extension = extensionOf(path);
    const chosen = extension === null ? null : this.getDefault(extension);
    return chosen !== null && availableKinds(path).includes(chosen) ? chosen : "text";
  }

  /** Chooses the default editor for an extension. Returns `false` if that file type can't be opened in `kind`. */
  async setDefault(extension: string, kind: EditorKind): Promise<boolean> {
    const normalized = extension.toLowerCase();
    if (kind !== "text" && !MARKDOWN_EXTENSIONS.includes(normalized)) {
      return false;
    }
    // The text editor is what every file gets anyway; don't keep a redundant entry for it.
    const kept = Object.entries(this.associations).filter(([key]) => key !== normalized);
    const next: Record<string, EditorKind> = Object.fromEntries(kept);
    if (kind !== "text") {
      next[normalized] = kind;
    }
    this.associations = next;
    this.notify();
    await this.ipc.settingsSet(SETTINGS_KEY, JSON.stringify(next)).catch(() => undefined);
    return true;
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function parse(raw: string): Record<string, EditorKind> {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const result: Record<string, EditorKind> = {};
    for (const [extension, kind] of Object.entries(value)) {
      if (kind === "markdownPreview" && MARKDOWN_EXTENSIONS.includes(extension)) {
        result[extension] = kind;
      }
    }
    return result;
  } catch {
    return {};
  }
}
